// Supervises the resident trellis-server child process: spawn it from the
// configured binary path, forward its stdout/stderr lines to the UI as
// `server-log` events (so the UI can show live stage progress), tee every line
// to a per-launch log file under the logs dir (so crashes/backend errors can be
// diagnosed after the fact), and make sure it dies with the app.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::config::{self, Config};

#[derive(Default)]
pub struct ServerState {
    child: Mutex<Option<Child>>,
    /// Path of the log file for the current/last launch, for the "open log" UI.
    log_path: Mutex<Option<PathBuf>>,
}

/// Is something already accepting connections on host:port? Used to detect a
/// server left running by a previously-crashed app instance (or a manually
/// launched one) so we don't spawn a duplicate that would fail to bind.
fn port_open(host: &str, port: u16) -> bool {
    match format!("{host}:{port}").to_socket_addrs() {
        Ok(mut addrs) => addrs
            .next()
            .map(|a| TcpStream::connect_timeout(&a, Duration::from_millis(300)).is_ok())
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// What answers on the configured port, as far as a plain HTTP probe can tell.
/// This guards against adopting an unrelated local service by accident; it is
/// not authentication.
#[derive(Debug, PartialEq, Eq)]
enum Listener {
    /// Answers `/identity` as trellis-server.
    Trellis,
    /// A runtime predating `/identity` whose `/health` still answers `ok`. This
    /// is a compatibility heuristic, not verified identity: any service that
    /// answers `/health` with `ok` also passes.
    LegacyTrellis,
    TimedOut,
    Unknown,
}

/// Shared connection/response budget for both startup requests. Hostname
/// resolution is not bounded; the default numeric loopback address needs no DNS.
const PROBE_BUDGET: Duration = Duration::from_secs(5);
const PROBE_MAX_RESPONSE: usize = 64 * 1024;

/// Time left before `deadline`, or None once it has passed.
fn remaining(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
}

/// Minimal blocking HTTP GET returning (status, body), bounded by `deadline`
/// across connect, write and every read. Uses a raw socket so it is safe from
/// the Tauri setup hook, where reqwest's blocking client may not be.
fn http_get(host: &str, port: u16, path: &str, deadline: Instant) -> Option<(u16, String)> {
    let addr = format!("{host}:{port}").to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, remaining(deadline)?).ok()?;
    let authority = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let request = format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n");
    stream.set_write_timeout(Some(remaining(deadline)?)).ok()?;
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        stream.set_read_timeout(Some(remaining(deadline)?)).ok()?;
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..n]);
        if raw.len() > PROBE_MAX_RESPONSE {
            return None;
        }
        if response_complete(&raw) {
            break;
        }
    }
    parse_http_response(&raw)
}

/// Split a raw response into (status line + headers, body bytes).
fn split_response(raw: &[u8]) -> Option<(String, &[u8])> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    Some((
        String::from_utf8_lossy(&raw[..end]).into_owned(),
        &raw[end + 4..],
    ))
}

fn content_length(head: &str) -> Option<usize> {
    head.lines().skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse().ok())?
    })
}

/// True once headers and the full `Content-Length` body have arrived. Without
/// a length the response ends at EOF (we always send `Connection: close`).
fn response_complete(raw: &[u8]) -> bool {
    split_response(raw)
        .and_then(|(head, body)| content_length(&head).map(|len| body.len() >= len))
        .unwrap_or(false)
}

/// Parse a complete response; a body shorter than its `Content-Length` is
/// treated as incomplete and rejected.
fn parse_http_response(raw: &[u8]) -> Option<(u16, String)> {
    let (head, body) = split_response(raw)?;
    let status = head
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    let body = match content_length(&head) {
        Some(len) if body.len() < len => return None,
        Some(len) => &body[..len],
        None => body,
    };
    Some((status, String::from_utf8_lossy(body).into_owned()))
}

fn classify_listener(identity: Option<(u16, String)>, health: Option<(u16, String)>) -> Listener {
    let is_trellis = identity
        .filter(|(status, _)| *status == 200)
        .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(&body).ok())
        .is_some_and(|value| value["service"] == "trellis-server");
    if is_trellis {
        return Listener::Trellis;
    }
    match health {
        Some((200, body)) if body.trim() == "ok" => Listener::LegacyTrellis,
        _ => Listener::Unknown,
    }
}

/// Identify the listener within `budget`, shared by the `/identity` request and
/// the legacy `/health` fallback.
fn probe_listener(host: &str, port: u16, budget: Duration) -> Listener {
    let deadline = Instant::now() + budget;
    let identity = http_get(host, port, "/identity", deadline);
    if matches!(identity, Some((200, _))) {
        return classify_listener(identity, None);
    }
    let health = http_get(host, port, "/health", deadline);
    let listener = classify_listener(identity, health);
    if listener == Listener::Unknown && remaining(deadline).is_none() {
        Listener::TimedOut
    } else {
        listener
    }
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Days-since-epoch -> (year, month, day). Howard Hinnant's civil-from-days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn fmt_utc(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86400) as i64);
    let tod = secs % 86400;
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

fn fmt_hms(secs: u64) -> String {
    let tod = secs % 86400;
    format!("{:02}:{:02}:{:02}", tod / 3600, (tod % 3600) / 60, tod % 60)
}

/// Compact, sortable, filesystem-safe log filename for a launch at `secs`.
fn log_file_name(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86400) as i64);
    let tod = secs % 86400;
    format!(
        "trellis-server-{y:04}{m:02}{d:02}-{:02}{:02}{:02}.log",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// Keep the logs dir from growing forever: delete all but the newest `keep`
/// trellis-server-*.log files. Best-effort; failures are ignored.
fn prune_logs(dir: &std::path::Path, keep: usize) {
    let mut logs: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("trellis-server-") && n.ends_with(".log"))
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => return,
    };
    if logs.len() <= keep {
        return;
    }
    // Names are timestamp-sortable, so lexicographic == chronological.
    logs.sort();
    for p in &logs[..logs.len() - keep] {
        let _ = std::fs::remove_file(p);
    }
}

/// Shared handle to the current launch's log file. Both the stdout and stderr
/// reader threads write to it under one lock; `None` if the log couldn't open
/// (which never blocks generation — logging is best-effort).
type LogSink = Arc<Mutex<Option<File>>>;

fn write_log(sink: &LogSink, line: &str) {
    if let Ok(mut guard) = sink.lock() {
        if let Some(f) = guard.as_mut() {
            let _ = writeln!(f, "[{}] {}", fmt_hms(now_epoch()), line);
            let _ = f.flush();
        }
    }
}

fn pipe<R: Read + Send + 'static>(app: AppHandle, reader: R, sink: LogSink) {
    std::thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines().map_while(Result::ok) {
            write_log(&sink, &line);
            let _ = app.emit("server-log", line);
        }
    });
}

/// Emit a `[studio]` diagnostic line to both the UI and the log file.
fn studio_log(app: &AppHandle, sink: &LogSink, msg: &str) {
    let line = format!("[studio] {msg}");
    write_log(sink, &line);
    let _ = app.emit("server-log", line);
}

/// (Re)start the server from the given config. Stops any child we own first.
///
/// `allow_reuse`: at autostart we adopt a server already bound to the port
/// (e.g. one a user launched by hand, or a pre-fix orphan) instead of spawning a
/// duplicate, provided it identifies as trellis-server (or, for older runtimes,
/// answers `/health` with `ok`); any other listener is reported as a conflict. On an explicit restart the user has just changed the config, so we
/// must NOT reuse a stale server — we spawn fresh so the new settings take
/// effect (surfacing a clear error if a foreign process still holds the port).
pub fn start(
    app: &AppHandle,
    cfg: &Config,
    state: &ServerState,
    allow_reuse: bool,
) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if std::env::var("TRIASTASIS_TEST_DISABLE_NATIVE_SERVER").as_deref() == Ok("1") {
        return Err("native server disabled for the isolated runtime download demo".into());
    }
    let _runtime_guard = crate::runtime::operation_guard()?;
    stop(state);
    if cfg.server_bin.is_empty() {
        return Err("server binary is not configured".to_string());
    }

    // Open the per-launch log file (best-effort).
    let started = now_epoch();
    let sink: LogSink = Arc::new(Mutex::new(None));
    if let Ok(dir) = config::resolve_logs_dir() {
        prune_logs(&dir, 19); // keep 19 old + the one we're about to open = 20
        let path = dir.join(log_file_name(started));
        if let Ok(f) = File::create(&path) {
            *sink.lock().unwrap() = Some(f);
            *state.log_path.lock().unwrap() = Some(path);
        }
    }
    studio_log(
        app,
        &sink,
        &format!("Triastasis server log: {}", fmt_utc(started)),
    );
    studio_log(
        app,
        &sink,
        &format!(
            "config: bin={} models={} gpu={} backend={} host={} port={}",
            cfg.server_bin, cfg.models_dir, cfg.gpu, cfg.backend, cfg.host, cfg.port
        ),
    );

    if port_open(&cfg.host, cfg.port) {
        if allow_reuse {
            match probe_listener(&cfg.host, cfg.port, PROBE_BUDGET) {
                Listener::Trellis => {
                    studio_log(
                        app,
                        &sink,
                        &format!("reusing server already on {}:{}", cfg.host, cfg.port),
                    );
                    return Ok(());
                }
                Listener::LegacyTrellis => {
                    studio_log(
                        app,
                        &sink,
                        &format!(
                            "reusing server already on {}:{} (older runtime without identity check)",
                            cfg.host, cfg.port
                        ),
                    );
                    return Ok(());
                }
                Listener::TimedOut => {
                    let msg = format!(
                        "The server on {}:{} did not respond in time. Try again.",
                        cfg.host, cfg.port
                    );
                    studio_log(app, &sink, &msg);
                    return Err(msg);
                }
                Listener::Unknown => {
                    let msg = format!(
                        "another program is using {}:{} and is not a Triastasis model server. Close it or change the server port in Settings",
                        cfg.host, cfg.port
                    );
                    studio_log(app, &sink, &msg);
                    return Err(msg);
                }
            }
        }
        // Explicit restart but a foreign process holds the port. Wait briefly in
        // case it's a socket we just released; if it persists, spawning will fail
        // to bind, so report it clearly rather than silently reusing stale config.
        let mut freed = false;
        for _ in 0..8 {
            std::thread::sleep(Duration::from_millis(200));
            if !port_open(&cfg.host, cfg.port) {
                freed = true;
                break;
            }
        }
        if !freed {
            let msg = format!(
                "another process is already using {}:{}. Close it (or change the port) so the new settings can take effect",
                cfg.host, cfg.port
            );
            studio_log(app, &sink, &msg);
            return Err(msg);
        }
    }

    let mut cmd = Command::new(&cfg.server_bin);
    cmd.arg("--models")
        .arg(&cfg.models_dir)
        .arg("--gpu")
        .arg(cfg.gpu.to_string())
        .arg("--host")
        .arg(&cfg.host)
        .arg("--port")
        .arg(cfg.port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Don't flash a console window on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // On Linux, ask the kernel to SIGKILL the server if we (the parent) die, so a
    // hard crash of the app can't orphan a server on the port — which would then
    // get reused with stale config and make Settings changes appear ignored.
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::prctl(
                libc::PR_SET_PDEATHSIG,
                libc::SIGKILL as libc::c_ulong,
                0,
                0,
                0,
            );
            Ok(())
        });
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch {}: {e}", cfg.server_bin))?;

    if let Some(out) = child.stdout.take() {
        pipe(app.clone(), out, sink.clone());
    }
    if let Some(err) = child.stderr.take() {
        pipe(app.clone(), err, sink.clone());
    }

    *state.child.lock().unwrap() = Some(child);
    studio_log(
        app,
        &sink,
        &format!("launched {} on {}:{}", cfg.server_bin, cfg.host, cfg.port),
    );
    Ok(())
}

pub fn stop(state: &ServerState) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

pub fn is_running(state: &ServerState) -> bool {
    let mut guard = state.child.lock().unwrap();
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

/// Whether the configured native server is reachable. This also reports true
/// when the app adopted a server launched by another process, in which case
/// `ServerState` intentionally has no child handle to inspect.
pub fn is_available(state: &ServerState, cfg: &Config) -> bool {
    is_running(state) || port_open(&cfg.host, cfg.port)
}

/// Path of the current/last launch's log file, if one was opened.
pub fn log_path(state: &ServerState) -> Option<String> {
    state
        .log_path
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn ok(body: &str) -> Option<(u16, String)> {
        Some((200, body.to_string()))
    }

    #[test]
    fn listener_classification_requires_trellis_identity_or_legacy_health() {
        assert_eq!(
            classify_listener(
                ok(r#"{"service":"trellis-server","identityVersion":1}"#),
                None
            ),
            Listener::Trellis
        );
        assert_eq!(
            classify_listener(Some((404, "Not Found".into())), ok("ok\n")),
            Listener::LegacyTrellis
        );
        assert_eq!(
            classify_listener(ok(r#"{"service":"other"}"#), ok("<html>")),
            Listener::Unknown
        );
        assert_eq!(
            classify_listener(ok("<html>"), Some((404, String::new()))),
            Listener::Unknown
        );
        assert_eq!(classify_listener(None, ok("okay")), Listener::Unknown);
        assert_eq!(classify_listener(None, None), Listener::Unknown);
    }

    #[test]
    fn http_response_parsing_extracts_status_and_body() {
        assert_eq!(
            parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"),
            Some((200, "ok".to_string()))
        );
        assert_eq!(
            parse_http_response(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nokEXTRA"),
            Some((200, "ok".to_string()))
        );
        assert_eq!(
            parse_http_response(b"HTTP/1.1 200 OK\r\n\r\nuntil eof"),
            Some((200, "until eof".to_string()))
        );
        assert_eq!(
            parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort"),
            None
        );
        assert_eq!(parse_http_response(b"HTTP/1.1 200 OK\r\nContent-"), None);
        assert_eq!(parse_http_response(b"garbage"), None);
        assert!(response_complete(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
        ));
        assert!(!response_complete(
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok"
        ));
        assert!(!response_complete(b"HTTP/1.1 200 OK\r\n\r\nno length"));
    }

    /// Serve every accepted connection on its own thread with `handle`. The
    /// threads are detached: stalled handlers outlive the test's assertions.
    fn serve(handle: fn(TcpStream)) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || handle(stream));
            }
        });
        port
    }

    fn read_request(stream: &mut TcpStream) {
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);
    }

    #[test]
    fn probe_rejects_an_unrelated_listener() {
        let port = serve(|mut stream| {
            read_request(&mut stream);
            let _ = stream.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        });
        assert_eq!(
            probe_listener("127.0.0.1", port, PROBE_BUDGET),
            Listener::Unknown
        );
    }

    #[test]
    fn probe_stops_once_the_response_is_complete() {
        // Answers correctly but never closes the connection.
        let port = serve(|mut stream| {
            read_request(&mut stream);
            let body = r#"{"service":"trellis-server","identityVersion":1}"#;
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            );
            std::thread::sleep(Duration::from_secs(5));
        });
        let started = Instant::now();
        assert_eq!(
            probe_listener("127.0.0.1", port, PROBE_BUDGET),
            Listener::Trellis
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn probe_gives_up_on_a_stalled_listener_within_one_budget() {
        // Accepts and reads, then never answers. The /identity attempt uses up
        // the budget, so the /health fallback must not get a fresh one.
        let port = serve(|mut stream| {
            read_request(&mut stream);
            std::thread::sleep(Duration::from_secs(5));
        });
        let budget = Duration::from_millis(400);
        let started = Instant::now();
        assert_eq!(probe_listener("127.0.0.1", port, budget), Listener::TimedOut);
        assert!(started.elapsed() < budget + Duration::from_millis(300));
    }

    #[test]
    fn probe_gives_up_on_a_trickling_listener_within_one_budget() {
        // Sends one byte at a time, each well inside any per-read timeout.
        let port = serve(|mut stream| {
            read_request(&mut stream);
            let response = b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n";
            for byte in response.iter().chain(std::iter::repeat(&b'x')).take(5000) {
                if stream.write_all(&[*byte]).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let budget = Duration::from_millis(400);
        let started = Instant::now();
        assert_eq!(probe_listener("127.0.0.1", port, budget), Listener::TimedOut);
        assert!(started.elapsed() < budget + Duration::from_millis(300));
    }
}

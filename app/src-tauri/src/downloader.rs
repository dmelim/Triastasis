// Phase 2 of the in-app model installation plan
// Native model download engine with resumable partial files and verification.
//
// Streaming resumable downloads against the pinned catalog revision, with
// pause/cancel, bounded retries, range-validated resume, atomic commits, a
// models-directory lock, and progress events for the UI. Downloads never touch
// the active bundle; activation is a separate command.

use crate::models::{self, ModelCatalog};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

const DISK_MARGIN_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ATTEMPTS_PER_FILE: u32 = 3;

/// Progress payload emitted as `model-download-progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub bundle_id: String,
    /// preparing | downloading | paused | verifying | ready | failed | cancelled
    pub state: String,
    pub error: Option<String>,
    pub file_name: Option<String>,
    pub file_index: usize,
    pub file_count: usize,
    pub file_bytes_done: u64,
    pub file_bytes_total: u64,
    pub total_bytes_done: u64,
    pub total_bytes_total: u64,
    pub bytes_per_second: u64,
    pub eta_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStatus {
    pub bundle_id: Option<String>,
    pub state: String,
    pub error: Option<String>,
}

/// Resume marker persisted beside partial files so a restart can explain what
/// it found. The authoritative resume offset is always the partial file size.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DownloadStateFile {
    #[serde(rename = "bundleId")]
    bundle_id: String,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

pub struct ActiveDownload {
    pub bundle_id: String,
    pause: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    status: Arc<Mutex<DownloadStatus>>,
}

#[derive(Default)]
pub struct DownloadControl {
    /// One model-management download at a time across the whole app.
    active: Mutex<Option<Arc<ActiveDownload>>>,
}

impl DownloadControl {
    fn begin(&self, bundle_id: &str) -> Result<Arc<ActiveDownload>, String> {
        let mut guard = self.active.lock().unwrap();
        if let Some(active) = guard.as_ref() {
            return Err(format!(
                "a model download is already running ({})",
                active.bundle_id
            ));
        }
        let active = Arc::new(ActiveDownload {
            bundle_id: bundle_id.to_string(),
            pause: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
            status: Arc::new(Mutex::new(DownloadStatus {
                bundle_id: Some(bundle_id.to_string()),
                state: "preparing".into(),
                error: None,
            })),
        });
        *guard = Some(active.clone());
        Ok(active)
    }

    pub fn finish(&self, bundle_id: &str) {
        let mut guard = self.active.lock().unwrap();
        if guard
            .as_ref()
            .map(|a| a.bundle_id == bundle_id)
            .unwrap_or(false)
        {
            *guard = None;
        }
    }

    /// Current status snapshot for the UI.
    pub fn status(&self) -> Option<DownloadStatus> {
        let guard = self.active.lock().unwrap();
        guard.as_ref().map(|a| a.status.lock().unwrap().clone())
    }

    /// Request a cooperative pause; the worker persists state and exits.
    pub fn request_pause(&self) -> Result<(), String> {
        let guard = self.active.lock().unwrap();
        match guard.as_ref() {
            Some(active) => {
                active.pause.store(true, Ordering::Release);
                Ok(())
            }
            None => Err("no model download is running".to_string()),
        }
    }

    /// Request cancellation; partial files owned by this download are removed.
    pub fn request_cancel(&self) -> Result<(), String> {
        let guard = self.active.lock().unwrap();
        match guard.as_ref() {
            Some(active) => {
                active.cancel.store(true, Ordering::Release);
                Ok(())
            }
            None => Err("no model download is running".to_string()),
        }
    }
}

// ---- models-directory lock ----------------------------------------------------

impl Drop for ModelDirLockGuard {
    fn drop(&mut self) {
        std::fs::remove_file(&self.path).ok();
    }
}

pub struct ModelDirLockGuard {
    _file: std::fs::File,
    path: PathBuf,
}

/// Exclusive models-directory lock held while any model-management operation
/// mutates the directory. Uses an unshared open handle on Windows (share_mode 0)
/// and flock on Linux; both are released by the OS even if the process dies.
pub fn acquire_models_lock(root: &Path) -> Result<ModelDirLockGuard, String> {
    let path = root.join(".triastasis-models.lock");
    let file = acquire_lock_platform(&path).map_err(|_| {
        "another Triastasis instance or tool is using this models directory".to_string()
    })?;
    Ok(ModelDirLockGuard { _file: file, path })
}

#[cfg(windows)]
fn acquire_lock_platform(path: &Path) -> Result<std::fs::File, ()> {
    use std::os::windows::fs::OpenOptionsExt;
    // share_mode(0): a second opener gets ERROR_SHARING_VIOLATION until we close.
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .share_mode(0)
        .open(path)
        .map_err(|_| ())
}

#[cfg(target_os = "linux")]
fn acquire_lock_platform(path: &Path) -> Result<std::fs::File, ()> {
    use std::os::unix::io::AsRawFd;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| ())?;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        return Err(());
    }
    Ok(file)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn acquire_lock_platform(_path: &Path) -> Result<std::fs::File, ()> {
    Err(())
}

// ---- helpers ------------------------------------------------------------------

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
struct HuggingFaceLfs {
    oid: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct HuggingFaceTreeEntry {
    path: String,
    size: u64,
    lfs: Option<HuggingFaceLfs>,
}

fn sha256_from_tree_metadata(
    body: &str,
    expected_path: &str,
    expected_size: u64,
) -> Result<String, String> {
    let entries = serde_json::from_str::<Vec<HuggingFaceTreeEntry>>(body)
        .map_err(|error| format!("invalid upstream metadata: {error}"))?;
    let entry = entries
        .into_iter()
        .find(|entry| entry.path == expected_path)
        .ok_or_else(|| format!("upstream metadata did not list {expected_path}"))?;
    if entry.size != expected_size {
        return Err(format!(
            "upstream metadata reports {} bytes, expected {}",
            entry.size, expected_size
        ));
    }
    let lfs = entry
        .lfs
        .ok_or_else(|| "upstream metadata did not provide an LFS SHA-256".to_string())?;
    if lfs.size != expected_size {
        return Err(format!(
            "upstream LFS metadata reports {} bytes, expected {}",
            lfs.size, expected_size
        ));
    }
    if lfs.oid.len() != 64 || !lfs.oid.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("upstream metadata returned an invalid SHA-256".to_string());
    }
    Ok(lfs.oid.to_ascii_lowercase())
}

fn upstream_file_path(bundle: &models::Bundle, file: &models::ModelFile) -> String {
    if bundle.path_prefix.is_empty() {
        file.name.clone()
    } else {
        format!("{}/{}", bundle.path_prefix, file.name)
    }
}

fn pinned_upstream_sha256(
    client: &reqwest::blocking::Client,
    catalog: &ModelCatalog,
    bundle: &models::Bundle,
    file: &models::ModelFile,
) -> Result<String, String> {
    if catalog.source.kind != "huggingface" {
        return Err(format!(
            "unsupported catalog source: {}",
            catalog.source.kind
        ));
    }
    let tree_url = if bundle.path_prefix.is_empty() {
        format!(
            "https://huggingface.co/api/models/{}/tree/{}?recursive=false&expand=true",
            catalog.source.repo, catalog.model_revision
        )
    } else {
        format!(
            "https://huggingface.co/api/models/{}/tree/{}/{}?recursive=false&expand=true",
            catalog.source.repo, catalog.model_revision, bundle.path_prefix
        )
    };
    let response = client
        .get(&tree_url)
        .send()
        .map_err(|error| format!("upstream metadata request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "upstream metadata returned HTTP {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .map_err(|error| format!("could not read upstream metadata: {error}"))?;
    let expected_path = upstream_file_path(bundle, file);
    sha256_from_tree_metadata(&body, &expected_path, file.size)
}

fn verify_hash_with_fallback(
    client: &reqwest::blocking::Client,
    catalog: &ModelCatalog,
    bundle: &models::Bundle,
    file: &models::ModelFile,
    actual: &str,
) -> Result<bool, String> {
    if actual == file.sha256 {
        return Ok(false);
    }
    let source_url = catalog.file_url(bundle, file);
    match pinned_upstream_sha256(client, catalog, bundle, file) {
        Ok(upstream) if upstream == actual => Ok(true),
        Ok(upstream) => Err(format!(
            "Could not verify {}. Download source: {}. Catalog expected {}, downloaded {}, and pinned upstream metadata reports {}.",
            file.name, source_url, file.sha256, actual, upstream
        )),
        Err(reason) => Err(format!(
            "Could not verify {}. Download source: {}. Catalog expected {} and downloaded {}. The pinned upstream metadata check also failed: {}.",
            file.name, source_url, file.sha256, actual, reason
        )),
    }
}

fn replace_effective_hash(
    catalog: &mut ModelCatalog,
    bundle_id: &str,
    file_name: &str,
    sha256: &str,
) {
    if let Some(file) = catalog
        .bundle_mut(bundle_id)
        .and_then(|bundle| bundle.files.iter_mut().find(|file| file.name == file_name))
    {
        file.sha256 = sha256.to_string();
    }
}

fn set_state(status: &Mutex<DownloadStatus>, state: &str, error: Option<String>) {
    let mut s = status.lock().unwrap();
    s.state = state.to_string();
    s.error = error;
}

/// The effective managed root for the current configuration.
fn effective_root() -> Result<PathBuf, String> {
    let cat = models::catalog()?;
    let cfg = crate::config::load();
    let models_dir = cfg
        .as_ref()
        .filter(|c| !c.models_dir.trim().is_empty())
        .map(|c| PathBuf::from(c.models_dir.trim()))
        .unwrap_or_else(models::default_models_root);
    Ok(models::resolve_models_root(&models_dir, cat))
}

fn emit_progress(app: &tauri::AppHandle, p: &DownloadProgress) {
    let _ = app.emit("model-download-progress", p);
}

#[allow(clippy::too_many_arguments)]
fn progress_payload(
    bundle_id: &str,
    state: &str,
    file_name: Option<&str>,
    file_index: usize,
    file_count: usize,
    file_done: u64,
    file_total: u64,
    total_done: u64,
    total_total: u64,
    speed: u64,
) -> DownloadProgress {
    DownloadProgress {
        bundle_id: bundle_id.into(),
        state: state.into(),
        error: None,
        file_name: file_name.map(Into::into),
        file_index,
        file_count,
        file_bytes_done: file_done.min(file_total),
        file_bytes_total: file_total,
        total_bytes_done: total_done.min(total_total),
        total_bytes_total: total_total,
        bytes_per_second: speed,
        eta_seconds: (speed > 0 && total_total > total_done)
            .then_some((total_total - total_done) / speed.max(1)),
    }
}

/// Record a terminal failure in status/events and surface the error.
#[allow(clippy::too_many_arguments)]
fn fail(
    app: &tauri::AppHandle,
    status: &Mutex<DownloadStatus>,
    bundle_id: &str,
    message: &str,
    file_index: usize,
    file_count: usize,
    total_done: u64,
    total_total: u64,
) -> String {
    set_state(status, "failed", Some(message.to_string()));
    let mut progress = progress_payload(
        bundle_id,
        "failed",
        None,
        file_index,
        file_count,
        0,
        0,
        total_done,
        total_total,
        0,
    );
    progress.error = Some(message.to_string());
    emit_progress(app, &progress);
    message.to_string()
}

fn retryable(attempt: u32) -> bool {
    attempt < MAX_ATTEMPTS_PER_FILE
}

fn backoff(attempt: u32) {
    std::thread::sleep(std::time::Duration::from_secs(2u64.pow(attempt.min(3))));
}

fn is_disk_full(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(28) | Some(112))
}

fn persist_resume_marker(dl_dir: &Path, bundle_id: &str) {
    let state = DownloadStateFile {
        bundle_id: bundle_id.to_string(),
        updated_at: now_secs(),
    };
    if let Ok(json) = serde_json::to_string(&state) {
        std::fs::write(dl_dir.join("download-state.json"), json).ok();
    }
}

fn remove_partials(dl_dir: &Path) {
    remove_dir_contents_matching(dl_dir, |name| {
        name.ends_with(".partial") || name == "download-state.json"
    });
}

/// Remove every partial/state file inside one bundle's download directory.
pub fn remove_bundle_partials(dl_dir: &Path) {
    remove_partials(dl_dir);
}

fn remove_dir_contents_matching(dl_dir: &Path, matches: impl Fn(&str) -> bool) {
    if let Ok(rd) = std::fs::read_dir(dl_dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if matches(&name) {
                std::fs::remove_file(entry.path()).ok();
            }
        }
    }
}

/// Partial downloads found on disk (restart recovery / first-launch detection).
pub fn scan_partial_downloads(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let base = root.join("downloads");
    if let Ok(rd) = std::fs::read_dir(base) {
        for entry in rd.flatten() {
            if entry.path().is_dir() {
                let has_partial = std::fs::read_dir(entry.path())
                    .map(|files| {
                        files
                            .flatten()
                            .any(|f| f.file_name().to_string_lossy().ends_with(".partial"))
                    })
                    .unwrap_or(false);
                if has_partial {
                    found.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
        }
    }
    found
}

// ---- main worker ----------------------------------------------------------------

/// Run one bundle download to completion on the caller's thread. Emits
/// `model-download-progress` events. Returns Ok on ready/cancelled/paused;
/// Err carries the failure message.
pub fn run_download(
    app: &tauri::AppHandle,
    control: &DownloadControl,
    bundle_id: &str,
) -> Result<(), String> {
    let active = control.begin(bundle_id)?;
    let result = run_download_inner(app, &active, bundle_id);
    if let Err(error) = &result {
        let already_reported = active.status.lock().unwrap().state == "failed";
        if !already_reported {
            let (file_count, total_bytes) = models::catalog()
                .ok()
                .and_then(|cat| cat.bundle(bundle_id))
                .map(|bundle| (bundle.files.len(), ModelCatalog::total_bytes(bundle)))
                .unwrap_or((0, 0));
            set_state(&active.status, "failed", Some(error.clone()));
            let mut progress = progress_payload(
                bundle_id,
                "failed",
                None,
                0,
                file_count,
                0,
                0,
                0,
                total_bytes,
                0,
            );
            progress.error = Some(error.clone());
            emit_progress(app, &progress);
        }
    }
    control.finish(bundle_id);
    result
}

fn stop_requested(cancel: &AtomicBool, pause: &AtomicBool) -> bool {
    cancel.load(Ordering::Acquire) || pause.load(Ordering::Acquire)
}

fn run_download_inner(
    app: &tauri::AppHandle,
    active: &Arc<ActiveDownload>,
    bundle_id: &str,
) -> Result<(), String> {
    let cat = models::catalog()?;
    let mut effective_catalog = cat.clone();
    let bundle = cat
        .bundle(bundle_id)
        .ok_or_else(|| format!("unknown bundle: {bundle_id}"))?
        .clone();
    let (pause, cancel, status) = (&active.pause, &active.cancel, &active.status);
    let file_count = bundle.files.len();
    let total_total = ModelCatalog::total_bytes(&bundle);

    let root = effective_root()?;
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let _lock = acquire_models_lock(&root)?;

    let leaf = root
        .join("installed")
        .join(&cat.model_revision)
        .join(&bundle.quantization);
    std::fs::create_dir_all(&leaf).map_err(|e| format!("create {}: {e}", leaf.display()))?;
    let dl_dir = root.join("downloads").join(bundle_id);
    std::fs::create_dir_all(&dl_dir).map_err(|e| format!("create {}: {e}", dl_dir.display()))?;

    let is_final = |name: &str, size: u64| {
        leaf.join(name)
            .metadata()
            .map(|m| m.is_file() && m.len() == size)
            .unwrap_or(false)
    };
    let partial_len = |name: &str| {
        dl_dir
            .join(format!("{name}.partial"))
            .metadata()
            .map(|m| m.len())
            .unwrap_or(0)
    };

    // Disk-space precheck over remaining bytes plus verification margin.
    let remaining: u64 = bundle
        .files
        .iter()
        .filter(|f| !is_final(&f.name, f.size))
        .map(|f| f.size.saturating_sub(partial_len(&f.name)))
        .sum();
    if let Ok(free) = models::free_space_bytes(&root) {
        if free < remaining.saturating_add(DISK_MARGIN_BYTES) {
            let need = format!(
                "{:.1} GB more space needed ({:.1} GB free at {})",
                (remaining + DISK_MARGIN_BYTES - free) as f64 / 1e9,
                free as f64 / 1e9,
                root.display()
            );
            return Err(fail(
                app,
                status,
                bundle_id,
                &need,
                0,
                file_count,
                0,
                total_total,
            ));
        }
    }

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("network client: {e}"))?;

    for file in &bundle.files {
        if !is_final(&file.name, file.size) {
            continue;
        }
        let path = leaf.join(&file.name);
        let actual = models::hash_file(&path)?;
        match verify_hash_with_fallback(&client, cat, &bundle, file, &actual) {
            Ok(true) => {
                eprintln!(
                    "[studio] catalog hash for {} was stale; pinned upstream SHA-256 confirmed the existing file",
                    file.name
                );
                replace_effective_hash(&mut effective_catalog, bundle_id, &file.name, &actual);
            }
            Ok(false) => {}
            Err(message) => {
                return Err(fail(
                    app,
                    status,
                    bundle_id,
                    &message,
                    0,
                    file_count,
                    0,
                    total_total,
                ));
            }
        }
    }

    let mut total_done: u64 = bundle
        .files
        .iter()
        .filter(|f| is_final(&f.name, f.size))
        .map(|f| f.size)
        .sum();

    set_state(status, "downloading", None);
    for (index, file) in bundle.files.iter().enumerate() {
        if is_final(&file.name, file.size) {
            continue; // completed earlier; full hash pass runs at the end
        }
        let partial = dl_dir.join(format!("{}.partial", file.name));
        let mut attempts: u32 = 0;

        // A previous process may have finished receiving the file but stopped
        // before hashing and committing it. Verify that complete partial
        // locally instead of issuing an invalid bytes=<size>- range request.
        if partial.metadata().map(|m| m.len()).unwrap_or(0) == file.size {
            match models::hash_file(&partial) {
                Ok(hash) => match verify_hash_with_fallback(&client, cat, &bundle, file, &hash) {
                    Ok(used_fallback) => {
                        if used_fallback {
                            eprintln!(
                                "[studio] catalog hash for {} was stale; pinned upstream SHA-256 confirmed the partial file",
                                file.name
                            );
                            replace_effective_hash(
                                &mut effective_catalog,
                                bundle_id,
                                &file.name,
                                &hash,
                            );
                        }
                        let target = leaf.join(&file.name);
                        if target.exists() {
                            std::fs::remove_file(&target)
                                .map_err(|e| format!("replace {}: {e}", target.display()))?;
                        }
                        std::fs::rename(&partial, &target)
                            .map_err(|e| format!("commit {}: {e}", target.display()))?;
                        total_done += file.size;
                        continue;
                    }
                    Err(message) => {
                        return Err(fail(
                            app,
                            status,
                            bundle_id,
                            &message,
                            index,
                            file_count,
                            total_done + file.size,
                            total_total,
                        ));
                    }
                },
                Err(error) => {
                    return Err(fail(
                        app,
                        status,
                        bundle_id,
                        &error,
                        index,
                        file_count,
                        total_done,
                        total_total,
                    ));
                }
            }
        }

        loop {
            if cancel.load(Ordering::Acquire) {
                remove_partials(&dl_dir);
                set_state(status, "cancelled", None);
                emit_progress(
                    app,
                    &progress_payload(
                        bundle_id,
                        "cancelled",
                        None,
                        index,
                        file_count,
                        0,
                        file.size,
                        total_done + partial_len(&file.name),
                        total_total,
                        0,
                    ),
                );
                return Ok(());
            }
            if pause.load(Ordering::Acquire) {
                persist_resume_marker(&dl_dir, bundle_id);
                set_state(status, "paused", None);
                emit_progress(
                    app,
                    &progress_payload(
                        bundle_id,
                        "paused",
                        None,
                        index,
                        file_count,
                        partial_len(&file.name),
                        file.size,
                        total_done + partial_len(&file.name),
                        total_total,
                        0,
                    ),
                );
                return Ok(());
            }

            attempts += 1;
            let start_len = partial.metadata().map(|m| m.len()).unwrap_or(0);
            let url = cat.file_url(&bundle, file);

            let mut request = client.get(&url);
            if start_len > 0 {
                request = request.header("Range", format!("bytes={start_len}-"));
            }
            let mut response = match request.send() {
                Ok(r) => r,
                Err(e) => {
                    let msg = format!("network error: {e}");
                    if retryable(attempts) {
                        backoff(attempts);
                        continue;
                    }
                    return Err(fail(
                        app,
                        status,
                        bundle_id,
                        &msg,
                        index,
                        file_count,
                        total_done + start_len,
                        total_total,
                    ));
                }
            };

            let append = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
            if append {
                let expected_prefix = format!("bytes {start_len}-");
                let expected_suffix = format!("/{}", file.size);
                let valid_range = response
                    .headers()
                    .get("content-range")
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.starts_with(&expected_prefix) && v.ends_with(&expected_suffix))
                    .unwrap_or(false);
                if !valid_range {
                    return Err(fail(
                        app,
                        status,
                        bundle_id,
                        "server returned an invalid resume range",
                        index,
                        file_count,
                        total_done + start_len,
                        total_total,
                    ));
                }
            }
            if !append && response.status() != reqwest::StatusCode::OK {
                let msg = format!("server returned {}", response.status());
                if retryable(attempts) {
                    backoff(attempts);
                    continue;
                }
                return Err(fail(
                    app,
                    status,
                    bundle_id,
                    &msg,
                    index,
                    file_count,
                    total_done + start_len,
                    total_total,
                ));
            }
            // If the server ignored Range and sent everything, truncate instead
            // of appending a complete copy onto the partial data.
            let mut sink = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .append(append)
                .truncate(!append)
                .open(&partial)
                .map_err(|e| format!("open {}: {e}", partial.display()))?;

            let expected_end = if append {
                file.size
            } else {
                response.content_length().unwrap_or(file.size)
            };
            let mut received: u64 = 0;
            let started = std::time::Instant::now();
            let mut last_emit = started;
            let mut speed: u64 = 0;
            let mut last_received: u64 = 0;
            let mut stream_error: Option<String> = None;

            let mut buf = [0u8; 64 * 1024];
            loop {
                if stop_requested(cancel, pause) {
                    break;
                }
                use std::io::Read;
                match response.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if start_len.saturating_add(received).saturating_add(n as u64) > file.size {
                            stream_error =
                                Some("server sent more data than the catalogued file size".into());
                            break;
                        }
                        if let Err(e) = sink.write_all(&buf[..n]) {
                            stream_error = Some(if is_disk_full(&e) {
                                "the disk is full; free space or pick another location to continue"
                                    .into()
                            } else {
                                format!("write failed: {e}")
                            });
                            break;
                        }
                        received += n as u64;
                        if last_emit.elapsed() >= std::time::Duration::from_millis(250) {
                            let dt = last_emit.elapsed().as_secs_f64();
                            if dt > 0.05 {
                                speed = ((received - last_received) as f64 / dt) as u64;
                                last_received = received;
                            }
                            last_emit = std::time::Instant::now();
                            let done = total_done + start_len + received;
                            emit_progress(
                                app,
                                &progress_payload(
                                    bundle_id,
                                    "downloading",
                                    Some(&file.name),
                                    index,
                                    file_count,
                                    start_len + received,
                                    expected_end,
                                    done,
                                    total_total,
                                    speed,
                                ),
                            );
                        }
                    }
                    Err(e) => {
                        stream_error = Some(format!("connection interrupted: {e}"));
                        break;
                    }
                }
            }
            let _ = sink.flush();
            sink.sync_all().ok();

            // Disk full preserves the partial without spending retries.
            if let Some(msg) = stream_error.as_ref().filter(|m| m.contains("disk is full")) {
                return Err(fail(
                    app,
                    status,
                    bundle_id,
                    msg,
                    index,
                    file_count,
                    total_done + start_len + received,
                    total_total,
                ));
            }
            if stop_requested(cancel, pause) {
                persist_resume_marker(&dl_dir, bundle_id);
                let cancelled = cancel.load(Ordering::Acquire);
                let state = if cancelled {
                    remove_partials(&dl_dir);
                    set_state(status, "cancelled", None);
                    "cancelled"
                } else {
                    set_state(status, "paused", None);
                    "paused"
                };
                emit_progress(
                    app,
                    &progress_payload(
                        bundle_id,
                        state,
                        None,
                        index,
                        file_count,
                        start_len + received,
                        expected_end,
                        total_done + start_len,
                        total_total,
                        0,
                    ),
                );
                return Ok(());
            }
            if let Some(err) = stream_error {
                if retryable(attempts) {
                    backoff(attempts);
                    continue;
                }
                return Err(fail(
                    app,
                    status,
                    bundle_id,
                    &err,
                    index,
                    file_count,
                    total_done + start_len + received,
                    total_total,
                ));
            }

            // Completed transfer: validate byte count then content hash.
            let actual_len = partial.metadata().map(|m| m.len()).unwrap_or(0);
            if actual_len != file.size {
                let msg = format!("incomplete transfer: {} of {} bytes", actual_len, file.size);
                if retryable(attempts) {
                    backoff(attempts);
                    continue;
                }
                return Err(fail(
                    app,
                    status,
                    bundle_id,
                    &msg,
                    index,
                    file_count,
                    total_done + start_len + received,
                    total_total,
                ));
            }
            match models::hash_file(&partial) {
                Ok(hash) => match verify_hash_with_fallback(&client, cat, &bundle, file, &hash) {
                    Ok(true) => {
                        eprintln!(
                            "[studio] catalog hash for {} was stale; pinned upstream SHA-256 confirmed the downloaded file",
                            file.name
                        );
                        replace_effective_hash(
                            &mut effective_catalog,
                            bundle_id,
                            &file.name,
                            &hash,
                        );
                    }
                    Ok(false) => {}
                    Err(message) => {
                        return Err(fail(
                            app,
                            status,
                            bundle_id,
                            &message,
                            index,
                            file_count,
                            total_done + start_len + received,
                            total_total,
                        ));
                    }
                },
                Err(e) => {
                    return Err(fail(
                        app,
                        status,
                        bundle_id,
                        &e,
                        index,
                        file_count,
                        total_done + start_len + received,
                        total_total,
                    ));
                }
            }
            let target = leaf.join(&file.name);
            if target.exists() {
                std::fs::remove_file(&target)
                    .map_err(|e| format!("replace {}: {e}", target.display()))?;
            }
            std::fs::rename(&partial, &target)
                .map_err(|e| format!("commit {}: {e}", target.display()))?;
            total_done += file.size;
            break;
        }
    }

    set_state(status, "verifying", None);
    emit_progress(
        app,
        &progress_payload(
            bundle_id,
            "verifying",
            None,
            file_count,
            file_count,
            total_total,
            total_total,
            total_total,
            total_total,
            0,
        ),
    );
    if let Err(e) = models::verify_and_register_with_catalog(&root, bundle_id, &effective_catalog) {
        return Err(fail(
            app,
            status,
            bundle_id,
            &e,
            file_count,
            file_count,
            total_done,
            total_total,
        ));
    }
    remove_partials(&dl_dir);
    set_state(status, "ready", None);
    emit_progress(
        app,
        &progress_payload(
            bundle_id,
            "ready",
            None,
            file_count,
            file_count,
            total_total,
            total_total,
            total_total,
            total_total,
            0,
        ),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sha256_from_tree_metadata;

    const SHA256: &str = "10c5dd4dcac904cf81c9a16180eb66f167dd52ab55867f54a44567b0b2babbc1";

    #[test]
    fn pinned_tree_metadata_returns_the_lfs_sha256() {
        let body = format!(
            r#"[{{"path":"q8/birefnet.gguf","size":882749024,"xetHash":"not-a-sha256","lfs":{{"oid":"{SHA256}","size":882749024}}}}]"#
        );
        assert_eq!(
            sha256_from_tree_metadata(&body, "q8/birefnet.gguf", 882_749_024).unwrap(),
            SHA256
        );
    }

    #[test]
    fn pinned_tree_metadata_rejects_missing_lfs_or_wrong_sizes() {
        let no_lfs = r#"[{"path":"q8/birefnet.gguf","size":882749024}]"#;
        assert!(sha256_from_tree_metadata(no_lfs, "q8/birefnet.gguf", 882_749_024).is_err());

        let wrong_size = format!(
            r#"[{{"path":"q8/birefnet.gguf","size":1,"lfs":{{"oid":"{SHA256}","size":1}}}}]"#
        );
        assert!(sha256_from_tree_metadata(&wrong_size, "q8/birefnet.gguf", 882_749_024).is_err());
    }
}

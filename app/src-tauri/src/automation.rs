use reqwest::blocking::Client;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Cursor, Read};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::config::{self, Config};

const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;
static JOB_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInfo {
    pub running: bool,
    pub url: String,
    pub port: u16,
    pub max_concurrency: u8,
    pub policy: String,
    pub gpu_name: String,
    pub vram_total_mb: u64,
    pub vram_free_mb: u64,
    pub reason: String,
}

impl Default for AutomationInfo {
    fn default() -> Self {
        Self {
            running: false,
            url: String::new(),
            port: 0,
            max_concurrency: 1,
            policy: "safe-serial".to_string(),
            gpu_name: "not detected".to_string(),
            vram_total_mb: 0,
            vram_free_mb: 0,
            reason: "Automation service has not started".to_string(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JobView {
    id: String,
    status: JobStatus,
    submitted_at: u64,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    output_path: Option<String>,
    error: Option<String>,
}

struct Job {
    id: String,
    status: JobStatus,
    submitted_at: u64,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    content_type: String,
    body: Vec<u8>,
    output_path: Option<String>,
    error: Option<String>,
}

impl Job {
    fn view(&self) -> JobView {
        JobView {
            id: self.id.clone(),
            status: self.status,
            submitted_at: self.submitted_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
            output_path: self.output_path.clone(),
            error: self.error.clone(),
        }
    }
}

#[derive(Default)]
struct QueueData {
    jobs: HashMap<String, Job>,
    pending: VecDeque<String>,
}

#[derive(Default)]
struct JobQueue {
    data: Mutex<QueueData>,
    changed: Condvar,
}

struct Control {
    stop: Arc<AtomicBool>,
    server: Arc<Server>,
    queue: Arc<JobQueue>,
}

#[derive(Default)]
pub struct AutomationState {
    control: Mutex<Option<Control>>,
    info: Mutex<AutomationInfo>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn next_job_id() -> String {
    format!(
        "job-{}-{}",
        now_ms(),
        JOB_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid static HTTP header")
}

fn json_response(status: u16, body: String) -> Response<Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
        .with_header(header("Access-Control-Allow-Origin", "*"))
}

fn error_response(status: u16, message: &str) -> Response<Cursor<Vec<u8>>> {
    json_response(status, serde_json::json!({ "error": message }).to_string())
}

fn gpu_capability(cfg: &Config, api_port: u16) -> AutomationInfo {
    let mut info = AutomationInfo {
        running: true,
        url: format!("http://127.0.0.1:{api_port}"),
        port: api_port,
        max_concurrency: 1,
        policy: "safe-serial".to_string(),
        gpu_name: format!("GPU {}", cfg.gpu),
        vram_total_mb: 0,
        vram_free_mb: 0,
        reason: "Parallel generation is disabled because the native TRELLIS server serializes GPU access"
            .to_string(),
    };

    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=index,name,memory.total,memory.free",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Ok(output) = cmd.output() {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let fields: Vec<&str> = line.split(',').map(str::trim).collect();
            if fields.len() >= 4 && fields[0].parse::<i32>().ok() == Some(cfg.gpu) {
                info.gpu_name = fields[1].to_string();
                info.vram_total_mb = fields[2].parse().unwrap_or(0);
                info.vram_free_mb = fields[3].parse().unwrap_or(0);
                info.reason = format!(
                    "Parallel generation is locked: {} has {} MB VRAM and the native pipeline permits one GPU job at a time",
                    info.gpu_name, info.vram_total_mb
                );
                break;
            }
        }
    }
    info
}

fn queue_counts(queue: &JobQueue) -> (usize, usize, usize) {
    let data = queue.data.lock().unwrap();
    let queued = data
        .jobs
        .values()
        .filter(|j| j.status == JobStatus::Queued)
        .count();
    let running = data
        .jobs
        .values()
        .filter(|j| j.status == JobStatus::Running)
        .count();
    (queued, running, data.jobs.len())
}

fn submit_job(mut request: Request, queue: &Arc<JobQueue>, base_url: &str) {
    let content_type = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Content-Type"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();
    if !content_type.starts_with("multipart/form-data") {
        let _ = request.respond(error_response(
            415,
            "POST /jobs expects the same multipart/form-data fields as POST /generate",
        ));
        return;
    }
    if request.body_length().unwrap_or(0) > MAX_REQUEST_BYTES {
        let _ = request.respond(error_response(413, "request exceeds the 64 MB limit"));
        return;
    }

    let mut body = Vec::new();
    if request
        .as_reader()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .is_err()
    {
        let _ = request.respond(error_response(400, "could not read request body"));
        return;
    }
    if body.is_empty() || body.len() > MAX_REQUEST_BYTES {
        let _ = request.respond(error_response(413, "invalid or oversized request body"));
        return;
    }

    let id = next_job_id();
    let job = Job {
        id: id.clone(),
        status: JobStatus::Queued,
        submitted_at: now_ms(),
        started_at: None,
        finished_at: None,
        content_type,
        body,
        output_path: None,
        error: None,
    };
    {
        let mut data = queue.data.lock().unwrap();
        data.pending.push_back(id.clone());
        data.jobs.insert(id.clone(), job);
    }
    queue.changed.notify_one();
    let body = serde_json::json!({
        "id": id,
        "status": "queued",
        "statusUrl": format!("{base_url}/jobs/{id}"),
        "modelUrl": format!("{base_url}/jobs/{id}/model")
    });
    let _ = request.respond(json_response(202, body.to_string()));
}

fn list_jobs(request: Request, queue: &JobQueue) {
    let mut jobs: Vec<JobView> = queue
        .data
        .lock()
        .unwrap()
        .jobs
        .values()
        .map(Job::view)
        .collect();
    jobs.sort_by_key(|j| std::cmp::Reverse(j.submitted_at));
    let _ = request.respond(json_response(
        200,
        serde_json::json!({ "jobs": jobs }).to_string(),
    ));
}

fn get_job(request: Request, queue: &JobQueue, id: &str) {
    let data = queue.data.lock().unwrap();
    match data.jobs.get(id) {
        Some(job) => {
            let _ = request.respond(json_response(
                200,
                serde_json::to_string(&job.view()).unwrap(),
            ));
        }
        None => {
            let _ = request.respond(error_response(404, "job not found"));
        }
    }
}

fn get_model(request: Request, queue: &JobQueue, id: &str) {
    let result = {
        let data = queue.data.lock().unwrap();
        data.jobs.get(id).map(|job| {
            (
                job.status,
                job.output_path.clone(),
                job.error.clone().unwrap_or_default(),
            )
        })
    };
    match result {
        None => {
            let _ = request.respond(error_response(404, "job not found"));
        }
        Some((JobStatus::Succeeded, Some(path), _)) => match std::fs::read(path) {
            Ok(bytes) => {
                let response = Response::from_data(bytes)
                    .with_header(header("Content-Type", "model/gltf-binary"))
                    .with_header(header(
                        "Content-Disposition",
                        &format!("attachment; filename=\"{id}.glb\""),
                    ))
                    .with_header(header("Access-Control-Allow-Origin", "*"));
                let _ = request.respond(response);
            }
            Err(_) => {
                let _ = request.respond(error_response(410, "saved model is no longer available"));
            }
        },
        Some((JobStatus::Failed, _, error)) => {
            let _ = request.respond(error_response(409, &format!("job failed: {error}")));
        }
        Some(_) => {
            let _ = request.respond(error_response(409, "model is not ready"));
        }
    }
}

fn cancel_job(request: Request, queue: &JobQueue, id: &str) {
    let mut data = queue.data.lock().unwrap();
    match data.jobs.get_mut(id) {
        None => {
            let _ = request.respond(error_response(404, "job not found"));
        }
        Some(job) if job.status == JobStatus::Queued => {
            job.status = JobStatus::Cancelled;
            job.finished_at = Some(now_ms());
            let _ = request.respond(json_response(
                200,
                serde_json::to_string(&job.view()).unwrap(),
            ));
        }
        Some(job) if job.status == JobStatus::Running => {
            let _ = request.respond(error_response(
                409,
                "a running native GPU job cannot be interrupted safely",
            ));
        }
        Some(job) => {
            let _ = request.respond(json_response(
                200,
                serde_json::to_string(&job.view()).unwrap(),
            ));
        }
    }
}

fn handle_request(request: Request, queue: &Arc<JobQueue>, info: &AutomationInfo, base_url: &str) {
    let method = request.method().clone();
    let path = request.url().split('?').next().unwrap_or("/").to_string();
    if method == Method::Options {
        let response = Response::empty(StatusCode(204))
            .with_header(header("Access-Control-Allow-Origin", "*"))
            .with_header(header(
                "Access-Control-Allow-Methods",
                "GET, POST, DELETE, OPTIONS",
            ))
            .with_header(header("Access-Control-Allow-Headers", "Content-Type"));
        let _ = request.respond(response);
        return;
    }
    if method == Method::Get && path == "/health" {
        let _ = request.respond(json_response(200, "{\"status\":\"ok\"}".to_string()));
        return;
    }
    if method == Method::Get && (path == "/" || path == "/capabilities") {
        let (queued, running, total) = queue_counts(queue);
        let body = serde_json::json!({
            "service": "Trellis Studio Automation",
            "apiVersion": 1,
            "capabilities": info,
            "queue": { "queued": queued, "running": running, "total": total },
            "endpoints": ["POST /jobs", "GET /jobs", "GET /jobs/{id}", "GET /jobs/{id}/model", "DELETE /jobs/{id}"]
        });
        let _ = request.respond(json_response(200, body.to_string()));
        return;
    }
    if method == Method::Post && path == "/jobs" {
        submit_job(request, queue, base_url);
        return;
    }
    if method == Method::Get && path == "/jobs" {
        list_jobs(request, queue);
        return;
    }

    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    if parts.len() >= 2 && parts[0] == "jobs" {
        let id = parts[1];
        if method == Method::Get && parts.len() == 2 {
            get_job(request, queue, id);
            return;
        }
        if method == Method::Get && parts.len() == 3 && parts[2] == "model" {
            get_model(request, queue, id);
            return;
        }
        if method == Method::Delete && parts.len() == 2 {
            cancel_job(request, queue, id);
            return;
        }
    }
    let _ = request.respond(error_response(404, "endpoint not found"));
}

fn worker_loop(queue: Arc<JobQueue>, stop: Arc<AtomicBool>) {
    let client = match Client::builder()
        .timeout(Duration::from_secs(60 * 60))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    while !stop.load(Ordering::Relaxed) {
        let work = {
            let mut data = queue.data.lock().unwrap();
            while data.pending.is_empty() && !stop.load(Ordering::Relaxed) {
                data = queue.changed.wait(data).unwrap();
            }
            let Some(id) = data.pending.pop_front() else {
                continue;
            };
            let Some(job) = data.jobs.get_mut(&id) else {
                continue;
            };
            if job.status != JobStatus::Queued {
                continue;
            }
            job.status = JobStatus::Running;
            job.started_at = Some(now_ms());
            Some((id, job.content_type.clone(), job.body.clone()))
        };

        let Some((id, content_type, body)) = work else {
            continue;
        };
        let result = (|| -> Result<String, String> {
            let cfg = config::load().ok_or("Trellis server configuration is unavailable")?;
            let url = format!("http://{}:{}/generate", cfg.host, cfg.port);
            let response = client
                .post(url)
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .body(body)
                .send()
                .map_err(|e| format!("could not reach the Trellis server: {e}"))?;
            let status = response.status();
            if !status.is_success() {
                let detail = response.text().unwrap_or_default();
                return Err(format!("Trellis server returned {status}: {detail}"));
            }
            let bytes = response
                .bytes()
                .map_err(|e| format!("could not read the generated model: {e}"))?;
            if bytes.is_empty() {
                return Err("Trellis server returned an empty model".to_string());
            }
            let output = config::resolve_output_dir()?.join(format!("automation_{id}.glb"));
            std::fs::write(&output, &bytes)
                .map_err(|e| format!("could not save generated model: {e}"))?;
            Ok(output.to_string_lossy().into_owned())
        })();

        let mut data = queue.data.lock().unwrap();
        if let Some(job) = data.jobs.get_mut(&id) {
            job.body.clear();
            job.finished_at = Some(now_ms());
            match result {
                Ok(path) => {
                    job.status = JobStatus::Succeeded;
                    job.output_path = Some(path);
                }
                Err(error) => {
                    job.status = JobStatus::Failed;
                    job.error = Some(error);
                }
            }
        }
    }
}

pub fn start(cfg: &Config, state: &AutomationState) -> Result<AutomationInfo, String> {
    stop(state);
    let api_port = cfg.port.checked_add(1).ok_or("server port is too high")?;
    let addr = format!("127.0.0.1:{api_port}");
    let server = Arc::new(Server::http(&addr).map_err(|e| format!("automation API: {e}"))?);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let queue = Arc::new(JobQueue::default());
    let info = gpu_capability(cfg, api_port);
    let base_url = info.url.clone();

    let http_server = server.clone();
    let http_queue = queue.clone();
    let http_stop = stop_flag.clone();
    let http_info = info.clone();
    std::thread::spawn(move || {
        while !http_stop.load(Ordering::Relaxed) {
            match http_server.recv_timeout(Duration::from_millis(500)) {
                Ok(Some(request)) => handle_request(request, &http_queue, &http_info, &base_url),
                Ok(None) => {}
                Err(_) if http_stop.load(Ordering::Relaxed) => break,
                Err(_) => {}
            }
        }
    });

    let worker_queue = queue.clone();
    let worker_stop = stop_flag.clone();
    std::thread::spawn(move || worker_loop(worker_queue, worker_stop));

    *state.info.lock().unwrap() = info.clone();
    *state.control.lock().unwrap() = Some(Control {
        stop: stop_flag,
        server,
        queue,
    });
    Ok(info)
}

pub fn stop(state: &AutomationState) {
    if let Some(control) = state.control.lock().unwrap().take() {
        control.stop.store(true, Ordering::Relaxed);
        control.queue.changed.notify_all();
        control.server.unblock();
    }
    state.info.lock().unwrap().running = false;
}

pub fn info(state: &AutomationState) -> AutomationInfo {
    state.info.lock().unwrap().clone()
}

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
const PLANE_COLLAPSE_RATIO: f64 = 0.05;
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobParams {
    seed: u64,
    resolution: u16,
    bg_removal: String,
    uv: String,
}

impl Default for JobParams {
    fn default() -> Self {
        Self {
            seed: 42,
            resolution: 512,
            bg_removal: "auto".to_string(),
            uv: "xatlas".to_string(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelDimensions {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QualityWarning {
    code: String,
    message: String,
    thin_ratio: f64,
    threshold: f64,
    dimensions: ModelDimensions,
}

/// Canonical progress for one job, stored by the queue that owns it. Percent
/// comes from the native server's sampler iterations; `None` means the backend
/// could not measure progress and the UI must show an indeterminate bar.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobProgressView {
    stage_id: Option<String>,
    stage_label: Option<String>,
    completed_steps: Option<u64>,
    total_steps: Option<u64>,
    percent: Option<f64>,
    eta_seconds: Option<f64>,
    updated_at: Option<u64>,
}

fn parse_progress_view(value: &serde_json::Value) -> Option<JobProgressView> {
    let object = value.as_object()?;
    let positive =
        |key: &str| -> Option<f64> { object.get(key)?.as_f64().filter(|number| *number >= 0.0) };
    Some(JobProgressView {
        stage_id: object
            .get("stageId")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        stage_label: object
            .get("stageLabel")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        completed_steps: object
            .get("completedSteps")
            .and_then(serde_json::Value::as_u64),
        total_steps: object.get("totalSteps").and_then(serde_json::Value::as_u64),
        percent: positive("percent"),
        // Newer servers report the active-sampler ETA as `stageEtaSeconds`;
        // accept the older spelling as a fallback.
        eta_seconds: positive("stageEtaSeconds").or_else(|| positive("etaSeconds")),
        updated_at: object
            .get("updatedAt")
            .and_then(serde_json::Value::as_f64)
            .map(|seconds| seconds as u64),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JobView {
    id: String,
    status: JobStatus,
    status_url: String,
    model_url: String,
    image_url: String,
    submitted_at: u64,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    output_path: Option<String>,
    error: Option<String>,
    source_name: String,
    source_type: String,
    params: JobParams,
    queue_position: Option<usize>,
    jobs_ahead: usize,
    quality_warning: Option<QualityWarning>,
    progress: JobProgressView,
}

struct Job {
    id: String,
    status: JobStatus,
    submitted_at: u64,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    source_image: Vec<u8>,
    source_name: String,
    source_type: String,
    source_path: Option<String>,
    params: JobParams,
    output_path: Option<String>,
    error: Option<String>,
    quality_warning: Option<QualityWarning>,
    progress: JobProgressView,
}

impl Job {
    fn view(&self, base_url: &str, queue_position: Option<usize>, jobs_ahead: usize) -> JobView {
        let id = &self.id;
        JobView {
            id: id.clone(),
            status: self.status,
            status_url: format!("{base_url}/jobs/{id}"),
            model_url: format!("{base_url}/jobs/{id}/model"),
            image_url: format!("{base_url}/jobs/{id}/image"),
            submitted_at: self.submitted_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
            output_path: self.output_path.clone(),
            error: self.error.clone(),
            source_name: self.source_name.clone(),
            source_type: self.source_type.clone(),
            params: self.params.clone(),
            queue_position,
            jobs_ahead,
            quality_warning: self.quality_warning.clone(),
            progress: self.progress.clone(),
        }
    }
}

fn glb_json(bytes: &[u8]) -> Option<serde_json::Value> {
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" {
        return None;
    }
    let version = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    if version != 2 {
        return None;
    }
    let mut offset = 12usize;
    while offset.checked_add(8)? <= bytes.len() {
        let length = u32::from_le_bytes(bytes[offset..offset + 4].try_into().ok()?) as usize;
        let chunk_type = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?);
        let start = offset.checked_add(8)?;
        let end = start.checked_add(length)?;
        if end > bytes.len() {
            return None;
        }
        if chunk_type == 0x4e4f534a {
            let json = std::str::from_utf8(&bytes[start..end])
                .ok()?
                .trim_end_matches(['\0', ' ']);
            return serde_json::from_str(json).ok();
        }
        offset = end;
    }
    None
}

fn vector3(value: &serde_json::Value) -> Option<[f64; 3]> {
    let values = value.as_array()?;
    if values.len() < 3 {
        return None;
    }
    Some([
        values[0].as_f64()?,
        values[1].as_f64()?,
        values[2].as_f64()?,
    ])
}

fn inspect_glb_quality(bytes: &[u8]) -> Option<QualityWarning> {
    let json = glb_json(bytes)?;
    let meshes = json.get("meshes")?.as_array()?;
    let accessors = json.get("accessors")?.as_array()?;
    let mut lower = [f64::INFINITY; 3];
    let mut upper = [f64::NEG_INFINITY; 3];
    let mut found = false;

    for mesh in meshes {
        let Some(primitives) = mesh.get("primitives").and_then(|value| value.as_array()) else {
            continue;
        };
        for primitive in primitives {
            let Some(index) = primitive
                .get("attributes")
                .and_then(|value| value.get("POSITION"))
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok())
            else {
                continue;
            };
            let Some(accessor) = accessors.get(index) else {
                continue;
            };
            let (Some(min), Some(max)) = (
                accessor.get("min").and_then(vector3),
                accessor.get("max").and_then(vector3),
            ) else {
                continue;
            };
            found = true;
            for axis in 0..3 {
                lower[axis] = lower[axis].min(min[axis]);
                upper[axis] = upper[axis].max(max[axis]);
            }
        }
    }
    if !found {
        return None;
    }
    let dimensions = ModelDimensions {
        x: upper[0] - lower[0],
        y: upper[1] - lower[1],
        z: upper[2] - lower[2],
    };
    let axes = [dimensions.x, dimensions.y, dimensions.z];
    let largest = axes.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let thinnest = axes.iter().copied().fold(f64::INFINITY, f64::min);
    if !largest.is_finite() || largest <= f64::EPSILON || thinnest < 0.0 {
        return None;
    }
    let thin_ratio = thinnest / largest;
    if thin_ratio >= PLANE_COLLAPSE_RATIO {
        return None;
    }
    Some(QualityWarning {
        code: "collapsed-plane".to_string(),
        message: "Collapsed into a plane".to_string(),
        thin_ratio,
        threshold: PLANE_COLLAPSE_RATIO,
        dimensions,
    })
}

struct MultipartInput {
    image: Vec<u8>,
    source_name: String,
    source_type: String,
    params: JobParams,
}

fn push_multipart_part(
    body: &mut Vec<u8>,
    boundary: &str,
    name: &str,
    filename: Option<&str>,
    content_type: Option<&str>,
    value: &str,
) {
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    match filename {
        Some(filename) => body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n")
                .as_bytes(),
        ),
        None => body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n").as_bytes(),
        ),
    }
    if let Some(content_type) = content_type {
        body.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
    }
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(value.as_bytes());
    body.extend_from_slice(b"\r\n");
}

/// Rebuild the /generate request for a queued job. The queue's stable job id
/// doubles as the native server's progress `request_id`, so any client polling
/// either side sees the same lifecycle.
fn build_generate_body(
    job_id: &str,
    source_image: &[u8],
    raw_source_name: &str,
    source_type: &str,
    params: &JobParams,
) -> (String, Vec<u8>) {
    // Re-sanitize even though admission already did: this string lands inside
    // a Content-Disposition header, so quotes or CR/LF here could corrupt the
    // rebuilt request.
    let source_name = sanitize_source_name(raw_source_name);
    let boundary = format!("trellis-job-{job_id}");
    let mut body = Vec::new();
    // The image part carries binary bytes verbatim, so it is written directly.
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"image\"; filename=\"{source_name}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {source_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(source_image);
    body.extend_from_slice(b"\r\n");
    push_multipart_part(
        &mut body,
        &boundary,
        "seed",
        None,
        None,
        &params.seed.to_string(),
    );
    push_multipart_part(
        &mut body,
        &boundary,
        "resolution",
        None,
        None,
        &params.resolution.to_string(),
    );
    push_multipart_part(
        &mut body,
        &boundary,
        "bg_removal",
        None,
        None,
        &params.bg_removal,
    );
    push_multipart_part(&mut body, &boundary, "uv", None, None, &params.uv);
    push_multipart_part(&mut body, &boundary, "request_id", None, None, job_id);
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

#[derive(Default)]
struct QueueData {
    jobs: HashMap<String, Job>,
    pending: VecDeque<String>,
}

struct AdmissionState {
    accepting: bool,
}

impl Default for AdmissionState {
    fn default() -> Self {
        Self { accepting: true }
    }
}

#[derive(Default)]
struct JobQueue {
    data: Mutex<QueueData>,
    changed: Condvar,
    admission: Mutex<AdmissionState>,
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
    maintenance: AtomicBool,
}

/// `start` first tears down the previous control. If binding the replacement
/// API then fails, the old queue must stay gone while maintenance becomes
/// retryable instead of remaining latched forever.
struct StartRecovery<'a> {
    state: &'a AutomationState,
    armed: bool,
}

impl<'a> StartRecovery<'a> {
    fn new(state: &'a AutomationState) -> Self {
        Self { state, armed: true }
    }

    fn complete(&mut self) {
        self.armed = false;
    }
}

impl Drop for StartRecovery<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.state.maintenance.store(false, Ordering::Release);
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Progress timestamps share the native server's unit: whole epoch seconds.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
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

fn allowed_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let origin = origin.trim();
    let (authority, is_tauri_scheme) = if let Some(authority) = origin.strip_prefix("tauri://") {
        (authority, true)
    } else if let Some(authority) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    {
        (authority, false)
    } else {
        return false;
    };
    if authority.is_empty() || authority.contains('/') || authority.contains('@') {
        return false;
    }

    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return false;
        };
        let host = &rest[..end];
        let suffix = &rest[end + 1..];
        let port = if suffix.is_empty() {
            true
        } else {
            suffix
                .strip_prefix(':')
                .map(|value| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()))
                .unwrap_or(false)
        };
        (host, port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        (
            host,
            !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()),
        )
    } else {
        (authority, true)
    };

    port && if is_tauri_scheme {
        host.eq_ignore_ascii_case("localhost") || host.eq_ignore_ascii_case("tauri.localhost")
    } else {
        matches!(
            host.to_ascii_lowercase().as_str(),
            "localhost" | "127.0.0.1" | "::1" | "tauri.localhost"
        )
    }
}

fn request_origins_allowed(request: &Request) -> bool {
    request
        .headers()
        .iter()
        .filter(|header| header.field.equiv("Origin"))
        .all(|header| allowed_origin(Some(header.value.as_str())))
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QueueSnapshot {
    pub queued: usize,
    pub running: usize,
}

pub fn queue_snapshot(state: &AutomationState) -> QueueSnapshot {
    let guard = state.control.lock().unwrap();
    let Some(control) = guard.as_ref() else {
        return QueueSnapshot {
            queued: 0,
            running: 0,
        };
    };
    let (queued, running, _) = queue_counts(&control.queue);
    QueueSnapshot { queued, running }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaintenanceError {
    Busy(QueueSnapshot),
    AlreadyInProgress,
}

/// Atomically pause new submissions if the current queue is idle. The
/// admission lock is held while checking and changing the queue, so a POST
/// cannot slip in between the idle check and the pause.
pub fn quiesce_if_idle(state: &AutomationState) -> Result<(), MaintenanceError> {
    if state.maintenance.swap(true, Ordering::AcqRel) {
        return Err(MaintenanceError::AlreadyInProgress);
    }

    let result = {
        let guard = state.control.lock().unwrap();
        if let Some(control) = guard.as_ref() {
            let mut admission = control.queue.admission.lock().unwrap();
            let (queued, running, _) = queue_counts(&control.queue);
            if queued > 0 || running > 0 {
                Err(MaintenanceError::Busy(QueueSnapshot { queued, running }))
            } else {
                admission.accepting = false;
                Ok(())
            }
        } else {
            Ok(())
        }
    };

    if result.is_err() {
        state.maintenance.store(false, Ordering::Release);
    }
    result
}

/// Resume submissions after a failed restart, or after a new automation
/// control has been installed. This is deliberately idempotent.
pub fn resume(state: &AutomationState) {
    state.maintenance.store(false, Ordering::Release);
    let guard = state.control.lock().unwrap();
    if let Some(control) = guard.as_ref() {
        control.queue.admission.lock().unwrap().accepting = true;
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn quoted_header_value(headers: &str, key: &str) -> Option<String> {
    let disposition = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("Content-Disposition")
            .then_some(value)
    })?;
    disposition.split(';').find_map(|part| {
        let (name, value) = part.split_once('=')?;
        if !name.trim().eq_ignore_ascii_case(key) {
            return None;
        }
        Some(value.trim().trim_matches('"').to_string())
    })
}

fn sanitize_source_name(filename: &str) -> String {
    let candidate = filename.rsplit(['/', '\\']).next().unwrap_or_default();
    let safe: String = candidate
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .take(128)
        .collect();
    if safe.is_empty() {
        "automation-source.png".to_string()
    } else {
        safe
    }
}

fn parse_multipart(content_type: &str, body: &[u8]) -> Result<MultipartInput, String> {
    let boundary = content_type
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix("boundary="))
        .map(|value| value.trim_matches('"'))
        .filter(|value| !value.is_empty())
        .ok_or("multipart boundary is missing")?;
    let marker = format!("--{boundary}").into_bytes();
    let next_marker = format!("\r\n--{boundary}").into_bytes();
    let mut cursor = 0;
    let mut image = None;
    let mut source_name = "automation-source.png".to_string();
    let mut source_type = "image/png".to_string();
    let mut params = JobParams::default();

    while let Some(relative) = find_bytes(&body[cursor..], &marker) {
        let mut part_start = cursor + relative + marker.len();
        if body.get(part_start..part_start + 2) == Some(b"--") {
            break;
        }
        if body.get(part_start..part_start + 2) == Some(b"\r\n") {
            part_start += 2;
        }
        let Some(header_len) = find_bytes(&body[part_start..], b"\r\n\r\n") else {
            break;
        };
        let data_start = part_start + header_len + 4;
        let Some(data_len) = find_bytes(&body[data_start..], &next_marker) else {
            break;
        };
        let headers = String::from_utf8_lossy(&body[part_start..part_start + header_len]);
        let name = quoted_header_value(&headers, "name").unwrap_or_default();
        let value = &body[data_start..data_start + data_len];

        if name == "image" {
            image = Some(value.to_vec());
            if let Some(filename) = quoted_header_value(&headers, "filename") {
                source_name = sanitize_source_name(&filename);
            }
            if let Some(content_type) = headers.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.trim()
                    .eq_ignore_ascii_case("Content-Type")
                    .then_some(value.trim())
                    .filter(|value| value.to_ascii_lowercase().starts_with("image/"))
            }) {
                source_type = content_type.to_string();
            }
        } else if let Ok(text) = std::str::from_utf8(value) {
            match name.as_str() {
                "seed" => params.seed = text.trim().parse().unwrap_or(params.seed),
                "resolution" => {
                    params.resolution = text.trim().parse().unwrap_or(params.resolution)
                }
                "bg_removal" => params.bg_removal = text.trim().to_string(),
                "uv" => params.uv = text.trim().to_string(),
                _ => {}
            }
        }
        cursor = data_start + data_len + 2;
    }

    let image = image
        .filter(|bytes| !bytes.is_empty())
        .ok_or("image field is missing")?;
    Ok(MultipartInput {
        image,
        source_name,
        source_type,
        params,
    })
}

fn job_queue_position(data: &QueueData, id: &str) -> (Option<usize>, usize) {
    let Some(job) = data.jobs.get(id) else {
        return (None, 0);
    };
    if job.status == JobStatus::Running {
        return (Some(1), 0);
    }
    if job.status != JobStatus::Queued {
        return (None, 0);
    }
    let running = data
        .jobs
        .values()
        .filter(|candidate| candidate.status == JobStatus::Running)
        .count();
    let Some(pending_index) = data.pending.iter().position(|pending| pending == id) else {
        return (None, 0);
    };
    let pending_before = data
        .pending
        .iter()
        .take(pending_index)
        .filter(|pending| {
            data.jobs
                .get(*pending)
                .map(|candidate| candidate.status == JobStatus::Queued)
                .unwrap_or(false)
        })
        .count();
    let jobs_ahead = running + pending_before;
    (Some(jobs_ahead + 1), jobs_ahead)
}

fn remove_pending_job(data: &mut QueueData, id: &str) {
    data.pending.retain(|pending| pending != id);
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

    let multipart = match parse_multipart(&content_type, &body) {
        Ok(input) => input,
        Err(error) => {
            let _ = request.respond(error_response(
                400,
                &format!("invalid generation request: {error}"),
            ));
            return;
        }
    };

    let admission = queue.admission.lock().unwrap();
    if !admission.accepting {
        let _ = request.respond(error_response(
            503,
            "automation API is temporarily paused while Trellis Studio is restarting or quitting",
        ));
        return;
    }

    let id = next_job_id();
    let job = Job {
        id: id.clone(),
        status: JobStatus::Queued,
        submitted_at: now_ms(),
        started_at: None,
        finished_at: None,
        source_image: multipart.image,
        source_name: multipart.source_name,
        source_type: multipart.source_type,
        source_path: None,
        params: multipart.params,
        output_path: None,
        error: None,
        quality_warning: None,
        progress: JobProgressView::default(),
    };
    let (queue_position, jobs_ahead, queued, running) = {
        let mut data = queue.data.lock().unwrap();
        data.pending.push_back(id.clone());
        data.jobs.insert(id.clone(), job);
        let (queue_position, jobs_ahead) = job_queue_position(&data, &id);
        let queued = data
            .jobs
            .values()
            .filter(|candidate| candidate.status == JobStatus::Queued)
            .count();
        let running = data
            .jobs
            .values()
            .filter(|candidate| candidate.status == JobStatus::Running)
            .count();
        (queue_position, jobs_ahead, queued, running)
    };
    drop(admission);
    queue.changed.notify_one();
    let message = if jobs_ahead == 0 {
        "Job accepted and next to run".to_string()
    } else {
        format!(
            "Job queued with {jobs_ahead} job{} ahead",
            if jobs_ahead == 1 { "" } else { "s" }
        )
    };
    let body = serde_json::json!({
        "id": id,
        "status": "queued",
        "statusUrl": format!("{base_url}/jobs/{id}"),
        "modelUrl": format!("{base_url}/jobs/{id}/model"),
        "imageUrl": format!("{base_url}/jobs/{id}/image"),
        "queuePosition": queue_position,
        "jobsAhead": jobs_ahead,
        "queue": { "queued": queued, "running": running },
        "message": message
    });
    let _ = request.respond(json_response(202, body.to_string()));
}

fn list_jobs(request: Request, queue: &JobQueue, base_url: &str) {
    let data = queue.data.lock().unwrap();
    let mut jobs: Vec<JobView> = data
        .jobs
        .values()
        .map(|job| {
            let (position, ahead) = job_queue_position(&data, &job.id);
            job.view(base_url, position, ahead)
        })
        .collect();
    jobs.sort_by_key(|j| std::cmp::Reverse(j.submitted_at));
    let _ = request.respond(json_response(
        200,
        serde_json::json!({ "jobs": jobs }).to_string(),
    ));
}

fn get_job(request: Request, queue: &JobQueue, id: &str, base_url: &str) {
    let data = queue.data.lock().unwrap();
    match data.jobs.get(id) {
        Some(job) => {
            let (position, ahead) = job_queue_position(&data, id);
            let _ = request.respond(json_response(
                200,
                serde_json::to_string(&job.view(base_url, position, ahead)).unwrap(),
            ));
        }
        None => {
            let _ = request.respond(error_response(404, "job not found"));
        }
    }
}

fn get_image(request: Request, queue: &JobQueue, id: &str) {
    let result = {
        let data = queue.data.lock().unwrap();
        data.jobs.get(id).map(|job| {
            (
                job.status,
                job.source_path.clone(),
                job.source_type.clone(),
                job.source_name.clone(),
            )
        })
    };
    match result {
        None => {
            let _ = request.respond(error_response(404, "job not found"));
        }
        Some((JobStatus::Succeeded, Some(path), content_type, filename)) => {
            match std::fs::read(path) {
                Ok(bytes) => {
                    let response = Response::from_data(bytes)
                        .with_header(header("Content-Type", &content_type))
                        .with_header(header(
                            "Content-Disposition",
                            &format!("attachment; filename=\"{filename}\""),
                        ))
                        .with_header(header("Access-Control-Allow-Origin", "*"));
                    let _ = request.respond(response);
                }
                Err(_) => {
                    let _ =
                        request.respond(error_response(410, "source image is no longer available"));
                }
            }
        }
        Some(_) => {
            let _ = request.respond(error_response(409, "source image is not ready"));
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

fn cancel_job(request: Request, queue: &JobQueue, id: &str, base_url: &str) {
    let mut data = queue.data.lock().unwrap();
    let Some(status) = data.jobs.get(id).map(|job| job.status) else {
        let _ = request.respond(error_response(404, "job not found"));
        return;
    };

    if status == JobStatus::Queued {
        remove_pending_job(&mut data, id);
        if let Some(job) = data.jobs.get_mut(id) {
            job.status = JobStatus::Cancelled;
            job.finished_at = Some(now_ms());
            job.source_image.clear();
        }
        let (position, ahead) = job_queue_position(&data, id);
        let Some(job) = data.jobs.get(id) else {
            let _ = request.respond(error_response(404, "job not found"));
            return;
        };
        let body = serde_json::to_string(&job.view(base_url, position, ahead)).unwrap();
        let _ = request.respond(json_response(200, body));
        return;
    }

    if status == JobStatus::Running {
        let _ = request.respond(error_response(
            409,
            "a running native GPU job cannot be interrupted safely",
        ));
        return;
    }

    let (position, ahead) = job_queue_position(&data, id);
    let Some(job) = data.jobs.get(id) else {
        let _ = request.respond(error_response(404, "job not found"));
        return;
    };
    let body = serde_json::to_string(&job.view(base_url, position, ahead)).unwrap();
    let _ = request.respond(json_response(200, body));
}

fn handle_request(request: Request, queue: &Arc<JobQueue>, info: &AutomationInfo, base_url: &str) {
    if !request_origins_allowed(&request) {
        let _ = request.respond(error_response(
            403,
            "automation API only accepts loopback, Tauri, or same-machine development origins",
        ));
        return;
    }
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
            "endpoints": ["POST /jobs", "GET /jobs", "GET /jobs/{id}", "GET /jobs/{id}/model", "GET /jobs/{id}/image", "DELETE /jobs/{id}"]
        });
        let _ = request.respond(json_response(200, body.to_string()));
        return;
    }
    if method == Method::Post && path == "/jobs" {
        submit_job(request, queue, base_url);
        return;
    }
    if method == Method::Get && path == "/jobs" {
        list_jobs(request, queue, base_url);
        return;
    }

    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    if parts.len() >= 2 && parts[0] == "jobs" {
        let id = parts[1];
        if method == Method::Get && parts.len() == 2 {
            get_job(request, queue, id, base_url);
            return;
        }
        if method == Method::Get && parts.len() == 3 && parts[2] == "model" {
            get_model(request, queue, id);
            return;
        }
        if method == Method::Get && parts.len() == 3 && parts[2] == "image" {
            get_image(request, queue, id);
            return;
        }
        if method == Method::Delete && parts.len() == 2 {
            cancel_job(request, queue, id, base_url);
            return;
        }
    }
    let _ = request.respond(error_response(404, "endpoint not found"));
}

/// Polls the native server's progress endpoint for one running job and copies
/// snapshots into `Job.progress`. The blocking `/generate` request occupies the
/// worker thread, so polling runs on a scoped helper thread.
///
/// Conservative by design: 404s mean "not registered yet" (or an older native
/// server without the endpoint) and never fail generation; connection errors
/// back off; every queue lock is taken briefly and never around network I/O;
/// polling stops as soon as the job leaves Running or the process shuts down.
fn spawn_progress_watcher(queue: Arc<JobQueue>, client: Client, job_id: String) {
    std::thread::spawn(move || {
        let Some(cfg) = config::load() else {
            return;
        };
        let url = format!("http://{}:{}/progress/{}", cfg.host, cfg.port, job_id);
        let mut interval = Duration::from_millis(400);
        loop {
            std::thread::sleep(interval);
            let still_running = {
                let data = queue.data.lock().unwrap();
                data.jobs
                    .get(&job_id)
                    .map(|job| job.status == JobStatus::Running)
                    .unwrap_or(false)
            };
            if !still_running {
                return;
            }
            match client.get(&url).send() {
                Err(_) => {
                    // Back off after repeated connection failures; generation
                    // itself is unaffected and keeps its own long timeout.
                    interval = (interval * 2).min(Duration::from_millis(4_000));
                    continue;
                }
                Ok(response) => {
                    interval = Duration::from_millis(400);
                    if !response.status().is_success() {
                        continue; // includes 404: progress not registered yet
                    }
                    let Ok(text) = response.text() else {
                        continue;
                    };
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    let Some(view) = parse_progress_view(&value) else {
                        continue;
                    };
                    let mut data = queue.data.lock().unwrap();
                    if let Some(job) = data.jobs.get_mut(&job_id) {
                        if job.status == JobStatus::Running {
                            job.progress = view;
                        }
                    }
                }
            }
        }
    });
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
            Some((
                id,
                job.source_image.clone(),
                job.source_name.clone(),
                job.source_type.clone(),
                job.params.clone(),
            ))
        };

        let Some((id, source_image, source_name, source_type, params)) = work else {
            continue;
        };
        // The job id doubles as the native request_id, so /progress/{job_id}
        // and the automation status URL describe the same lifecycle.
        spawn_progress_watcher(queue.clone(), client.clone(), id.clone());
        let result = (|| -> Result<(String, String, Option<QualityWarning>), String> {
            let cfg = config::load().ok_or("Trellis server configuration is unavailable")?;
            let url = format!("http://{}:{}/generate", cfg.host, cfg.port);
            let (content_type, body) =
                build_generate_body(&id, &source_image, &source_name, &source_type, &params);
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
            let quality_warning = inspect_glb_quality(&bytes);
            let output = config::resolve_output_dir()?.join(format!("automation_{id}.glb"));
            std::fs::write(&output, &bytes)
                .map_err(|e| format!("could not save generated model: {e}"))?;
            let extension = std::path::Path::new(&source_name)
                .extension()
                .and_then(|value| value.to_str())
                .filter(|value| {
                    value.len() <= 8 && value.chars().all(|ch| ch.is_ascii_alphanumeric())
                })
                .unwrap_or("img");
            let source_path =
                config::resolve_output_dir()?.join(format!("automation_{id}_source.{extension}"));
            std::fs::write(&source_path, &source_image)
                .map_err(|e| format!("could not save automation source image: {e}"))?;
            Ok((
                output.to_string_lossy().into_owned(),
                source_path.to_string_lossy().into_owned(),
                quality_warning,
            ))
        })();

        let mut data = queue.data.lock().unwrap();
        if let Some(job) = data.jobs.get_mut(&id) {
            // Source bytes are no longer needed once the copy was persisted.
            job.source_image.clear();
            job.finished_at = Some(now_ms());
            match result {
                Ok((path, source_path, quality_warning)) => {
                    job.status = JobStatus::Succeeded;
                    job.output_path = Some(path);
                    job.source_path = Some(source_path);
                    job.quality_warning = quality_warning;
                    job.progress.percent = Some(100.0);
                    job.progress.stage_id = Some("complete".to_string());
                    job.progress.stage_label = Some("Model ready".to_string());
                    job.progress.updated_at = Some(now_secs());
                }
                Err(error) => {
                    job.status = JobStatus::Failed;
                    job.error = Some(error);
                    job.progress.updated_at = Some(now_secs());
                }
            }
        }
    }
}

pub fn start(cfg: &Config, state: &AutomationState) -> Result<AutomationInfo, String> {
    stop(state);
    let mut recovery = StartRecovery::new(state);
    let api_port = cfg.port.checked_add(1).ok_or("server port is too high")?;
    let addr = format!("127.0.0.1:{api_port}");
    let server = Arc::new(Server::http(&addr).map_err(|e| format!("automation API: {e}"))?);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let queue = Arc::new(JobQueue::default());
    queue.admission.lock().unwrap().accepting = !state.maintenance.load(Ordering::Acquire);
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
    let next_queue = queue.clone();
    *state.control.lock().unwrap() = Some(Control {
        stop: stop_flag,
        server,
        queue,
    });
    state.maintenance.store(false, Ordering::Release);
    next_queue.admission.lock().unwrap().accepting = true;
    recovery.complete();
    Ok(info)
}

pub fn stop(state: &AutomationState) {
    state.maintenance.store(true, Ordering::Release);
    if let Some(control) = state.control.lock().unwrap().take() {
        control.queue.admission.lock().unwrap().accepting = false;
        control.stop.store(true, Ordering::Relaxed);
        control.queue.changed.notify_all();
        control.server.unblock();
    }
    state.info.lock().unwrap().running = false;
}

pub fn info(state: &AutomationState) -> AutomationInfo {
    state.info.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn job(id: &str, status: JobStatus) -> Job {
        Job {
            id: id.to_string(),
            status,
            submitted_at: 0,
            started_at: None,
            finished_at: None,
            source_image: Vec::new(),
            source_name: "source.png".to_string(),
            source_type: "image/png".to_string(),
            source_path: None,
            params: JobParams::default(),
            output_path: None,
            error: None,
            quality_warning: None,
            progress: JobProgressView::default(),
        }
    }

    #[test]
    fn queued_job_reports_running_and_pending_jobs_ahead() {
        let mut data = QueueData::default();
        data.jobs
            .insert("running".to_string(), job("running", JobStatus::Running));
        data.jobs
            .insert("first".to_string(), job("first", JobStatus::Queued));
        data.jobs
            .insert("second".to_string(), job("second", JobStatus::Queued));
        data.pending
            .extend(["first".to_string(), "second".to_string()]);

        assert_eq!(job_queue_position(&data, "first"), (Some(2), 1));
        assert_eq!(job_queue_position(&data, "second"), (Some(3), 2));
        assert_eq!(job_queue_position(&data, "running"), (Some(1), 0));
    }

    #[test]
    fn finished_or_missing_jobs_have_no_queue_position() {
        let mut data = QueueData::default();
        data.jobs
            .insert("done".to_string(), job("done", JobStatus::Succeeded));

        assert_eq!(job_queue_position(&data, "done"), (None, 0));
        assert_eq!(job_queue_position(&data, "missing"), (None, 0));
    }

    #[test]
    fn job_view_exposes_stable_urls_and_queue_metadata() {
        let value = serde_json::to_value(job("abc", JobStatus::Queued).view(
            "http://127.0.0.1:8082",
            Some(3),
            2,
        ))
        .unwrap();

        assert_eq!(value["id"], "abc");
        assert_eq!(value["statusUrl"], "http://127.0.0.1:8082/jobs/abc");
        assert_eq!(value["modelUrl"], "http://127.0.0.1:8082/jobs/abc/model");
        assert_eq!(value["imageUrl"], "http://127.0.0.1:8082/jobs/abc/image");
        assert_eq!(value["queuePosition"], 3);
        assert_eq!(value["jobsAhead"], 2);
        assert!(value["qualityWarning"].is_null());
    }

    fn test_glb(dimensions: [f64; 3]) -> Vec<u8> {
        let mut json = serde_json::json!({
            "asset": { "version": "2.0" },
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 } }] }],
            "accessors": [{ "min": [0.0, 0.0, 0.0], "max": dimensions }]
        })
        .to_string()
        .into_bytes();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let total_length = 12 + 8 + json.len();
        let mut glb = Vec::with_capacity(total_length);
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&(total_length as u32).to_le_bytes());
        glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x4e4f534au32.to_le_bytes());
        glb.extend_from_slice(&json);
        glb
    }

    #[test]
    fn flags_a_generated_model_collapsed_into_a_plane() {
        let warning = inspect_glb_quality(&test_glb([1.0, 1.0, 0.004])).unwrap();
        assert_eq!(warning.code, "collapsed-plane");
        assert!((warning.thin_ratio - 0.004).abs() < f64::EPSILON);
        assert_eq!(warning.threshold, 0.05);
    }

    #[test]
    fn accepts_a_model_with_visible_volume() {
        assert!(inspect_glb_quality(&test_glb([1.0, 0.7, 0.2])).is_none());
    }

    #[test]
    fn multipart_parser_keeps_binary_image_and_all_generation_fields() {
        let boundary = "----trellis-test-boundary";
        let mut body = Vec::new();
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"C:\\\\tmp\\\\hero.png\"\r\nContent-Type: image/png\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(&[0, 1, 2, 255, 0]);
        body.extend_from_slice(
            format!(
                "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"seed\"\r\n\r\n123\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"resolution\"\r\n\r\n1024\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"bg_removal\"\r\n\r\nbirefnet\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"uv\"\r\n\r\nxatlas\r\n--{boundary}--\r\n"
            )
            .as_bytes(),
        );

        let parsed =
            parse_multipart(&format!("multipart/form-data; boundary={boundary}"), &body).unwrap();
        assert_eq!(parsed.image, vec![0, 1, 2, 255, 0]);
        assert_eq!(parsed.source_name, "hero.png");
        assert_eq!(parsed.source_type, "image/png");
        assert_eq!(parsed.params.seed, 123);
        assert_eq!(parsed.params.resolution, 1024);
        assert_eq!(parsed.params.bg_removal, "birefnet");
        assert_eq!(parsed.params.uv, "xatlas");
    }

    #[test]
    fn cancelled_job_is_removed_from_later_queue_positions() {
        let mut data = QueueData::default();
        data.jobs
            .insert("cancelled".to_string(), job("cancelled", JobStatus::Queued));
        data.jobs
            .insert("later".to_string(), job("later", JobStatus::Queued));
        data.pending
            .extend(["cancelled".to_string(), "later".to_string()]);

        remove_pending_job(&mut data, "cancelled");
        data.jobs.get_mut("cancelled").unwrap().status = JobStatus::Cancelled;

        assert_eq!(job_queue_position(&data, "later"), (Some(1), 0));
    }

    #[test]
    fn generate_body_round_trips_image_params_and_request_id_through_the_parser() {
        let params = JobParams {
            seed: 7,
            resolution: 1024,
            bg_removal: "birefnet".to_string(),
            uv: "box".to_string(),
        };
        // Binary bytes including multipart-hostile sequences (\r\n, dashes, NUL).
        let image: Vec<u8> = vec![0, 13, 10, 45, 45, 255, 0, 1, 2, 3];
        let (content_type, body) =
            build_generate_body("job-123", &image, "hero.png", "image/png", &params);

        assert!(content_type.starts_with("multipart/form-data; boundary="));
        let parsed = parse_multipart(&content_type, &body).unwrap();
        assert_eq!(parsed.image, image);
        assert_eq!(parsed.source_name, "hero.png");
        assert_eq!(parsed.source_type, "image/png");
        assert_eq!(parsed.params.seed, 7);
        assert_eq!(parsed.params.resolution, 1024);
        assert_eq!(parsed.params.bg_removal, "birefnet");
        assert_eq!(parsed.params.uv, "box");
    }

    #[test]
    fn generate_body_carries_the_automation_job_id_as_request_id() {
        let (content_type, body) = build_generate_body(
            "job-42",
            &[9, 9, 9],
            "source.png",
            "image/png",
            &JobParams::default(),
        );
        let text = String::from_utf8(body).unwrap();
        assert!(text.contains("name=\"request_id\"\r\n\r\njob-42\r\n"));
        let boundary = content_type
            .split("boundary=")
            .last()
            .expect("boundary present");
        assert!(
            text.ends_with(&format!("--{boundary}--\r\n")),
            "body must end with a closing boundary delimiter"
        );
    }

    #[test]
    fn generate_body_preserves_binary_image_bytes_exactly() {
        // Every byte value, including CR/LF and the boundary prefix sequence.
        let image: Vec<u8> = (0..=255u8).chain([13, 10, 45, 45]).collect();
        let (content_type, body) = build_generate_body(
            "job-bytes",
            &image,
            "raw.bin",
            "application/octet-stream",
            &JobParams::default(),
        );
        let parsed = parse_multipart(&content_type, &body).unwrap();
        assert_eq!(parsed.image, image);
    }

    #[test]
    fn generate_body_sanitizes_hostile_source_filenames() {
        let (_, body) = build_generate_body(
            "job-name",
            &[1],
            "..\\evil name.png",
            "image/png",
            &JobParams::default(),
        );
        let text = String::from_utf8(body).unwrap();
        assert!(text.contains("filename=\"evil_name.png\""));
        assert!(!text.contains("..\\evil"));
        let disposition_line = text
            .lines()
            .find(|line| line.starts_with("Content-Disposition"))
            .unwrap();
        assert!(!disposition_line.contains(".."));
    }

    #[test]
    fn progress_view_parses_native_snapshots_and_rejects_negative_percent() {
        let value: serde_json::Value = serde_json::from_str(
            r#"{
                "requestId": "req-1",
                "status": "running",
                "stageId": "shape_slat_hr",
                "stageLabel": "Refining",
                "completedSteps": 20,
                "totalSteps": 48,
                "percent": 41.7,
                "stageEtaSeconds": 120,
                "updatedAt": 123.5,
                "error": null
            }"#,
        )
        .unwrap();
        let view = parse_progress_view(&value).unwrap();
        assert_eq!(view.stage_id.as_deref(), Some("shape_slat_hr"));
        assert_eq!(view.completed_steps, Some(20));
        assert_eq!(view.total_steps, Some(48));
        assert!((view.percent.unwrap() - 41.7).abs() < 1e-9);
        // Canonical spelling: the active sampler's ETA in seconds.
        assert_eq!(view.eta_seconds, Some(120.0));
        // updatedAt stays in whole epoch seconds, matching the native server.
        assert_eq!(view.updated_at, Some(123));

        let indeterminate: serde_json::Value =
            serde_json::from_str(r#"{ "percent": -1, "stageEtaSeconds": -1 }"#).unwrap();
        let view = parse_progress_view(&indeterminate).unwrap();
        assert!(view.percent.is_none());
        assert!(view.eta_seconds.is_none());
        assert!(view.stage_id.is_none());
    }

    #[test]
    fn progress_view_accepts_the_legacy_eta_spelling_as_fallback() {
        let legacy: serde_json::Value =
            serde_json::from_str(r#"{ "etaSeconds": 90, "percent": 10 }"#).unwrap();
        let view = parse_progress_view(&legacy).unwrap();
        assert_eq!(view.eta_seconds, Some(90.0));
    }

    #[test]
    fn origin_policy_allows_local_clients_and_rejects_remote_origins() {
        for origin in [
            None,
            Some("http://localhost:5173"),
            Some("https://127.0.0.1:1420"),
            Some("http://tauri.localhost"),
            Some("tauri://localhost"),
            Some("http://[::1]:5173"),
        ] {
            assert!(
                allowed_origin(origin),
                "expected allowed origin: {origin:?}"
            );
        }
        for origin in [
            Some("null"),
            Some("https://example.com"),
            Some("https://localhost.evil"),
            Some("http://127.0.0.1.evil:8080"),
            Some("tauri://example.com"),
        ] {
            assert!(
                !allowed_origin(origin),
                "expected rejected origin: {origin:?}"
            );
        }
    }

    #[test]
    fn maintenance_quiesce_is_atomic_and_resumable() {
        let state = AutomationState::default();
        let queue = Arc::new(JobQueue::default());
        queue
            .data
            .lock()
            .unwrap()
            .jobs
            .insert("busy".to_string(), job("busy", JobStatus::Running));
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        *state.control.lock().unwrap() = Some(Control {
            stop: Arc::new(AtomicBool::new(false)),
            server,
            queue: queue.clone(),
        });

        assert_eq!(
            quiesce_if_idle(&state),
            Err(MaintenanceError::Busy(QueueSnapshot {
                queued: 0,
                running: 1
            }))
        );
        queue.data.lock().unwrap().jobs.clear();
        assert_eq!(quiesce_if_idle(&state), Ok(()));
        assert!(!queue.admission.lock().unwrap().accepting);
        assert_eq!(
            quiesce_if_idle(&state),
            Err(MaintenanceError::AlreadyInProgress)
        );
        resume(&state);
        assert!(queue.admission.lock().unwrap().accepting);
    }

    #[test]
    fn failed_start_releases_maintenance_without_restoring_old_control() {
        let state = AutomationState::default();
        let cfg = Config {
            server_bin: String::new(),
            models_dir: String::new(),
            backend: "test".to_string(),
            gpu: 0,
            host: "127.0.0.1".to_string(),
            port: u16::MAX,
            output_dir: String::new(),
        };

        let error = match start(&cfg, &state) {
            Ok(_) => panic!("an overflowing port must fail before binding"),
            Err(error) => error,
        };

        assert_eq!(error, "server port is too high");
        assert!(!state.maintenance.load(Ordering::Acquire));
        assert!(state.control.lock().unwrap().is_none());
        assert!(!info(&state).running);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let held_port = listener.local_addr().unwrap().port();
        let cfg = Config {
            port: held_port.checked_sub(1).expect("ephemeral port is nonzero"),
            ..cfg
        };

        assert!(start(&cfg, &state).is_err());
        assert!(!state.maintenance.load(Ordering::Acquire));
        assert!(state.control.lock().unwrap().is_none());
    }
}

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
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

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
struct JobParams {
    seed: u64,
    resolution: u16,
    bg_removal: String,
    uv: String,
    /// `None` keeps the native server's launch default (texturing enabled).
    texture: Option<bool>,
    /// `None` keeps the backend's per-resolution QEM default.
    target_faces: Option<u32>,
    /// `None` keeps the backend's per-resolution atlas default.
    atlas_size: Option<u32>,
    /// `None` keeps the automatic texture decode resolution.
    texture_resolution: Option<u16>,
    /// `None` keeps the resolution-scaled remesh band.
    remesh_band: Option<u8>,
    /// `None` keeps the backend's WebP-if-available default. Stored values are
    /// canonicalized to "auto", "webp", or "png".
    texture_encoding: Option<String>,
}

impl Default for JobParams {
    fn default() -> Self {
        Self {
            seed: 42,
            resolution: 512,
            bg_removal: "auto".to_string(),
            uv: "xatlas".to_string(),
            texture: None,
            target_faces: None,
            atlas_size: None,
            texture_resolution: None,
            remesh_band: None,
            texture_encoding: None,
        }
    }
}

/// Validation bounds mirroring trellis-server's `/generate` enforcement so a
/// rejected request never enters the queue in the first place.
fn validate_job_params(params: &JobParams) -> Result<(), String> {
    if !matches!(params.resolution, 512 | 1024 | 1536) {
        return Err("resolution must be 512, 1024, or 1536".to_string());
    }
    if !matches!(
        params.bg_removal.as_str(),
        "auto" | "birefnet" | "threshold"
    ) {
        return Err("bg_removal must be auto, threshold, or birefnet".to_string());
    }
    if !matches!(params.uv.as_str(), "xatlas" | "box") {
        return Err("uv must be xatlas or box".to_string());
    }
    if let Some(value) = params.target_faces {
        if !(10_000..=1_000_000).contains(&value) {
            return Err("targetFaces must be between 10000 and 1000000".to_string());
        }
    }
    if let Some(value) = params.atlas_size {
        if !(128..=4096).contains(&value) {
            return Err("atlasSize must be between 128 and 4096".to_string());
        }
    }
    if let Some(value) = params.texture_resolution {
        if value != 512 && value != 1024 {
            return Err("textureResolution must be 512 or 1024".to_string());
        }
    }
    if let Some(value) = params.remesh_band {
        if value > 8 {
            return Err("remeshBand must be between 0 and 8".to_string());
        }
    }
    if let Some(value) = &params.texture_encoding {
        if !matches!(value.as_str(), "auto" | "webp" | "png") {
            return Err("textureEncoding must be auto, webp, or png".to_string());
        }
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ModelDimensions {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
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
#[derive(Clone, Default, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
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

/// Version of the on-disk job-store schema. Bump when DurableJob changes
/// shape; older files are quarantined instead of misread.
const JOB_STORE_VERSION: u32 = 1;

/// One durable job record: everything needed to reconcile a job after the app
/// restarts — identity, inputs, lifecycle state, timestamps, progress, and
/// outputs. Persisted atomically at every lifecycle transition.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
struct DurableJob {
    schema_version: u32,
    id: String,
    status: JobStatus,
    source_image_path: String,
    source_name: String,
    source_type: String,
    params: JobParams,
    submitted_at: u64,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    /// True when this job was Running in a previous process life and must be
    /// re-run; the worker waits out any native-side orphan first.
    interrupted: bool,
    output_path: Option<String>,
    error: Option<String>,
    quality_warning: Option<QualityWarning>,
    progress: JobProgressView,
}

impl Default for DurableJob {
    fn default() -> Self {
        Self {
            schema_version: JOB_STORE_VERSION,
            id: String::new(),
            status: JobStatus::Queued,
            source_image_path: String::new(),
            source_name: String::new(),
            source_type: "image/png".to_string(),
            params: JobParams::default(),
            submitted_at: 0,
            started_at: None,
            finished_at: None,
            interrupted: false,
            output_path: None,
            error: None,
            quality_warning: None,
            progress: JobProgressView::default(),
        }
    }
}

impl Job {
    fn to_durable(&self) -> DurableJob {
        DurableJob {
            schema_version: JOB_STORE_VERSION,
            id: self.id.clone(),
            status: self.status,
            source_image_path: self.source_disk_path.clone().unwrap_or_default(),
            source_name: self.source_name.clone(),
            source_type: self.source_type.clone(),
            params: self.params.clone(),
            submitted_at: self.submitted_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
            interrupted: self.interrupted,
            output_path: self.output_path.clone(),
            error: self.error.clone(),
            quality_warning: self.quality_warning.clone(),
            progress: self.progress.clone(),
        }
    }

    fn from_durable(durable: DurableJob) -> Job {
        let source_path = if durable.source_image_path.is_empty() {
            None
        } else {
            Some(durable.source_image_path.clone())
        };
        Job {
            id: durable.id,
            status: durable.status,
            submitted_at: durable.submitted_at,
            started_at: durable.started_at,
            finished_at: durable.finished_at,
            source_image: Vec::new(),
            source_name: durable.source_name,
            source_type: durable.source_type,
            source_path: source_path.clone(),
            source_disk_path: source_path,
            params: durable.params,
            output_path: durable.output_path,
            error: durable.error,
            quality_warning: durable.quality_warning,
            progress: durable.progress,
            interrupted: durable.interrupted,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct JobStoreFile {
    version: u32,
    jobs: Vec<serde_json::Value>,
}

fn serialize_store(jobs: &[DurableJob]) -> String {
    let file = JobStoreFile {
        version: JOB_STORE_VERSION,
        jobs: jobs
            .iter()
            .map(|job| serde_json::to_value(job).unwrap_or_else(|_| serde_json::Value::Null))
            .collect(),
    };
    serde_json::to_string(&file).unwrap_or_default()
}

/// Parses a store file leniently: one unreadable record becomes an explicit
/// unrecoverable placeholder instead of losing every other job.
fn parse_store(text: &str) -> Result<Vec<DurableJob>, String> {
    let stripped = text.strip_prefix('\u{feff}').unwrap_or(text);
    let file: JobStoreFile =
        serde_json::from_str(stripped).map_err(|e| format!("store is not valid JSON: {e}"))?;
    if file.version != JOB_STORE_VERSION {
        return Err(format!(
            "store schema version {} is not supported (expected {JOB_STORE_VERSION})",
            file.version
        ));
    }
    Ok(file
        .jobs
        .into_iter()
        .map(
            |value| match serde_json::from_value::<DurableJob>(value.clone()) {
                Ok(job) => job,
                Err(error) => {
                    let id = value
                        .get("id")
                        .and_then(|id| id.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    DurableJob {
                        id,
                        status: JobStatus::Failed,
                        error: Some(format!("unrecoverable: unreadable job record ({error})")),
                        finished_at: Some(now_ms()),
                        ..DurableJob::default()
                    }
                }
            },
        )
        .collect())
}

/// Applies recovery rules after loading: non-terminal records from a previous
/// process become requeued (interrupted) or clearly unrecoverable. Queue order
/// follows submission time so restarts preserve ordering.
fn reconcile_loaded_jobs(jobs: Vec<DurableJob>) -> Vec<DurableJob> {
    let mut ordered = jobs;
    ordered.sort_by_key(|job| job.submitted_at);
    for job in &mut ordered {
        // A record whose stored parameters fail current validation can never
        // be replayed faithfully; surface it as explicitly unrecoverable
        // instead of silently regenerating with different settings.
        if let Err(error) = validate_job_params(&job.params) {
            job.status = JobStatus::Failed;
            job.error = Some(format!(
                "unrecoverable: stored generation parameters are invalid ({error})"
            ));
            job.interrupted = false;
            job.finished_at = Some(now_ms());
            continue;
        }
        let terminal = matches!(
            job.status,
            JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled
        );
        if terminal {
            continue;
        }
        // Non-terminal records were mid-flight during a crash or restart.
        let image_available = !job.source_image_path.is_empty()
            && std::path::Path::new(&job.source_image_path).is_file();
        if !image_available {
            job.status = JobStatus::Failed;
            job.error =
                Some("unrecoverable: the saved source image is missing or unreadable".to_string());
            job.interrupted = false;
            job.finished_at = Some(now_ms());
        } else {
            // Only a previously-Running job can have an orphaned native
            // request under its id; a merely-queued one never started.
            let was_running = job.status == JobStatus::Running;
            job.interrupted = was_running;
            job.status = JobStatus::Queued;
        }
    }
    ordered
}

fn jobs_store_path() -> Result<std::path::PathBuf, String> {
    if let Some(mut path) = crate::config::config_path() {
        if let Some(parent) = path.parent() {
            path = parent.to_path_buf();
        } else {
            path.pop();
        }
        return Ok(path.join("automation-jobs.json"));
    }
    Ok(crate::config::resolve_output_dir()?.join("automation-jobs.json"))
}

/// Replaces the store through a fully-written temporary file. Windows cannot
/// rename over an existing destination with std::fs::rename, so the previous
/// store is retained as a backup during the swap and used for recovery if the
/// process stops between the two renames.
fn save_store_file(path: &std::path::Path, jobs: &[DurableJob]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serialize_store(jobs);
    let temp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    if path.exists() {
        if backup.exists() {
            std::fs::remove_file(&backup).map_err(|e| e.to_string())?;
        }
        std::fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = std::fs::rename(&temp, path) {
        if !path.exists() && backup.exists() {
            let _ = std::fs::rename(&backup, path);
        }
        return Err(error.to_string());
    }
    if backup.exists() {
        let _ = std::fs::remove_file(backup);
    }
    Ok(())
}

fn load_store_file(path: &std::path::Path) -> Vec<DurableJob> {
    let backup = path.with_extension("json.bak");
    let (loaded_path, text) = match std::fs::read_to_string(path) {
        Ok(text) => (path, text),
        Err(_) => match std::fs::read_to_string(&backup) {
            Ok(text) => (backup.as_path(), text),
            Err(_) => return Vec::new(), // no store yet: nothing to recover
        },
    };
    match parse_store(&text) {
        Ok(jobs) => reconcile_loaded_jobs(jobs),
        Err(reason) => {
            // Quarantine the unreadable file rather than deleting evidence.
            let quarantine = path.with_extension(format!("json.corrupt-{}", now_ms()));
            let _ = std::fs::rename(loaded_path, quarantine);
            eprintln!("[automation] job store quarantined: {reason}");
            Vec::new()
        }
    }
}

/// Persists the whole queue under an already-held data lock. Failures are
/// returned, never swallowed: a caller that ignores them could report work as
/// accepted while it would be lost on restart.
fn persist_locked(data: &QueueData) -> Result<(), String> {
    let path = jobs_store_path()
        .map_err(|error| format!("could not resolve the durable job store: {error}"))?;
    let mut jobs: Vec<DurableJob> = data.jobs.values().map(|job| job.to_durable()).collect();
    jobs.sort_by_key(|job| job.submitted_at);
    save_store_file(&path, &jobs)
        .map_err(|error| format!("could not persist job store {}: {error}", path.display()))
}

impl JobQueue {
    /// Latches a persistence failure: durability can no longer be guaranteed,
    /// so new submissions pause until a successful retry clears the state.
    fn record_persistence_failure(&self, context: &str, error: &str) {
        let mut degraded = self.degraded.lock().unwrap();
        let message = format!("{context}: {error}");
        if degraded.is_none() {
            eprintln!("[automation] persistence degraded — {message}");
        }
        *degraded = Some(message);
    }

    /// A successful full-queue persistence clears degradation.
    fn record_persistence_success(&self) {
        let mut degraded = self.degraded.lock().unwrap();
        if degraded.is_some() {
            eprintln!("[automation] persistence recovered; resuming admission");
            *degraded = None;
        }
    }

    fn degradation(&self) -> Option<String> {
        self.degraded.lock().unwrap().clone()
    }
}

/// Why `POST /jobs` cannot currently accept work, if it cannot. The caller
/// passes the admission flag it already holds under the admission lock —
/// this function must not reacquire that non-reentrant mutex.
fn admission_block_reason(queue: &JobQueue, accepting: bool) -> Option<String> {
    if let Some(error) = queue.degradation() {
        return Some(format!(
            "automation is temporarily not accepting jobs because persistence is degraded ({error}); retry later"
        ));
    }
    if !accepting {
        return Some(
            "automation API is temporarily paused while Triastasis is restarting or quitting"
                .to_string(),
        );
    }
    None
}

/// Loads persisted jobs into a fresh queue before it starts accepting work.
fn recover_persisted_jobs(queue: &JobQueue) {
    let Ok(path) = jobs_store_path() else {
        return;
    };
    let recovered = load_store_file(&path);
    if recovered.is_empty() {
        return;
    }
    let mut data = queue.data.lock().unwrap();
    for durable in recovered {
        let status = durable.status;
        let id = durable.id.clone();
        let job = Job::from_durable(durable);
        data.jobs.insert(id.clone(), job);
        if status == JobStatus::Queued {
            data.pending.push_back(id);
        }
    }
    if let Err(error) = persist_locked(&data) {
        queue.record_persistence_failure("startup recovery", &error);
    }
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
    /// Where the source image was persisted at submission, so interrupted
    /// jobs can be requeued after a restart.
    source_disk_path: Option<String>,
    /// Set when this job survived a restart mid-run and must be re-run.
    interrupted: bool,
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
    /// A client-supplied progress id, if any. Admission rejects it because
    /// the queue owns the native `request_id`.
    client_request_id: Option<String>,
}

/// Admission-level guard: the automation queue assigns every native
/// `request_id`, so a client attempt to choose one is rejected outright.
fn ensure_queue_owned_request_id(input: &MultipartInput) -> Result<(), String> {
    if input.client_request_id.is_some() {
        Err("request_id is assigned by the automation queue and cannot be supplied".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
impl std::fmt::Debug for MultipartInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MultipartInput")
            .field("image_len", &self.image.len())
            .field("source_name", &self.source_name)
            .field("source_type", &self.source_type)
            .field("params", &self.params)
            .finish()
    }
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
    // Optional advanced fields are forwarded only when supplied, exactly like
    // an interactive request that leaves them at their backend defaults.
    if let Some(texture) = params.texture {
        push_multipart_part(
            &mut body,
            &boundary,
            "texture",
            None,
            None,
            if texture { "true" } else { "false" },
        );
    }
    if let Some(value) = params.target_faces {
        push_multipart_part(
            &mut body,
            &boundary,
            "target_faces",
            None,
            None,
            &value.to_string(),
        );
    }
    if let Some(value) = params.atlas_size {
        push_multipart_part(
            &mut body,
            &boundary,
            "atlas_size",
            None,
            None,
            &value.to_string(),
        );
    }
    if let Some(value) = params.texture_resolution {
        push_multipart_part(
            &mut body,
            &boundary,
            "texture_resolution",
            None,
            None,
            &value.to_string(),
        );
    }
    if let Some(value) = params.remesh_band {
        push_multipart_part(
            &mut body,
            &boundary,
            "remesh_band",
            None,
            None,
            &value.to_string(),
        );
    }
    if let Some(value) = &params.texture_encoding {
        push_multipart_part(&mut body, &boundary, "texture_encoding", None, None, value);
    }
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
    /// Last persistence failure. While latched, durability cannot be
    /// guaranteed: new submissions return 503 until a successful full-queue
    /// persistence clears the state.
    degraded: Mutex<Option<String>>,
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

/// Maps an accepted multipart field name (including every alias the native
/// `/generate` endpoint recognizes) onto its canonical parameter name.
fn canonical_field_name(name: &str) -> Option<&'static str> {
    match name {
        "seed" => Some("seed"),
        "resolution" => Some("resolution"),
        "bg_removal" | "bgRemoval" => Some("bg_removal"),
        "uv" => Some("uv"),
        "texture" | "texture_enabled" | "textureEnabled" => Some("texture"),
        "target_faces" | "targetFaces" => Some("target_faces"),
        "atlas" | "atlas_size" | "atlasSize" => Some("atlas_size"),
        "tex_res" | "texRes" | "texture_resolution" | "textureResolution" => {
            Some("texture_resolution")
        }
        "band" | "remesh_band" | "remeshBand" => Some("remesh_band"),
        "webp" | "texture_encoding" | "textureEncoding" => Some("texture_encoding"),
        _ => None,
    }
}

/// Native toggle spelling shared with `/generate`'s parse_toggle_field.
fn parse_toggle(value: &str, field: &str) -> Result<bool, String> {
    match value {
        "on" | "true" | "1" => Ok(true),
        "off" | "false" | "0" => Ok(false),
        _ => Err(format!(
            "{field} must be one of on, off, true, false, 1, or 0"
        )),
    }
}

/// Native encoding spelling shared with `/generate`'s parse_texture_encoding,
/// canonicalized to the stored "auto"/"webp"/"png" form.
fn canonical_texture_encoding(value: &str, field: &str) -> Result<String, String> {
    match value {
        "auto" => Ok("auto".to_string()),
        "webp" | "on" | "true" | "1" => Ok("webp".to_string()),
        "png" | "off" | "false" | "0" => Ok("png".to_string()),
        _ => Err(format!("{field} must be auto, webp, png, on, or off")),
    }
}

/// Applies validated text fields onto a default `JobParams`. Every value is
/// parsed and range-checked here; nothing falls back to a silent default.
fn job_params_from_fields(fields: &HashMap<&'static str, String>) -> Result<JobParams, String> {
    let mut params = JobParams::default();
    if let Some(value) = fields.get("seed") {
        params.seed = value
            .parse()
            .map_err(|_| "seed must be an integer between 0 and 4294967295".to_string())?;
    }
    if let Some(value) = fields.get("resolution") {
        params.resolution = value
            .parse()
            .map_err(|_| "resolution must be 512, 1024, or 1536".to_string())?;
    }
    if let Some(value) = fields.get("bg_removal") {
        params.bg_removal = value.clone();
    }
    if let Some(value) = fields.get("uv") {
        params.uv = value.clone();
    }
    if let Some(value) = fields.get("texture") {
        params.texture = Some(parse_toggle(value, "texture")?);
    }
    if let Some(value) = fields.get("target_faces") {
        params.target_faces =
            Some(value.parse().map_err(|_| {
                "targetFaces must be an integer between 10000 and 1000000".to_string()
            })?);
    }
    if let Some(value) = fields.get("atlas_size") {
        params.atlas_size = Some(
            value
                .parse()
                .map_err(|_| "atlasSize must be an integer between 128 and 4096".to_string())?,
        );
    }
    if let Some(value) = fields.get("texture_resolution") {
        params.texture_resolution = Some(
            value
                .parse()
                .map_err(|_| "textureResolution must be 512 or 1024".to_string())?,
        );
    }
    if let Some(value) = fields.get("remesh_band") {
        params.remesh_band = Some(
            value
                .parse()
                .map_err(|_| "remeshBand must be an integer between 0 and 8".to_string())?,
        );
    }
    if let Some(value) = fields.get("texture_encoding") {
        params.texture_encoding = Some(canonical_texture_encoding(value, "textureEncoding")?);
    }
    validate_job_params(&params)?;
    Ok(params)
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
    let mut client_request_id: Option<String> = None;
    // Canonical field name -> trimmed text value. Aliases collapse here, and
    // conflicting alias values are rejected instead of resolved by order.
    let mut fields: HashMap<&'static str, String> = HashMap::new();

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
            let text = text.trim();
            if name == "request_id" || name == "requestId" {
                // Captured here so our own rebuilt bodies still parse;
                // admission rejects client-supplied values explicitly.
                client_request_id = Some(text.to_string());
            } else if let Some(canonical) = canonical_field_name(&name) {
                if let Some(previous) = fields.get(canonical) {
                    if previous != text {
                        return Err(format!(
                            "conflicting values supplied for {canonical} through \"{name}\""
                        ));
                    }
                } else {
                    fields.insert(canonical, text.to_string());
                }
            } else {
                return Err(format!("unsupported field \"{name}\""));
            }
        }
        cursor = data_start + data_len + 2;
    }

    let image = image
        .filter(|bytes| !bytes.is_empty())
        .ok_or("image field is missing")?;
    let params = job_params_from_fields(&fields)?;
    Ok(MultipartInput {
        image,
        source_name,
        source_type,
        params,
        client_request_id,
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
    if let Err(error) = ensure_queue_owned_request_id(&multipart) {
        let _ = request.respond(error_response(400, &error));
        return;
    }

    // Held across the whole submission so an atomic restart cannot flip the
    // admission state between validation and publication.
    let _admission = queue.admission.lock().unwrap();
    if let Some(reason) = admission_block_reason(queue, _admission.accepting) {
        let _ = request.respond(error_response(503, &reason));
        return;
    }

    let id = next_job_id();
    // Persist the source image at submission time: recovery after a crash
    // needs the input bytes on disk, not in a dead process's memory.
    let source_disk_path = match config::resolve_output_dir() {
        Ok(dir) => {
            if let Err(error) = std::fs::create_dir_all(&dir) {
                let _ = request.respond(error_response(
                    500,
                    &format!("could not prepare durable job storage: {error}"),
                ));
                return;
            }
            let extension = std::path::Path::new(&multipart.source_name)
                .extension()
                .and_then(|value| value.to_str())
                .filter(|value| {
                    value.len() <= 8 && value.chars().all(|ch| ch.is_ascii_alphanumeric())
                })
                .unwrap_or("img");
            let path = dir.join(format!("automation_{id}_source.{extension}"));
            match std::fs::write(&path, &multipart.image) {
                Ok(()) => Some(path.to_string_lossy().into_owned()),
                Err(error) => {
                    let _ = request.respond(error_response(
                        500,
                        &format!("could not persist source image for recovery: {error}"),
                    ));
                    return;
                }
            }
        }
        Err(error) => {
            let _ = request.respond(error_response(
                500,
                &format!("could not resolve durable job storage: {error}"),
            ));
            return;
        }
    };
    let staged_source_path = source_disk_path.clone();
    let job = Job {
        id: id.clone(),
        status: JobStatus::Queued,
        submitted_at: now_ms(),
        started_at: None,
        finished_at: None,
        source_image: multipart.image,
        source_disk_path,
        interrupted: false,
        source_name: multipart.source_name,
        source_type: multipart.source_type,
        source_path: None,
        params: multipart.params,
        output_path: None,
        error: None,
        quality_warning: None,
        progress: JobProgressView::default(),
    };
    // Transaction: the proposed durable snapshot (existing jobs plus this
    // one) is written and the job published to memory under ONE held data
    // lock, so no other writer can persist an intervening snapshot that
    // excludes this job between the save and the publication. If the process
    // stops right after the save, startup recovery finds the job; if the
    // save fails, nothing was accepted and the staged image is cleaned up.
    let submission = {
        let mut data = queue.data.lock().unwrap();
        let mut staged: Vec<DurableJob> = data.jobs.values().map(|job| job.to_durable()).collect();
        staged.push(job.to_durable());
        staged.sort_by_key(|job| job.submitted_at);
        let saved = match jobs_store_path() {
            Ok(path) => save_store_file(&path, &staged).map_err(|error| {
                format!("could not persist job store {}: {error}", path.display())
            }),
            Err(error) => Err(format!("could not resolve durable job storage: {error}")),
        };
        match saved {
            Ok(()) => {
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
                Ok((queue_position, jobs_ahead, queued, running))
            }
            Err(error) => Err(error),
        }
    };
    let (queue_position, jobs_ahead, queued, running) = match submission {
        Ok(values) => values,
        Err(error) => {
            queue.record_persistence_failure("admission", &error);
            // Best-effort cleanup of the staged source image; nothing was
            // accepted, so no orphaned input should linger.
            if let Some(path) = &staged_source_path {
                let _ = std::fs::remove_file(path);
            }
            let _ = request.respond(error_response(
                500,
                "the job was not accepted because it could not be made durable; no work was queued",
            ));
            return;
        }
    };
    drop(_admission);
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
        // A cancellation that cannot be made durable is rolled back: leaving
        // it applied only in memory would resurrect the job after a restart
        // and spend GPU time the user explicitly withdrew.
        if let Err(error) = persist_locked(&data) {
            queue.record_persistence_failure("cancel", &error);
            if let Some(job) = data.jobs.get_mut(id) {
                job.status = JobStatus::Queued;
                job.finished_at = None;
            }
            data.pending.push_back(id.to_string());
            let _ = request.respond(error_response(
                500,
                "the cancellation could not be persisted; the job remains queued",
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
        let degradation = queue.degradation();
        let body = serde_json::json!({
            "service": "Triastasis Automation",
            "apiVersion": 1,
            "capabilities": info,
            "queue": { "queued": queued, "running": running, "total": total },
            "persistenceHealthy": degradation.is_none(),
            "persistenceError": degradation,
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
                            // Persist only on stage changes, not every poll:
                            // lifecycle transitions matter for recovery.
                            let stage_changed = job.progress.stage_id != view.stage_id;
                            job.progress = view;
                            if stage_changed {
                                if let Err(error) = persist_locked(&data) {
                                    queue.record_persistence_failure(
                                        &format!("progress of job {job_id}"),
                                        &error,
                                    );
                                }
                            }
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
        // While persistence is degraded, no further job may start: retry a
        // full-queue save first and only resume once durability is proven
        // again.
        if queue.degradation().is_some() {
            let recovered = {
                let data = queue.data.lock().unwrap();
                persist_locked(&data)
            };
            match recovered {
                Ok(()) => queue.record_persistence_success(),
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(2_000));
                    continue;
                }
            }
        }
        let work = {
            let mut data = queue.data.lock().unwrap();
            while data.pending.is_empty() && !stop.load(Ordering::Relaxed) {
                data = queue.changed.wait(data).unwrap();
            }
            let Some(id) = data.pending.pop_front() else {
                continue;
            };
            // Scoped block: the mutable job borrow must end before
            // persist_locked takes its own (immutable) look at the queue.
            let payload = {
                let Some(job) = data.jobs.get_mut(&id) else {
                    continue;
                };
                if job.status != JobStatus::Queued {
                    continue;
                }
                job.status = JobStatus::Running;
                job.started_at = Some(now_ms());
                (
                    id.clone(),
                    job.source_image.clone(),
                    job.source_name.clone(),
                    job.source_type.clone(),
                    job.params.clone(),
                    job.interrupted,
                )
            };
            // The Queued -> Running transition MUST be durable before any GPU
            // work starts: otherwise a restart would find the record still
            // Queued, skip orphan confirmation, and resubmit while the first
            // native request may still be running. On failure, roll the
            // transition back, requeue at the front, and withhold execution.
            if let Err(error) = persist_locked(&data) {
                queue.record_persistence_failure(&format!("start of job {id}"), &error);
                if let Some(job) = data.jobs.get_mut(&id) {
                    job.status = JobStatus::Queued;
                    job.started_at = None;
                }
                data.pending.push_front(id);
                continue;
            }
            Some(payload)
        };

        let Some((id, source_image, source_name, source_type, params, interrupted)) = work else {
            continue;
        };
        // A job that survived a restart mid-run may still have an orphaned
        // native-side request running under the same request_id (the server
        // keeps processing after the old client vanished). Wait for it to
        // finish before re-submitting so the GPU never runs duplicates.
        if interrupted {
            match wait_for_orphan(&client, &id) {
                Ok(()) => {
                    let mut data = queue.data.lock().unwrap();
                    if let Some(job) = data.jobs.get_mut(&id) {
                        job.interrupted = false;
                        if let Err(error) = persist_locked(&data) {
                            queue.record_persistence_failure(
                                &format!("orphan clearance of job {id}"),
                                &error,
                            );
                        }
                    }
                }
                Err(reason) => {
                    // Uncertainty is never permission to resubmit: withhold
                    // the automatic rerun visibly instead of risking
                    // concurrent GPU work under the same request id.
                    let mut data = queue.data.lock().unwrap();
                    if let Some(job) = data.jobs.get_mut(&id) {
                        job.status = JobStatus::Failed;
                        job.finished_at = Some(now_ms());
                        job.error = Some(format!(
                            "recovery withheld: the previous native request could not be \
                             proven inactive, so the job was not rerun ({reason})"
                        ));
                        if let Err(error) = persist_locked(&data) {
                            queue.record_persistence_failure(
                                &format!("recovery withholding of job {id}"),
                                &error,
                            );
                        }
                    }
                    continue;
                }
            }
        }
        // The job id doubles as the native request_id, so /progress/{job_id}
        // and the automation status URL describe the same lifecycle.
        spawn_progress_watcher(queue.clone(), client.clone(), id.clone());
        // Recovered jobs carry no in-memory image bytes; reload from disk.
        let source_image = if source_image.is_empty() {
            let path = {
                let data = queue.data.lock().unwrap();
                data.jobs
                    .get(&id)
                    .and_then(|job| job.source_disk_path.clone())
            };
            match path.map(|p| std::fs::read(p)) {
                Some(Ok(bytes)) => bytes,
                _ => {
                    let mut data = queue.data.lock().unwrap();
                    if let Some(job) = data.jobs.get_mut(&id) {
                        job.status = JobStatus::Failed;
                        job.error =
                            Some("unrecoverable: the saved source image could not be read".into());
                        job.finished_at = Some(now_ms());
                        if let Err(error) = persist_locked(&data) {
                            queue.record_persistence_failure(
                                &format!("terminal failure of job {id}"),
                                &error,
                            );
                        }
                    }
                    continue;
                }
            }
        } else {
            source_image
        };
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
            if let Err(terminal_error) = persist_locked(&data) {
                queue.record_persistence_failure(
                    &format!("terminal transition of job {id}"),
                    &terminal_error,
                );
            } else {
                // A successful save proves durability again; the worker's
                // degraded retry loop also clears the latch, but do it here so
                // capabilities reflect recovery immediately.
                queue.record_persistence_success();
            }
        }
    }
}

/// One observed outcome of a `/progress/{id}` poll.
#[derive(Clone, Debug, PartialEq)]
enum OrphanPoll {
    /// The native request is still executing.
    Running,
    /// A responsive server proved the request absent or terminal.
    Cleared,
    /// No conclusion is possible (transport failure, bad body, server error).
    Unknown(String),
}

/// Classifies one progress response. Only evidence produced by a responsive
/// native server may clear an orphan; connection failures are never treated
/// as absence, because they also occur while the server is still booting.
fn classify_progress_response(status: u16, body: Option<&str>) -> OrphanPoll {
    match status {
        // The server answered and knows no such request: confirmed absence.
        404 => OrphanPoll::Cleared,
        200 => {
            let Some(text) = body else {
                return OrphanPoll::Unknown("empty progress body".to_string());
            };
            let parsed: serde_json::Value = match serde_json::from_str(text) {
                Ok(value) => value,
                Err(error) => {
                    return OrphanPoll::Unknown(format!("malformed progress JSON: {error}"))
                }
            };
            match parsed.get("status").and_then(|value| value.as_str()) {
                Some("running") => OrphanPoll::Running,
                Some("succeeded") | Some("failed") => OrphanPoll::Cleared,
                other => OrphanPoll::Unknown(format!(
                    "unrecognized progress status {}",
                    other.unwrap_or("<missing>")
                )),
            }
        }
        other => OrphanPoll::Unknown(format!("progress endpoint returned HTTP {other}")),
    }
}

/// Outcome of the orphan-wait algorithm.
enum OrphanWait {
    /// The prior request was confirmed inactive.
    Confirmed,
    /// Never confirmed before the safety deadline expired.
    Unresolved(String),
}

/// Drives orphan confirmation by polling until a definitive answer, keeping
/// the sleeping injectable so the policy is unit-testable without real time.
fn wait_for_orphan_polling(
    mut poll: impl FnMut() -> OrphanPoll,
    deadline: std::time::Instant,
    mut sleep: impl FnMut(Duration),
    poll_interval: Duration,
    max_backoff: Duration,
) -> OrphanWait {
    let mut backoff = poll_interval;
    loop {
        if std::time::Instant::now() >= deadline {
            return OrphanWait::Unresolved(
                "the safety deadline expired without confirming the state of the previous \
                 native request"
                    .to_string(),
            );
        }
        match poll() {
            OrphanPoll::Cleared => return OrphanWait::Confirmed,
            OrphanPoll::Running => {
                backoff = poll_interval;
                sleep(poll_interval);
            }
            OrphanPoll::Unknown(_) => {
                // Uncertainty must never become permission to resubmit: keep
                // retrying (with capped backoff) rather than proceeding.
                sleep(backoff);
                backoff = std::cmp::min(backoff * 2, max_backoff);
            }
        }
    }
}

/// After a crash, the native server may still be finishing the orphaned
/// generation for `id` (its handler outlives the dead HTTP client). Poll its
/// progress endpoint until that request is CONFIRMED inactive before this
/// queue re-runs the job, so the same request id never executes twice
/// concurrently. Returns an error when confirmation was impossible; callers
/// must not submit in that case.
fn wait_for_orphan(client: &Client, id: &str) -> Result<(), String> {
    let Some(cfg) = config::load() else {
        return Err("the Trellis server configuration is unavailable".to_string());
    };
    let url = format!("http://{}:{}/progress/{}", cfg.host, cfg.port, id);
    // Bounded by the native generation client timeout (60 min) plus margin.
    let deadline = std::time::Instant::now() + Duration::from_secs(65 * 60);
    let outcome = wait_for_orphan_polling(
        || {
            let response = client.get(&url).send();
            match response {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let body = response.text().ok();
                    classify_progress_response(status, body.as_deref())
                }
                Err(error) => OrphanPoll::Unknown(error.to_string()),
            }
        },
        deadline,
        std::thread::sleep,
        Duration::from_millis(2_000),
        Duration::from_millis(15_000),
    );
    match outcome {
        OrphanWait::Confirmed => Ok(()),
        OrphanWait::Unresolved(reason) => Err(reason),
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
    // Reconcile persisted jobs with this fresh process BEFORE the API accepts
    // traffic: queued jobs requeue, interrupted runs become re-runnable, and
    // unrecoverable records surface as failed with a clear reason.
    recover_persisted_jobs(&queue);
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
            source_disk_path: None,
            interrupted: false,
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

    fn multipart_request(fields: &[(&str, &str)]) -> (String, Vec<u8>) {
        let boundary = "test-boundary";
        let mut body = Vec::new();
        push_multipart_part(
            &mut body,
            boundary,
            "image",
            Some("in.png"),
            Some("image/png"),
            "x",
        );
        for (name, value) in fields {
            push_multipart_part(&mut body, boundary, name, None, None, value);
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        (format!("multipart/form-data; boundary={boundary}"), body)
    }

    #[test]
    fn multipart_accepts_every_native_alias_and_canonicalizes() {
        // One request through snake-case names, one through camelCase ones.
        for fields in [
            vec![
                ("seed", "9"),
                ("resolution", "1024"),
                ("bg_removal", "birefnet"),
                ("uv", "box"),
                ("texture", "off"),
                ("target_faces", "250000"),
                ("atlas_size", "2048"),
                ("tex_res", "512"),
                ("remesh_band", "2"),
                ("texture_encoding", "png"),
            ],
            vec![
                ("seed", "9"),
                ("resolution", "1024"),
                ("bgRemoval", "threshold"),
                ("uv", "xatlas"),
                ("textureEnabled", "true"),
                ("targetFaces", "250000"),
                ("atlasSize", "2048"),
                ("textureResolution", "512"),
                ("remeshBand", "2"),
                ("webp", "on"),
            ],
        ] {
            let (content_type, body) = multipart_request(&fields);
            let parsed = parse_multipart(&content_type, &body).unwrap();
            assert_eq!(parsed.params.seed, 9);
            assert_eq!(parsed.params.resolution, 1024);
            assert_eq!(parsed.params.target_faces, Some(250_000));
            assert_eq!(parsed.params.atlas_size, Some(2_048));
            assert_eq!(parsed.params.texture_resolution, Some(512));
            assert_eq!(parsed.params.remesh_band, Some(2));
            if fields[3].1 == "box" {
                assert_eq!(parsed.params.uv, "box");
                assert_eq!(parsed.params.bg_removal, "birefnet");
                assert_eq!(parsed.params.texture, Some(false));
                assert_eq!(parsed.params.texture_encoding.as_deref(), Some("png"));
            } else {
                assert_eq!(parsed.params.uv, "xatlas");
                assert_eq!(parsed.params.bg_removal, "threshold");
                // Native toggle spellings canonicalize to the stored choices.
                assert_eq!(parsed.params.texture, Some(true));
                assert_eq!(parsed.params.texture_encoding.as_deref(), Some("webp"));
            }
        }
    }

    #[test]
    fn multipart_rejects_conflicting_alias_values_regardless_of_order() {
        for fields in [
            vec![("atlasSize", "512"), ("atlas_size", "1024")],
            vec![("atlas_size", "512"), ("atlasSize", "1024")],
            vec![("atlas_size", "512"), ("atlasSize", "512")],
        ] {
            let (content_type, body) = multipart_request(&fields);
            match parse_multipart(&content_type, &body) {
                Ok(parsed) => {
                    // Equal values through different aliases are acceptable.
                    assert_eq!(parsed.params.atlas_size, Some(512));
                }
                Err(error) => {
                    assert!(error.contains("conflicting values supplied for atlas_size"));
                }
            }
        }
    }

    #[test]
    fn multipart_rejects_unknown_fields_and_client_request_ids() {
        let unknown = multipart_request(&[("seed", "5"), ("fancy_knob", "1")]);
        let error = parse_multipart(&unknown.0, &unknown.1).unwrap_err();
        assert!(error.contains("unsupported field \"fancy_knob\""));

        for name in ["request_id", "requestId"] {
            let claimed = multipart_request(&[(name, "attacker-chosen-id")]);
            let parsed = parse_multipart(&claimed.0, &claimed.1).unwrap();
            assert_eq!(
                parsed.client_request_id.as_deref(),
                Some("attacker-chosen-id")
            );
            // The admission guard refuses the captured id.
            assert!(ensure_queue_owned_request_id(&parsed)
                .err()
                .unwrap()
                .contains("request_id is assigned by the automation queue"));
        }
    }

    #[test]
    fn multipart_rejects_invalid_values_instead_of_defaulting() {
        let cases: Vec<Vec<(&str, &str)>> = vec![
            vec![("seed", "not-a-number")],
            vec![("resolution", "700")],
            vec![("bg_removal", "magic")],
            vec![("uv", "spherical")],
            vec![("texture", "maybe")],
            vec![("targetFaces", "9999")],
            vec![("targetFaces", "1000001")],
            vec![("atlasSize", "127")],
            vec![("textureResolution", "256")],
            vec![("remeshBand", "9")],
            vec![("textureEncoding", "jpeg")],
        ];
        for fields in cases {
            let request = multipart_request(&fields);
            assert!(
                parse_multipart(&request.0, &request.1).is_err(),
                "expected rejection for {fields:?}"
            );
        }
    }

    #[test]
    fn generate_body_forwards_all_supplied_advanced_params() {
        let params = JobParams {
            seed: 11,
            resolution: 1536,
            bg_removal: "threshold".to_string(),
            uv: "box".to_string(),
            texture: Some(true),
            target_faces: Some(500_000),
            atlas_size: Some(4_096),
            texture_resolution: Some(1_024),
            remesh_band: Some(8),
            texture_encoding: Some("webp".to_string()),
        };
        let (content_type, body) =
            build_generate_body("job-full", &[7], "m.png", "image/png", &params);
        let text = String::from_utf8(body.clone()).unwrap();
        for expected in [
            "name=\"seed\"\r\n\r\n11\r\n",
            "name=\"resolution\"\r\n\r\n1536\r\n",
            "name=\"bg_removal\"\r\n\r\nthreshold\r\n",
            "name=\"uv\"\r\n\r\nbox\r\n",
            "name=\"texture\"\r\n\r\ntrue\r\n",
            "name=\"target_faces\"\r\n\r\n500000\r\n",
            "name=\"atlas_size\"\r\n\r\n4096\r\n",
            "name=\"texture_resolution\"\r\n\r\n1024\r\n",
            "name=\"remesh_band\"\r\n\r\n8\r\n",
            "name=\"texture_encoding\"\r\n\r\nwebp\r\n",
            "name=\"request_id\"\r\n\r\njob-full\r\n",
        ] {
            assert!(text.contains(expected), "missing part {expected}");
        }
        // The rebuilt request parses back into identical parameters.
        let parsed = parse_multipart(&content_type, &body).unwrap();
        assert_eq!(parsed.params.seed, 11);
        assert_eq!(parsed.params.target_faces, Some(500_000));
        assert_eq!(parsed.params.remesh_band, Some(8));
    }

    #[test]
    fn generate_body_omits_unsupplied_advanced_params() {
        let (_, body) = build_generate_body(
            "job-basic",
            &[7],
            "m.png",
            "image/png",
            &JobParams::default(),
        );
        let text = String::from_utf8(body).unwrap();
        for absent in [
            "name=\"texture\"",
            "name=\"target_faces\"",
            "name=\"atlas_size\"",
            "name=\"texture_resolution\"",
            "name=\"remesh_band\"",
            "name=\"texture_encoding\"",
        ] {
            assert!(!text.contains(absent), "unexpected part {absent}");
        }
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
            ..JobParams::default()
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

    fn durable(id: &str, status: JobStatus, submitted_at: u64) -> DurableJob {
        DurableJob {
            id: id.to_string(),
            status,
            submitted_at,
            source_name: "source.png".to_string(),
            ..DurableJob::default()
        }
    }

    #[test]
    fn store_round_trips_records_without_loss() {
        let jobs = vec![
            durable("b", JobStatus::Queued, 20),
            durable("a", JobStatus::Succeeded, 10),
            durable("c", JobStatus::Running, 30),
            durable("d", JobStatus::Cancelled, 40),
        ];
        let text = serialize_store(&jobs);
        let loaded = parse_store(&text).unwrap();
        assert_eq!(loaded.len(), jobs.len());
        // Record order is preserved verbatim; ordering is reconcile's job.
        assert_eq!(loaded[0].id, "b");
        assert_eq!(loaded[0].status, JobStatus::Queued);
        assert_eq!(loaded[1].status, JobStatus::Succeeded);
        assert_eq!(loaded[2].status, JobStatus::Running);
    }

    #[test]
    fn old_store_records_without_advanced_fields_deserialize_with_defaults() {
        // Written by a version of the app whose JobParams only carried the
        // four basic fields.
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "id": "legacy-1",
            "status": "queued",
            "sourceImagePath": "img.png",
            "sourceName": "in.png",
            "sourceType": "image/png",
            "params": {
                "seed": 3,
                "resolution": 512,
                "bgRemoval": "auto",
                "uv": "xatlas"
            },
            "submittedAt": 5,
            "interrupted": false
        });
        let record: DurableJob = serde_json::from_value(legacy).unwrap();
        assert_eq!(record.params.seed, 3);
        assert_eq!(record.params.texture, None);
        assert_eq!(record.params.target_faces, None);
        assert_eq!(record.params.atlas_size, None);
        assert_eq!(record.params.texture_resolution, None);
        assert_eq!(record.params.remesh_band, None);
        assert_eq!(record.params.texture_encoding, None);
        // Defaults are valid and replayable.
        assert!(validate_job_params(&record.params).is_ok());
    }

    #[test]
    fn complete_params_survive_a_store_round_trip() {
        let mut record = durable("full", JobStatus::Queued, 10);
        record.params = JobParams {
            seed: 77,
            resolution: 1536,
            bg_removal: "threshold".to_string(),
            uv: "box".to_string(),
            texture: Some(false),
            target_faces: Some(120_000),
            atlas_size: Some(256),
            texture_resolution: Some(512),
            remesh_band: Some(4),
            texture_encoding: Some("png".to_string()),
        };
        let text = serialize_store(&[record]);
        let loaded = parse_store(&text).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].params.texture, Some(false));
        assert_eq!(loaded[0].params.target_faces, Some(120_000));
        assert_eq!(loaded[0].params.atlas_size, Some(256));
        assert_eq!(loaded[0].params.texture_resolution, Some(512));
        assert_eq!(loaded[0].params.remesh_band, Some(4));
        assert_eq!(loaded[0].params.texture_encoding.as_deref(), Some("png"));
    }

    #[test]
    fn recovery_marks_invalid_stored_parameters_unrecoverable() {
        let mut bad = durable("bad", JobStatus::Queued, 10);
        bad.source_image_path = "whatever.png".to_string();
        bad.params.resolution = 700;
        let reconciled = reconcile_loaded_jobs(vec![bad]);
        assert_eq!(reconciled[0].status, JobStatus::Failed);
        assert!(reconciled[0]
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("unrecoverable: stored generation parameters are invalid"));
        assert!(!reconciled[0].interrupted);

        // Valid records keep their normal recovery path.
        let dir = std::env::temp_dir().join(format!("trellis-jobs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut good = durable("good", JobStatus::Queued, 20);
        good.source_image_path = dir.join("img.png").to_string_lossy().into_owned();
        if !dir.join("img.png").is_file() {
            std::fs::write(dir.join("img.png"), b"png").unwrap();
        }
        assert_eq!(
            reconcile_loaded_jobs(vec![good])[0].status,
            JobStatus::Queued
        );
    }

    #[test]
    fn save_store_file_fails_loudly_when_the_target_cannot_be_written() {
        // A plain file occupying the store's parent directory makes
        // create_dir_all fail, simulating a disk or permission fault without
        // platform-specific ACL manipulation.
        let root = std::env::temp_dir().join(format!("trellis-store-fault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let blocker = root.join("blocked");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let store = blocker.join("nested").join("automation-jobs.json");
        let result = save_store_file(&store, &[durable("x", JobStatus::Queued, 1)]);
        assert!(result.is_err(), "write under a file parent must fail");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn degradation_latches_and_only_a_successful_retry_clears_it() {
        let queue = JobQueue::default();
        assert_eq!(queue.degradation(), None);
        assert_eq!(admission_block_reason(&queue, true), None);

        queue.record_persistence_failure("cancel of job j-1", "disk on fire");
        let reason = admission_block_reason(&queue, true).expect("degraded must block submissions");
        assert!(reason.contains("persistence is degraded"), "{reason}");
        assert!(reason.contains("cancel of job j-1"), "{reason}");
        // Degradation blocks even when the admission flag is open.
        assert!(admission_block_reason(&queue, true).is_some());

        // A failed retry does not clear the latch.
        queue.record_persistence_failure("retry", "still broken");
        assert!(queue.degradation().is_some());

        queue.record_persistence_success();
        assert_eq!(queue.degradation(), None);
        assert_eq!(admission_block_reason(&queue, true), None);

        // The maintenance pause remains independently observable.
        queue.admission.lock().unwrap().accepting = false;
        let reason = admission_block_reason(&queue, false).expect("paused must block submissions");
        assert!(reason.contains("temporarily paused"), "{reason}");
    }

    fn poll_status(status: u16, body: &str) -> OrphanPoll {
        classify_progress_response(status, Some(body))
    }

    #[test]
    fn orphan_poll_classification_follows_native_semantics() {
        // Native /progress returns 200 with running|succeeded|failed and 404
        // for an id it does not know.
        assert_eq!(
            poll_status(200, r#"{"status":"running"}"#),
            OrphanPoll::Running
        );
        assert_eq!(
            poll_status(200, r#"{"status":"succeeded"}"#),
            OrphanPoll::Cleared
        );
        assert_eq!(
            poll_status(200, r#"{"status":"failed","error":"boom"}"#),
            OrphanPoll::Cleared
        );
        assert_eq!(classify_progress_response(404, None), OrphanPoll::Cleared);

        // Anything that is not evidence from a responsive server is Unknown.
        assert!(matches!(
            classify_progress_response(503, None),
            OrphanPoll::Unknown(_)
        ));
        assert!(matches!(
            poll_status(200, "not json at all"),
            OrphanPoll::Unknown(_)
        ));
        assert!(matches!(
            poll_status(200, r#"{"stageId":"x"}"#),
            OrphanPoll::Unknown(_)
        ));
        assert!(matches!(
            classify_progress_response(200, None),
            OrphanPoll::Unknown(_)
        ));
    }

    fn no_sleep(_: Duration) {}

    fn instant_deadline() -> std::time::Instant {
        std::time::Instant::now()
    }

    #[test]
    fn orphan_wait_requires_confirmation_before_submitting() {
        let script = [
            OrphanPoll::Unknown("connection refused".to_string()), // server booting
            OrphanPoll::Unknown("timeout".to_string()),
            OrphanPoll::Running,
            OrphanPoll::Running,
            OrphanPoll::Cleared, // terminal status finally observed
        ];
        let mut polls = script.iter();
        let outcome = wait_for_orphan_polling(
            || polls.next().cloned().unwrap_or(OrphanPoll::Cleared),
            std::time::Instant::now() + Duration::from_secs(60),
            no_sleep,
            Duration::from_millis(1),
            Duration::from_millis(4),
        );
        assert!(matches!(outcome, OrphanWait::Confirmed));
    }

    #[test]
    fn orphan_wait_never_confirms_through_persistent_uncertainty() {
        let mut polls: u32 = 0;
        let outcome = wait_for_orphan_polling(
            || {
                polls += 1;
                OrphanPoll::Unknown("connection refused".to_string())
            },
            instant_deadline(), // expires immediately
            no_sleep,
            Duration::from_millis(1),
            Duration::from_millis(2),
        );
        match outcome {
            OrphanWait::Unresolved(reason) => {
                assert!(reason.contains("safety deadline"));
            }
            OrphanWait::Confirmed => panic!("uncertainty must never confirm"),
        }
        assert_eq!(polls, 0, "an expired deadline must not poll-and-submit");
    }

    #[test]
    fn orphan_wait_keeps_retrying_while_the_orphan_runs() {
        let mut running_polls: u32 = 0;
        let deadline = std::time::Instant::now() + Duration::from_millis(50);
        let outcome = wait_for_orphan_polling(
            || {
                if std::time::Instant::now() < deadline && running_polls < 3 {
                    running_polls += 1;
                    return OrphanPoll::Running;
                }
                OrphanPoll::Cleared
            },
            std::time::Instant::now() + Duration::from_secs(30),
            no_sleep,
            Duration::from_millis(1),
            Duration::from_millis(2),
        );
        assert!(matches!(outcome, OrphanWait::Confirmed));
        assert!(running_polls >= 3, "running orphans are waited out");
    }

    #[test]
    fn recovery_requeues_interrupted_runs_and_preserves_order() {
        let jobs = vec![
            durable("late", JobStatus::Queued, 30),
            durable("midrun", JobStatus::Running, 20),
            durable("done", JobStatus::Succeeded, 10),
        ];
        // Every record points at an existing file so validation passes.
        let dir = std::env::temp_dir().join(format!("trellis-jobs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = dir.join("img.png");
        std::fs::write(&image, b"png").unwrap();
        let jobs: Vec<DurableJob> = jobs
            .into_iter()
            .map(|mut job| {
                job.source_image_path = image.to_string_lossy().into_owned();
                job
            })
            .collect();

        let recovered = reconcile_loaded_jobs(jobs);
        assert_eq!(recovered.len(), 3);
        assert_eq!(recovered[0].id, "done");
        assert_eq!(recovered[0].status, JobStatus::Succeeded); // history untouched
        assert_eq!(recovered[1].id, "midrun");
        assert_eq!(recovered[1].status, JobStatus::Queued); // requeued
        assert!(recovered[1].interrupted); // flagged for orphan-wait
        assert_eq!(recovered[2].id, "late");
        assert_eq!(recovered[2].status, JobStatus::Queued); // original queue order kept
        assert!(!recovered[2].interrupted);

        let _ = std::fs::remove_file(&image);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn recovery_marks_missing_source_images_unrecoverable() {
        let mut job = durable("ghost", JobStatus::Running, 5);
        job.source_image_path = "Z:/definitely/not/here/source.png".to_string();
        let recovered = reconcile_loaded_jobs(vec![job]);
        assert_eq!(recovered[0].status, JobStatus::Failed);
        assert!(recovered[0]
            .error
            .as_deref()
            .unwrap()
            .contains("unrecoverable"));
        assert!(!recovered[0].interrupted);
    }

    #[test]
    fn corrupt_and_incompatible_stores_are_rejected_not_misread() {
        let parsed = parse_store("this is not json at all");
        assert!(parsed.is_err());

        let wrong_version = serde_json::json!({ "version": 99, "jobs": [] }).to_string();
        let parsed = parse_store(&wrong_version);
        assert!(parsed.is_err());
    }

    #[test]
    fn one_unreadable_record_does_not_lose_the_others() {
        let good = serde_json::to_value(durable("good", JobStatus::Queued, 1)).unwrap();
        let mut bad = good.clone();
        bad.as_object_mut().unwrap().insert(
            "submittedAt".to_string(),
            serde_json::Value::String("not-a-number".to_string()),
        );
        let file = serde_json::json!({ "version": JOB_STORE_VERSION, "jobs": [bad, good] });
        let loaded = parse_store(&file.to_string()).unwrap();
        assert_eq!(loaded.len(), 2);
        // The unreadable record keeps its id but surfaces as clearly failed.
        let failed = loaded
            .iter()
            .find(|job| job.status == JobStatus::Failed)
            .unwrap();
        assert_eq!(failed.id, "good");
        assert!(failed.error.as_deref().unwrap().contains("unrecoverable"));
        // The healthy record survived untouched.
        let good_job = loaded
            .iter()
            .find(|job| job.status == JobStatus::Queued)
            .unwrap();
        assert_eq!(good_job.id, "good");
    }

    #[test]
    fn store_file_replaces_an_existing_snapshot_on_windows() {
        let dir = std::env::temp_dir().join(format!(
            "trellis-store-replace-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("automation-jobs.json");

        save_store_file(&path, &[durable("first", JobStatus::Succeeded, 1)]).unwrap();
        save_store_file(&path, &[durable("second", JobStatus::Succeeded, 2)]).unwrap();

        let loaded = load_store_file(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "second");
        assert!(!path.with_extension("json.tmp").exists());
        assert!(!path.with_extension("json.bak").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn durable_terminal_job_restores_source_and_quality_warning() {
        let mut saved = durable("done", JobStatus::Succeeded, 1);
        saved.source_image_path = "C:/saved/source.png".to_string();
        saved.quality_warning = Some(QualityWarning {
            code: "collapsed-plane".to_string(),
            message: "Collapsed into a plane".to_string(),
            thin_ratio: 0.001,
            threshold: PLANE_COLLAPSE_RATIO,
            dimensions: ModelDimensions {
                x: 1.0,
                y: 2.0,
                z: 0.001,
            },
        });

        let job = Job::from_durable(saved);
        assert_eq!(job.source_disk_path.as_deref(), Some("C:/saved/source.png"));
        assert_eq!(job.source_path.as_deref(), Some("C:/saved/source.png"));
        assert_eq!(
            job.quality_warning
                .as_ref()
                .map(|warning| warning.code.as_str()),
            Some("collapsed-plane")
        );
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

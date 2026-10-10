use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, MutexGuard};
use std::{
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

const REPO: &str = "dmelim/Triastasis";
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub installed: bool,
    pub managed: bool,
    pub version: Option<String>,
    pub version_state: String,
    pub release_url: String,
    pub target_version: String,
    pub update_available: bool,
    pub pending_version: Option<String>,
    pub pending_path: Option<String>,
    pub backend: String,
    pub path: String,
    pub portable: bool,
    pub recommended_backend: String,
    pub recommendation: String,
}

const RECEIPT: &str = "triastasis-runtime.json";

#[derive(Debug, Deserialize, Serialize)]
struct RuntimeReceipt {
    version: String,
    backend: String,
    archive_sha256: String,
}

pub(crate) fn operation_guard() -> Result<MutexGuard<'static, ()>, String> {
    INSTALL_LOCK
        .try_lock()
        .map_err(|_| "runtime installation or server startup is already in progress".into())
}

fn receipt(directory: &Path) -> Option<RuntimeReceipt> {
    let value: RuntimeReceipt =
        serde_json::from_slice(&std::fs::read(directory.join(RECEIPT)).ok()?).ok()?;
    if value.version.trim().is_empty()
        || !matches!(
            value.backend.as_str(),
            "cuda" | "cuda12" | "rocm" | "vulkan"
        )
        || !valid_digest(&value.archive_sha256)
    {
        return None;
    }
    Some(value)
}

fn version_state(installed: Option<&str>, target: &str) -> &'static str {
    let Some(installed) = installed else {
        return "unknown";
    };
    if installed == target {
        return "current";
    }
    fn core(version: &str) -> Option<([u64; 3], bool)> {
        let version = version.split('+').next()?;
        let (core, prerelease) = if let Some((core, suffix)) = version.split_once('-') {
            if suffix.is_empty()
                || suffix.split('.').any(|part| {
                    part.is_empty() || !part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                })
            {
                return None;
            }
            (core, true)
        } else {
            (version, false)
        };
        let parts: Vec<_> = core.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        Some((
            [
                parts[0].parse().ok()?,
                parts[1].parse().ok()?,
                parts[2].parse().ok()?,
            ],
            prerelease,
        ))
    }
    let (Some((installed_core, installed_pre)), Some((target_core, target_pre))) =
        (core(installed), core(target))
    else {
        return "unknown";
    };
    match installed_core.cmp(&target_core) {
        std::cmp::Ordering::Less => "older",
        std::cmp::Ordering::Greater => "newer",
        std::cmp::Ordering::Equal if installed_pre && !target_pre => "older",
        std::cmp::Ordering::Equal if !installed_pre && target_pre => "newer",
        std::cmp::Ordering::Equal if !installed_pre && !target_pre => "current",
        _ => "unknown",
    }
}

fn pending_matches(receipt: &RuntimeReceipt, backend: &str, target: &str) -> bool {
    receipt.version == target && receipt.backend == backend
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn checksum_for(text: &str, artifact: &str) -> Result<String, String> {
    let mut found = None;
    let mut names = std::collections::HashSet::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let (digest, name) = line
            .split_once("  ")
            .ok_or("the release checksum file is malformed")?;
        if !valid_digest(digest)
            || name.is_empty()
            || name.trim() != name
            || name.contains(['/', '\\'])
            || !names.insert(name)
        {
            return Err("the release checksum file is malformed or ambiguous".into());
        }
        if name == artifact {
            found = Some(digest.to_string());
        }
    }
    found.ok_or_else(|| format!("the release checksum file does not include {artifact}"))
}

fn server_name() -> &'static str {
    if cfg!(windows) {
        "trellis-server.exe"
    } else {
        "trellis-server"
    }
}

fn root() -> Result<PathBuf, String> {
    if let Some(root) = crate::config::portable_mode_root() {
        return Ok(root.join("runtime"));
    }
    dirs::data_local_dir()
        .map(|path| path.join("triastasis").join("runtime"))
        .ok_or_else(|| "could not determine the local application data directory".into())
}

fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

fn recommendation_for_capability(capability: Option<f32>) -> (String, String) {
    match capability {
        Some(value) if value.is_finite() && value >= 7.5 => (
            "cuda".into(),
            format!("NVIDIA compute capability {value:.1} detected. The CUDA runtime is recommended."),
        ),
        Some(value) if value.is_finite() && value >= 6.0 => (
            "cuda12".into(),
            format!("NVIDIA compute capability {value:.1} detected. The CUDA 12 compatibility runtime is recommended."),
        ),
        Some(value) if value.is_finite() => (
            "vulkan".into(),
            format!("NVIDIA compute capability {value:.1} detected, but the published CUDA runtimes require 6.0 or newer. Vulkan is recommended for this GPU."),
        ),
        _ => (
            "vulkan".into(),
            "No compatible NVIDIA CUDA device was detected. Vulkan is the safest compatible runtime.".into(),
        ),
    }
}

fn detect_recommendation() -> (String, String) {
    let mut command = Command::new("nvidia-smi");
    command.args([
        "--query-gpu=compute_cap",
        "--format=csv,noheader",
        "--id",
        "0",
    ]);
    hidden(&mut command);
    let capability = command
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| text.lines().next()?.trim().parse::<f32>().ok());
    recommendation_for_capability(capability)
}

fn recommendation() -> (String, String) {
    static DETECTED: OnceLock<(String, String)> = OnceLock::new();
    DETECTED.get_or_init(detect_recommendation).clone()
}

pub fn status() -> Result<RuntimeStatus, String> {
    let root = root()?;
    let config = crate::config::load();
    let configured = config
        .as_ref()
        .map(|config| PathBuf::from(config.server_bin.trim()))
        .filter(|path| path.is_file());
    let managed = configured
        .as_ref()
        .map(|path| same_path(path, &root.join(server_name())))
        .unwrap_or(false);
    // Read local metadata only. Never execute an arbitrary custom binary to identify it.
    let installed_receipt = configured
        .as_ref()
        .and_then(|path| path.parent())
        .and_then(receipt);
    let version = installed_receipt
        .as_ref()
        .map(|receipt| receipt.version.clone());
    let target_version = env!("CARGO_PKG_VERSION").to_string();
    let installed_backend = installed_receipt
        .as_ref()
        .map(|receipt| receipt.backend.as_str())
        .or_else(|| config.as_ref().map(|cfg| cfg.backend.as_str()))
        .unwrap_or("unknown");
    let version_state = version_state(version.as_deref(), &target_version).to_string();
    // Custom runtimes may also opt in to a verified release. It is staged in the
    // app-managed folder; the custom binary itself is never modified.
    let pending_version = configured
        .is_some()
        .then(|| receipt(&root.with_extension("pending")))
        .flatten()
        .filter(|receipt| {
            version_state != "newer"
                && pending_matches(receipt, installed_backend, &target_version)
                && root.with_extension("pending").join(server_name()).is_file()
        })
        .map(|receipt| receipt.version);
    let release_url =
        format!("https://github.com/{REPO}/releases/tag/triastasis-v{target_version}");
    let update_available = configured.is_some()
        && matches!(installed_backend, "cuda" | "cuda12" | "rocm" | "vulkan")
        && matches!(version_state.as_str(), "older" | "unknown")
        && pending_version.as_deref() != Some(target_version.as_str());
    let server = configured;
    let (recommended_backend, recommendation) = recommendation();
    Ok(RuntimeStatus {
        installed: server.is_some(),
        managed,
        version,
        version_state,
        release_url,
        target_version,
        update_available,
        pending_path: pending_version.as_ref().map(|_| {
            root.with_extension("pending")
                .to_string_lossy()
                .into_owned()
        }),
        pending_version,
        backend: installed_receipt
            .map(|receipt| receipt.backend)
            .or_else(|| {
                config
                    .as_ref()
                    .map(|config| config.backend.clone())
                    .filter(|backend| !backend.trim().is_empty() && backend != "unknown")
            })
            .unwrap_or_else(|| {
                if server.is_some() {
                    "unknown".into()
                } else {
                    recommended_backend.clone()
                }
            }),
        path: server
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        portable: crate::config::portable_mode_root().is_some(),
        recommended_backend,
        recommendation,
    })
}

fn release_url(file: &str) -> String {
    format!(
        "https://github.com/{REPO}/releases/download/triastasis-v{}/{file}",
        env!("CARGO_PKG_VERSION")
    )
}

fn download_url(file: &str) -> Result<String, String> {
    let override_base = std::env::var("TRIASTASIS_TEST_RUNTIME_RELEASE_URL").ok();
    download_url_with_override(file, override_base.as_deref(), cfg!(debug_assertions))
}

fn download_url_with_override(
    file: &str,
    override_base: Option<&str>,
    debug: bool,
) -> Result<String, String> {
    if !debug {
        return Ok(release_url(file));
    }
    let Some(base) = override_base else {
        return Ok(release_url(file));
    };
    let url = reqwest::Url::parse(base).map_err(|_| "invalid local runtime test URL")?;
    let numeric_loopback = url
        .host_str()
        .map(|host| {
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .map(|ip| ip.is_loopback())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let origin = url.origin().ascii_serialization();
    if (base != origin && base != format!("{origin}/"))
        || url.scheme() != "http"
        || !numeric_loopback
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || file.is_empty()
        || !file
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
        || file == "."
        || file == ".."
    {
        return Err("local runtime tests require HTTP on a numeric loopback address with an explicit port and no path, credentials, query, or fragment".into());
    }
    Ok(format!("{}{file}", url.as_str()))
}

fn download(
    client: &reqwest::blocking::Client,
    url: &str,
    path: &Path,
    resume: bool,
) -> Result<(), String> {
    let offset = if resume {
        std::fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    } else {
        0
    };
    let mut request = client.get(url);
    if offset > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    let mut response = request
        .send()
        .map_err(|error| format!("download request failed: {error}"))?;
    if offset > 0 && response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        std::fs::remove_file(path).ok();
        return download(client, url, path, false);
    }
    let appending = offset > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !response.status().is_success() {
        return Err(format!("download failed with HTTP {}", response.status()));
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    if appending {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    std::io::copy(&mut response, &mut file)
        .map_err(|error| format!("could not save {}: {error}", path.display()))?;
    file.flush()
        .map_err(|error| format!("could not finish download: {error}"))
}

fn hash(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn inspect_archive(archive: &Path) -> Result<(), String> {
    let mut command = Command::new("tar.exe");
    command.args(["-tf"]).arg(archive);
    hidden(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("Windows archive support is unavailable: {error}"))?;
    if !output.status.success() {
        return Err("the downloaded runtime archive could not be inspected".into());
    }
    let listing = String::from_utf8(output.stdout)
        .map_err(|_| "the runtime archive contains invalid file names".to_string())?;
    for entry in listing.lines().filter(|entry| !entry.trim().is_empty()) {
        if Path::new(entry.trim()).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(format!(
                "the runtime archive contains an unsafe path: {entry}"
            ));
        }
    }
    Ok(())
}

fn extract(archive: &Path, staging: &Path) -> Result<(), String> {
    std::fs::create_dir_all(staging).map_err(|error| error.to_string())?;
    let mut command = Command::new("tar.exe");
    command.arg("-xf").arg(archive).arg("-C").arg(staging);
    hidden(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    output
        .status
        .success()
        .then_some(())
        .ok_or_else(|| "Windows could not extract the verified runtime archive".into())
}

fn activate(root: &Path, staging: &Path, backend: &str) -> Result<(), String> {
    if !staging.join(server_name()).is_file() {
        return Err("trellis-server.exe was not found in the runtime archive".into());
    }
    let backup = root.with_extension("previous");
    if backup.exists() {
        std::fs::remove_dir_all(&backup).map_err(|error| error.to_string())?;
    }
    let had_existing = root.exists();
    if had_existing {
        std::fs::rename(root, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = std::fs::rename(staging, root) {
        if had_existing {
            std::fs::rename(&backup, root).ok();
        }
        return Err(format!("could not activate the runtime: {error}"));
    }

    let models = crate::models::default_models_root();
    let mut config = crate::config::load().unwrap_or_else(|| crate::config::Config {
        server_bin: String::new(),
        models_dir: models.to_string_lossy().into_owned(),
        backend: backend.into(),
        gpu: 0,
        host: "127.0.0.1".into(),
        port: 8080,
        output_dir: crate::config::default_output_dir(),
        models_root: models.to_string_lossy().into_owned(),
        active_bundle: String::new(),
        custom_models_dir: String::new(),
    });
    config.server_bin = root.join(server_name()).to_string_lossy().into_owned();
    config.backend = backend.into();
    // An empty models root with a configured models directory means "derive the
    // root from that directory" (including legacy flat layouts). Only fill in
    // defaults when no model location is configured at all.
    if config.models_root.trim().is_empty() && config.models_dir.trim().is_empty() {
        config.models_root = models.to_string_lossy().into_owned();
    }
    if config.models_dir.trim().is_empty() {
        config.models_dir = config.models_root.clone();
    }
    if config.output_dir.trim().is_empty() {
        config.output_dir = crate::config::default_output_dir();
    }
    if let Err(error) = crate::config::save(&config) {
        std::fs::remove_dir_all(root).ok();
        if had_existing {
            std::fs::rename(&backup, root).ok();
        }
        return Err(format!(
            "runtime installed but configuration could not be saved: {error}"
        ));
    }
    // Keep the last working runtime available for manual rollback.
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_or_stage(
    backend: &str,
    update: bool,
    state: Option<&crate::server::ServerState>,
) -> Result<RuntimeStatus, String> {
    if !matches!(backend, "cuda" | "cuda12" | "rocm" | "vulkan") {
        return Err("choose CUDA, CUDA 12 compatibility, ROCm, or Vulkan".into());
    }
    // Every backend uses the same staging and activation paths. Keep the
    // complete transaction serialized even if the frontend invokes it twice.
    let _install_guard = operation_guard()?;
    let current = status()?;
    if update {
        if !current.installed {
            return Err("no runtime is installed; complete runtime setup first".into());
        }
        if backend != current.backend {
            return Err("the update backend must match the installed runtime".into());
        }
        if root()?.with_extension("pending").exists() && current.pending_version.is_none() {
            return Err("a staged update for another version or backend exists; remove runtime.pending from the runtime parent directory before downloading again".into());
        }
        if !current.update_available {
            return Ok(current);
        }
    } else if current.installed {
        return Ok(current);
    }

    if !update {
        if let (Some(state), Some(cfg)) = (state, crate::config::load()) {
            if crate::server::is_available(state, &cfg) {
                return Err("the runtime cannot be installed while a server is running".into());
            }
        }
    }
    let root = root()?;
    let parent = root.parent().ok_or("invalid runtime installation path")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let artifact = format!("trellis-{backend}-windows-x64.zip");
    let archive = parent.join(format!("{artifact}.download"));
    let checksum = parent.join("SHA256SUMS.download");
    let staging = parent.join("runtime.installing");
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }
    std::fs::remove_file(&checksum).ok();

    let client_builder = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(2 * 60 * 60))
        .user_agent(format!("Triastasis/{}", env!("CARGO_PKG_VERSION")));
    #[cfg(debug_assertions)]
    let client_builder = if std::env::var_os("TRIASTASIS_TEST_RUNTIME_RELEASE_URL").is_some() {
        client_builder.redirect(reqwest::redirect::Policy::none())
    } else {
        client_builder
    };
    let client = client_builder.build().map_err(|error| error.to_string())?;
    let result = (|| {
        download(&client, &download_url("SHA256SUMS")?, &checksum, false)?;
        download(&client, &download_url(&artifact)?, &archive, true)?;
        let text = std::fs::read_to_string(&checksum).map_err(|error| error.to_string())?;
        let expected = checksum_for(&text, &artifact)?;
        if hash(&archive)? != expected {
            std::fs::remove_file(&archive).ok();
            return Err("SHA-256 verification failed. The runtime was not installed.".into());
        }
        inspect_archive(&archive)?;
        extract(&archive, &staging)?;
        if !staging.join(server_name()).is_file() {
            return Err("trellis-server.exe was not found in the runtime archive".into());
        }
        let receipt = RuntimeReceipt {
            version: env!("CARGO_PKG_VERSION").into(),
            backend: backend.into(),
            archive_sha256: expected,
        };
        std::fs::write(
            staging.join(RECEIPT),
            serde_json::to_vec_pretty(&receipt).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        if update {
            // Leave the active binary untouched. Startup activates only with no reachable server.
            let pending = root.with_extension("pending");
            if pending.exists() {
                return Err(
                    "a runtime update is already staged; restart Triastasis to apply it".into(),
                );
            }
            std::fs::rename(&staging, pending).map_err(|error| error.to_string())
        } else {
            activate(&root, &staging, backend)
        }
    })();
    if result.is_ok() {
        std::fs::remove_file(&archive).ok();
    }
    std::fs::remove_file(checksum).ok();
    if result.is_err() {
        std::fs::remove_dir_all(staging).ok();
    }
    result?;
    status()
}

#[cfg(target_os = "windows")]
pub fn install(backend: &str, state: &crate::server::ServerState) -> Result<RuntimeStatus, String> {
    install_or_stage(backend, false, Some(state))
}

#[cfg(target_os = "windows")]
pub fn update(backend: &str) -> Result<RuntimeStatus, String> {
    install_or_stage(backend, true, None)
}

#[cfg(not(target_os = "windows"))]
pub fn update(_backend: &str) -> Result<RuntimeStatus, String> {
    Err("automatic runtime updates are currently available on Windows only".into())
}

/// Called before autostart. A staged update never stops or replaces a live server.
pub fn activate_pending(state: &crate::server::ServerState) -> Result<(), String> {
    let _guard = operation_guard()?;
    let root = root()?;
    let pending = root.with_extension("pending");
    if !pending.exists() {
        return Ok(());
    }
    let current = status()?;
    if current.version_state == "newer" {
        return Err(
            "staged update retained because the installed runtime is newer than this app".into(),
        );
    }
    let cfg = crate::config::load().ok_or("runtime configuration is unavailable")?;
    if crate::server::is_available(state, &cfg) {
        return Err("staged runtime update retained because the server is still running".into());
    }
    let receipt = receipt(&pending).ok_or("staged runtime update receipt is invalid")?;
    if !pending_matches(&receipt, &current.backend, env!("CARGO_PKG_VERSION")) {
        return Err("staged runtime update does not match this app version and backend".into());
    }
    activate(&root, &pending, &receipt.backend)
}

#[cfg(not(target_os = "windows"))]
pub fn install(
    _backend: &str,
    _state: &crate::server::ServerState,
) -> Result<RuntimeStatus, String> {
    Err("automatic runtime installation is currently available on Windows only".into())
}

#[cfg(test)]
mod tests {
    use super::{
        checksum_for, pending_matches, receipt, recommendation_for_capability, RuntimeReceipt,
    };

    #[test]
    fn local_download_override_is_debug_only_and_numeric_loopback_only() {
        assert_eq!(
            super::download_url_with_override("SHA256SUMS", Some("http://127.0.0.1:48804"), true)
                .unwrap(),
            "http://127.0.0.1:48804/SHA256SUMS"
        );
        assert!(
            super::download_url_with_override("SHA256SUMS", Some("http://[::1]:48804/"), true)
                .is_ok()
        );
        for base in [
            "http://localhost:48804",
            "https://127.0.0.1:48804",
            "http://192.168.1.2:48804",
            "http://127.0.0.1",
            "http://user@127.0.0.1:48804",
            "http://127.0.0.1:48804/path",
            "http://127.0.0.1:48804/path/..",
            "http://127.0.0.1:48804?x=1",
            "http://127.0.0.1:48804#x",
        ] {
            assert!(
                super::download_url_with_override("SHA256SUMS", Some(base), true).is_err(),
                "accepted {base}"
            );
        }
        assert!(super::download_url_with_override(
            "../archive.zip",
            Some("http://127.0.0.1:48804"),
            true
        )
        .is_err());
        assert_eq!(
            super::download_url_with_override("SHA256SUMS", Some("https://evil.invalid"), false)
                .unwrap(),
            super::release_url("SHA256SUMS")
        );
    }

    #[test]
    fn distinguishes_unknown_older_current_and_newer_versions() {
        assert_eq!(super::version_state(None, "0.0.4"), "unknown");
        assert_eq!(
            super::version_state(Some("not-a-version"), "0.0.4"),
            "unknown"
        );
        assert_eq!(super::version_state(Some("0.0.3"), "0.0.4"), "older");
        assert_eq!(super::version_state(Some("0.0.4"), "0.0.4"), "current");
        assert_eq!(super::version_state(Some("0.0.5"), "0.0.4"), "newer");
        assert_eq!(
            super::version_state(Some("0.0.4-alpha.1"), "0.0.4"),
            "older"
        );
        assert_eq!(
            super::version_state(Some("0.0.4+local"), "0.0.4"),
            "current"
        );
    }

    #[test]
    fn missing_staged_server_preserves_existing_runtime() {
        let directory = std::env::temp_dir().join(format!(
            "triastasis-runtime-activation-test-{}",
            std::process::id()
        ));
        let root = directory.join("runtime");
        let staging = directory.join("runtime.pending");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(root.join(super::server_name()), "old runtime").unwrap();
        assert!(super::activate(&root, &staging, "vulkan").is_err());
        assert_eq!(
            std::fs::read_to_string(root.join(super::server_name())).unwrap(),
            "old runtime"
        );
        assert!(!root.with_extension("previous").exists());
        assert!(super::same_path(
            &root.join(super::server_name()),
            &root.join(".").join(super::server_name())
        ));
        assert!(!super::same_path(
            &root.join(super::server_name()),
            &staging.join(super::server_name())
        ));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn runtime_and_server_operations_cannot_overlap() {
        let guard = super::operation_guard().unwrap();
        assert!(super::operation_guard().is_err());
        drop(guard);
        assert!(super::operation_guard().is_ok());
    }

    #[test]
    fn pending_updates_require_matching_version_and_backend() {
        let value = RuntimeReceipt {
            version: "0.0.4".into(),
            backend: "vulkan".into(),
            archive_sha256: "a".repeat(64),
        };
        assert!(pending_matches(&value, "vulkan", "0.0.4"));
        assert!(!pending_matches(&value, "cuda", "0.0.4"));
        assert!(!pending_matches(&value, "vulkan", "0.0.5"));
    }

    #[test]
    fn legacy_and_malformed_receipts_are_unknown() {
        let directory = std::env::temp_dir().join(format!(
            "triastasis-runtime-receipt-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        assert!(receipt(&directory).is_none());
        let file = directory.join(super::RECEIPT);
        for invalid in [
            "{}",
            "not json",
            r#"{"version":"0.0.4","backend":"custom","archive_sha256":"bad"}"#,
        ] {
            std::fs::write(&file, invalid).unwrap();
            assert!(receipt(&directory).is_none());
        }
        let valid = RuntimeReceipt {
            version: "0.0.4".into(),
            backend: "vulkan".into(),
            archive_sha256: "a".repeat(64),
        };
        std::fs::write(&file, serde_json::to_vec(&valid).unwrap()).unwrap();
        assert_eq!(receipt(&directory).unwrap().version, "0.0.4");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn checksum_requires_exact_unique_filename_and_strict_format() {
        let digest = "a".repeat(64);
        let sums = format!("{digest}  other.zip\n{digest}  runtime.zip\n");
        assert_eq!(checksum_for(&sums, "runtime.zip").unwrap(), digest);
        assert!(checksum_for(&sums, "time.zip").is_err());
        for bad in [
            format!("{digest} runtime.zip"),
            format!("{digest}  runtime.zip\n{digest}  runtime.zip"),
            format!("{}  runtime.zip", "A".repeat(64)),
            format!("{digest}  ../runtime.zip"),
            format!("{digest}  runtime.zip "),
        ] {
            assert!(checksum_for(&bad, "runtime.zip").is_err(), "accepted {bad}");
        }
    }

    fn backend(capability: Option<f32>) -> String {
        recommendation_for_capability(capability).0
    }

    #[test]
    fn recommends_vulkan_without_supported_nvidia_compute() {
        assert_eq!(backend(None), "vulkan");
        assert_eq!(backend(Some(5.9)), "vulkan");
        assert_eq!(backend(Some(f32::NAN)), "vulkan");
    }

    #[test]
    fn recommends_cuda12_for_legacy_supported_compute() {
        assert_eq!(backend(Some(6.0)), "cuda12");
        assert_eq!(backend(Some(7.4)), "cuda12");
    }

    #[test]
    fn recommends_current_cuda_from_compute_75() {
        assert_eq!(backend(Some(7.5)), "cuda");
        assert_eq!(backend(Some(12.0)), "cuda");
    }
}

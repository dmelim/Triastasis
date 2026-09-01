use serde::Serialize;
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::sync::Mutex;
use std::{
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

const REPO: &str = "dmelim/Triastasis";
#[cfg(target_os = "windows")]
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub installed: bool,
    pub backend: String,
    pub path: String,
    pub portable: bool,
    pub recommended_backend: String,
    pub recommendation: String,
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
    let server = configured;
    let (recommended_backend, recommendation) = recommendation();
    Ok(RuntimeStatus {
        installed: server.is_some(),
        backend: config
            .as_ref()
            .map(|config| config.backend.clone())
            .filter(|backend| !backend.trim().is_empty() && backend != "unknown")
            .unwrap_or_else(|| recommended_backend.clone()),
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
    let mut buffer = [0; 1024 * 1024];
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
    if config.models_root.trim().is_empty() {
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
    if backup.exists() {
        std::fs::remove_dir_all(backup).ok();
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn install(backend: &str) -> Result<RuntimeStatus, String> {
    if !matches!(backend, "cuda" | "cuda12" | "rocm" | "vulkan") {
        return Err("choose CUDA, CUDA 12 compatibility, ROCm, or Vulkan".into());
    }
    // Every backend uses the same staging and activation paths. Keep the
    // complete transaction serialized even if the frontend invokes it twice.
    let _install_guard = INSTALL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let current = status()?;
    if current.installed {
        return Ok(current);
    }

    let root = root()?;
    let parent = root.parent().ok_or("invalid runtime installation path")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let artifact = format!("trellis-{backend}-windows-x64.zip");
    let archive = parent.join(format!("{artifact}.download"));
    let checksum = parent.join(format!("{artifact}.sha256.download"));
    let staging = parent.join("runtime.installing");
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }
    std::fs::remove_file(&checksum).ok();

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(2 * 60 * 60))
        .user_agent(format!("Triastasis/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let result = (|| {
        download(
            &client,
            &release_url(&format!("{artifact}.sha256")),
            &checksum,
            false,
        )?;
        download(&client, &release_url(&artifact), &archive, true)?;
        let text = std::fs::read_to_string(&checksum).map_err(|error| error.to_string())?;
        let expected = text
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if expected.len() != 64
            || !expected
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err("the release checksum file is invalid".into());
        }
        if hash(&archive)? != expected {
            std::fs::remove_file(&archive).ok();
            return Err("SHA-256 verification failed. The runtime was not installed.".into());
        }
        inspect_archive(&archive)?;
        extract(&archive, &staging)?;
        activate(&root, &staging, backend)
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

#[cfg(not(target_os = "windows"))]
pub fn install(_backend: &str) -> Result<RuntimeStatus, String> {
    Err("automatic runtime installation is currently available on Windows only".into())
}

#[cfg(test)]
mod tests {
    use super::recommendation_for_capability;

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

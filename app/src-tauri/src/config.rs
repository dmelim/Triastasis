// config.json is the contract between the installer (writer) and the app
// (reader). In an installed build it lives at <config_dir>/triastasis/.
// The former trellis-studio path remains a read-only fallback for upgrades.
//
// PORTABLE MODE: if a `portable.dat` marker sits next to the executable (as in
// the portable .zip / .tar.gz), everything lives next to the exe instead —
// config + generated files under <exe-dir>/data/, and the server + models are
// picked up from <exe-dir>/runtime/ and <exe-dir>/models/ when present. Nothing
// touches the system config/data dirs, so the unzipped folder is self-contained.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    #[serde(rename = "serverBin", default)]
    pub server_bin: String,
    #[serde(rename = "modelsDir", default)]
    pub models_dir: String,
    #[serde(default = "default_backend")]
    pub backend: String,
    #[serde(default)]
    pub gpu: i32,
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// Where generated GLBs are auto-saved. Empty => use `default_output_dir()`.
    #[serde(rename = "outputDir", default)]
    pub output_dir: String,
    /// Managed models root (downloads/, installed/). Empty => derive from
    /// `modelsDir` (legacy flat layout). Optional; older configs stay valid.
    #[serde(rename = "modelsRoot", default)]
    pub models_root: String,
    /// Currently activated bundle id (e.g. "trellis2-q8"). Empty => no managed
    /// bundle is active; `modelsDir` is used as-is.
    #[serde(rename = "activeBundle", default)]
    pub active_bundle: String,
    /// Last custom model directory explicitly accepted by the user. Custom
    /// files remain user-owned and are never managed or deleted by Triastasis.
    #[serde(rename = "customModelsDir", default)]
    pub custom_models_dir: String,
}

fn default_backend() -> String {
    "unknown".to_string()
}
fn default_host() -> String {
    "127.0.0.1".to_string()
}
fn default_port() -> u16 {
    8080
}

/// The portable root (the executable's directory) when a `portable.dat` marker
/// is present next to it; otherwise None (installed mode). AppImages run from a
/// temp mount with no marker, so they correctly stay in installed mode.
fn portable_root() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    dir.join("portable.dat").exists().then_some(dir)
}

/// Public accessor for model management: portable installations must keep
/// models and download state next to the exe, never in AppData.
pub fn portable_mode_root() -> Option<PathBuf> {
    portable_root()
}

fn server_bin_name() -> &'static str {
    if cfg!(windows) {
        "trellis-server.exe"
    } else {
        "trellis-server"
    }
}

/// Default location for generated GLBs: <exe>/data/output in portable mode, else
/// <local-data>/triastasis/output (%LOCALAPPDATA%\... / ~/.local/share/...).
pub fn default_output_dir() -> String {
    if let Some(root) = portable_root() {
        return root
            .join("data")
            .join("output")
            .to_string_lossy()
            .into_owned();
    }
    dirs::data_local_dir()
        .map(|d| d.join("triastasis").join("output"))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The effective output dir (config value or default), created if missing.
pub fn resolve_output_dir() -> Result<PathBuf, String> {
    let dir = load()
        .map(|c| c.output_dir)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_output_dir);
    if dir.is_empty() {
        return Err("could not determine an output directory".to_string());
    }
    let p = PathBuf::from(dir);
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}

/// Where server launch logs are written: <exe>/data/logs in portable mode, else
/// <local-data>/triastasis/logs. Mirrors `default_output_dir()`.
pub fn logs_dir() -> String {
    if let Some(root) = portable_root() {
        return root
            .join("data")
            .join("logs")
            .to_string_lossy()
            .into_owned();
    }
    dirs::data_local_dir()
        .map(|d| d.join("triastasis").join("logs"))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The logs dir, created if missing.
pub fn resolve_logs_dir() -> Result<PathBuf, String> {
    let dir = logs_dir();
    if dir.is_empty() {
        return Err("could not determine a logs directory".to_string());
    }
    let p = PathBuf::from(dir);
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}

pub fn config_path() -> Option<PathBuf> {
    if let Some(root) = portable_root() {
        return Some(root.join("data").join("config.json"));
    }
    dirs::config_dir().map(|d| d.join("triastasis").join("config.json"))
}

fn legacy_config_path() -> Option<PathBuf> {
    portable_root()
        .is_none()
        .then(|| dirs::config_dir().map(|d| d.join("trellis-studio").join("config.json")))
        .flatten()
}

fn load_from_path(p: PathBuf) -> Option<Config> {
    let s = std::fs::read_to_string(p).ok()?;
    // Tolerate a UTF-8 BOM: some Windows editors / PowerShell's `Set-Content
    // -Encoding UTF8` prepend one, and serde_json won't parse past it.
    let s = s.strip_prefix('\u{feff}').unwrap_or(&s);
    serde_json::from_str(s).ok()
}

pub fn load() -> Option<Config> {
    if let Some(mut cfg) = config_path().and_then(load_from_path) {
        if let Some(root) = portable_root() {
            let previous = config_path().and_then(|path| std::fs::read_to_string(path).ok())
                .and_then(|text| serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')).ok())
                .and_then(|json| json.get("portableRoot").and_then(|value| value.as_str()).map(PathBuf::from));
            rebase_portable_paths(&mut cfg, &root, previous.as_deref());
        }
        return Some(cfg);
    }
    if let Some(cfg) = legacy_config_path().and_then(load_from_path) {
        return Some(cfg);
    }
    // Portable fallback: no config.json yet, but if the portable folder already
    // has a runtime/ + models/ layout, synthesize a usable config from it so the
    // app works the moment you drop those in and launch.
    let root = portable_root()?;
    let server = root.join("runtime").join(server_bin_name());
    server.exists().then(|| Config {
        server_bin: server.to_string_lossy().into_owned(),
        models_dir: root.join("models").to_string_lossy().into_owned(),
        backend: default_backend(),
        gpu: 0,
        host: default_host(),
        port: default_port(),
        output_dir: String::new(),
        models_root: String::new(),
        active_bundle: String::new(),
        custom_models_dir: String::new(),
    })
}

pub fn save(cfg: &Config) -> Result<(), String> {
    let p = config_path().ok_or("no config directory available")?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut value = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
    if let Some(root) = portable_root() {
        value["portableRoot"] = serde_json::Value::String(root.to_string_lossy().into_owned());
    }
    let s = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(p, s).map_err(|e| e.to_string())
}

/// Only paths in the conventional portable-managed layout move with the app.
/// Legacy portable configs have no root marker; their conventional runtime
/// path identifies that root. Explicit external model/output paths are retained.
fn rebase_portable_paths(cfg: &mut Config, root: &std::path::Path, previous: Option<&std::path::Path>) {
    let server = PathBuf::from(&cfg.server_bin);
    let server_root = server.parent().filter(|parent| parent.file_name().is_some_and(|name| name == "runtime"))
        .and_then(|parent| parent.parent());
    let models = PathBuf::from(&cfg.models_root);
    let model_root = models.parent().filter(|_| models.file_name().is_some_and(|name| name == "models"));
    // Older configs lack a root marker. Require corroborating conventional
    // paths; a deliberately external runtime may also live in a folder named runtime.
    let inferred = server_root.filter(|old| models == old.join("models") || PathBuf::from(&cfg.output_dir) == old.join("data/output"))
        .or_else(|| model_root.filter(|old| PathBuf::from(&cfg.output_dir) == old.join("data/output")));
    let Some(old) = previous.or(inferred) else { return; };
    if old == root { return; }
    if server == old.join("runtime").join(server_bin_name()) {
        cfg.server_bin = root.join("runtime").join(server_bin_name()).to_string_lossy().into_owned();
    }
    let old_models = old.join("models");
    if PathBuf::from(&cfg.models_root) == old_models {
        cfg.models_root = root.join("models").to_string_lossy().into_owned();
    }
    // A selected custom bundle is user-owned, even if its name resembles a managed path.
    if cfg.models_dir != cfg.custom_models_dir {
        if let Ok(relative) = std::path::Path::new(&cfg.models_dir).strip_prefix(&old_models) {
            if relative.as_os_str().is_empty() || relative.starts_with("installed") {
                cfg.models_dir = root.join("models").join(relative).to_string_lossy().into_owned();
            }
        }
    }
    if PathBuf::from(&cfg.output_dir) == old.join("data").join("output") {
        cfg.output_dir = root.join("data").join("output").to_string_lossy().into_owned();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn portable() -> Config {
        serde_json::from_value(serde_json::json!({
            "serverBin": "C:/old/runtime/trellis-server.exe",
            "modelsRoot": "C:/old/models",
            "modelsDir": "C:/old/models/installed/revision/q8",
            "activeBundle": "trellis2-q8", "outputDir": "C:/old/data/output"
        })).unwrap()
    }
    #[test]
    fn moved_portable_rebases_managed_paths_with_or_without_marker() {
        for marker in [None, Some(std::path::Path::new("C:/old"))] {
            let mut cfg = portable();
            rebase_portable_paths(&mut cfg, std::path::Path::new("D:/new"), marker);
            assert_eq!(PathBuf::from(cfg.server_bin), PathBuf::from("D:/new/runtime/trellis-server.exe"));
            assert_eq!(PathBuf::from(cfg.models_dir), PathBuf::from("D:/new/models/installed/revision/q8"));
            assert_eq!(PathBuf::from(cfg.models_root), PathBuf::from("D:/new/models"));
            assert_eq!(PathBuf::from(cfg.output_dir), PathBuf::from("D:/new/data/output"));
            assert_eq!(cfg.active_bundle, "trellis2-q8");
        }
    }
    #[test]
    fn moved_portable_preserves_explicit_custom_external_locations() {
        let mut cfg = portable();
        cfg.models_dir = "E:/custom".into(); cfg.custom_models_dir = cfg.models_dir.clone();
        cfg.models_root = "E:/managed".into(); cfg.output_dir = "E:/art".into();
        rebase_portable_paths(&mut cfg, std::path::Path::new("D:/new"), None);
        assert_eq!(cfg.models_dir, "E:/custom"); assert_eq!(cfg.custom_models_dir, "E:/custom");
        assert_eq!(cfg.models_root, "E:/managed"); assert_eq!(cfg.output_dir, "E:/art");
    }
    #[test]
    fn portable_marker_and_legacy_evidence_preserve_external_runtime() {
        for marker in [None, Some(std::path::Path::new("C:/old"))] {
            let mut cfg = portable(); cfg.server_bin = "E:/tools/runtime/trellis-server.exe".into();
            rebase_portable_paths(&mut cfg, std::path::Path::new("D:/new"), marker);
            assert_eq!(cfg.server_bin, "E:/tools/runtime/trellis-server.exe");
            assert_eq!(PathBuf::from(cfg.models_root), PathBuf::from("D:/new/models"));
        }
    }

}

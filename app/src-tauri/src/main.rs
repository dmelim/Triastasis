// Triastasis: Tauri v2 desktop shell around the trellis-server image-to-3D
// pipeline. Reads the installer-written config.json, launches & supervises the
// server, and exposes a few commands to the web UI.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod automation;
mod config;
mod downloader;
mod hardware;
mod manifest;
mod models;
mod server;
mod tray;

use automation::AutomationState;
use server::ServerState;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tray::LifecycleState;

#[tauri::command]
async fn preview_alpha(image: Vec<u8>, bg_removal: String) -> Result<Vec<u8>, String> {
    let cfg = config::load().ok_or("no config.json found")?;
    tauri::async_runtime::spawn_blocking(move || {
        if image.is_empty() {
            return Err("input image is empty".to_string());
        }

        let server_path = std::path::PathBuf::from(&cfg.server_bin);
        #[cfg(windows)]
        let cli_name = "trellis-cli.exe";
        #[cfg(not(windows))]
        let cli_name = "trellis-cli";
        let cli_path = server_path.with_file_name(cli_name);
        if !cli_path.exists() {
            return Err(format!(
                "mask preview tool not found: {}",
                cli_path.display()
            ));
        }

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let work =
            std::env::temp_dir().join(format!("trellis-mask-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let input_path = work.join("input.png");
        let output_path = work.join("preview.glb");
        let cutout_path = work.join("preview_cutout.png");
        std::fs::write(&input_path, image).map_err(|e| e.to_string())?;

        let mut cmd = std::process::Command::new(&cli_path);
        cmd.arg("--image")
            .arg(&input_path)
            .arg("--output")
            .arg(&output_path)
            .arg("--models")
            .arg(&cfg.models_dir)
            .arg("--gpu")
            .arg(cfg.gpu.to_string())
            .arg("--res")
            .arg("512")
            .arg("--bg-only");
        if bg_removal == "birefnet" || bg_removal == "threshold" {
            cmd.arg("--bg-removal").arg(&bg_removal);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let result = cmd
            .output()
            .map_err(|e| format!("could not run mask preview: {e}"));
        let response = match result {
            Ok(output) if output.status.success() => {
                std::fs::read(&cutout_path).map_err(|e| format!("could not read mask preview: {e}"))
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                let detail = if stderr.trim().is_empty() {
                    stdout.trim()
                } else {
                    stderr.trim()
                };
                Err(format!("mask preview failed: {detail}"))
            }
            Err(e) => Err(e),
        };
        let _ = std::fs::remove_dir_all(&work);
        response
    })
    .await
    .map_err(|e| format!("mask preview task failed: {e}"))?
}

#[tauri::command]
fn get_config() -> Option<config::Config> {
    config::load().map(|mut c| {
        if c.output_dir.trim().is_empty() {
            c.output_dir = config::default_output_dir();
        }
        c
    })
}

#[tauri::command]
fn save_config(config: config::Config) -> Result<(), String> {
    config::save(&config)
}

#[tauri::command]
fn default_output_dir() -> String {
    config::default_output_dir()
}

/// Resolve the output dir (creating it), return the full path for `name` so the UI
/// can write the GLB there via the fs plugin.
#[tauri::command]
fn output_path(name: String) -> Result<String, String> {
    let dir = config::resolve_output_dir()?;
    Ok(dir.join(name).to_string_lossy().into_owned())
}

/// Open `path` in the OS file browser (Explorer / Finder / xdg-open).
fn open_in_file_browser(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(path);
    // explorer.exe returns a non-zero exit code even on success; spawn() ignores it.
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Open the output directory in the OS file browser.
/// AppData\Local is awkward to reach in Explorer, so this button matters.
#[tauri::command]
fn open_output_dir() -> Result<(), String> {
    let dir = config::resolve_output_dir()?;
    open_in_file_browser(&dir)
}

/// The logs directory path (whether or not it exists yet).
#[tauri::command]
fn logs_dir() -> String {
    config::logs_dir()
}

/// Open the logs directory in the OS file browser, creating it if needed.
#[tauri::command]
fn open_logs_dir() -> Result<(), String> {
    let dir = config::resolve_logs_dir()?;
    open_in_file_browser(&dir)
}

/// Path of the current/last server launch's log file, if any.
#[tauri::command]
fn current_log_path(state: tauri::State<ServerState>) -> Option<String> {
    server::log_path(state.inner())
}

#[tauri::command]
fn restart_server(app: tauri::AppHandle) -> Result<(), String> {
    tray::restart_services(&app)
}

#[tauri::command]
fn server_running(state: tauri::State<ServerState>) -> bool {
    server::is_running(state.inner())
}

#[tauri::command]
fn automation_info(state: tauri::State<AutomationState>) -> automation::AutomationInfo {
    automation::info(state.inner())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn read_generation_manifest(path: String) -> Result<manifest::ManifestPreview, String> {
    manifest::read_generation_manifest_impl(&path)
}

#[tauri::command]
fn import_generation_manifest(path: String) -> Result<manifest::ImportedGeneration, String> {
    manifest::import_generation_manifest_impl(&path)
}

/// Write a manifest beside its generation. The frontend sends the structured
/// manifest with blank hashes; the writer fills them from existing files.
/// `fileName` pins the manifest filename (resume flows reuse the same file).
#[tauri::command]
async fn write_generation_manifest(
    dir: String,
    manifest: manifest::GenerationManifest,
    file_name: Option<String>,
) -> Result<String, String> {
    let dir = std::path::PathBuf::from(dir);
    if !dir.is_absolute() {
        return Err("manifest directory must be absolute".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let target =
            manifest::write_generation_manifest_impl(&dir, manifest, file_name.as_deref())?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("manifest task failed: {e}"))?
}

#[tauri::command]
fn read_manifest_asset(path: String, role: String) -> Result<Vec<u8>, String> {
    manifest::read_manifest_asset_impl(&path, &role)
}

/// Removes a staged file from the output directory (sweep-preparation
/// rollback). The path must resolve inside the configured output directory.
#[tauri::command]
fn remove_output_file(path: String) -> Result<(), String> {
    let dir = config::resolve_output_dir()?;
    let candidate = std::path::PathBuf::from(&path);
    if !candidate.is_absolute() {
        return Err("file path must be absolute".to_string());
    }
    let canonical_dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let canonical = candidate.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_dir) {
        return Err("file path is outside the output directory".to_string());
    }
    std::fs::remove_file(&canonical).map_err(|e| e.to_string())
}

#[tauri::command]
fn relink_manifest_file(
    manifest_path: String,
    role: String,
    source_path: String,
) -> Result<manifest::GenerationManifest, String> {
    manifest::relink_manifest_file_impl(&manifest_path, &role, &source_path)
}

#[tauri::command]
fn find_linked_manifest(glb_path: String) -> Option<String> {
    manifest::find_linked_manifest_impl(&glb_path)
}

#[tauri::command]
fn scan_interrupted_manifests() -> Vec<(String, manifest::GenerationManifest)> {
    manifest::scan_interrupted_manifests_impl()
}

#[tauri::command]
fn list_sibling_manifests(path: String) -> Result<Vec<String>, String> {
    manifest::list_sibling_manifests_impl(&path)
}

// ---- model management (Phase 1: catalog + detection + verification) ---------

#[tauri::command]
fn model_catalog() -> Result<Vec<models::BundleSummary>, String> {
    let cat = models::catalog()?;
    Ok(cat
        .bundles
        .iter()
        .map(|b| models::BundleSummary {
            id: b.id.clone(),
            display_name: b.display_name.clone(),
            quantization: b.quantization.clone(),
            file_count: b.files.len(),
            total_bytes: models::ModelCatalog::total_bytes(b),
        })
        .collect())
}

#[tauri::command]
fn scan_models() -> Result<models::ModelsScan, String> {
    models::scan_models()
}

/// Full size+SHA-256 verification of one bundle inside the managed root,
/// writing the installation.json commit marker on success. Blocking; called
/// from the UI after downloads or manual/offline placement.
#[tauri::command]
async fn verify_model_bundle(bundle_id: String) -> Result<String, String> {
    let cat = models::catalog()?;
    // Resolve the root before entering the blocking task.
    let cfg = config::load();
    let models_dir = cfg
        .as_ref()
        .filter(|c| !c.models_dir.trim().is_empty())
        .map(|c| std::path::PathBuf::from(c.models_dir.trim()))
        .unwrap_or_else(models::default_models_root);
    let root = models::resolve_models_root(&models_dir, cat);
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = downloader::acquire_models_lock(&root)?;
        models::verify_and_register(&root, &bundle_id).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("verification task failed: {e}"))?
}

#[tauri::command]
fn free_disk_space(path: String) -> Result<u64, String> {
    models::free_space_bytes(std::path::Path::new(&path))
}

/// Start (or resume) downloading a bundle. Returns immediately; progress
/// arrives as `model-download-progress` events and via `model_download_status`.
/// Resuming picks up from existing partial files automatically.
#[tauri::command]
fn start_model_download(app: tauri::AppHandle, bundle_id: String) -> Result<(), String> {
    models::catalog()?
        .bundle(&bundle_id)
        .ok_or_else(|| format!("unknown bundle: {bundle_id}"))?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let control = handle.state::<downloader::DownloadControl>();
        let result = downloader::run_download(&handle, control.inner(), &bundle_id);
        if let Err(e) = &result {
            eprintln!("[studio] model download failed: {e}");
        }
        result
    });
    Ok(())
}

#[tauri::command]
fn pause_model_download(state: tauri::State<downloader::DownloadControl>) -> Result<(), String> {
    state.request_pause()
}

#[tauri::command]
fn cancel_model_download(state: tauri::State<downloader::DownloadControl>) -> Result<(), String> {
    state.request_cancel()
}

#[tauri::command]
fn model_download_status(
    state: tauri::State<downloader::DownloadControl>,
) -> Option<downloader::DownloadStatus> {
    state.status()
}

/// Partial downloads found in the managed root (restart recovery).
#[tauri::command]
fn scan_partial_downloads() -> Result<Vec<String>, String> {
    let cat = models::catalog()?;
    let cfg = config::load();
    let models_dir = cfg
        .as_ref()
        .filter(|c| !c.models_dir.trim().is_empty())
        .map(|c| std::path::PathBuf::from(c.models_dir.trim()))
        .unwrap_or_else(models::default_models_root);
    let root = models::resolve_models_root(&models_dir, cat);
    Ok(downloader::scan_partial_downloads(&root)
        .into_iter()
        .filter(|id| cat.bundle(id).is_some())
        .collect())
}

/// Discard one interrupted download's partial files (restart recovery).
/// Only removes data owned by that bundle's download directory.
#[tauri::command]
fn discard_model_download(bundle_id: String) -> Result<(), String> {
    let cat = models::catalog()?;
    cat.bundle(&bundle_id)
        .ok_or_else(|| format!("unknown bundle: {bundle_id}"))?;
    let cfg = config::load();
    let models_dir = cfg
        .as_ref()
        .filter(|c| !c.models_dir.trim().is_empty())
        .map(|c| std::path::PathBuf::from(c.models_dir.trim()))
        .unwrap_or_else(models::default_models_root);
    let root = models::resolve_models_root(&models_dir, cat);
    let _lock = downloader::acquire_models_lock(&root)?;
    downloader::remove_bundle_partials(&root.join("downloads").join(&bundle_id));
    Ok(())
}

/// Remove an inactive, incomplete managed bundle and all of its partial files.
/// This is intentionally separate from ordinary removal so the frontend can
/// require explicit confirmation after a recovery attempt fails.
#[tauri::command]
fn reset_incomplete_model_bundle(bundle_id: String) -> Result<(), String> {
    let cat = models::catalog()?;
    cat.bundle(&bundle_id)
        .ok_or_else(|| format!("unknown bundle: {bundle_id}"))?;

    let scan = models::scan_models()?;
    if scan.active_bundle.as_deref() == Some(bundle_id.as_str()) {
        return Err("cannot delete the active bundle; switch to another one first".to_string());
    }

    let managed = scan.managed.iter().find(|m| m.bundle_id == bundle_id);
    if managed.is_some_and(|entry| entry.registered) {
        return Err("this bundle is installed and verified; use Remove instead".to_string());
    }

    let root = std::path::Path::new(&scan.models_root);
    let _lock = downloader::acquire_models_lock(root)?;
    if let Some(entry) = managed {
        let path = std::path::Path::new(&entry.dir);
        if path.exists() {
            std::fs::remove_dir_all(path)
                .map_err(|e| format!("could not remove incomplete bundle: {e}"))?;
        }
    }
    downloader::remove_bundle_partials(&root.join("downloads").join(&bundle_id));
    Ok(())
}

/// Point the server at a verified bundle and restart it. Reversible: on
/// failure the previous configuration is restored and restarted.
#[tauri::command]
fn activate_model_bundle(
    app: tauri::AppHandle,
    automation: tauri::State<AutomationState>,
    bundle_id: String,
) -> Result<(), String> {
    let scan = models::scan_models()?;
    let entry = scan
        .managed
        .iter()
        .find(|m| m.bundle_id == bundle_id && m.registered)
        .ok_or("bundle is not installed and verified yet")?;
    let leaf = entry.dir.clone();
    let root = scan.models_root.clone();

    // Queue-idle gating: activation must not interrupt running generations.
    match automation::quiesce_if_idle(automation.inner()) {
        Ok(()) => {}
        Err(automation::MaintenanceError::AlreadyInProgress) => {
            return Err("another maintenance operation is already in progress".to_string());
        }
        Err(automation::MaintenanceError::Busy(_)) => {
            return Err("wait until all generations finish before switching bundles".to_string());
        }
    }

    let previous = config::load().map(|c| (c.models_dir, c.models_root, c.active_bundle));
    let apply = || -> Result<(), String> {
        let mut cfg = config::load().ok_or("no config.json found")?;
        cfg.models_dir = leaf.clone();
        cfg.models_root = root.clone();
        cfg.active_bundle = bundle_id.clone();
        config::save(&cfg)?;
        tray::restart_services(&app)
    };
    match apply() {
        Ok(()) => {
            automation::resume(automation.inner());
            Ok(())
        }
        Err(e) => {
            // Roll back to the previously active configuration.
            if let Some((dir, r#root, active)) = previous {
                if let Some(mut cfg) = config::load() {
                    cfg.models_dir = dir;
                    cfg.models_root = r#root;
                    cfg.active_bundle = active;
                    config::save(&cfg).ok();
                }
            }
            tray::restart_services(&app).ok();
            automation::resume(automation.inner());
            Err(format!("activation failed, previous bundle restored: {e}"))
        }
    }
}

/// Activate a user-selected local model folder without claiming catalog or
/// publisher verification. The folder remains user-owned and is never copied
/// or deleted by this command.
#[tauri::command]
fn activate_custom_model_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let requested = path.trim();
    if requested.is_empty() {
        return Err("choose a custom model folder first".to_string());
    }
    let (canonical, _) = models::inspect_custom_model_dir(std::path::Path::new(requested))?;
    let custom_dir = canonical.to_string_lossy().into_owned();
    let previous = config::load().ok_or("no config.json found")?;
    let mut next = previous.clone();
    if next.models_root.trim().is_empty() {
        let scan = models::scan_models()?;
        next.models_root = scan.models_root;
    }
    next.models_dir = custom_dir.clone();
    next.custom_models_dir = custom_dir;
    next.active_bundle = models::CUSTOM_BUNDLE_ID.to_string();
    config::save(&next)?;

    match tray::restart_services(&app) {
        Ok(()) => Ok(()),
        Err(error) => {
            config::save(&previous).ok();
            tray::restart_services(&app).ok();
            Err(format!(
                "custom model activation failed, previous model folder restored: {error}"
            ))
        }
    }
}

/// Forget a custom folder without touching any files inside it.
#[tauri::command]
fn forget_custom_model_directory() -> Result<(), String> {
    let mut cfg = config::load().ok_or("no config.json found")?;
    if cfg.active_bundle == models::CUSTOM_BUNDLE_ID {
        return Err(
            "switch to another model bundle before forgetting the active custom folder".to_string(),
        );
    }
    cfg.custom_models_dir.clear();
    config::save(&cfg)
}

/// Remove an installed but inactive bundle after explicit confirmation.
#[tauri::command]
fn remove_model_bundle(bundle_id: String) -> Result<(), String> {
    let scan = models::scan_models()?;
    if scan.active_bundle.as_deref() == Some(bundle_id.as_str()) {
        return Err("cannot remove the active bundle; switch to another one first".to_string());
    }
    let entry = scan
        .managed
        .iter()
        .find(|m| m.bundle_id == bundle_id)
        .ok_or("bundle is not installed")?;
    let _lock = downloader::acquire_models_lock(std::path::Path::new(&scan.models_root))?;
    std::fs::remove_dir_all(&entry.dir).map_err(|e| format!("could not remove bundle: {e}"))
}

fn main() {
    // WebKitGTK ≥2.42 + the NVIDIA proprietary driver (and some other GPU/driver
    // combos) render a blank white window through the DMA-BUF path, and can even
    // crash the compositor on launch. Disabling that path fixes it with no
    // downside for this app's simple WebGL preview. Only set it if the user
    // hasn't already, so an explicit override still wins. (Linux only.)
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ServerState::default())
        .manage(AutomationState::default())
        .manage(downloader::DownloadControl::default())
        .manage(LifecycleState::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            default_output_dir,
            output_path,
            open_output_dir,
            logs_dir,
            open_logs_dir,
            current_log_path,
            restart_server,
            server_running,
            automation_info,
            hardware::detect_hardware_info,
            preview_alpha,
            app_version,
            read_generation_manifest,
            import_generation_manifest,
            write_generation_manifest,
            read_manifest_asset,
            remove_output_file,
            relink_manifest_file,
            find_linked_manifest,
            scan_interrupted_manifests,
            list_sibling_manifests,
            model_catalog,
            scan_models,
            verify_model_bundle,
            free_disk_space,
            start_model_download,
            pause_model_download,
            cancel_model_download,
            model_download_status,
            scan_partial_downloads,
            discard_model_download,
            reset_incomplete_model_bundle,
            activate_model_bundle,
            activate_custom_model_directory,
            forget_custom_model_directory,
            remove_model_bundle
        ])
        .setup(|app| {
            // Auto-launch the server if the installer already wrote a usable config.
            if let Some(cfg) = config::load() {
                if !cfg.server_bin.is_empty() {
                    let state = app.state::<ServerState>();
                    // Autostart may adopt a server already on the port (manual
                    // launch / pre-fix orphan) rather than fail to bind.
                    if let Err(e) = server::start(app.handle(), &cfg, state.inner(), true) {
                        eprintln!("[studio] server autostart failed: {e}");
                    }
                    let automation_state = app.state::<AutomationState>();
                    if let Err(e) = automation::start(&cfg, automation_state.inner()) {
                        eprintln!("[studio] automation API failed: {e}");
                    }
                }
            }
            tray::setup(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<LifecycleState>().is_quitting() {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit("studio-hidden", ());
                    if window
                        .state::<LifecycleState>()
                        .should_show_background_notice()
                    {
                        let _ = window
                            .app_handle()
                            .notification()
                            .builder()
                            .title("Triastasis is still running")
                            .body(
                                "Triastasis will stay open in the background so you can use the API. Quit it from the system tray when you are done.",
                            )
                            .show();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Triastasis")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                automation::stop(app.state::<AutomationState>().inner());
                server::stop(app.state::<ServerState>().inner());
            }
        });
}

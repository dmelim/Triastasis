use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::{automation, config, open_in_file_browser, server, AutomationState, ServerState};

const OPEN_ID: &str = "open-studio";
const STATUS_ID: &str = "server-status";
const OUTPUT_ID: &str = "open-output";
const RESTART_ID: &str = "restart-server";
const QUIT_ID: &str = "quit-studio";

#[derive(Default)]
pub struct LifecycleState {
    quitting: AtomicBool,
}

impl LifecycleState {
    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::Relaxed)
    }

    fn begin_quit(&self) {
        self.quitting.store(true, Ordering::Relaxed);
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = app.emit("studio-shown", ());
    }
}

fn maintenance_message(action: &str, error: automation::MaintenanceError) -> String {
    match error {
        automation::MaintenanceError::Busy(snapshot) => format!(
            "Cannot {action} while {} job{} running and {} queued",
            snapshot.running,
            if snapshot.running == 1 {
                " is"
            } else {
                "s are"
            },
            snapshot.queued
        ),
        automation::MaintenanceError::AlreadyInProgress => {
            format!("Cannot {action}; another server maintenance operation is already in progress")
        }
    }
}

pub fn restart_services(app: &AppHandle) -> Result<(), String> {
    if let Err(error) = automation::quiesce_if_idle(app.state::<AutomationState>().inner()) {
        let message = maintenance_message("restart the server", error);
        show_main_window(app);
        return Err(message);
    }
    let cfg = match config::load() {
        Some(cfg) => cfg,
        None => {
            automation::resume(app.state::<AutomationState>().inner());
            return Err("no config.json found".to_string());
        }
    };
    if let Err(error) = server::start(app, &cfg, app.state::<ServerState>().inner(), false) {
        automation::resume(app.state::<AutomationState>().inner());
        return Err(error);
    }
    if let Err(error) = automation::start(&cfg, app.state::<AutomationState>().inner()) {
        automation::resume(app.state::<AutomationState>().inner());
        return Err(error);
    }
    let _ = app.emit("server-restarted", ());
    Ok(())
}

fn status_text(app: &AppHandle) -> String {
    let api = automation::info(app.state::<AutomationState>().inner());
    let snapshot = automation::queue_snapshot(app.state::<AutomationState>().inner());
    let native_ready = config::load()
        .map(|cfg| server::is_available(app.state::<ServerState>().inner(), &cfg))
        .unwrap_or(false);

    if !native_ready {
        return if api.running {
            "Trellis server offline · API queue active".to_string()
        } else {
            "Trellis server offline · API offline".to_string()
        };
    }
    if !api.running {
        return "Trellis server ready · API offline".to_string();
    }
    match (snapshot.running, snapshot.queued) {
        (0, 0) => "Trellis ready · API queue idle".to_string(),
        (running, queued) => format!("Trellis ready · {} running · {} queued", running, queued),
    }
}

fn start_status_updater(app: &AppHandle, status: MenuItem<tauri::Wry>) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        let _ = status.set_text(status_text(&app));
        if app.state::<LifecycleState>().is_quitting() {
            break;
        }
        std::thread::sleep(Duration::from_secs(2));
    });
}

fn request_quit(app: &AppHandle) {
    if let Err(error) = automation::quiesce_if_idle(app.state::<AutomationState>().inner()) {
        let message = maintenance_message("quit Triastasis", error);
        show_main_window(app);
        let _ = app.emit("tray-action-blocked", message);
        return;
    }
    app.state::<LifecycleState>().begin_quit();
    app.exit(0);
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Triastasis", true, None::<&str>)?;
    let status = MenuItem::with_id(
        app,
        STATUS_ID,
        "Server ready · API queue active",
        false,
        None::<&str>,
    )?;
    let output = MenuItem::with_id(app, OUTPUT_ID, "Open output folder", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, RESTART_ID, "Restart server", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit Triastasis", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &status, &output, &restart, &quit])?;

    let mut builder = TrayIconBuilder::with_id("triastasis-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Triastasis: automation ready")
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => show_main_window(app),
            OUTPUT_ID => match config::resolve_output_dir() {
                Ok(path) => {
                    if let Err(error) = open_in_file_browser(&path) {
                        show_main_window(app);
                        let _ = app.emit("tray-action-blocked", error);
                    }
                }
                Err(error) => {
                    show_main_window(app);
                    let _ = app.emit("tray-action-blocked", error);
                }
            },
            RESTART_ID => {
                if let Err(error) = restart_services(app) {
                    eprintln!("[studio] tray restart blocked: {error}");
                    let _ = app.emit("tray-action-blocked", error);
                }
            }
            QUIT_ID => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let open = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            );
            if open {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    start_status_updater(app.handle(), status);
    Ok(())
}

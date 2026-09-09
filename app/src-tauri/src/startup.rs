use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

static REVEALED: AtomicBool = AtomicBool::new(false);

/// Reveal only once so the delayed fallback cannot steal focus or reopen a
/// window the user has since hidden. A failed show leaves the fallback usable.
pub fn reveal(app: &tauri::AppHandle) {
    if REVEALED.swap(true, Ordering::SeqCst) {
        return;
    }
    let shown = app
        .get_webview_window("main")
        .map(|window| {
            if window.show().is_err() {
                return false;
            }
            let _ = window.set_focus();
            true
        })
        .unwrap_or(false);
    if !shown {
        REVEALED.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn reveal_startup_window(app: tauri::AppHandle) {
    reveal(&app);
}

pub fn schedule_fallback(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        reveal(&app);
    });
}

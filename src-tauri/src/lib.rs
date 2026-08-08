//! Kodama-Lite data plane entry point. Keeps the Tauri builder tiny:
//! register the one bus command, boot the subsystems that need startup
//! work, and run. All behaviour lives in the subsystems behind the bus,
//! so this file never grows as features are added.

mod bus;
mod protocol;
mod subsystems;
mod ytdlp;

/// Brings `get_webview_window` into scope for the single-instance
/// callback — it's an extension-trait method on `AppHandle`.
use tauri::Manager;

/// Linux-only environment fixup that must run before GTK/WebKit is
/// initialized — i.e. the very first statement of `run()`, before the
/// builder exists.
///
/// WebKitGTK's DMABUF renderer negotiates a buffer format the Pi 5's V3D
/// driver/compositor combination can't present correctly — confirmed on
/// device as corrupted/garbled window content (YTMLite hit the same root
/// cause as a blank white window instead; the visual symptom depends on
/// what's being composited, not the underlying cause). Disabling it falls
/// back to a compatible path that still uses the GPU for compositing.
/// Only fills in the variable if the user hasn't already set it, so an
/// explicit `WEBKIT_DISABLE_DMABUF_RENDERER=0` in the environment still
/// wins. Ported from YTMLite's `platform.rs::init_env()`.
fn init_env() {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            // SAFETY: single-threaded here — this runs before any window,
            // plugin, or async runtime exists.
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_env();
    tauri::Builder::default()
        // MUST be the first plugin registered — it decides whether this
        // process is the app or a duplicate that should hand over and
        // quit, and that has to happen before anything else claims a
        // resource. The callback runs in the ALREADY-RUNNING instance
        // when a second launch is attempted; the second process exits on
        // its own once this returns.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Raise the window the user was trying to reach. Tapping the
            // desktop icon while the service is running should look like
            // switching to the app, not like nothing happened.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Before playback: the stream server's `/local/:id` route and
            // `stream:resolve` both look this index up, so it has to exist
            // by the time either can be reached.
            subsystems::local::init(app.handle());
            subsystems::playback::start(app.handle());
            // The view plane only re-probes connectivity while it already
            // believes it is offline, so an outage that begins mid-drive
            // would otherwise be noticed by nobody. This watcher is also
            // what gets to power-cycle a wedged USB hotspot.
            subsystems::connectivity::start(app.handle());
            // MPRIS must be created on the main thread — souvlaki's
            // MediaControls is neither Send nor Sync. `setup` is that
            // thread, so this is the only place it can be built.
            subsystems::media::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bus::handle_command])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

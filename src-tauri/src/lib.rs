//! Kodama-Lite data plane entry point. Keeps the Tauri builder tiny:
//! register the one bus command, boot the subsystems that need startup
//! work, and run. All behaviour lives in the subsystems behind the bus,
//! so this file never grows as features are added.

mod bus;
mod protocol;
mod subsystems;
mod ytdlp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            subsystems::playback::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bus::handle_command])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

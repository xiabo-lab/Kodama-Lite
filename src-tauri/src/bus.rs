//! The data plane's half of the bus: one entry command that receives every
//! dispatch and routes it to the owning subsystem, plus an `emit` helper
//! subsystems use to push events back to the UI.
//!
//! The router never does I/O itself and never blocks — each subsystem
//! spawns its own async task and returns immediately, so the `handle_command`
//! call is effectively instantaneous no matter how slow the underlying work.

use tauri::{AppHandle, Emitter};

use crate::protocol::{AppEvent, Command};
use crate::subsystems;

/// Must match `EVENT_CHANNEL` in `src/protocol.ts`.
pub const EVENT_CHANNEL: &str = "kl:event";

/// Push an event to the view plane. Fire-and-forget; a webview that isn't
/// listening yet simply misses it (the UI re-requests on mount).
pub fn emit(app: &AppHandle, event: AppEvent) {
    let _ = app.emit(EVENT_CHANNEL, event);
}

/// The single command endpoint. The UI's `dispatch(command)` lands here.
#[tauri::command]
pub async fn handle_command(app: AppHandle, command: Command) {
    match command {
        Command::Ping => subsystems::ping(&app),
        Command::ConnectivityCheck => subsystems::connectivity::check(&app),
        Command::StreamResolve { video_id } => subsystems::playback::resolve(&app, video_id),
        Command::StreamPrefetch { video_id } => subsystems::playback::prefetch(&app, video_id),
    }
}

//! The data plane's subsystems. Each is an independent module that consumes
//! commands (routed by the bus) and emits events — it knows nothing about the
//! UI or the other subsystems. Adding a feature means adding a module here and
//! a command/event variant to the protocol; nothing existing changes.
//!
//! YouTube Music content lives in the view plane instead (see
//! `src/lib/contentBus.ts`) — there is no `library`/`search`/etc. subsystem
//! here to mirror it.

pub mod auth;
pub mod connectivity;
pub mod playback;

use tauri::AppHandle;

use crate::bus::emit;
use crate::protocol::AppEvent;

/// Liveness check — the simplest possible command→event round-trip, handy for
/// proving the bus end to end.
pub fn ping(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        emit(&app, AppEvent::Pong { ts });
    });
}

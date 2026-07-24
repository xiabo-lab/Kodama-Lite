//! Connectivity subsystem. Reports real reachability (not the OS "a NIC is
//! up" lie) so the UI can show an offline state and, later, so subsystems can
//! replay intents that failed while offline. Phase 1 answers on demand; a
//! future version adds a background watcher that emits transitions.

use std::time::Duration;

use tauri::AppHandle;
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::bus::emit;
use crate::protocol::AppEvent;

/// Probe reachability once and emit `net:status`.
pub fn check(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let online = reachable().await;
        emit(&app, AppEvent::NetStatus { online });
    });
}

/// A real reachability probe: a short-timeout TCP connect to a well-known
/// anycast resolver on 443. This deliberately does NOT go through the app's
/// HTTP resolver (which on the Pi bypasses /etc/hosts) — it's a raw socket,
/// so it reflects actual internet reachability.
async fn reachable() -> bool {
    matches!(
        timeout(Duration::from_secs(3), TcpStream::connect("1.1.1.1:443")).await,
        Ok(Ok(_))
    )
}

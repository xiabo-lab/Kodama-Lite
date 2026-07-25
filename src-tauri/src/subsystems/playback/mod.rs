//! Playback subsystem — resolves a videoId to a playable URL. This is
//! deliberately thin: the actual transport state (queue, current index,
//! play/pause, shuffle/repeat, position) lives in the view plane's
//! `playbackStore`, because that's what has to drive an `<audio>` element
//! — something only the webview can do. What belongs here, on the data
//! plane, is exactly the part that's genuinely async I/O: turning a
//! videoId into bytes, which means yt-dlp and a disk cache.
//!
//! `resolve` never waits on yt-dlp. It only waits for the local server to
//! be listening (near-instant after boot) and then hands back a
//! deterministic URL — the actual download happens lazily inside the
//! server's HTTP handler when the `<audio>` element's own GET arrives, so
//! the command call is effectively instantaneous even for an uncached
//! first play.

mod server;

use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::bus::emit;
use crate::protocol::AppEvent;
use crate::ytdlp;
use server::StreamServer;

/// Shared handle to the streaming server, managed as Tauri state so the
/// `resolve`/`prefetch` command handlers reach the same download map the
/// HTTP server uses — a prefetch and a real play of the same track always
/// dedupe against one in-flight download, whichever asked first.
struct PlaybackHandle {
    server: StreamServer,
    base_url: watch::Receiver<Option<String>>,
}

pub(crate) fn sanitize_video_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 32
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Boot the subsystem: ensure yt-dlp is available and start the local
/// streaming server. Called once from `run()`'s setup hook.
pub fn start(app: &AppHandle) {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("stream");
    let ytdlp_bin = ytdlp::managed_path(app);

    let (tx, rx) = watch::channel(None);
    let stream_server = StreamServer::new(cache_dir, ytdlp_bin);
    app.manage(PlaybackHandle {
        server: stream_server.clone(),
        base_url: rx,
    });

    let app_ytdlp = app.clone();
    tauri::async_runtime::spawn(async move {
        ytdlp::ensure(app_ytdlp).await;
    });

    tauri::async_runtime::spawn(async move {
        server::run(stream_server, tx).await;
    });
}

/// `stream:resolve` — see module docs for why this doesn't wait on yt-dlp.
pub fn resolve(app: &AppHandle, video_id: String) {
    if !sanitize_video_id(&video_id) {
        emit(
            app,
            AppEvent::StreamError {
                video_id,
                message: "invalid id".into(),
            },
        );
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(base) = wait_for_base_url(&app).await else {
            emit(
                &app,
                AppEvent::StreamError {
                    video_id,
                    message: "stream server unavailable".into(),
                },
            );
            return;
        };
        emit(
            &app,
            AppEvent::StreamReady {
                url: format!("{base}/stream/{video_id}"),
                video_id,
            },
        );
    });
}

/// `ytdlp:check` — re-report the managed binary's phase.
///
/// `start` already emits `ytdlp:state`, but it runs from the setup hook,
/// before the webview exists and long before it has subscribed to the
/// event channel: on any launch where the binary is already present the
/// "ready" emit lands in the void and the UI's `ytdlpPhase` stays
/// "downloading" for the rest of the session. Nothing depended on that
/// until resume-on-startup gated itself on it, at which point auto-play
/// silently never fired.
///
/// `ensure` is the right thing to call again rather than a cached flag:
/// it's idempotent, serialised behind its own mutex, and its self-update
/// is stamp-guarded to 72h — so on the common path this costs one
/// file-exists check and re-emits the phase the UI missed.
pub fn check_ytdlp(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        ytdlp::ensure(app).await;
    });
}

/// `stream:prefetch` — warm the disk cache for a track without playing
/// it. Silent either way: a background prefetch has nothing to report to
/// the UI, matching its fire-and-forget nature.
pub fn prefetch(app: &AppHandle, video_id: String) {
    if !sanitize_video_id(&video_id) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if wait_for_base_url(&app).await.is_none() {
            return;
        }
        app.state::<PlaybackHandle>()
            .server
            .ensure_cached_background(video_id);
    });
}

/// Wait for the server's base URL to be published. Normally resolves on
/// the very first poll — the server binds its port within a few
/// milliseconds of app startup — but a generous timeout guards against a
/// bind failure (port exhaustion, sandboxing) leaving a command hung
/// forever instead of failing.
async fn wait_for_base_url(app: &AppHandle) -> Option<String> {
    let mut rx = app.state::<PlaybackHandle>().base_url.clone();
    loop {
        if let Some(url) = rx.borrow().clone() {
            return Some(url);
        }
        if tokio::time::timeout(Duration::from_secs(10), rx.changed())
            .await
            .is_err()
        {
            return None;
        }
    }
}

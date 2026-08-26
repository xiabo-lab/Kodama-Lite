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
    let app_cache = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let cache_dir = app_cache.join("stream");
    let covers_dir = crate::subsystems::covers::dir(&app_cache);
    let ytdlp_bin = ytdlp::managed_path(app);

    // Trim the cover cache once per launch, off the request path — see the
    // note on `covers::prune`.
    {
        let covers_dir = covers_dir.clone();
        tauri::async_runtime::spawn(async move {
            crate::subsystems::covers::prune(&covers_dir).await;
        });
    }

    let (tx, rx) = watch::channel(None);
    let stream_server = StreamServer::new(cache_dir, covers_dir, ytdlp_bin, app.clone());
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
                cause: "track".into(),
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
                    cause: "track".into(),
                },
            );
            return;
        };
        // A local (USB) track resolves to the local route instead. Doing
        // the fork HERE rather than in the view plane is what lets local
        // files reuse the entire playback path unchanged: the store fires
        // the same `stream:resolve`, gets back the same `stream:ready`,
        // and the audio element neither knows nor cares that these bytes
        // came off a stick rather than out of yt-dlp.
        let is_local = {
            let index = app.state::<crate::subsystems::local::LocalIndex>();
            let map = index.lock().await;
            map.contains_key(&video_id)
        };

        // A local id we don't currently hold: the queue outlived the index.
        // The queue is persisted across restarts and the index is not, so
        // after a reboot the restored track asks to resolve before anything
        // has scanned the drive. Handing that id to yt-dlp — which is what
        // used to happen — spends several seconds failing and then reports
        // the track as unavailable, when the truth is simply that the drive
        // has not been read yet.
        if !is_local && crate::subsystems::local::looks_local(&video_id) {
            emit(
                &app,
                AppEvent::StreamError {
                    video_id,
                    message: "Open Library → Local to scan the USB drive first.".into(),
                    cause: "track".into(),
                },
            );
            return;
        }

        let path = if is_local { "local" } else { "stream" };
        emit(
            &app,
            AppEvent::StreamReady {
                url: format!("{base}/{path}/{video_id}"),
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
        // A local file is already on disk — prefetching it would hand its
        // id to yt-dlp as if it were a videoId, which fails slowly and
        // pointlessly on every USB track the queue looks ahead to. The
        // shape check covers the same not-yet-scanned case `resolve` does.
        if crate::subsystems::local::looks_local(&video_id) {
            return;
        }
        {
            let index = app.state::<crate::subsystems::local::LocalIndex>();
            if index.lock().await.contains_key(&video_id) {
                return;
            }
        }
        app.state::<PlaybackHandle>()
            .server
            .ensure_cached_background(video_id);
    });
}

/// `cover:base` — tell the view plane where to fetch artwork.
///
/// Shares `wait_for_base_url` with track resolution, so it is subject to
/// the same 10s guard: if the server never binds, this answers nothing and
/// `Thumbnail` simply keeps pointing at the CDN, which is exactly the
/// behaviour that existed before the cache. Degrading to "no cache" beats
/// degrading to "no artwork".
pub fn cover_base(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(base) = wait_for_base_url(&app).await else {
            eprintln!("[covers] no server base URL — artwork will bypass the cache");
            return;
        };
        emit(&app, AppEvent::CoverBase { url: format!("{base}/cover") });
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

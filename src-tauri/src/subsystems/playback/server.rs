//! The local streaming server: an axum service on `127.0.0.1` that lazily
//! downloads a track's audio via yt-dlp on first request and serves it —
//! with Range support, so the `<audio>` element can seek — from an
//! on-disk cache on every request after. Ported from YTMLite's proven
//! stream server, trimmed of the Premium/ephemeral-cache split: Kodama-
//! Lite has no accounts yet (that's Phase 3), so every track is cached
//! persistently for now. Revisit this once accounts land, the same way
//! YTMLite splits ephemeral vs. persistent by subscription status.
//!
//! Why a local HTTP server rather than piping bytes to the UI directly:
//! it gives the `<audio>` element real Range-request seeking almost for
//! free (via `tower_http::services::ServeFile`), and it means the actual
//! byte transfer is the *browser's own* async media pipeline — never
//! something our view-plane JS awaits.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, Request, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command as TokioCommand;
use tokio::sync::{watch, Mutex, Notify};
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeFile;

use super::sanitize_video_id;
use crate::ytdlp;

struct DownloadState {
    complete: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

type DownloadMap = Arc<Mutex<HashMap<String, Arc<DownloadState>>>>;

#[derive(Clone)]
pub struct StreamServer {
    cache_dir: PathBuf,
    downloads: DownloadMap,
    ytdlp_bin: PathBuf,
}

impl StreamServer {
    pub fn new(cache_dir: PathBuf, ytdlp_bin: PathBuf) -> Self {
        Self {
            cache_dir,
            downloads: Arc::new(Mutex::new(HashMap::new())),
            ytdlp_bin,
        }
    }

    /// Warm the cache for `video_id` without waiting for it — the
    /// `stream:prefetch` command's implementation. Dedupes against a
    /// download already in flight from an actual `/stream` request via
    /// the shared `downloads` map, so a prefetch and "the user hit next
    /// before it finished" can never double-download the same track.
    pub fn ensure_cached_background(&self, video_id: String) {
        let final_path = self.cache_dir.join(format!("{video_id}.webm"));
        if final_path.exists() {
            return;
        }
        let downloads = self.downloads.clone();
        let cache_dir = self.cache_dir.clone();
        let srv = self.clone();
        tauri::async_runtime::spawn(async move {
            let map_key = video_id.clone();
            let state = {
                let mut map = downloads.lock().await;
                if map.contains_key(&map_key) {
                    return;
                }
                let state = Arc::new(DownloadState {
                    complete: Arc::new(AtomicBool::new(false)),
                    notify: Arc::new(Notify::new()),
                });
                map.insert(map_key.clone(), state.clone());
                state
            };
            spawn_downloader(video_id, cache_dir, map_key, srv, state);
        });
    }
}

/// Boot the server: create the cache dir, bind a random localhost port,
/// publish the base URL (`http://127.0.0.1:<port>/<token>`) over
/// `ready_tx`, then serve forever. The per-launch token is an unguessable
/// path prefix — the frontend gets it baked into the base URL it's
/// handed, so it's transparent to the webview, but a stray web page that
/// only knows the port can't form a valid request.
pub async fn run(server: StreamServer, ready_tx: watch::Sender<Option<String>>) {
    if let Err(e) = tokio::fs::create_dir_all(&server.cache_dir).await {
        eprintln!("[stream-server] mkdir {:?}: {e}", server.cache_dir);
    }

    let token = generate_stream_token();
    let routes = Router::new()
        .route("/stream/:video_id", get(stream_handler))
        .with_state(server);
    let app_router = Router::new()
        .nest(&format!("/{token}"), routes)
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[stream-server] bind failed: {e}");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            eprintln!("[stream-server] local_addr failed: {e}");
            return;
        }
    };
    eprintln!("[stream-server] listening on 127.0.0.1:{port}");
    let _ = ready_tx.send(Some(format!("http://127.0.0.1:{port}/{token}")));

    if let Err(e) = axum::serve(listener, app_router).await {
        eprintln!("[stream-server] serve error: {e}");
    }
}

/// Spawn a yt-dlp downloader that pipes stdout straight into a
/// `<videoId>.part` file, notifying `state` on every chunk so a waiting
/// HTTP request can react as soon as there's *some* data (Range requests
/// against a still-growing file work fine). On successful exit, renames
/// `.part` → `.webm`, the signal the file is safe to treat as complete
/// and immutable.
fn spawn_downloader(
    video_id: String,
    target_dir: PathBuf,
    map_key: String,
    srv: StreamServer,
    state: Arc<DownloadState>,
) {
    let downloads = srv.downloads.clone();
    let ytdlp_bin = srv.ytdlp_bin.clone();
    tauri::async_runtime::spawn(async move {
        let url = format!("https://www.youtube.com/watch?v={video_id}");
        let part_path = target_dir.join(format!("{video_id}.part"));
        let final_path = target_dir.join(format!("{video_id}.webm"));
        let _ = tokio::fs::create_dir_all(&target_dir).await;
        let _ = tokio::fs::remove_file(&part_path).await; // clean stale

        let mut cmd = TokioCommand::new(ytdlp::program(&ytdlp_bin));
        cmd.args([
            "-f",
            "bestaudio[ext=webm]/bestaudio",
            "--no-playlist",
            "--no-warnings",
            "--no-part",
            "-q",
            // A signed media URL that 403s on the first byte-range request
            // is common (token/pot desync); a few retries clear most of
            // these before the handler ever returns 502.
            "--retries",
            "5",
            "--extractor-retries",
            "3",
            "--socket-timeout",
            "15",
            "--extractor-args",
            "youtube:player_client=tv,android_vr",
            "-o",
            "-",
        ]);
        cmd.arg(&url);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = match cmd.stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[stream] spawn {video_id}: {e}");
                state.complete.store(true, Ordering::Release);
                state.notify.notify_waiters();
                downloads.lock().await.remove(&map_key);
                return;
            }
        };

        let mut stdout = child.stdout.take().unwrap();
        let mut file = tokio::fs::File::create(&part_path).await.ok();
        let mut buf = vec![0u8; 64 * 1024];
        let mut ok = true;
        // Per-read timeout so a wedged yt-dlp can't keep this task (and the
        // download entry) alive forever with `complete` stuck false.
        const READ_TIMEOUT: Duration = Duration::from_secs(60);
        loop {
            match tokio::time::timeout(READ_TIMEOUT, stdout.read(&mut buf)).await {
                Err(_) => {
                    eprintln!("[stream] read timeout for {video_id}; killing yt-dlp");
                    let _ = child.start_kill();
                    ok = false;
                    break;
                }
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => {
                    let chunk = &buf[..n];
                    if let Some(ref mut f) = file {
                        if let Err(e) = f.write_all(chunk).await {
                            eprintln!("[stream] write .part: {e}");
                            file = None;
                            ok = false;
                        }
                    }
                    state.notify.notify_waiters();
                }
                Ok(Err(e)) => {
                    eprintln!("[stream] read stdout: {e}");
                    ok = false;
                    break;
                }
            }
        }
        if let Some(mut f) = file.take() {
            let _ = f.flush().await;
            drop(f);
        }
        let status = child.wait().await;
        let success = ok && status.map(|s| s.success()).unwrap_or(false);

        // 32 KB floor: yt-dlp can exit 0 with a near-empty payload on a
        // rate-limit / geo-block storyboard fallback. Renaming that to
        // .webm would pin a permanently-broken cache entry.
        const MIN_AUDIO_BYTES: u64 = 32 * 1024;
        let part_size = tokio::fs::metadata(&part_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if success && part_size >= MIN_AUDIO_BYTES {
            if let Err(e) = tokio::fs::rename(&part_path, &final_path).await {
                eprintln!("[stream] rename: {e}");
                let _ = tokio::fs::remove_file(&part_path).await;
            } else {
                eprintln!("[stream] cached {video_id} ({part_size} bytes)");
            }
        } else {
            if success {
                eprintln!(
                    "[stream] download too small for {video_id}: {part_size} bytes (min {MIN_AUDIO_BYTES})"
                );
            } else {
                eprintln!("[stream] download failed {video_id}");
            }
            let _ = tokio::fs::remove_file(&part_path).await;
        }

        state.complete.store(true, Ordering::Release);
        state.notify.notify_waiters();

        if success {
            // Keep the in-flight entry around briefly so a fast re-request
            // (e.g. the HTTP handler racing a prefetch) attaches instead of
            // re-downloading, then drop it — after that, disk existence
            // alone is the cache check.
            let downloads_evict = downloads.clone();
            let key = map_key.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                downloads_evict.lock().await.remove(&key);
            });
        } else {
            // Failed: drop immediately so the next request retries instead
            // of blocking on a dead entry.
            downloads.lock().await.remove(&map_key);
        }
    });
}

/// GET /:token/stream/:video_id — unified serving path with Range support
/// even during an active download.
async fn stream_handler(
    AxumState(srv): AxumState<StreamServer>,
    Path(video_id): Path<String>,
    req: Request,
) -> Response {
    if !sanitize_video_id(&video_id) {
        return (StatusCode::BAD_REQUEST, "invalid videoId").into_response();
    }
    let final_path = srv.cache_dir.join(format!("{video_id}.webm"));
    let t0 = std::time::Instant::now();

    if !final_path.exists() {
        let state = {
            let mut map = srv.downloads.lock().await;
            if let Some(s) = map.get(&video_id) {
                s.clone()
            } else {
                let s = Arc::new(DownloadState {
                    complete: Arc::new(AtomicBool::new(false)),
                    notify: Arc::new(Notify::new()),
                });
                map.insert(video_id.clone(), s.clone());
                drop(map);
                spawn_downloader(
                    video_id.clone(),
                    srv.cache_dir.clone(),
                    video_id.clone(),
                    srv.clone(),
                    s.clone(),
                );
                s
            }
        };

        // Bounded wait — 120s is generous for any single track; if yt-dlp
        // is wedged past that, fail fast rather than hang the element.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        while !state.complete.load(Ordering::Acquire) {
            if tokio::time::Instant::now() >= deadline {
                eprintln!("[stream] {video_id}: TIMEOUT after 120s");
                return (StatusCode::GATEWAY_TIMEOUT, "download timeout").into_response();
            }
            let notified = state.notify.notified();
            tokio::pin!(notified);
            let _ = tokio::time::timeout(Duration::from_secs(5), notified).await;
        }

        if !final_path.exists() {
            eprintln!(
                "[stream] {video_id}: BAD_GATEWAY — complete but no .webm (elapsed {:.2}s)",
                t0.elapsed().as_secs_f32()
            );
            return (StatusCode::BAD_GATEWAY, "download failed").into_response();
        }
        eprintln!(
            "[stream] {video_id}: download finished in {:.2}s",
            t0.elapsed().as_secs_f32()
        );
    }

    // Every track is saved with a `.webm` extension regardless of what
    // yt-dlp actually produced (it falls back to m4a when a video has no
    // webm audio) — sniff the real container so Chromium gets a content
    // type it'll actually decode.
    let sniffed_ct = sniff_audio_mime(&final_path).await;
    let mut resp = ServeFile::new(&final_path)
        .oneshot(req)
        .await
        .map(|r| r.into_response())
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("serve: {e}")).into_response());
    if resp.status().is_success() || resp.status() == StatusCode::PARTIAL_CONTENT {
        resp.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static(sniffed_ct),
        );
    }
    eprintln!(
        "[stream] {video_id}: responding {} ({:.2}s total)",
        resp.status(),
        t0.elapsed().as_secs_f32(),
    );
    resp
}

/// Read the first 16 bytes and map the container magic to the right
/// `audio/*` mime.
async fn sniff_audio_mime(path: &std::path::Path) -> &'static str {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = tokio::fs::File::open(path).await {
        let _ = f.read(&mut buf).await;
    }
    if &buf[4..8] == b"ftyp" {
        "audio/mp4"
    } else if buf[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        "audio/webm"
    } else if &buf[..3] == b"ID3" {
        "audio/mpeg"
    } else {
        "audio/webm"
    }
}

/// Unguessable per-launch token used as a URL path prefix. OS-seeded
/// RandomState (SipHash keys) rather than pulling in an RNG crate — 128
/// bits is ample for a localhost secret that only needs to resist online
/// guessing by a stray web page.
fn generate_stream_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(0x9E37_79B9_7F4A_7C15);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

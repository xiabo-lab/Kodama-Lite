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
/// `state()` is an extension-trait method on `AppHandle` — needed for the
/// local-file index lookup in `local_handler`.
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command as TokioCommand;
use tokio::sync::{watch, Mutex, Notify};
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeFile;

use super::sanitize_video_id;
use crate::bus::emit;
use crate::protocol::AppEvent;
use crate::ytdlp;

struct DownloadState {
    complete: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

type DownloadMap = Arc<Mutex<HashMap<String, Arc<DownloadState>>>>;

/// Why a download failed, and — the part that actually matters — whether
/// trying again could possibly help.
///
/// This distinction is the whole point of capturing yt-dlp's stderr. The
/// journal on the device shows three failure modes with very different
/// answers: `HTTP Error 403: Forbidden` is a signed-URL/pot desync that a
/// fresh extraction clears, while `This video is DRM protected` and `This
/// video is only available to Music Premium members` are properties of the
/// video that no number of retries will change. Retrying the second kind
/// just makes the user wait longer for the same failure, and reporting the
/// first kind as final makes a track look broken when it would play on the
/// next tap.
enum FailureKind {
    /// Unplayable for this account/region, period. Stop, and say why.
    Permanent(&'static str),
    /// Worth another extraction, ideally with a different player client.
    Transient,
}

struct DownloadFailure {
    kind: FailureKind,
    /// yt-dlp's own last error line, for the journal.
    detail: String,
}

/// Player-client sets to try, in order.
///
/// A 403 on the media URL usually means the client that did the extraction
/// and the one fetching the bytes disagree about the token, so the useful
/// retry is not "the same request again" but "extract it a different way".
/// These three sets fail independently in practice, which is what makes
/// walking them worth more than three attempts at the first one.
const PLAYER_CLIENTS: [&str; 3] = [
    "youtube:player_client=tv,android_vr",
    "youtube:player_client=web_safari,mweb",
    "youtube:player_client=ios,tv_embedded",
];

/// Gap between attempts. Short — this is a user waiting on a track, not a
/// background job — but non-zero, because an immediate retry against a
/// rate-limiter is just a second rejection.
const RETRY_BACKOFF: Duration = Duration::from_millis(750);

/// Map yt-dlp's stderr to a failure kind.
///
/// Matching on message text is unlovely but it is the only signal yt-dlp
/// gives: the exit code is 1 for every one of these. The permanent list is
/// deliberately conservative — anything unrecognised is treated as
/// transient and retried, because a wasted retry costs a few seconds while
/// a wrongly-permanent verdict costs the track.
fn classify(stderr: &str) -> FailureKind {
    let s = stderr.to_ascii_lowercase();
    // Order matters only for which message is shown; the kinds agree.
    const PERMANENT: [(&str, &str); 8] = [
        ("drm protected", "This track is DRM protected."),
        (
            "only available to music premium",
            "This track needs a YouTube Music Premium subscription.",
        ),
        ("private video", "This track is private."),
        (
            "video unavailable",
            "This track is unavailable.",
        ),
        (
            "removed by the uploader",
            "This track was removed by the uploader.",
        ),
        (
            "account associated with this video has been terminated",
            "This track's channel was terminated.",
        ),
        (
            "not available in your country",
            "This track isn't available in your region.",
        ),
        (
            "sign in to confirm your age",
            "This track is age-restricted.",
        ),
    ];
    for (needle, message) in PERMANENT {
        if s.contains(needle) {
            return FailureKind::Permanent(message);
        }
    }
    FailureKind::Transient
}

/// The last `ERROR:` line yt-dlp printed, which is the one that says what
/// actually went wrong. Falls back to the whole tail when it printed
/// something unusual.
fn last_error_line(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .find(|l| l.contains("ERROR:"))
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| stderr.trim().chars().take(200).collect())
}

#[derive(Clone)]
pub struct StreamServer {
    cache_dir: PathBuf,
    downloads: DownloadMap,
    ytdlp_bin: PathBuf,
    /// Kept so a failed download can tell the UI *why*. Without this the
    /// view plane only ever saw a bare HTTP 502 from the `<audio>`
    /// element, which is where the undifferentiated "Couldn't play this
    /// track" came from — the reason existed, in the journal, and simply
    /// had no route to the screen.
    app: tauri::AppHandle,
}

impl StreamServer {
    pub fn new(cache_dir: PathBuf, ytdlp_bin: PathBuf, app: tauri::AppHandle) -> Self {
        Self {
            cache_dir,
            downloads: Arc::new(Mutex::new(HashMap::new())),
            ytdlp_bin,
            app,
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
        // Local files from a USB drive. Same server, same per-launch token,
        // same `ServeFile` Range handling — the only difference is that the
        // bytes are already on disk and there is nothing to download.
        .route("/local/:local_id", get(local_handler))
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
    let app = srv.app.clone();
    tauri::async_runtime::spawn(async move {
        let part_path = target_dir.join(format!("{video_id}.part"));
        let final_path = target_dir.join(format!("{video_id}.webm"));
        let _ = tokio::fs::create_dir_all(&target_dir).await;

        // Walk the player clients until one works or the failure turns out
        // to be permanent. Each attempt starts its `.part` from scratch —
        // nothing serves partial data (the HTTP handler waits for
        // `complete` before touching the file), so truncating is safe.
        let mut success = false;
        let mut last: Option<DownloadFailure> = None;
        for (attempt, clients) in PLAYER_CLIENTS.iter().enumerate() {
            if attempt > 0 {
                eprintln!(
                    "[stream] {video_id}: retry {}/{} with {clients}",
                    attempt + 1,
                    PLAYER_CLIENTS.len()
                );
                tokio::time::sleep(RETRY_BACKOFF).await;
            }
            match try_download(&video_id, &part_path, &ytdlp_bin, clients, &state).await {
                Ok(bytes) => {
                    if let Err(e) = tokio::fs::rename(&part_path, &final_path).await {
                        eprintln!("[stream] rename: {e}");
                        let _ = tokio::fs::remove_file(&part_path).await;
                    } else {
                        eprintln!("[stream] cached {video_id} ({bytes} bytes)");
                        success = true;
                    }
                    break;
                }
                Err(f) => {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    eprintln!("[stream] download failed {video_id}: {}", f.detail);
                    let permanent = matches!(f.kind, FailureKind::Permanent(_));
                    last = Some(f);
                    if permanent {
                        eprintln!("[stream] {video_id}: permanent — not retrying");
                        break;
                    }
                }
            }
        }

        // Tell the UI what happened, in words it can show. A permanent
        // failure gets its own sentence; a transient one that survived
        // every client is reported as worth trying again, because it is.
        if !success {
            let message = match last.as_ref().map(|f| &f.kind) {
                Some(FailureKind::Permanent(m)) => (*m).to_string(),
                _ => format!(
                    "Couldn't download this track after {} attempts. Tap play to try again.",
                    PLAYER_CLIENTS.len()
                ),
            };
            emit(
                &app,
                AppEvent::StreamError {
                    video_id: video_id.clone(),
                    message,
                },
            );
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

/// One yt-dlp invocation, streaming stdout into `part_path`.
///
/// Returns the byte count on success, or a classified failure. stderr is
/// captured rather than inherited so the failure can be classified at all
/// — and is still echoed to the journal afterwards, because that narrative
/// is how these problems get diagnosed in the first place.
async fn try_download(
    video_id: &str,
    part_path: &std::path::Path,
    ytdlp_bin: &std::path::Path,
    extractor_args: &str,
    state: &Arc<DownloadState>,
) -> Result<u64, DownloadFailure> {
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let _ = tokio::fs::remove_file(part_path).await; // clean stale

    let mut cmd = TokioCommand::new(ytdlp::program(ytdlp_bin));
    cmd.args([
        "-f",
        "bestaudio[ext=webm]/bestaudio",
        "--no-playlist",
        "--no-warnings",
        "--no-part",
        "-q",
        // yt-dlp's own retries handle a flaky connection within one
        // extraction. They do NOT help when the extraction itself produced
        // a URL the server rejects — that's what the outer player-client
        // walk is for.
        "--retries",
        "5",
        "--extractor-retries",
        "3",
        "--socket-timeout",
        "15",
        "--extractor-args",
        extractor_args,
        "-o",
        "-",
    ]);
    cmd.arg(&url);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = match cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => {
            return Err(DownloadFailure {
                kind: FailureKind::Transient,
                detail: format!("spawn failed: {e}"),
            })
        }
    };

    // stderr must be drained CONCURRENTLY with stdout. yt-dlp writes
    // progress and errors to it, and a full 64KB pipe buffer with nobody
    // reading blocks the child mid-write — which would deadlock against us
    // waiting on stdout for bytes it can no longer produce.
    let mut stderr_pipe = child.stderr.take().expect("stderr piped");
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut chunk = vec![0u8; 8 * 1024];
        loop {
            match stderr_pipe.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.push_str(&String::from_utf8_lossy(&chunk[..n])),
            }
        }
        buf
    });

    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut file = tokio::fs::File::create(part_path).await.ok();
    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    let mut io_ok = true;
    // Per-read timeout so a wedged yt-dlp can't keep this task (and the
    // download entry) alive forever with `complete` stuck false.
    const READ_TIMEOUT: Duration = Duration::from_secs(60);
    loop {
        match tokio::time::timeout(READ_TIMEOUT, stdout.read(&mut buf)).await {
            Err(_) => {
                eprintln!("[stream] read timeout for {video_id}; killing yt-dlp");
                let _ = child.start_kill();
                io_ok = false;
                break;
            }
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                if let Some(ref mut f) = file {
                    if let Err(e) = f.write_all(&buf[..n]).await {
                        eprintln!("[stream] write .part: {e}");
                        file = None;
                        io_ok = false;
                    } else {
                        written += n as u64;
                    }
                }
                state.notify.notify_waiters();
            }
            Ok(Err(e)) => {
                eprintln!("[stream] read stdout: {e}");
                io_ok = false;
                break;
            }
        }
    }
    if let Some(mut f) = file.take() {
        let _ = f.flush().await;
        drop(f);
    }

    let status = child.wait().await;
    let stderr = stderr_task.await.unwrap_or_default();
    // Keep the journal saying what it always said — this is the line that
    // made the three failure modes identifiable on the device.
    for line in stderr.lines().filter(|l| !l.trim().is_empty()) {
        eprintln!("{line}");
    }

    let exited_clean = status.map(|s| s.success()).unwrap_or(false);
    if !io_ok || !exited_clean {
        return Err(DownloadFailure {
            kind: classify(&stderr),
            detail: last_error_line(&stderr),
        });
    }

    // 32 KB floor: yt-dlp can exit 0 with a near-empty payload on a
    // rate-limit / geo-block storyboard fallback. Renaming that to .webm
    // would pin a permanently-broken cache entry.
    const MIN_AUDIO_BYTES: u64 = 32 * 1024;
    let size = tokio::fs::metadata(part_path)
        .await
        .map(|m| m.len())
        .unwrap_or(written);
    if size < MIN_AUDIO_BYTES {
        return Err(DownloadFailure {
            // Exit 0 with no audio is the shape a throttle takes, so it is
            // worth another client rather than being called final.
            kind: classify(&stderr),
            detail: format!("only {size} bytes (min {MIN_AUDIO_BYTES})"),
        });
    }
    Ok(size)
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

/// GET /:token/local/:local_id — serve a file from the scanned USB index.
///
/// The id is looked up in the index the scan built; a path is never
/// accepted from the webview and never constructed from one. So there is
/// no traversal to defend against: an id we didn't mint simply isn't in
/// the map. The `..`-style attack has no surface here at all, which is
/// worth more than a sanitiser would be.
async fn local_handler(
    AxumState(srv): AxumState<StreamServer>,
    Path(local_id): Path<String>,
    req: Request,
) -> Response {
    let path = {
        let index = srv.app.state::<crate::subsystems::local::LocalIndex>();
        let map = index.lock().await;
        map.get(&local_id).cloned()
    };
    let Some(path) = path else {
        // Also the honest answer after the stick is pulled and rescanned.
        return (StatusCode::NOT_FOUND, "unknown local track").into_response();
    };
    if !path.exists() {
        return (StatusCode::NOT_FOUND, "file no longer on the drive").into_response();
    }

    let sniffed_ct = sniff_audio_mime(&path).await;
    let mut resp = ServeFile::new(&path)
        .oneshot(req)
        .await
        .map(|r| r.into_response())
        .unwrap_or_else(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("serve: {e}")).into_response()
        });
    if resp.status().is_success() || resp.status() == StatusCode::PARTIAL_CONTENT {
        resp.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static(sniffed_ct),
        );
    }
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
    // The four below matter for USB files, where we serve whatever the
    // user put on the stick rather than something yt-dlp produced. A bare
    // MP3 with no ID3 tag starts straight at a frame sync word and used to
    // fall through to the audio/webm default, which Chromium refuses to
    // decode — the file plays fine and the element still errors.
    } else if buf[0] == 0xFF && (buf[1] & 0xE0) == 0xE0 {
        "audio/mpeg"
    } else if &buf[..4] == b"fLaC" {
        "audio/flac"
    } else if &buf[..4] == b"OggS" {
        "audio/ogg"
    } else if &buf[..4] == b"RIFF" && &buf[8..12] == b"WAVE" {
        "audio/wav"
    } else if buf[..4] == [0x30, 0x26, 0xB2, 0x75] {
        // ASF/WMA. Found on the real test drive as a file named
        // `philosophy.mp3` — the extension is simply a lie, which is why
        // this function sniffs magic bytes instead of trusting one.
        // WebKit can't decode WMA, so this will still fail; labelling it
        // correctly means it fails as an unsupported *format* rather than
        // as a corrupt webm, which is the difference between a diagnosable
        // error and a mysterious one.
        "audio/x-ms-wma"
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

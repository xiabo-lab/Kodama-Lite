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
// NOT `std::path::Path`: axum's `Path` extractor is imported below and
// owns that name in this file.
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, Request, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
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
    /// Refused specifically as Premium-only. Permanent for an anonymous
    /// client, but the one failure a signed-in retry can actually fix —
    /// so it is tracked separately from `kind` rather than folded into it.
    premium_gated: bool,
}

/// One download attempt's configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Attempt {
    /// `--extractor-args` value — or **empty**, meaning pass no
    /// `--extractor-args` at all and let yt-dlp pick its own player
    /// clients. The empty lead tier is the point; see `default_ladder`.
    args: String,
    /// Whether to attach the signed-in session.
    ///
    /// This is the field that has to stay honest. Attaching cookies is NOT
    /// free: measured on the device, an authenticated request returns only
    /// storyboards — no audio at all — on every client, because YouTube
    /// expects a PO Token once it knows who you are. Anonymous requests
    /// are exempt from that particular demand, which is why the ordinary
    /// path stays anonymous.
    /// So cookies are a LAST resort for tracks that are refused outright,
    /// never a default, and never applied to a track that would otherwise
    /// have played.
    cookies: bool,
}

/// What to try, in order. Every tier but the last is anonymous: a 403 on
/// the media URL usually means the client that did the extraction and the
/// one fetching the bytes disagree about the token, so the useful retry is
/// "extract it a different way". These fail independently in practice.
///
/// The last tier is the Premium tier and is only ever reached for a track
/// that has been refused as Premium-only. It pairs the signed-in session
/// with `web_music` and relies on a PO Token provider being reachable —
/// see `premium_tier` and the README.
///
/// ## Why tier 1 pins nothing
///
/// Rewritten 2026-08-18, after an outage where no track would play at all.
/// The ladder had pinned `tv,android_vr` → `web_safari,mweb` →
/// `ios,tv_embedded`, and all three died at once: the media URL those
/// clients hand back carries no `pot=` parameter, and googlevideo now
/// rejects it — no `Range` header at all is a 403, `Range: 0-…` is served,
/// and any range not starting at zero is a 403 even as the first request
/// on a freshly signed URL, so a download dies after roughly one chunk.
/// `web_safari` could not cover for it either: its formats now arrive with
/// no URL whatsoever (YouTube forcing SABR, yt-dlp#12482), which is exactly
/// how the walk fell through onto the token-less `android_vr` URL.
///
/// Measured across four videos and both yt-dlp channels:
///
/// | | pinned `tv,android_vr` | no `--extractor-args` |
/// |---|---|---|
/// | stable 2026.07.04 | fail | fail |
/// | nightly 2026.08.18 | fail | **all four downloaded** |
///
/// The lesson is not "pin different clients" — it is that **pinning at all
/// opts us out of the maintenance that fixes this**. yt-dlp's default
/// client list is the most actively maintained part of the extractor;
/// upstream had already fixed this by changing which clients it picks, and
/// our pin overrode the fix. So tier 1 now pins nothing and inherits that
/// work, and the pinned tiers below it are fallbacks for the case where a
/// specific client outlives the default — which is what they were always
/// really for.
///
/// Note what tiers 2-3 cost: they depend on a JS runtime and a reachable
/// PO Token provider, which `android_vr` did not, so a `kodama-pot` outage
/// degrades them. `tv,android_vr` is kept below them as the no-dependency
/// hedge, and because a client YouTube has broken has historically come
/// back.
fn default_ladder() -> Vec<Attempt> {
    let anon = |args: &str| Attempt { args: args.to_string(), cookies: false };
    vec![
        // Nothing pinned: yt-dlp's own current default clients.
        anon(""),
        anon("youtube:player_client=web_music"),
        anon("youtube:player_client=web_embedded"),
        // The hedge: needs neither Deno nor a PO token.
        anon("youtube:player_client=tv,android_vr"),
        // `web_music` is also the client whose GVS PO Token unlocks Music
        // Premium formats (yt-dlp#13835 demonstrates premium-only format
        // 774 arriving with exactly this pairing and being skipped without
        // it) — hence the same client anonymously above and signed in here.
        Attempt { args: "youtube:player_client=web_music".to_string(), cookies: true },
    ]
}

/// Ladder override, read from `<cache-dir>/player-clients.txt`.
///
/// This exists because the outage above cost a full bump → CI → release →
/// install cycle to change four strings, on an appliance bolted into a car.
/// With this, the same fix is one line and a restart. One
/// `--extractor-args` value per line; `-` or `default` means the unpinned
/// tier; `#` starts a comment. The Premium tier is always appended and is
/// not configurable — it is not a client choice but a distinct mode, and a
/// ladder file that omitted it would silently disable Premium playback.
///
/// A missing file is the normal case, not an error. A file that parses to
/// nothing is ignored rather than obeyed: an empty ladder can play nothing
/// at all, which is a worse failure than the one this is here to fix.
const LADDER_FILE: &str = "player-clients.txt";

fn parse_ladder(text: &str) -> Vec<Attempt> {
    text.lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| !l.is_empty())
        .map(|l| Attempt {
            args: if l == "-" || l.eq_ignore_ascii_case("default") {
                String::new()
            } else {
                l.to_string()
            },
            cookies: false,
        })
        .collect()
}

fn load_ladder(cache_dir: &std::path::Path) -> Vec<Attempt> {
    let path = cache_dir.join(LADDER_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return default_ladder();
    };
    let mut anon = parse_ladder(&text);
    if anon.is_empty() {
        eprintln!("[stream] {LADDER_FILE} has no usable entries — using the built-in ladder");
        return default_ladder();
    }
    eprintln!("[stream] player-client ladder from {}: {} tier(s)", path.display(), anon.len());
    let premium = default_ladder().pop().expect("ladder is never empty");
    anon.push(premium);
    anon
}

/// Index of the Premium tier: always last. Skipped entirely unless the
/// failure so far was specifically a Premium refusal.
fn premium_tier(ladder: &[Attempt]) -> usize {
    ladder.len().saturating_sub(1)
}

/// Remembered winner, in `<cache-dir>/last-good-client.txt`.
///
/// When YouTube breaks the lead tier, every track pays for the whole walk
/// again — three failed extractions, each with yt-dlp's own retries inside
/// it, before the one that works. That was tens of seconds per track for
/// the entire drive. Recording the client that last worked and trying it
/// first makes that cost land once rather than on every song.
///
/// Deliberately only a *reordering*: nothing is removed, so a remembered
/// client that later breaks costs one wasted attempt and then the ordinary
/// ladder runs. And it is only ever an anonymous tier — the Premium tier
/// stays pinned last, where the walk can reach it only on a Premium
/// refusal.
const LAST_GOOD_FILE: &str = "last-good-client.txt";

fn read_last_good(cache_dir: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(cache_dir.join(LAST_GOOD_FILE))
        .ok()
        .map(|s| s.trim().to_string())
}

fn write_last_good(cache_dir: &std::path::Path, args: &str) {
    let path = cache_dir.join(LAST_GOOD_FILE);
    if read_last_good(cache_dir).as_deref() == Some(args) {
        return; // steady state: don't rewrite the file on every track
    }
    let _ = std::fs::write(path, args);
}

/// A tier's name for the log. The unpinned tier has no `--extractor-args`
/// to print, and an empty string in the journal reads like a bug.
fn describe(args: &str) -> &str {
    if args.is_empty() {
        "yt-dlp default clients"
    } else {
        args
    }
}

/// The order to walk `ladder`, with `remembered` promoted to the front.
///
/// Returns indices so the caller keeps using the real tier numbers — the
/// Premium check is `index == premium_tier`, and promoting by index rather
/// than by cloning keeps that comparison meaningful.
fn walk_order(ladder: &[Attempt], remembered: Option<&str>) -> Vec<usize> {
    let premium = premium_tier(ladder);
    let mut order: Vec<usize> = (0..ladder.len()).collect();
    let Some(want) = remembered else { return order };
    // Only anonymous tiers are promotable, and only to the front of the
    // anonymous run — never past the Premium tier at the end.
    if let Some(pos) = order
        .iter()
        .position(|&i| i != premium && ladder[i].args == want)
    {
        let idx = order.remove(pos);
        order.insert(0, idx);
    }
    order
}

/// Gap between attempts. Short — this is a user waiting on a track, not a
/// background job — but non-zero, because an immediate retry against a
/// rate-limiter is just a second rejection.
const RETRY_BACKOFF: Duration = Duration::from_millis(750);

/// Was this specifically the Premium gate? Kept beside `classify` so the
/// needle is written in one place only.
const PREMIUM_NEEDLE: &str = "only available to music premium";

fn is_premium_gated(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains(PREMIUM_NEEDLE)
}

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
            PREMIUM_NEEDLE,
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

// ── Is it this track, the internet, or extraction itself? ─────────────

/// How many *different* tracks must fail in a row before we stop blaming
/// the track and start blaming extraction.
///
/// Distinct video IDs, not attempts: the same track failing repeatedly is
/// one broken track and the user tapping play again. Three different ones
/// in a row is not a coincidence — during the 2026-08-18 outage it was
/// every track, forever, and the app said "Couldn't play this track" each
/// time, which is precisely the sentence that sent the user looking for a
/// bad song instead of a broken extractor.
const SYSTEMIC_THRESHOLD: usize = 3;

/// Distinct recently-failed video IDs, most recent last. Cleared by any
/// success, because one track playing proves extraction works.
static RECENT_FAILURES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn note_success() {
    if let Ok(mut f) = RECENT_FAILURES.lock() {
        f.clear();
    }
}

/// Record a failed track and answer whether the failures now look systemic.
fn note_failure(video_id: &str) -> bool {
    let Ok(mut f) = RECENT_FAILURES.lock() else {
        return false;
    };
    if f.last().map(String::as_str) != Some(video_id) && !f.iter().any(|v| v == video_id) {
        f.push(video_id.to_string());
    }
    if f.len() > SYSTEMIC_THRESHOLD {
        let excess = f.len() - SYSTEMIC_THRESHOLD;
        f.drain(..excess);
    }
    f.len() >= SYSTEMIC_THRESHOLD
}

/// What to blame, in the words the user gets and a tag the UI can style.
///
/// The order is the whole point. "No internet" outranks everything —
/// during an outage every track fails and the systemic counter fills up,
/// but telling someone in a tunnel that YouTube changed its API is worse
/// than useless. Only once the network answers is a total failure
/// attributable to extraction.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Cause {
    Offline,
    Systemic,
    Track,
}

impl Cause {
    fn tag(self) -> &'static str {
        match self {
            Cause::Offline => "offline",
            Cause::Systemic => "systemic",
            Cause::Track => "track",
        }
    }
}

fn cause_of(online: bool, systemic: bool, permanent: bool) -> Cause {
    if !online {
        Cause::Offline
    } else if systemic && !permanent {
        // A permanent verdict — DRM, region, age gate — is a fact about
        // this one video and stays that way even in the middle of an
        // outage. Overwriting it with "everything is broken" would throw
        // away the most specific answer we have.
        Cause::Systemic
    } else {
        Cause::Track
    }
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
    /// The player-client walk, resolved once at startup so an override
    /// file is read from disk on launch rather than on every track.
    /// `Arc` because `StreamServer` is cloned into every download task.
    ladder: Arc<Vec<Attempt>>,
}

impl StreamServer {
    pub fn new(cache_dir: PathBuf, ytdlp_bin: PathBuf, app: tauri::AppHandle) -> Self {
        let ladder = Arc::new(load_ladder(&cache_dir));
        Self {
            cache_dir,
            downloads: Arc::new(Mutex::new(HashMap::new())),
            ytdlp_bin,
            app,
            ladder,
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
        // The voice assistant's way in. Behind the same per-launch token as
        // everything else here, so knowing the port is still not enough to
        // drive the player.
        .route("/control", post(control_handler))
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
    let base = format!("http://127.0.0.1:{port}/{token}");
    publish_control_endpoint(&base);
    let _ = ready_tx.send(Some(base));

    if let Err(e) = axum::serve(listener, app_router).await {
        eprintln!("[stream-server] serve error: {e}");
    }
}

/// One command from the voice assistant.
#[derive(serde::Deserialize)]
struct ControlRequest {
    action: String,
    #[serde(default)]
    argument: Option<String>,
}

/// Actions the view plane implements.
///
/// Must stay in step with the `control:command` union in `src/protocol.ts`
/// and the switch in `src/lib/voiceControl.ts`. Duplicating the names here is
/// the price of validating before the event reaches the webview: the
/// exhaustiveness check on the TypeScript side catches a name added to the
/// protocol and not handled, and this catches a name sent that exists in
/// neither.
const CONTROL_ACTIONS: &[&str] = &[
    "play",
    "search",
    "volume",
    "shuffle",
    "repeat",
    "like",
    "lyrics",
    "lyrics_search",
    "lyrics_save",
    "karaoke",
    "home",
    "play_local",
    "play_liked",
    "quit",
];

/// `POST /<token>/control` — hand a command to the view plane.
///
/// Returns as soon as the event is on the bus rather than waiting for the
/// UI to act on it. The assistant is speaking its confirmation at the same
/// moment this returns, and blocking here would put the whole round trip
/// inside its latency budget for no benefit — nothing it could do with a
/// failure that it cannot do with the player's state a moment later.
///
/// An action this build does not implement is a different matter, and gets a
/// 400. It used to get the same 202 as a real command, so the assistant could
/// not tell a working feature from one the installed version predates — it
/// said "lyrics saved" out loud to a build that had no such action and saved
/// nothing. Not waiting for the *result* is deliberate; not checking the
/// *name* was an oversight.
async fn control_handler(
    AxumState(server): AxumState<StreamServer>,
    Json(req): Json<ControlRequest>,
) -> Response {
    eprintln!(
        "[control] {} {}",
        req.action,
        req.argument.as_deref().unwrap_or("")
    );
    if !CONTROL_ACTIONS.contains(&req.action.as_str()) {
        eprintln!("[control] rejected unknown action {:?}", req.action);
        return (
            StatusCode::BAD_REQUEST,
            format!("unknown action {:?}\n", req.action),
        )
            .into_response();
    }
    emit(
        &server.app,
        AppEvent::ControlCommand {
            action: req.action,
            argument: req.argument,
        },
    );
    StatusCode::ACCEPTED.into_response()
}

/// Write the control endpoint where a local helper can find it.
///
/// The server binds port 0 and namespaces every route under a random
/// per-launch token, precisely so that knowing the port is not enough to
/// drive the app. That also means an external controller cannot guess the
/// URL — so it is written to a file only this user can read, which keeps
/// the token model intact while making the endpoint discoverable to a
/// process already running as the same user. A fixed unauthenticated port
/// would have been simpler and would have thrown that property away.
///
/// Best-effort: a failure here costs voice control, not playback.
fn publish_control_endpoint(base: &str) {
    let Some(home) = std::env::var_os("HOME") else {
        eprintln!("[control] no HOME; not publishing the control endpoint");
        return;
    };
    let dir = PathBuf::from(home).join(".local/state/kodama-lite");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[control] mkdir {dir:?}: {e}");
        return;
    }
    let path = dir.join("control.json");
    let body = format!("{{\"url\":\"{base}/control\",\"pid\":{}}}\n", std::process::id());
    if let Err(e) = std::fs::write(&path, body) {
        eprintln!("[control] write {path:?}: {e}");
        return;
    }
    // The token is a capability: anything that can read this file can drive
    // the player, so it is owner-only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
            eprintln!("[control] chmod {path:?}: {e}");
        }
    }
    eprintln!("[control] endpoint published at {path:?}");
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
        let cookies_path = srv.cache_dir.join("yt-dlp-cookies.txt");
        let ladder = srv.ladder.clone();
        let premium_idx = premium_tier(&ladder);
        let order = walk_order(&ladder, read_last_good(&srv.cache_dir).as_deref());
        let mut success = false;
        let mut last: Option<DownloadFailure> = None;
        for (step, &attempt) in order.iter().enumerate() {
            let cfg = &ladder[attempt];
            // The Premium tier is opt-in per track, not part of the walk.
            // Reaching it on an ordinary failure would attach cookies to a
            // track that never needed them — and an authenticated request
            // returns no audio formats at all without a PO Token, so that
            // would turn a retryable failure into a guaranteed one. Only a
            // track YouTube has explicitly refused as Premium-only is
            // worth spending it on.
            if attempt == premium_idx && !last.as_ref().is_some_and(|f| f.premium_gated) {
                break;
            }

            let cookies = if cfg.cookies {
                if !crate::subsystems::auth::export_cookies_txt(&app, &cookies_path) {
                    eprintln!("[stream] {video_id}: Premium-only, but no signed-in session");
                    break;
                }
                eprintln!("[stream] {video_id}: retrying as Premium (signed in + PO token)");
                Some(cookies_path.as_path())
            } else {
                None
            };

            if step > 0 {
                eprintln!(
                    "[stream] {video_id}: attempt {}/{} with {}",
                    step + 1,
                    order.len(),
                    describe(&cfg.args),
                );
                tokio::time::sleep(RETRY_BACKOFF).await;
            }
            match try_download(&video_id, &part_path, &ytdlp_bin, &cfg.args, cookies, &state).await {
                Ok(bytes) => {
                    if let Err(e) = tokio::fs::rename(&part_path, &final_path).await {
                        eprintln!("[stream] rename: {e}");
                        let _ = tokio::fs::remove_file(&part_path).await;
                    } else {
                        eprintln!("[stream] cached {video_id} ({bytes} bytes)");
                        success = true;
                        // One track playing is proof extraction works, so
                        // it clears the systemic streak outright.
                        note_success();
                        // Only anonymous winners are worth remembering:
                        // the Premium tier is reached by a track-specific
                        // refusal, not because it is a good general
                        // choice, and promoting it would attach cookies to
                        // every ordinary track.
                        if !cfg.cookies {
                            write_last_good(&srv.cache_dir, &cfg.args);
                        }
                    }
                    break;
                }
                Err(f) => {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    eprintln!("[stream] download failed {video_id}: {}", f.detail);
                    // A Premium refusal is "permanent" for the anonymous
                    // clients but is exactly what the Premium tier exists
                    // for, so it must not end the walk before reaching it.
                    let stop = matches!(f.kind, FailureKind::Permanent(_))
                        && !(f.premium_gated && attempt != premium_idx);
                    last = Some(f);
                    if stop {
                        eprintln!("[stream] {video_id}: permanent — not retrying");
                        break;
                    }
                }
            }
        }
        // The session file has done its job; it holds a live Google master
        // session and there is no reason to leave it sitting on disk
        // between plays.
        let _ = tokio::fs::remove_file(&cookies_path).await;

        // Tell the UI what happened, in words it can show — and, since
        // 2026-08-18, *what to blame*. A permanent failure gets its own
        // sentence; a transient one that survived every client is reported
        // as worth trying again, because it is.
        if !success {
            let permanent = matches!(last.as_ref().map(|f| &f.kind), Some(FailureKind::Permanent(_)));
            let systemic = note_failure(&video_id);
            // Ask the network only when we are about to blame something
            // big. A per-track failure needs no probe, and this runs on
            // every failed song.
            let online = if systemic || !permanent {
                crate::subsystems::connectivity::reachable().await
            } else {
                true
            };
            let cause = cause_of(online, systemic, permanent);
            let message = match (cause, last.as_ref().map(|f| &f.kind)) {
                (Cause::Offline, _) => {
                    "No internet connection. Saved and USB tracks still play; this one will \
                     work once you're back online."
                        .to_string()
                }
                (Cause::Systemic, _) => {
                    "Nothing is playing right now — this isn't just this track. YouTube changed \
                     something and yt-dlp needs to catch up. It updates itself; try again later."
                        .to_string()
                }
                (Cause::Track, Some(FailureKind::Permanent(m))) => (*m).to_string(),
                // Counts the anonymous tiers only: the Premium tier is not
                // part of every track's journey, so including it would
                // overstate what was tried for an ordinary failure.
                (Cause::Track, _) => format!(
                    "Couldn't download this track after {premium_idx} attempts. Tap play to try again."
                ),
            };
            eprintln!("[stream] {video_id}: giving up — cause={}", cause.tag());
            emit(
                &app,
                AppEvent::StreamError {
                    video_id: video_id.clone(),
                    message,
                    cause: cause.tag().to_string(),
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
    cookies: Option<&std::path::Path>,
    state: &Arc<DownloadState>,
) -> Result<u64, DownloadFailure> {
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let _ = tokio::fs::remove_file(part_path).await; // clean stale

    let mut cmd = TokioCommand::new(ytdlp::program(ytdlp_bin));

    // Put a JavaScript runtime on the child's PATH.
    //
    // This is the piece that actually unlocks Premium, and it is not
    // obvious. The `web_music` client's media URLs are protected by
    // YouTube's signature and `n` challenges, which yt-dlp can only solve
    // by *executing JavaScript*. With no runtime it logs
    //
    //   WARNING: Signature solving failed: Some formats may be missing
    //   WARNING: Only images are available for download
    //
    // and returns storyboards — which looks exactly like an auth failure
    // and is not one. `android_vr`/`tv` need no signature solving, which
    // is why the anonymous path used to work without any of this — but as
    // of 2026-08-18 those clients are 403ing and `web_music` leads the
    // ladder, so this PATH is now load-bearing for ordinary playback too,
    // not just for Premium. See `ATTEMPTS`.
    //
    // PATH rather than `--js-runtimes` so the same environment also serves
    // the PO Token provider's script mode. A systemd user service inherits
    // a minimal PATH that contains none of these locations.
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        let mut paths: Vec<std::path::PathBuf> = vec![
            home.join(".deno/bin"),
            home.join(".bun/bin"),
            std::path::PathBuf::from("/usr/local/bin"),
        ];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }

    // The signed-in session, on the Premium tier only. Attaching it to an
    // ordinary download makes YouTube demand a PO Token and return no
    // audio at all — see `Attempt::cookies`.
    if let Some(path) = cookies {
        cmd.arg("--cookies").arg(path);
    }
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
    ]);
    // Empty means "pass the flag at all" — the unpinned lead tier, which
    // lets yt-dlp choose its own player clients. Passing
    // `--extractor-args ""` is NOT the same thing: yt-dlp parses it as an
    // empty spec rather than an absent one, and the whole point of that
    // tier is to add nothing.
    if !extractor_args.is_empty() {
        cmd.args(["--extractor-args", extractor_args]);
    }
    cmd.args(["-o", "-"]);
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
                premium_gated: false,
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
            premium_gated: is_premium_gated(&stderr),
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
            premium_gated: is_premium_gated(&stderr),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn anon(args: &str) -> Attempt {
        Attempt { args: args.to_string(), cookies: false }
    }

    // ── The ladder override file ──────────────────────────────────────

    #[test]
    fn parses_one_client_per_line_ignoring_comments_and_blanks() {
        let got = parse_ladder(
            "\n# the lead tier\nyoutube:player_client=web_music\n\n  youtube:player_client=ios  # trailing\n",
        );
        assert_eq!(
            got,
            vec![anon("youtube:player_client=web_music"), anon("youtube:player_client=ios")]
        );
    }

    /// `-` and `default` are how the file spells the unpinned tier, which
    /// otherwise could only be written as a blank line — and blank lines
    /// are skipped.
    #[test]
    fn dash_and_default_mean_no_extractor_args() {
        assert_eq!(parse_ladder("-\ndefault\nDEFAULT"), vec![anon(""), anon(""), anon("")]);
    }

    /// A file that parses to nothing must not be obeyed: an empty ladder
    /// plays nothing at all, which is worse than the breakage the
    /// override exists to fix.
    #[test]
    fn a_file_of_only_comments_falls_back_to_the_builtin_ladder() {
        let dir = std::env::temp_dir().join(format!("kl-ladder-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(LADDER_FILE), "# nothing here\n\n").unwrap();
        assert_eq!(load_ladder(&dir), default_ladder());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_is_the_normal_case_not_an_error() {
        let dir = std::env::temp_dir().join(format!("kl-ladder-absent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load_ladder(&dir), default_ladder());
    }

    /// The Premium tier is appended to an override, never configurable —
    /// a ladder file that dropped it would silently disable Premium
    /// playback, and nothing in the UI would say so.
    #[test]
    fn an_override_still_ends_with_the_premium_tier() {
        let dir = std::env::temp_dir().join(format!("kl-ladder-premium-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(LADDER_FILE), "youtube:player_client=ios\n").unwrap();
        let ladder = load_ladder(&dir);
        assert_eq!(ladder.len(), 2);
        assert_eq!(ladder[0], anon("youtube:player_client=ios"));
        assert!(ladder[premium_tier(&ladder)].cookies);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Remembering the client that worked ────────────────────────────

    #[test]
    fn the_builtin_ladder_leads_with_nothing_pinned() {
        assert_eq!(default_ladder()[0].args, "");
    }

    #[test]
    fn a_remembered_client_is_promoted_to_the_front() {
        let ladder = default_ladder();
        let order = walk_order(&ladder, Some("youtube:player_client=web_embedded"));
        assert_eq!(ladder[order[0]].args, "youtube:player_client=web_embedded");
        // A promotion, not a removal: everything still gets its turn, so a
        // remembered client that later breaks costs one attempt and then
        // the ordinary ladder runs.
        assert_eq!(order.len(), ladder.len());
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..ladder.len()).collect::<Vec<_>>());
    }

    #[test]
    fn remembering_nothing_walks_the_ladder_in_order() {
        let ladder = default_ladder();
        assert_eq!(walk_order(&ladder, None), (0..ladder.len()).collect::<Vec<_>>());
    }

    /// The Premium tier is gated on a Premium refusal, and the gate is
    /// `index == premium_tier`. Promoting it would attach cookies to
    /// every ordinary track — which returns no audio at all.
    #[test]
    fn the_premium_tier_is_never_promoted() {
        let ladder = default_ladder();
        let premium = premium_tier(&ladder);
        // Ask for exactly the Premium tier's args; the anonymous copy of
        // the same client must win instead.
        let order = walk_order(&ladder, Some(&ladder[premium].args));
        assert_ne!(order[0], premium);
        assert!(!ladder[order[0]].cookies);
        assert_eq!(*order.last().unwrap(), premium);
    }

    #[test]
    fn an_unknown_remembered_client_changes_nothing() {
        let ladder = default_ladder();
        assert_eq!(
            walk_order(&ladder, Some("youtube:player_client=nonesuch")),
            (0..ladder.len()).collect::<Vec<_>>()
        );
    }

    /// The unpinned lead tier is `""`, which is also what a corrupt or
    /// truncated last-good file reads as. Promoting it is a no-op rather
    /// than a reorder, so this must not panic or shuffle anything.
    #[test]
    fn remembering_the_unpinned_tier_is_a_no_op() {
        let ladder = default_ladder();
        assert_eq!(walk_order(&ladder, Some("")), (0..ladder.len()).collect::<Vec<_>>());
    }

    // ── Blaming the right thing ───────────────────────────────────────

    /// The ordering rule that matters: during an outage every track fails
    /// and the systemic counter fills up, but telling someone in a tunnel
    /// that YouTube changed its API is worse than useless.
    #[test]
    fn offline_outranks_a_systemic_streak() {
        assert_eq!(cause_of(false, true, false), Cause::Offline);
        assert_eq!(cause_of(false, false, true), Cause::Offline);
    }

    /// A permanent verdict is a fact about one video and survives even a
    /// systemic streak — it is the most specific answer available.
    #[test]
    fn a_permanent_verdict_stays_about_the_track() {
        assert_eq!(cause_of(true, true, true), Cause::Track);
        assert_eq!(cause_of(true, false, true), Cause::Track);
    }

    #[test]
    fn several_different_tracks_failing_online_is_systemic() {
        assert_eq!(cause_of(true, true, false), Cause::Systemic);
        assert_eq!(cause_of(true, false, false), Cause::Track);
    }

    // `note_failure` walks shared global state, so these run as one test
    // rather than racing each other under the parallel test harness.
    #[test]
    fn the_streak_counts_distinct_tracks_and_any_success_clears_it() {
        note_success();

        // The same track failing over and over is one broken track and a
        // user tapping play again — never a systemic verdict.
        for _ in 0..10 {
            assert!(!note_failure("aaaaaaaaaaa"));
        }

        assert!(!note_failure("bbbbbbbbbbb"));
        // Third distinct id crosses the threshold.
        assert!(note_failure("ccccccccccc"));
        // And a repeat of one already counted doesn't inflate it further.
        assert!(note_failure("aaaaaaaaaaa"));

        // One track playing proves extraction works.
        note_success();
        assert!(!note_failure("ddddddddddd"));
        note_success();
    }

    // ── Logging ───────────────────────────────────────────────────────

    #[test]
    fn the_unpinned_tier_has_a_name_in_the_journal() {
        assert_eq!(describe(""), "yt-dlp default clients");
        assert_eq!(describe("youtube:player_client=ios"), "youtube:player_client=ios");
    }
}

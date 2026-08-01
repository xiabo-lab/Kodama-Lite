//! The Rust mirror of `src/protocol.ts` — the typed bus contract. The
//! `#[serde(tag = "type")]` + `rename` on every variant makes these
//! (de)serialize to exactly the same JSON shapes the TypeScript side
//! declares, so a command sent from the UI lands as the right enum here and
//! an event emitted here arrives as the right variant there.
//!
//! YouTube Music content (home/explore/search/playlist/album/artist) and
//! lyrics are NOT here — they're handled entirely in the view plane (see
//! `src/lib/contentBus.ts` on the frontend) and never cross into Rust, so
//! there is nothing for this file to mirror for them.

use serde::{Deserialize, Serialize};

// ── Commands: view plane → data plane ─────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "connectivity:check")]
    ConnectivityCheck,
    /// Resolve a videoId to a playable URL. Never blocks on yt-dlp — see
    /// `subsystems::playback` for why.
    #[serde(rename = "stream:resolve")]
    StreamResolve {
        #[serde(rename = "videoId")]
        video_id: String,
    },
    /// Warm the disk cache for a track without playing it.
    #[serde(rename = "stream:prefetch")]
    StreamPrefetch {
        #[serde(rename = "videoId")]
        video_id: String,
    },
    /// Re-report the managed yt-dlp binary's phase — see the TS mirror for
    /// why the boot-time emit alone is not enough.
    #[serde(rename = "ytdlp:check")]
    YtdlpCheck,
    /// Re-read the webview's cookie jar and report the current session.
    #[serde(rename = "auth:check")]
    AuthCheck,
    /// Open the Google sign-in webview and watch for the session cookies.
    #[serde(rename = "auth:signIn")]
    AuthSignIn,
    /// Drop every Google/YouTube cookie from the jar.
    #[serde(rename = "auth:signOut")]
    AuthSignOut,
    /// Publish the current track + transport state to the OS media
    /// controls (MPRIS on Linux) — what a car head unit reads over
    /// Bluetooth AVRCP.
    #[serde(rename = "media:update")]
    MediaUpdate {
        title: String,
        artist: String,
        album: String,
        thumbnail: String,
        duration: f64,
        elapsed: f64,
        paused: bool,
    },
    #[serde(rename = "media:clear")]
    MediaClear,
    #[serde(rename = "cache:stats")]
    CacheStats,
    #[serde(rename = "cache:clear")]
    CacheClear,
    /// Report the current output volume, for seeding the slider on a
    /// profile that has never set one. Read-only — see `subsystems::volume`.
    #[serde(rename = "volume:get")]
    VolumeGet,
    /// Scan a removable drive for playable audio — the Library's Local
    /// tab. Mounts the drive first if nothing else has; see
    /// `subsystems::local` for why that is our job here.
    #[serde(rename = "local:scan")]
    LocalScan,
    /// Close the app — the Pi runs it full-screen with no desktop chrome,
    /// so the Settings screen's Quit row is the only way out.
    #[serde(rename = "app:quit")]
    AppQuit,
}

// ── Events: data plane → view plane ───────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum AppEvent {
    #[serde(rename = "pong")]
    Pong { ts: i64 },
    #[serde(rename = "net:status")]
    NetStatus { online: bool },
    /// A videoId is now playable at `url` (the local stream server).
    #[serde(rename = "stream:ready")]
    StreamReady {
        #[serde(rename = "videoId")]
        video_id: String,
        url: String,
    },
    #[serde(rename = "stream:error")]
    StreamError {
        #[serde(rename = "videoId")]
        video_id: String,
        message: String,
    },
    /// Managed yt-dlp binary lifecycle: "downloading" | "ready" | "error".
    #[serde(rename = "ytdlp:state")]
    YtdlpState {
        phase: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// The current account session — see the TS mirror for what `cookie`
    /// and `sapisid` are and why neither side persists them.
    #[serde(rename = "auth:state")]
    AuthState {
        #[serde(rename = "signedIn")]
        signed_in: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        cookie: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sapisid: Option<String>,
    },
    #[serde(rename = "auth:error")]
    AuthError { message: String },
    /// A transport button pressed on the OS media controls.
    #[serde(rename = "media:control")]
    MediaControl {
        action: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        position: Option<f64>,
    },
    /// A command from the local control endpoint — the voice assistant.
    ///
    /// Deliberately shaped like `media:control`, and handled the same way:
    /// the view plane routes it into the very same store actions the
    /// on-screen controls call, so a spoken "shuffle on" and a tap on the
    /// shuffle button cannot drift apart. What MPRIS already covers
    /// (play/pause/next/previous/stop/seek) is *not* duplicated here — that
    /// path works without this endpoint existing at all.
    ///
    /// `argument` is free text whose meaning depends on the action: a song
    /// to search for, a volume percentage, "on"/"off".
    #[serde(rename = "control:command")]
    ControlCommand {
        action: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        argument: Option<String>,
    },
    #[serde(rename = "cache:stats")]
    CacheStatsReport {
        count: u64,
        bytes: u64,
        dir: String,
    },
    /// The real output volume, linear 0..1 (the scale a slider wants —
    /// PipeWire's stored `channelVolumes` is its cube). `available: false`
    /// means there is no mixer to talk to: no stream yet, or no
    /// `pw-dump`/`wpctl`, as in a plain browser. The view plane falls back
    /// to attenuating in the webview.
    #[serde(rename = "volume:state")]
    VolumeState {
        volume: f64,
        muted: bool,
        available: bool,
    },
    /// A drive scan started.
    #[serde(rename = "local:scanning")]
    LocalScanning,
    /// Tag-reading progress. A full stick is thousands of `ffprobe` spawns
    /// and tens of seconds, which a bare spinner misrepresents as a hang.
    #[serde(rename = "local:progress")]
    LocalProgress { done: u64, total: u64 },
    /// The finished library. `source` names the drive(s) it came from, so
    /// the tab can say which stick it is showing.
    #[serde(rename = "local:scanned")]
    LocalScanned {
        source: String,
        tracks: Vec<crate::subsystems::local::LocalTrack>,
    },
    /// No drive, no music on it, or it couldn't be mounted — always with a
    /// message that says which, because the three have different fixes.
    #[serde(rename = "local:error")]
    LocalError { message: String },
}

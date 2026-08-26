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
    /// Ask where cover art is served from, so the view plane can rewrite
    /// artwork URLs through the local disk cache. Answered with
    /// `cover:base`. A request rather than a boot-time emit because the
    /// answer has to survive the listener-registration race — an event
    /// emitted before `listen()` completes reaches nobody, and a Home
    /// screen whose artwork silently never caches is exactly the kind of
    /// quiet failure this app has been bitten by before.
    #[serde(rename = "cover:base")]
    CoverBase,
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
        /// Stable per-track identity (the videoId), so `mpris:trackid` can
        /// actually change between songs. It used to be the constant `/`,
        /// which left a head unit unable to tell one track from the next
        /// and its progress bar with nothing to re-anchor on.
        // The view plane speaks camelCase; this enum has no `rename_all`,
        // so the rename is per-field as it is for `videoId` above.
        // Getting it wrong is silent — `default` fills in an empty string
        // and `mpris:trackid` quietly becomes the "no track" sentinel,
        // which is exactly what the first build on the device did.
        #[serde(rename = "trackId", default)]
        track_id: String,
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
    /// A diagnostic line from the view plane, printed to stdout so it
    /// lands in the journal beside the data plane's own.
    ///
    /// The Pi is a headless appliance with no devtools and no visible
    /// console — `console.log` in the webview reaches nothing at all
    /// (verified: an entire boot's worth of the app's journal is Rust
    /// output only). Anything worth diagnosing a boot with therefore has
    /// to cross the bus to be seen.
    #[serde(rename = "log:line")]
    LogLine { scope: String, message: String },
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
    /// Where to fetch cover art: the local server's `/cover` endpoint,
    /// already carrying the per-launch token. Answers `cover:base`.
    #[serde(rename = "cover:base")]
    CoverBase { url: String },
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
        /// What to blame: `"offline"` | `"systemic"` | `"track"`.
        ///
        /// `message` is already written for a human, so this is not for
        /// choosing words — it is so the UI can treat "the internet is
        /// gone" and "extraction is broken for everything" as states of
        /// the app rather than as properties of one song. Before this,
        /// all three rendered identically and the user had no way to tell
        /// a DRM'd track from a dead extractor.
        cause: String,
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
        /// 0.0-1.0, for `volume`. Its own field rather than reusing
        /// `position`, which would make a volume look like a seek.
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<f64>,
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
        /// True when this is the subset already known from the saved index
        /// and more tags are still being read. The tab keeps its progress
        /// line up, but the list is live and playable — a drive that gained
        /// ten songs shouldn't hide the other 20,000 while they're read.
        partial: bool,
    },
    /// No drive, no music on it, or it couldn't be mounted — always with a
    /// message that says which, because the three have different fixes.
    #[serde(rename = "local:error")]
    LocalError { message: String },
}

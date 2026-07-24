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
}

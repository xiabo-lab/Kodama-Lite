//! Reading the current output volume — and only reading it.
//!
//! This exists for one job: on a profile that has never set a volume, tell
//! the UI what the output is already at, so a fresh install opens the
//! slider there instead of at full.
//!
//! It is deliberately not a mixer. An earlier version of this file also
//! *set* the volume with `wpctl`, on the theory that the app slider and the
//! PipeWire stream were two independent attenuators in series. Measuring on
//! the device disproved that: `el.volume` in the webview is written through
//! to the stream's `channelVolumes`, and `wpctl` displays the cube root of
//! that, so the app's cubic curve and PipeWire's cube root cancel exactly —
//! slider 0.37 reads back as `wpctl` 0.37. The UI already owns this value.
//! Writing it from here as well produced two writers racing, which ended
//! with the stream pinned at 1.0 and the app playing at full volume.
//!
//! The real bug was narrower: WirePlumber restores its remembered volume
//! for the `media.role=Music` stream when the node is created, which is
//! after the webview has assigned `el.volume`, and WebKit only propagates a
//! *change* — so an assignment equal to what the element already held was a
//! no-op and WirePlumber's value silently won. The fix is in
//! `lib/audioEngine.ts`: re-assert the volume once playback has actually
//! started.
//!
//! Shells out to `pw-dump` (to find our own node) and `wpctl` (to read it)
//! rather than linking the PipeWire client library: both ship with the Pi's
//! install, the app already spawns yt-dlp so this is not a new capability,
//! and a C binding would be a hard dependency for something that has to
//! degrade gracefully anyway. Any failure reports `available: false` and
//! the UI simply keeps its own value — which is what a plain browser gets,
//! since there is no `wpctl` there.
//!
//! Scale note: `wpctl` speaks the *linear* volume a slider wants, while
//! PipeWire stores `channelVolumes` as its cube. What crosses the bus is
//! the linear value, which is the same scale as the slider.

use std::process::Command as OsCommand;
use std::sync::Mutex;

use tauri::AppHandle;

use crate::bus::emit;
use crate::protocol::AppEvent;

/// The `application.name` PipeWire sees for our stream — set by WebKit from
/// the process name.
const APP_NAME: &str = "kodama-lite";

/// Last known node id. Resolving means running `pw-dump` and parsing a few
/// hundred KB of JSON, which is far too much to do on every frame of a
/// slider drag, so the id is cached and only re-resolved when a command
/// against it fails. Node ids are reused across restarts of our own
/// process, so a stale one is possible — hence the retry rather than
/// trusting the cache.
static CACHED_NODE: Mutex<Option<u32>> = Mutex::new(None);

/// Find our audio stream's PipeWire node id.
///
/// The node only exists while the stream does: before the first track plays
/// there is nothing to find, which is a normal state, not an error.
fn resolve_node() -> Option<u32> {
    let out = OsCommand::new("pw-dump").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    for obj in json.as_array()? {
        if obj.get("type")?.as_str()? != "PipeWire:Interface:Node" {
            continue;
        }
        let props = obj.get("info")?.get("props")?;
        if props.get("application.name").and_then(|v| v.as_str()) != Some(APP_NAME) {
            continue;
        }
        // A process can own several nodes; only the playback stream is ours
        // to move. Matching the class avoids grabbing a monitor or a
        // capture node if one ever appears.
        if props.get("media.class").and_then(|v| v.as_str()) != Some("Stream/Output/Audio") {
            continue;
        }
        if let Some(id) = obj.get("id").and_then(|v| v.as_u64()) {
            return Some(id as u32);
        }
    }
    None
}

/// Cached node id, re-resolving when there isn't one yet.
fn node_id(force: bool) -> Option<u32> {
    let mut cache = CACHED_NODE.lock().ok()?;
    if !force {
        if let Some(id) = *cache {
            return Some(id);
        }
    }
    let found = resolve_node();
    *cache = found;
    found
}

/// Parse `wpctl get-volume <id>`, whose output is `Volume: 0.45` and, when
/// the node is muted, `Volume: 0.45 [MUTED]`.
fn read_volume(id: u32) -> Option<(f64, bool)> {
    let out = OsCommand::new("wpctl")
        .args(["get-volume", &id.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let muted = text.contains("[MUTED]");
    let volume = text
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<f64>().ok())?;
    Some((volume, muted))
}

/// Report the current output volume. Answers `available: false` when there
/// is no stream yet or the tools are missing — never an error, because a
/// missing mixer is a supported configuration, not a fault.
pub fn get(app: &AppHandle) {
    let app = app.clone();
    // `spawn_blocking`, not `spawn`: every call below waits on a child
    // process, and `pw-dump` on a Pi is a few hundred KB of JSON to parse.
    // Parking that on an async worker would stall unrelated tasks.
    tauri::async_runtime::spawn_blocking(move || {
        // Try the cached node first, then re-resolve once — the usual
        // reason for a miss is a cached id from before the stream restarted.
        let reading = node_id(false)
            .and_then(read_volume)
            .or_else(|| node_id(true).and_then(read_volume));
        let event = match reading {
            Some((volume, muted)) => AppEvent::VolumeState {
                volume,
                muted,
                available: true,
            },
            None => AppEvent::VolumeState {
                volume: 1.0,
                muted: false,
                available: false,
            },
        };
        emit(&app, event);
    });
}

// There is deliberately no `set` here. Writing the volume from this side
// was tried and removed: measured on the device, `el.volume` in the webview
// is written straight through to the stream's `channelVolumes`, so the UI
// already controls this exact value and a second writer only fought it.
// See the module comment above and `lib/audioEngine.ts`.

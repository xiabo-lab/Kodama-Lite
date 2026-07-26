//! Output volume, as the system actually sees it.
//!
//! The app used to attenuate in the webview — `el.volume = slider³` — which
//! made the slider a *second* control stacked on top of the PipeWire stream
//! volume it could neither read nor set. WirePlumber persists that stream
//! volume keyed by `media.role` (Kodama-Lite declares `Music`, the same role
//! YTMLite uses, so they share one saved value), and it restores it after
//! the webview has already set its own. The result was a slider pinned at
//! 100% while the speakers played at 45%, with no way to tell from inside
//! the app.
//!
//! So the slider drives the real thing now. `el.volume` stays at 1.0 and
//! this subsystem moves the PipeWire stream, which means one attenuator,
//! and a bar position that always equals what comes out.
//!
//! Implemented by shelling out to `pw-dump` (to find our own node) and
//! `wpctl` (to read and write it) rather than linking the PipeWire client
//! library: both ship with the Pi's PipeWire/WirePlumber install, the app
//! already spawns yt-dlp so process-spawning is not a new capability here,
//! and a C binding would be a hard dependency for something that must
//! degrade gracefully anyway. Every failure path reports
//! `available: false`, and the view plane falls back to webview volume —
//! which is what happens in `vite dev` in a browser, where there is no
//! PipeWire at all.
//!
//! Scale note: `wpctl` speaks the *linear* volume a slider wants, while
//! PipeWire stores `channelVolumes` as its cube. Everything crossing the
//! bus is the linear value.

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

fn apply(id: u32, volume: f64, muted: bool) -> bool {
    let v = volume.clamp(0.0, 1.0);
    let vol_ok = OsCommand::new("wpctl")
        .args(["set-volume", &id.to_string(), &format!("{v:.4}")])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let mute_ok = OsCommand::new("wpctl")
        .args([
            "set-mute",
            &id.to_string(),
            if muted { "1" } else { "0" },
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    vol_ok && mute_ok
}

/// Set the output volume. Deliberately emits nothing on success: the slider
/// is already showing this value (the view plane is optimistic, exactly like
/// the like button), and echoing it back mid-drag would fight the user's
/// finger. Only a failure is reported, so the UI can fall back.
pub fn set(app: &AppHandle, volume: f64, muted: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let try_with = |force: bool| node_id(force).is_some_and(|id| apply(id, volume, muted));
        // Same two-step as `get`: the cached id, then a fresh resolve.
        let ok = try_with(false) || try_with(true);
        if !ok {
            emit(
                &app,
                AppEvent::VolumeState {
                    volume,
                    muted,
                    available: false,
                },
            );
        }
    });
}

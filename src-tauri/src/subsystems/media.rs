//! OS media controls via `souvlaki`. On Linux (the Pi) this publishes an
//! **MPRIS** service on the session D-Bus, which is what `playerctl`, the
//! desktop panel applets and — the reason this exists — **Bluetooth AVRCP**
//! read. A car head unit paired to the Pi gets its "now playing" text and
//! its steering-wheel / touchscreen transport buttons from MPRIS and
//! nothing else: with no MPRIS service published, the car has no way to
//! know a track is playing at all, which is exactly the symptom of
//! metadata and next/prev/play-pause all being dead.
//!
//! Ported from YTMLite's `src-tauri/src/media.rs`, trimmed to the Linux
//! path. YTMLite's Windows half (SMTC, the WebView2 "Unknown app" identity
//! workaround, HWND plumbing) is dropped — this app is Pi-only. The
//! main-thread discipline is kept anyway: `souvlaki::MediaControls` is
//! neither `Send` nor `Sync` on any platform, so it lives in a
//! main-thread thread-local and every touch is marshalled on via
//! `AppHandle::run_on_main_thread`.
//!
//! Direction of travel matches the rest of the bus: `media:update` /
//! `media:clear` are commands going down, and a button press in the car
//! comes back up as a `media:control` event.

use std::cell::RefCell;
use std::time::Duration;

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use tauri::AppHandle;

use crate::bus::emit;
use crate::protocol::AppEvent;

/// Step for a `Seek` that carries no amount. Matches what most head units
/// do for a single press of fast-forward.
const DEFAULT_SEEK_STEP_S: f64 = 10.0;

/// A seek offset as a signed number of seconds.
fn signed(direction: SeekDirection, secs: f64) -> f64 {
    match direction {
        SeekDirection::Forward => secs,
        SeekDirection::Backward => -secs,
    }
}

thread_local! {
    static CONTROLS: RefCell<Option<MediaControls>> = const { RefCell::new(None) };
    /// Signature of the metadata last pushed. The view plane re-pushes
    /// every couple of seconds to keep the car's scrubber honest, but
    /// `set_metadata` re-serialises the whole property set (and the cover
    /// URL) over D-Bus — skip it when nothing actually changed and only
    /// update the cheap playback state + position.
    static LAST_META: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Create the MPRIS service and forward button presses back over the bus.
/// MUST be called on the main thread (from `setup()`), where souvlaki
/// requires to run.
///
/// Registration needs a **session D-Bus**, which a normal Raspberry Pi OS
/// desktop login has; over bare SSH or on a headless image there is none
/// and `MediaControls::new` fails. That's logged and skipped — playback
/// itself is unaffected, the app simply won't appear to `playerctl` or to
/// a paired car. If the Tesla still shows nothing after this ships, that
/// log line is the first thing to check.
///
/// Cover art is handed over as a URL. MPRIS clients fetch `mpris:artUrl`
/// themselves; ours points at `i.ytimg.com`, so it resolves without this
/// app having to cache or serve anything.
pub fn init(app: &AppHandle) {
    let config = PlatformConfig {
        dbus_name: "kodamalite",
        display_name: "Kodama-Lite",
        hwnd: None,
    };

    let mut controls = match MediaControls::new(config) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[media] no OS media controls (no session D-Bus?): {e:?}");
            return;
        }
    };

    let app_handle = app.clone();
    let attached = controls.attach(move |event: MediaControlEvent| {
        let send = |action: &str, position: Option<f64>| {
            emit(
                &app_handle,
                AppEvent::MediaControl {
                    action: action.to_string(),
                    position,
                    volume: None,
                },
            );
        };
        let send_volume = |v: f64| {
            emit(
                &app_handle,
                AppEvent::MediaControl {
                    action: "volume".to_string(),
                    position: None,
                    volume: Some(v),
                },
            );
        };
        match event {
            MediaControlEvent::Play => send("play", None),
            MediaControlEvent::Pause => send("pause", None),
            MediaControlEvent::Toggle => send("toggle", None),
            MediaControlEvent::Next => send("next", None),
            MediaControlEvent::Previous => send("previous", None),
            MediaControlEvent::Stop => send("stop", None),
            MediaControlEvent::SetPosition(MediaPosition(d)) => {
                send("seek", Some(d.as_secs_f64()))
            }
            // MPRIS `Seek` is *relative*, and souvlaki delivers it as
            // `SeekBy`. Both used to fall into the catch-all below and be
            // dropped without a word, so a head unit's fast-forward and
            // rewind — which is what AVRCP maps to `Seek` — did nothing at
            // all. Verified against the running app: `Seek` by +60 s moved
            // playback 2.0 s, i.e. only the time the test itself took.
            //
            // Sent as an offset rather than resolved here, because only the
            // view plane knows the true current position; this side sees it
            // at whatever the 2 s metadata push last reported.
            MediaControlEvent::SeekBy(direction, amount) => {
                let secs = amount.as_secs_f64();
                send("seek_by", Some(signed(direction, secs)))
            }
            // `Seek` with no amount: the spec leaves the step to the player.
            MediaControlEvent::Seek(direction) => {
                send("seek_by", Some(signed(direction, DEFAULT_SEEK_STEP_S)))
            }
            // A head unit setting absolute volume over AVRCP. Dropped until
            // now, so the car's volume knob moved nothing — measured:
            // `playerctl volume 0.20` left the property reading 1.000000,
            // because souvlaki only updates it once the app acts on the
            // event.
            MediaControlEvent::SetVolume(v) => send_volume(v.clamp(0.0, 1.0)),
            _ => {}
        }
    });
    if let Err(e) = attached {
        eprintln!("[media] failed to attach media controls: {e:?}");
        return;
    }

    CONTROLS.with(|c| *c.borrow_mut() = Some(controls));
}

/// Push metadata + playback state. Main-thread only.
#[allow(clippy::too_many_arguments)]
fn apply(
    title: String,
    artist: String,
    album: String,
    cover: String,
    duration: f64,
    playing: bool,
    elapsed: f64,
) {
    CONTROLS.with(|cell| {
        if let Some(controls) = cell.borrow_mut().as_mut() {
            let sig = format!("{title}\u{1}{artist}\u{1}{album}\u{1}{cover}\u{1}{duration}");
            let changed = LAST_META.with(|m| {
                let mut m = m.borrow_mut();
                if m.as_deref() == Some(sig.as_str()) {
                    false
                } else {
                    *m = Some(sig);
                    true
                }
            });
            if changed {
                let _ = controls.set_metadata(MediaMetadata {
                    title: Some(&title),
                    artist: Some(&artist),
                    album: if album.is_empty() { None } else { Some(&album) },
                    cover_url: if cover.is_empty() { None } else { Some(&cover) },
                    duration: if duration > 0.0 {
                        Some(Duration::from_secs_f64(duration))
                    } else {
                        None
                    },
                });
            }
            let progress = Some(MediaPosition(Duration::from_secs_f64(elapsed.max(0.0))));
            let _ = controls.set_playback(if playing {
                MediaPlayback::Playing { progress }
            } else {
                MediaPlayback::Paused { progress }
            });
        }
    });
}

fn clear_now() {
    LAST_META.with(|m| *m.borrow_mut() = None);
    CONTROLS.with(|cell| {
        if let Some(controls) = cell.borrow_mut().as_mut() {
            let _ = controls.set_playback(MediaPlayback::Stopped);
        }
    });
}

/// `media:update` — publish the current track and transport state.
#[allow(clippy::too_many_arguments)]
pub fn update(
    app: &AppHandle,
    title: String,
    artist: String,
    album: String,
    thumbnail: String,
    duration: f64,
    elapsed: f64,
    paused: bool,
) {
    let _ = app.run_on_main_thread(move || {
        apply(title, artist, album, thumbnail, duration, !paused, elapsed);
    });
}

/// `media:clear` — report that nothing is playing.
pub fn clear(app: &AppHandle) {
    let _ = app.run_on_main_thread(clear_now);
}

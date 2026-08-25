//! OS media controls — an **MPRIS** service on the session D-Bus, which is
//! what `playerctl`, the desktop panel applets and — the reason this exists
//! — **Bluetooth AVRCP** read. A car head unit paired to the Pi gets its
//! "now playing" text, its progress bar and its transport buttons from
//! MPRIS and nothing else.
//!
//! The chain to the car, measured on the Pi with `dbus-monitor`:
//!
//! ```text
//! this module  --MPRIS-->  mpris-proxy  --org.bluez.MediaPlayer1-->  bluetoothd  --AVRCP-->  Tesla
//! ```
//!
//! ## Why this is hand-written instead of using `souvlaki`
//!
//! It used to be `souvlaki` 0.7.3. That crate **structurally cannot keep a
//! head unit's progress bar honest**, which was the reported bug: replay
//! and backward seek moved the audio on the Pi but left the Tesla's bar
//! where it was, climbing until it pinned at the end of the song.
//!
//! Three defects, all confirmed in souvlaki's source *and* on the wire:
//!
//!   1. `Position` is a plain get-only property with no change signal, and
//!      souvlaki's `PropertiesChanged` only ever carries `PlaybackStatus`.
//!      An event-driven consumer therefore never learns a position at all.
//!   2. `Seeked` is declared `Seeked(s)` — a *string* — because `("x",)` in
//!      `b.signal::<(String,), _>("Seeked", ("x",))` is the argument *name*,
//!      not its type. The spec says `Seeked(x)`, an int64.
//!   3. `Seeked` is emitted with **zero arguments**, and only from the
//!      inbound `Seek` method — never for `SetPosition` and never for a
//!      seek the user makes on the Pi's own screen.
//!
//! Measured against the old build, playing, over 18 s spanning a backward
//! seek from 71.8 s to 4.9 s, everything that reached `bluetoothd` was:
//!
//! ```text
//! PropertiesChanged ('org.mpris.MediaPlayer2.Player', {'PlaybackStatus': <'Playing'>})   x9
//! ```
//!
//! Nine identical, information-free signals. `bluetoothd` keeps its own
//! `position` plus a `GTimer` and *extrapolates* between updates, so with
//! no update ever arriving the car's bar could only ever climb — exactly
//! the symptom. Nothing about that is fixable from outside the crate: the
//! signal has to come from the connection that owns the bus name, and
//! souvlaki owns it.
//!
//! `zbus` 5 is already in the dependency graph (Tauri's own plugins pull
//! it), so writing the ~40 lines of interface this app actually needs costs
//! no new dependency and removes `souvlaki`, `dbus` and `dbus-crossroads`
//! along with the C `libdbus` link.
//!
//! ## What this publishes, and when
//!
//! Steady playback emits **nothing**. That is deliberate and is how AVRCP
//! is designed to work: the controller is told a position once and runs its
//! own clock from there. Re-anchoring is only needed when the clock would
//! be wrong, so a signal goes out exactly on a **discontinuity** —
//!
//!   * seek forward / backward (from the Pi's screen or from the car)
//!   * replay / restart of the current track
//!   * track change, next, previous
//!   * natural end of a track, and a restart after one
//!   * play / pause / stop
//!
//! — and consists of a spec-correct `Seeked(x)` plus a `PropertiesChanged`
//! carrying `Position`. The second one is what actually moves the Tesla:
//! `mpris-proxy` mirrors `Position` into `org.bluez.MediaPlayer1`, and
//! `bluetoothd`'s `set_position()` turns that into the AVRCP event that
//! re-anchors the controller. Nothing here fakes a bar with a timer — every
//! value published is the real element position read back from the view
//! plane.
//!
//! `Position` itself is *extrapolated* on read rather than returned as the
//! last pushed snapshot. Under souvlaki a polling client saw the property
//! step in ~2 s jumps because it only moved when the app pushed; now a read
//! between pushes is accurate to the millisecond.
//!
//! ## Track identity
//!
//! souvlaki hardcoded `mpris:trackid` to the constant `/`, so no consumer
//! could tell one song from the next and AVRCP's track-changed event never
//! carried anything. Each track now gets a real object path derived from
//! its videoId, which is also what makes "next"/"previous" re-anchor the
//! car's bar without waiting for the position signal.
//!
//! Direction of travel matches the rest of the bus: `media:update` /
//! `media:clear` are commands going down, and a button press in the car
//! comes back up as a `media:control` event.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use futures_lite::future::block_on;
use tauri::AppHandle;
use zbus::blocking::connection;
use zbus::interface;
use zbus::names::InterfaceName;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

use crate::bus::emit;
use crate::protocol::AppEvent;

/// Step for a `Seek` that carries no amount. Matches what most head units
/// do for a single press of fast-forward.
const DEFAULT_SEEK_STEP_S: f64 = 10.0;

/// The MPRIS object path, fixed by the spec.
const OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";

/// The player interface name, needed for the hand-rolled `Position`
/// change signal.
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";

/// How far the real position may drift from the predicted one before it
/// counts as a **discontinuity** rather than ordinary playback.
///
/// The view plane pushes every 2 s while playing, and the prediction is
/// "last position + wall time since". Ordinary drift is the scheduling
/// jitter between those two clocks — tens of milliseconds. A user seek is
/// never that small, and the on-screen scrubber cannot be dragged by less
/// than a second's worth of pixels on a 440px panel. One second is
/// comfortably above the noise and below anything a person can do.
const DISCONTINUITY_S: f64 = 1.0;

// ── shared state ──────────────────────────────────────────────────────

/// Everything the D-Bus property getters serve, behind one lock.
#[derive(Default)]
struct State {
    track_id: String,
    title: String,
    artist: String,
    album: String,
    cover: String,
    /// Track length. Zero means "unknown", which MPRIS spells as an absent
    /// `mpris:length` rather than a zero one.
    duration_s: f64,
    playing: bool,
    /// Distinct from `!playing`: MPRIS has three states and a head unit
    /// shows a different thing for each.
    stopped: bool,
    /// Position at the instant `sampled` was taken.
    position_s: f64,
    sampled: Option<Instant>,
    /// Last value a client wrote to `Volume`. Never read by this app —
    /// carried only so the property round-trips, as it did before.
    volume: f64,
}

impl State {
    /// The live position: the last pushed sample plus however long has
    /// elapsed since, while playing. Clamped to the track length so a late
    /// push can't report past the end.
    fn live_position_s(&self) -> f64 {
        if self.stopped {
            return 0.0;
        }
        let mut pos = self.position_s;
        if self.playing {
            if let Some(at) = self.sampled {
                pos += at.elapsed().as_secs_f64();
            }
        }
        if self.duration_s > 0.0 {
            pos = pos.min(self.duration_s);
        }
        pos.max(0.0)
    }

    fn status(&self) -> &'static str {
        if self.stopped {
            "Stopped"
        } else if self.playing {
            "Playing"
        } else {
            "Paused"
        }
    }

    /// `mpris:trackid`. A valid D-Bus object path may only contain
    /// `[A-Za-z0-9_]` between slashes, and a YouTube videoId routinely
    /// carries `-` and `_`, so it is escaped rather than interpolated.
    fn track_path(&self) -> ObjectPath<'static> {
        if self.track_id.is_empty() {
            // The spec's "no track" sentinel.
            return ObjectPath::try_from("/org/mpris/MediaPlayer2/TrackList/NoTrack")
                .expect("static path")
                .to_owned();
        }
        let mut path = String::from("/com/xiabolab/kodamalite/track/");
        for ch in self.track_id.chars() {
            if ch.is_ascii_alphanumeric() {
                path.push(ch);
            } else {
                // Escaped, not dropped: two different ids must not be able
                // to collide into one path.
                path.push_str(&format!("_{:02x}", ch as u32 & 0xff));
            }
        }
        ObjectPath::try_from(path)
            .unwrap_or_else(|_| {
                ObjectPath::try_from("/org/mpris/MediaPlayer2/TrackList/NoTrack")
                    .expect("static path")
            })
            .to_owned()
    }

    fn metadata(&self) -> HashMap<String, OwnedValue> {
        let mut map = HashMap::new();
        let mut put = |k: &str, v: Value<'_>| {
            if let Ok(owned) = OwnedValue::try_from(v) {
                map.insert(k.to_string(), owned);
            }
        };
        put("mpris:trackid", Value::from(self.track_path()));
        if self.duration_s > 0.0 {
            put(
                "mpris:length",
                Value::from((self.duration_s * 1_000_000.0) as i64),
            );
        }
        if !self.cover.is_empty() {
            put("mpris:artUrl", Value::from(self.cover.clone()));
        }
        if !self.title.is_empty() {
            put("xesam:title", Value::from(self.title.clone()));
        }
        if !self.artist.is_empty() {
            put("xesam:artist", Value::from(vec![self.artist.clone()]));
        }
        if !self.album.is_empty() {
            put("xesam:album", Value::from(self.album.clone()));
        }
        map
    }
}

// ── the two MPRIS interfaces ──────────────────────────────────────────

struct Root;

#[interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    fn raise(&self) {}
    fn quit(&self) {}

    #[zbus(property)]
    fn can_quit(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_raise(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn identity(&self) -> String {
        "Kodama-Lite".to_string()
    }
    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        Vec::new()
    }
    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        Vec::new()
    }
}

struct Player {
    app: AppHandle,
    state: Arc<Mutex<State>>,
}

impl Player {
    fn send(&self, action: &str, position: Option<f64>) {
        emit(
            &self.app,
            AppEvent::MediaControl {
                action: action.to_string(),
                position,
                volume: None,
            },
        );
    }
}

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    #[zbus(name = "Next")]
    fn next(&self) {
        self.send("next", None);
    }
    #[zbus(name = "Previous")]
    fn previous(&self) {
        self.send("previous", None);
    }
    #[zbus(name = "Pause")]
    fn pause(&self) {
        self.send("pause", None);
    }
    #[zbus(name = "PlayPause")]
    fn play_pause(&self) {
        self.send("toggle", None);
    }
    #[zbus(name = "Stop")]
    fn stop(&self) {
        self.send("stop", None);
    }
    #[zbus(name = "Play")]
    fn play(&self) {
        self.send("play", None);
    }

    /// MPRIS `Seek` is **relative**, in microseconds, and is what AVRCP's
    /// fast-forward / rewind maps to. Passed on as an offset rather than
    /// resolved here, because only the view plane knows the true current
    /// position — this side sees it at whatever the last push reported.
    #[zbus(name = "Seek")]
    fn seek(&self, offset: i64) {
        let secs = offset as f64 / 1_000_000.0;
        // A head unit that sends a bare Seek with no amount (some do) gets
        // the conventional step rather than a no-op.
        let secs = if secs == 0.0 { DEFAULT_SEEK_STEP_S } else { secs };
        println!("[Kodama Media] AVRCP seek request: {:+.0} ms", secs * 1000.0);
        self.send("seek_by", Some(secs));
    }

    /// Absolute seek, in microseconds.
    ///
    /// The spec says to ignore the call when `track_id` isn't the current
    /// track. That is deliberately only *logged* here: a head unit that
    /// cached an id across a track change would otherwise have its scrub
    /// silently swallowed, which is a worse failure than acting on a stale
    /// one — the position is still a position the user asked for.
    #[zbus(name = "SetPosition")]
    fn set_position(&self, track_id: ObjectPath<'_>, position: i64) {
        if let Ok(state) = self.state.lock() {
            let current = state.track_path();
            if track_id.as_str() != current.as_str() && track_id.as_str() != "/" {
                println!(
                    "[Kodama Media] SetPosition for a stale track id ({track_id}), honouring it anyway"
                );
            }
        }
        let secs = (position as f64 / 1_000_000.0).max(0.0);
        println!("[Kodama Media] AVRCP set-position request: {:.0} ms", secs * 1000.0);
        self.send("seek", Some(secs));
    }

    #[zbus(name = "OpenUri")]
    fn open_uri(&self, _uri: String) {}

    /// The signal souvlaki declared with the wrong type and then emitted
    /// empty. `x` is an int64 of microseconds, as the spec requires.
    #[zbus(signal)]
    async fn seeked(emitter: &SignalEmitter<'_>, position: i64) -> zbus::Result<()>;

    #[zbus(property)]
    fn playback_status(&self) -> String {
        self.state
            .lock()
            .map(|s| s.status().to_string())
            .unwrap_or_else(|_| "Stopped".to_string())
    }

    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        self.state.lock().map(|s| s.metadata()).unwrap_or_default()
    }

    /// Deliberately **not** change-signalled by zbus: the spec forbids
    /// `Position` in `PropertiesChanged`, and emitting it on every push
    /// would put four signals a second onto a bus that `bluetoothd` is
    /// listening to. It is emitted by hand, only on a discontinuity —
    /// see `publish`.
    #[zbus(property(emits_changed_signal = "false"))]
    fn position(&self) -> i64 {
        self.state
            .lock()
            .map(|s| (s.live_position_s() * 1_000_000.0) as i64)
            .unwrap_or(0)
    }

    #[zbus(property)]
    fn volume(&self) -> f64 {
        self.state.lock().map(|s| s.volume).unwrap_or(1.0)
    }

    /// A head unit's absolute volume knob over AVRCP.
    #[zbus(property)]
    fn set_volume(&self, volume: f64) {
        let v = volume.clamp(0.0, 1.0);
        if let Ok(mut s) = self.state.lock() {
            s.volume = v;
        }
        emit(
            &self.app,
            AppEvent::MediaControl {
                action: "volume".to_string(),
                position: None,
                volume: Some(v),
            },
        );
    }

    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_play(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_pause(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_seek(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }
}

// ── the service thread ────────────────────────────────────────────────

/// One snapshot of the view plane's playback state.
struct Snapshot {
    track_id: String,
    title: String,
    artist: String,
    album: String,
    cover: String,
    duration_s: f64,
    elapsed_s: f64,
    playing: bool,
}

enum Msg {
    Update(Box<Snapshot>),
    Clear,
}

static TX: OnceLock<Sender<Msg>> = OnceLock::new();

/// Create the MPRIS service and forward button presses back over the bus.
///
/// Registration needs a **session D-Bus**, which a normal Raspberry Pi OS
/// desktop login has; over bare SSH or on a headless image there is none
/// and the connection fails. That's logged and skipped — playback itself
/// is unaffected, the app simply won't appear to `playerctl` or to a
/// paired car. If the Tesla shows nothing at all, that log line is the
/// first thing to check.
///
/// Unlike the `souvlaki` version this has no main-thread requirement:
/// `zbus` types are `Send`, so the whole service lives on a thread of its
/// own and `update`/`clear` are a channel send from wherever they're
/// called.
pub fn init(app: &AppHandle) {
    let (tx, rx) = mpsc::channel();
    if TX.set(tx).is_err() {
        return; // already initialised
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("mpris".into())
        .spawn(move || run(app, rx))
        .ok();
}

fn run(app: AppHandle, rx: Receiver<Msg>) {
    let state = Arc::new(Mutex::new(State {
        volume: 1.0,
        stopped: true,
        ..Default::default()
    }));

    let player = Player {
        app,
        state: state.clone(),
    };

    let conn = match connection::Builder::session()
        .and_then(|b| b.name("org.mpris.MediaPlayer2.kodamalite"))
        .and_then(|b| b.serve_at(OBJECT_PATH, Root))
        .and_then(|b| b.serve_at(OBJECT_PATH, player))
        .and_then(|b| b.build())
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Kodama Media] no MPRIS service (no session D-Bus?): {e}");
            return;
        }
    };
    println!("[Kodama Media] MPRIS service registered as org.mpris.MediaPlayer2.kodamalite");

    let iface = match conn
        .object_server()
        .interface::<_, Player>(OBJECT_PATH)
    {
        Ok(i) => i,
        Err(e) => {
            eprintln!("[Kodama Media] MPRIS player interface unavailable: {e}");
            return;
        }
    };

    // What the last push said, so the next one can be judged against it.
    let mut last_status: Option<String> = None;
    let mut last_meta_sig: Option<String> = None;
    let mut last_track_id = String::new();

    while let Ok(msg) = rx.recv() {
        let (snapshot, clearing) = match msg {
            Msg::Update(s) => (*s, false),
            Msg::Clear => (
                Snapshot {
                    track_id: String::new(),
                    title: String::new(),
                    artist: String::new(),
                    album: String::new(),
                    cover: String::new(),
                    duration_s: 0.0,
                    elapsed_s: 0.0,
                    playing: false,
                },
                true,
            ),
        };

        // Was this a discontinuity? Judged *before* the new sample
        // overwrites the old one.
        let (jumped, predicted) = {
            let s = state.lock().expect("mpris state");
            let predicted = s.live_position_s();
            let track_changed = s.track_id != snapshot.track_id;
            let jumped = track_changed
                || s.stopped != clearing
                || s.playing != snapshot.playing
                || (snapshot.elapsed_s - predicted).abs() > DISCONTINUITY_S;
            (jumped, predicted)
        };

        let meta_sig = format!(
            "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
            snapshot.track_id,
            snapshot.title,
            snapshot.artist,
            snapshot.album,
            snapshot.cover,
            snapshot.duration_s
        );
        let meta_changed = last_meta_sig.as_deref() != Some(meta_sig.as_str());
        let track_changed = last_track_id != snapshot.track_id;

        {
            let mut s = state.lock().expect("mpris state");
            s.track_id = snapshot.track_id.clone();
            s.title = snapshot.title;
            s.artist = snapshot.artist;
            s.album = snapshot.album;
            s.cover = snapshot.cover;
            s.duration_s = snapshot.duration_s;
            s.playing = snapshot.playing && !clearing;
            s.stopped = clearing;
            s.position_s = snapshot.elapsed_s.max(0.0);
            s.sampled = Some(Instant::now());
        }

        let status = {
            let s = state.lock().expect("mpris state");
            s.status().to_string()
        };

        block_on(async {
            let emitter = iface.signal_emitter();

            // Metadata first: a head unit that sees a new trackid re-reads
            // everything else, so getting the order wrong makes it re-read
            // the *old* position.
            if meta_changed {
                if let Err(e) = iface.get().metadata_changed(emitter).await {
                    eprintln!("[Kodama Media] metadata signal failed: {e}");
                }
                last_meta_sig = Some(meta_sig);
            }

            if last_status.as_deref() != Some(status.as_str()) {
                if let Err(e) = iface.get().playback_status_changed(emitter).await {
                    eprintln!("[Kodama Media] status signal failed: {e}");
                }
                last_status = Some(status.clone());
            }

            if jumped {
                let pos_us = (snapshot.elapsed_s.max(0.0) * 1_000_000.0) as i64;
                if track_changed {
                    println!(
                        "[Kodama Media] Track change -> {}: position={} ms",
                        if snapshot.track_id.is_empty() {
                            "(none)"
                        } else {
                            snapshot.track_id.as_str()
                        },
                        pos_us / 1000
                    );
                } else if snapshot.elapsed_s <= 0.5 {
                    println!("[Kodama Media] Replay current track: position=0");
                } else {
                    println!(
                        "[Kodama Media] Seek: {} ms -> {} ms",
                        (predicted * 1000.0) as i64,
                        pos_us / 1000
                    );
                }
                println!("[Kodama Media] Publishing playback position: {} ms", pos_us / 1000);

                if let Err(e) = Player::seeked(emitter, pos_us).await {
                    eprintln!("[Kodama Media] seeked signal failed: {e}");
                }
                publish_position(emitter, pos_us).await;
                println!("[Kodama Media] MPRIS/AVRCP state updated ({status})");
            }
        });

        last_track_id = snapshot.track_id;
    }
}

/// Emit `PropertiesChanged` carrying `Position`.
///
/// The MPRIS spec says `Position` is not change-signalled, and a
/// spec-pure player therefore leaves a bridge nothing to act on. BlueZ's
/// `mpris-proxy` explicitly reads it — it mirrors the value into
/// `org.bluez.MediaPlayer1`, where `bluetoothd`'s `set_position()` turns
/// it into the AVRCP event that re-anchors the controller's clock. Sent
/// only on a discontinuity, so the extra signal costs one message per
/// user action rather than a stream.
async fn publish_position(emitter: &SignalEmitter<'_>, position_us: i64) {
    let iface = match InterfaceName::try_from(PLAYER_IFACE) {
        Ok(n) => n,
        Err(_) => return,
    };
    let mut changed: HashMap<&str, Value<'_>> = HashMap::new();
    changed.insert("Position", Value::from(position_us));
    if let Err(e) =
        zbus::fdo::Properties::properties_changed(emitter, iface, changed, Cow::Borrowed(&[]))
            .await
    {
        eprintln!("[Kodama Media] position signal failed: {e}");
    }
}

/// `media:update` — publish the current track and transport state.
#[allow(clippy::too_many_arguments)]
pub fn update(
    _app: &AppHandle,
    track_id: String,
    title: String,
    artist: String,
    album: String,
    thumbnail: String,
    duration: f64,
    elapsed: f64,
    paused: bool,
) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Msg::Update(Box::new(Snapshot {
            track_id,
            title,
            artist,
            album,
            cover: thumbnail,
            duration_s: if duration.is_finite() && duration > 0.0 {
                duration
            } else {
                0.0
            },
            elapsed_s: if elapsed.is_finite() { elapsed } else { 0.0 },
            playing: !paused,
        })));
    }
}

/// `media:clear` — report that nothing is playing.
pub fn clear(_app: &AppHandle) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Msg::Clear);
    }
}

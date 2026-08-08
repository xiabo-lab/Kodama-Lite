//! Connectivity subsystem. Reports real reachability (not the OS "a NIC is
//! up" lie) so the UI can show an offline state and so subsystems can replay
//! intents that failed while offline — and, on the Pi, repairs the one outage
//! it is able to repair.
//!
//! ## Why there is repair code in here at all
//!
//! In the car the internet comes from a 5G hotspot plugged into a USB port.
//! Out on the road it wedges at random: the interface stays up, the default
//! route stays in place, and not one packet gets through. Nothing in the
//! modem announces this, retrying does not clear it, and the driver cannot
//! exactly pull the stick out at 70mph — the only reliable cure is to
//! power-cycle the port it is plugged into, which is what `recover` does.
//!
//! Everything above `recover` exists to be sure we only ever do that to a
//! genuine hardware hang: never to a tunnel or an underground car park (hence
//! `OUTAGE_GRACE`), never to the hotspot while it is still coming up after a
//! cold boot (`BOOT_QUIET`), never twice in a row before the first attempt
//! could possibly have worked (`RECOVER_COOLDOWN`), and never at all when the
//! Pi is online through something that is not a USB adapter — at home on
//! Wi-Fi, an outage is the ISP's and the hotspot is innocent.
//!
//! Deliberately NOT here: rebooting the Pi as a last resort, the way the
//! Carlyrics display does it. That app has nothing to lose by rebooting; this
//! one is playing music, keeps playing it from cache and USB with no internet
//! at all, and — per the Tesla's connect policy — would lose the car's
//! Bluetooth link until someone pressed Connect on the centre screen. A dead
//! hotspot must never cost the user their audio.

use std::time::{Duration, Instant};

use tauri::AppHandle;
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::bus::emit;
use crate::protocol::AppEvent;

/// How long a single reachability probe may take before it counts as a miss.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Background re-probe interval.
///
/// The view plane polls every 5s *while it believes it is offline*, and not
/// at all otherwise — so before this watcher existed, an outage that began
/// mid-drive was never noticed by anyone: the app went on thinking it was
/// online, asked nobody, and simply failed every request. That is exactly the
/// case this whole module is for, so the probe cannot be driven from the UI's
/// retry loop.
const WATCH_INTERVAL: Duration = Duration::from_secs(20);

/// How long the internet must stay unreachable before we blame the hardware.
///
/// Long enough to sit out a tunnel or a coverage hole, short enough that a
/// wedged hotspot costs about a minute of a drive rather than all of it.
const OUTAGE_GRACE: Duration = Duration::from_secs(45);

/// No recovery within this long of the first probe of the session. A cold
/// boot is offline for a while by nature — the Pi powers up with the
/// ignition and the hotspot has to enumerate, attach to the network and hand
/// out a lease — and yanking its power partway through that is how you turn
/// a slow start into a failed one.
const BOOT_QUIET: Duration = Duration::from_secs(90);

/// Minimum gap between two power cycles. Covers re-enumeration, radio
/// attach and DHCP with room to spare, so a persistent outage (no signal at
/// all) can't turn into a loop that cycles the port every minute.
const RECOVER_COOLDOWN: Duration = Duration::from_secs(180);

/// Probe reachability once and emit `net:status`. Answers `connectivity:check`.
pub fn check(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { probe(&app).await });
}

/// Start the background watcher. Called once from setup.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(WATCH_INTERVAL).await;
            probe(&app).await;
        }
    });
}

/// One probe: measure, report, and repair if this is the outage that has
/// earned it.
async fn probe(app: &AppHandle) {
    let started = Instant::now();
    let online = reachable().await;
    // Logged because this probe's *timing* is what a boot-time hang looks
    // like from the outside. A cold boot beats Wi-Fi association, the
    // connect fails with ENETUNREACH in microseconds rather than
    // milliseconds, and anything downstream that waits for a confirmed
    // connection — resume-on-startup especially — depends on this answer
    // being delivered. When the panel is lit but silent again, this line
    // says whether the probe ran, what it decided, and how long it took to
    // decide it.
    eprintln!(
        "[net] probe: online={online} in {:.3}s",
        started.elapsed().as_secs_f64()
    );
    emit(app, AppEvent::NetStatus { online });

    // Scoped so the guard is provably dropped before the `.await` below —
    // a std `MutexGuard` held across one would make this future non-Send
    // and, worse, hold the lock for the whole minute a power cycle takes.
    let cycle_it = {
        let mut outage = OUTAGE.lock().expect("outage state poisoned");
        outage.record(online, Instant::now())
    };
    if cycle_it {
        recover().await;
    }
}

/// A real reachability probe: a short-timeout TCP connect to a well-known
/// anycast resolver on 443. This deliberately does NOT go through the app's
/// HTTP resolver (which on the Pi bypasses /etc/hosts) — it's a raw socket,
/// so it reflects actual internet reachability.
async fn reachable() -> bool {
    matches!(
        timeout(PROBE_TIMEOUT, TcpStream::connect("1.1.1.1:443")).await,
        Ok(Ok(_))
    )
}

// ── When an outage has earned a power cycle ───────────────────────────

static OUTAGE: std::sync::Mutex<Outage> = std::sync::Mutex::new(Outage {
    first_probe: None,
    offline_since: None,
    last_action: None,
});

/// The decision half of recovery, kept free of sockets, sysfs and processes
/// so the policy above can be tested by driving it with synthetic clocks
/// instead of by unplugging things in a car.
struct Outage {
    /// First probe of the session — the start of the boot-quiet window.
    first_probe: Option<Instant>,
    /// Start of the current unbroken run of failures, `None` when online.
    offline_since: Option<Instant>,
    last_action: Option<Instant>,
}

impl Outage {
    /// Fold in one probe result. `true` means: power-cycle the hotspot now.
    fn record(&mut self, online: bool, now: Instant) -> bool {
        let first = *self.first_probe.get_or_insert(now);
        if online {
            self.offline_since = None;
            return false;
        }
        let since = *self.offline_since.get_or_insert(now);
        if now.duration_since(first) < BOOT_QUIET
            || now.duration_since(since) < OUTAGE_GRACE
            || self
                .last_action
                .is_some_and(|last| now.duration_since(last) < RECOVER_COOLDOWN)
        {
            return false;
        }
        self.last_action = Some(now);
        // Restart the outage clock too. The adapter needs to re-enumerate,
        // attach and get a lease before its silence means anything again —
        // without this, the very next probe would already be looking at a
        // 45-second-old outage and only the cooldown would be holding us
        // back.
        self.offline_since = Some(now);
        true
    }
}

// ── The power cycle itself ────────────────────────────────────────────

/// Nothing to do off the Pi. The dev machines have no `/sys/class/net`
/// worth reading and no USB hotspot to cycle.
#[cfg(not(target_os = "linux"))]
async fn recover() {}

#[cfg(target_os = "linux")]
async fn recover() {
    let Some(iface) = usb_net_iface().await else {
        eprintln!("[net] sustained outage, but no USB network adapter to cycle — leaving it alone");
        return;
    };
    let Some(busid) = usb_busid_for_iface(&iface) else {
        eprintln!("[net] {iface} has no USB parent — nothing to cycle");
        return;
    };
    eprintln!("[net] sustained outage on {iface} — power-cycling USB hotspot at {busid}");
    // A real VBUS cycle is what actually revives a wedged modem, so try it
    // first; re-binding the driver only re-enumerates a device that still
    // has power, which clears fewer hangs but needs no hub support.
    if uhubctl_cycle(&busid).await {
        return;
    }
    rebind(&busid).await;
}

/// The USB-backed network interface the hotspot is behind.
///
/// Prefers whatever holds the default route, because that is provably the
/// one we were using; falls back to scanning, because a wedged modem often
/// takes its route down with it and then there is no default route to ask
/// about.
///
/// Returns `None` whenever the route we were using is not USB. That is the
/// safety property that matters most here: at home the Pi is on Wi-Fi or
/// wired Ethernet, an outage means the ISP is down, and there is nothing
/// this code should touch — least of all a hotspot that is sitting in the
/// port doing nothing wrong.
#[cfg(target_os = "linux")]
async fn usb_net_iface() -> Option<String> {
    if let Some(iface) = default_route_iface().await {
        // There IS a route and we still can't reach anything. Only the USB
        // adapter's own wedge is ours to fix; every other carrier is not.
        return usb_busid_for_iface(&iface)
            .is_some()
            .then_some(iface)
            .filter(|n| usable_iface(n));
    }
    // No default route at all — the usual shape of a modem that took its
    // own route down with it, and the case where there is nothing left to
    // ask. Fall back to the first USB-backed interface that qualifies.
    let mut names: Vec<String> = std::fs::read_dir("/sys/class/net")
        .ok()?
        .filter_map(|e| Some(e.ok()?.file_name().to_string_lossy().into_owned()))
        .filter(|n| usable_iface(n))
        .collect();
    names.sort();
    names.into_iter().find(|n| usb_busid_for_iface(n).is_some())
}

/// Could this interface be the USB hotspot?
///
/// The USB-parent check does most of the work — it already rules out the Pi's
/// built-in Ethernet, which is not on the USB bus. This adds the names whose
/// hardware *is* often a USB dongle but which must never be power-cycled:
/// `wl*` because Wi-Fi is a different failure with a different answer, and
/// `bnep*` because that is Bluetooth PAN — and on this Pi the second
/// Bluetooth adapter is a USB dongle, so cycling its port would drop the
/// car's audio link to fix the internet.
#[cfg(target_os = "linux")]
fn usable_iface(name: &str) -> bool {
    !(name == "lo"
        || name.starts_with("wl")
        || name.starts_with("bnep")
        || name.starts_with("docker")
        || name.starts_with("veth")
        || name.starts_with("br-")
        || name.starts_with("tun")
        || name.starts_with("tap"))
}

/// Interface carrying the default route, e.g. `usb0` / `wlan0`.
#[cfg(target_os = "linux")]
async fn default_route_iface() -> Option<String> {
    let out = tokio::process::Command::new("ip")
        .args(["route", "show", "default"])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let parts: Vec<&str> = text.lines().next()?.split_whitespace().collect();
    let at = parts.iter().position(|p| *p == "dev")?;
    parts.get(at + 1).map(|s| (*s).to_owned())
}

/// Resolve a network interface to the bus-id of the USB *device* behind it
/// (e.g. `1-1.2`), or `None` when it isn't USB-backed at all.
#[cfg(target_os = "linux")]
fn usb_busid_for_iface(iface: &str) -> Option<String> {
    let dev = std::fs::canonicalize(format!("/sys/class/net/{iface}/device")).ok()?;
    if !dev.to_string_lossy().contains("/usb") {
        return None;
    }
    // Walk up to the USB device directory — the one carrying `idVendor`.
    // Its basename is the bus-id both the usb driver and uhubctl expect;
    // the interface's own directory (`1-1.2:1.0`) is not.
    let mut path = dev.as_path();
    for _ in 0..8 {
        if path.join("idVendor").exists() {
            let id = path.file_name()?.to_string_lossy().into_owned();
            return busid_ok(&id).then_some(id);
        }
        path = path.parent()?;
    }
    None
}

/// Bus-ids are read out of sysfs, so this is not about untrusted input — it
/// is about never handing something unexpected to a shell or to a kernel
/// sysfs write. Anything that isn't a plain bus-id means we misidentified
/// the device, and the right move then is to do nothing.
fn busid_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '_'))
}

/// Split a bus-id into the (hub, port) pair uhubctl addresses: `1-1.2` is
/// port 2 of hub `1-1`; a root-hub device like `1-1` is port 1 of hub `1`.
fn hub_port(busid: &str) -> Option<(String, String)> {
    let sep = if busid.contains('.') { '.' } else { '-' };
    let (hub, port) = busid.rsplit_once(sep)?;
    (!hub.is_empty() && !port.is_empty()).then(|| (hub.to_owned(), port.to_owned()))
}

/// Cut VBUS to the hotspot's port and restore it. `true` only when the port
/// was really cycled.
#[cfg(target_os = "linux")]
async fn uhubctl_cycle(busid: &str) -> bool {
    let Some((hub, port)) = hub_port(busid) else {
        return false;
    };
    // uhubctl lives in /usr/sbin, which a systemd *user* service's PATH
    // does not include — looking it up by name alone would silently miss
    // the real power cycle and drop us to the weaker fallback.
    let Some(bin) = ["/usr/sbin/uhubctl", "/usr/bin/uhubctl", "/usr/local/bin/uhubctl"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
    else {
        eprintln!("[net] uhubctl not installed — falling back to a driver rebind");
        return false;
    };
    let args = [
        "-l",
        hub.as_str(),
        "-p",
        port.as_str(),
        "-a",
        "cycle",
        "-d",
        "2",
    ];
    for elevate in [false, true] {
        let out = if elevate {
            // The app runs as a user service, so switching port power is
            // not ours to do directly; passwordless sudo is how the Pi is
            // set up and `-n` guarantees we fail instantly rather than
            // block on a password prompt nobody can answer in a car.
            let mut all = vec!["-n", bin];
            all.extend_from_slice(&args);
            run("sudo", &all).await
        } else {
            run(bin, &args).await
        };
        let Some(out) = out else { continue };
        // uhubctl exits 0 while doing nothing on a hub with no per-port
        // power switching, which the Pi's internal hubs may well be — so
        // trust its words, not just its status.
        if out.contains("No compatible devices detected") {
            eprintln!("[net] hub {hub} can't switch port power — falling back to a driver rebind");
            return false;
        }
        eprintln!("[net] uhubctl cycled hub {hub} port {port}");
        return true;
    }
    eprintln!("[net] uhubctl failed (even under sudo) — falling back to a driver rebind");
    false
}

/// Force a re-enumeration by unbinding the device from the usb driver and
/// binding it back. Reloads the hotspot's CDC/RNDIS driver and clears most
/// hangs without power switching, so it is the fallback for hubs that can't
/// cut VBUS.
#[cfg(target_os = "linux")]
async fn rebind(busid: &str) {
    const DRIVER: &str = "/sys/bus/usb/drivers/usb";
    if !sysfs_write(&format!("{DRIVER}/unbind"), busid).await {
        eprintln!("[net] could not unbind {busid} — the hotspot stays as it is");
        return;
    }
    // The device has to be gone before the kernel will take it back.
    tokio::time::sleep(Duration::from_secs(2)).await;
    if sysfs_write(&format!("{DRIVER}/bind"), busid).await {
        eprintln!("[net] re-enumerated USB device {busid}");
    } else {
        // Worse than not having tried: the adapter is now unbound and will
        // stay that way until it is replugged or the Pi restarts. Say so
        // plainly — this is the line to look for when the internet never
        // came back.
        eprintln!("[net] UNBOUND {busid} but could not bind it back — replug needed");
    }
}

/// Write one value to a sysfs attribute, directly if we may and through
/// `sudo -n` if we may not.
#[cfg(target_os = "linux")]
async fn sysfs_write(path: &str, value: &str) -> bool {
    if !busid_ok(value) {
        return false;
    }
    if tokio::fs::write(path, value).await.is_ok() {
        return true;
    }
    // Not ours to write directly: the app runs as a systemd *user* service.
    // `busid_ok` above is what makes this interpolation safe, and `-n` is
    // what keeps a machine without passwordless sudo failing instantly
    // instead of waiting for a password nobody can type while driving.
    let script = format!("printf %s '{value}' > {path}");
    run("sudo", &["-n", "sh", "-c", script.as_str()])
        .await
        .is_some()
}

/// Run a command to completion; `Some(combined output)` on success, `None`
/// on a non-zero exit or a spawn failure. `stdin` is closed so nothing can
/// ever sit waiting for input.
#[cfg(target_os = "linux")]
async fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = tokio::process::Command::new(cmd)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Outage {
        Outage {
            first_probe: None,
            offline_since: None,
            last_action: None,
        }
    }

    /// Every probe result the app has ever produced, replayed at `now`.
    fn at(o: &mut Outage, t0: Instant, secs: u64, online: bool) -> bool {
        o.record(online, t0 + Duration::from_secs(secs))
    }

    #[test]
    fn online_never_recovers() {
        let (mut o, t0) = (fresh(), Instant::now());
        for s in [0, 100, 200, 1000] {
            assert!(!at(&mut o, t0, s, true));
        }
    }

    #[test]
    fn a_brief_outage_is_left_alone() {
        // A tunnel: offline for 40s, then back. Nothing should be cycled.
        let (mut o, t0) = (fresh(), Instant::now());
        at(&mut o, t0, 0, true);
        for s in [200, 220, 240] {
            assert!(!at(&mut o, t0, s, false));
        }
        assert!(!at(&mut o, t0, 245, true));
    }

    #[test]
    fn boot_quiet_protects_a_starting_hotspot() {
        // Offline from the very first probe — a cold boot. The outage is
        // well past OUTAGE_GRACE long before the modem has had its 90s.
        let (mut o, t0) = (fresh(), Instant::now());
        for s in [0, 20, 46, 60, 89] {
            assert!(!at(&mut o, t0, s, false), "cycled at {s}s into boot");
        }
        assert!(at(&mut o, t0, 91, false));
    }

    #[test]
    fn a_sustained_outage_mid_drive_recovers() {
        let (mut o, t0) = (fresh(), Instant::now());
        at(&mut o, t0, 0, true);
        assert!(!at(&mut o, t0, 600, false)); // outage starts
        assert!(!at(&mut o, t0, 620, false)); // 20s in — too early
        assert!(!at(&mut o, t0, 640, false)); // 40s in — still too early
        assert!(at(&mut o, t0, 646, false)); // 46s in — cycle it
    }

    #[test]
    fn cooldown_stops_a_cycle_loop() {
        // No signal at all: recovery can't help, so it must not repeat
        // every grace period for the rest of the drive.
        let (mut o, t0) = (fresh(), Instant::now());
        at(&mut o, t0, 0, true);
        at(&mut o, t0, 550, false);
        assert!(at(&mut o, t0, 600, false));
        for s in [650, 700, 750, 779] {
            assert!(!at(&mut o, t0, s, false), "second cycle at {s}s");
        }
        // Cooldown is 180s and the outage clock restarted with it, so the
        // next attempt is the first probe past both.
        assert!(at(&mut o, t0, 781, false));
    }

    #[test]
    fn recovering_resets_the_outage_clock() {
        let (mut o, t0) = (fresh(), Instant::now());
        at(&mut o, t0, 0, true);
        at(&mut o, t0, 550, false);
        assert!(at(&mut o, t0, 600, false));
        // Back online, then a *new* outage: it gets its own full grace
        // period rather than inheriting the old one's age.
        assert!(!at(&mut o, t0, 900, true));
        assert!(!at(&mut o, t0, 910, false));
        assert!(!at(&mut o, t0, 940, false));
        assert!(at(&mut o, t0, 960, false));
    }

    #[test]
    fn hub_port_splits_both_shapes() {
        assert_eq!(hub_port("1-1.2"), Some(("1-1".into(), "2".into())));
        assert_eq!(hub_port("1-1.4.3"), Some(("1-1.4".into(), "3".into())));
        assert_eq!(hub_port("1-1"), Some(("1".into(), "1".into())));
        assert_eq!(hub_port("usb1"), None);
        assert_eq!(hub_port("-1"), None);
        assert_eq!(hub_port("1-"), None);
    }

    #[test]
    fn busid_ok_rejects_anything_shell_shaped() {
        assert!(busid_ok("1-1.2"));
        assert!(busid_ok("2-1:1.0"));
        assert!(!busid_ok(""));
        assert!(!busid_ok("1-1; rm -rf /"));
        assert!(!busid_ok("1-1 2"));
        assert!(!busid_ok("$(id)"));
        assert!(!busid_ok("1-1'"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn wifi_and_bluetooth_are_never_candidates() {
        assert!(usable_iface("usb0"));
        assert!(usable_iface("eth1"));
        assert!(usable_iface("enx00e04c680001"));
        assert!(usable_iface("wwan0"));
        assert!(!usable_iface("lo"));
        assert!(!usable_iface("wlan0"));
        assert!(!usable_iface("wlp1s0"));
        assert!(!usable_iface("bnep0"));
    }
}

//! In-app update. The Settings → About row's "Update" button lands here.
//!
//! This is `scripts/update-pi.sh` moved inside the app, for the same
//! reason that script exists: Tauri's own updater can only install
//! AppImage bundles on Linux, and Kodama-Lite ships a `.deb` so it stays
//! integrated with apt and the desktop menu. So the sequence is the
//! script's, unchanged — ask the GitHub API for the latest release, take
//! the prebuilt arm64 `.deb` it has already built, `apt-get install` it,
//! restart the systemd user unit — with the difference that the Pi is a
//! panel in a car and the person in front of it has no keyboard, no
//! terminal and no SSH client. A button is the only shape this can take
//! there.
//!
//! Every step reports through `AppEvent::UpdateState` rather than being
//! silent until done: on the Pi's uplink the download alone is tens of
//! seconds, and a button that looks inert for that long gets pressed
//! again.
//!
//! ## What this deliberately does not do
//!
//! No signature check of our own. The `.deb` comes over TLS from the
//! GitHub release built by `.github/workflows/release.yml` — the same
//! trust root the shell script has always used, and the same one apt
//! would have for any third-party `.deb`. A bespoke signing key here
//! would be new key management for no new guarantee, since the thing we
//! would be signing and the key we would sign it with both live in this
//! one repository.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

use crate::bus::emit;
use crate::protocol::AppEvent;

/// Mirrors `REPO` in `scripts/update-pi.sh`.
const API: &str = "https://api.github.com/repos/xiabo-lab/Kodama-Lite/releases/latest";

/// The systemd *user* unit that owns the app on the Pi — see the README
/// block that installs it. Restarting through systemd rather than
/// re-exec'ing ourselves is what keeps `Restart=on-failure` out of it:
/// this is a deliberate stop and start, not a crash.
const SERVICE: &str = "kodama-lite.service";

/// The `.deb` asset built for this machine's architecture. Tauri names
/// the bundle `Kodama-Lite_<version>_<arch>.deb`, so matching the suffix
/// is enough and survives every version bump.
///
/// `None` means "this build cannot install a release of itself" — a
/// Windows or macOS dev build. The check still runs there and still
/// reports the version honestly; only the install step refuses. That is
/// better than hiding the row off-device and leaving a developer unsure
/// whether the button works at all.
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const ASSET_SUFFIX: Option<&str> = Some("_arm64.deb");
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const ASSET_SUFFIX: Option<&str> = Some("_amd64.deb");
#[cfg(not(all(
    target_os = "linux",
    any(target_arch = "aarch64", target_arch = "x86_64")
)))]
const ASSET_SUFFIX: Option<&str> = None;

const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// The `.deb` is ~10 MB, but the Pi's uplink is a USB 5G dongle that can
/// be very slow without being broken.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// One update at a time. The button disables itself while a run is in
/// flight, but the control endpoint reaches the same command, and two
/// concurrent `apt-get`s would sit on the dpkg lock rather than fail
/// cleanly.
static BUSY: AtomicBool = AtomicBool::new(false);

fn state(app: &AppHandle, phase: &str, version: Option<String>, message: Option<String>) {
    emit(
        app,
        AppEvent::UpdateState {
            phase: phase.to_string(),
            version,
            message,
        },
    );
}

/// `update:check` — check, and install if there is something newer.
///
/// One command rather than a check/confirm pair on purpose: the only
/// answer to "an update is available" on this panel is yes, and a second
/// tap in a moving car buys nothing. The two outcomes the user sees are
/// "you are on the latest version" and the app coming back restarted.
pub fn check(app: &AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        state(&app, "checking", None, None);
        if let Err(message) = run(&app).await {
            println!("[update] {message}");
            state(&app, "error", None, Some(message));
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

/// The whole sequence. Emits its own terminal state on success — either
/// `up-to-date`, or `restarting`/`restart-required` after installing —
/// so `Ok(())` here does not mean "nothing happened".
async fn run(app: &AppHandle) -> Result<(), String> {
    // The same string the About row shows: `scripts/bump-version.mjs`
    // keeps `package.json`, `tauri.conf.json` and `Cargo.toml` in step,
    // so the version compiled in here is the version of the installed
    // package. (Missing one of the three is silent — that is exactly the
    // failure this comparison would then get wrong.)
    let current = env!("CARGO_PKG_VERSION");
    let (tag, asset) = latest_release().await?;
    let remote = tag.trim_start_matches('v').to_string();

    if !is_newer(&remote, current) {
        state(app, "up-to-date", Some(current.to_string()), None);
        return Ok(());
    }

    let suffix = ASSET_SUFFIX.ok_or_else(|| {
        format!("{remote} is available, but this build has no installable package for its platform.")
    })?;
    let url = asset.ok_or_else(|| format!("Release {tag} has no {suffix} asset attached."))?;

    state(app, "downloading", Some(remote.clone()), None);
    let deb = download(&url).await?;

    state(app, "installing", Some(remote.clone()), None);
    let installed = install(&deb).await;
    let _ = tokio::fs::remove_file(&deb).await;
    installed?;

    // Only now is the new version on disk. This process is still the old
    // binary, running from its own unlinked inode; everything from here
    // is about replacing it.
    if restart().await {
        state(app, "restarting", Some(remote), None);
    } else {
        state(app, "restart-required", Some(remote), None);
    }
    Ok(())
}

/// Ask the GitHub API for the latest *published* release. Returns its tag
/// and the download URL of the asset for this architecture, if any.
async fn latest_release() -> Result<(String, Option<String>), String> {
    let client = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        // GitHub answers 403 to a request with no User-Agent.
        .user_agent(concat!("Kodama-Lite/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Could not build an HTTP client: {e}"))?;

    let resp = client
        .get(API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Timed out reaching GitHub. Check the connection and try again.".to_string()
            } else {
                format!("Could not reach GitHub: {e}")
            }
        })?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        // `/releases/latest` does not return drafts, so this is also what
        // a repository with nothing but draft releases looks like.
        return Err("No published release found yet.".into());
    }
    let body = resp
        .error_for_status()
        .map_err(|e| format!("GitHub answered {e}"))?
        .text()
        .await
        .map_err(|e| format!("Could not read GitHub's reply: {e}"))?;

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Could not parse GitHub's reply: {e}"))?;

    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("GitHub's reply had no release tag.")?
        .to_string();

    let asset = ASSET_SUFFIX.and_then(|suffix| {
        json.get("assets")?
            .as_array()?
            .iter()
            .find(|a| {
                a.get("name")
                    .and_then(|n| n.as_str())
                    .is_some_and(|n| n.ends_with(suffix))
            })
            .and_then(|a| a.get("browser_download_url")?.as_str().map(str::to_string))
    });

    Ok((tag, asset))
}

/// Fetch the `.deb` into the system temp directory.
///
/// `/tmp` rather than the app's data directory, and 0644 rather than
/// 0600, both on purpose: apt drops privileges to the `_apt` user to read
/// the file, and it cannot traverse a 0700 home directory. Same
/// reasoning, and same trap, as `scripts/update-pi.sh`.
///
/// Downloads to `.part` and renames, so a torn download can never be
/// handed to apt as if it were a package.
async fn download(url: &str) -> Result<PathBuf, String> {
    let name = url.rsplit('/').next().unwrap_or("kodama-lite.deb");
    let path = std::env::temp_dir().join(name);
    let part = path.with_extension("part");
    let _ = tokio::fs::remove_file(&part).await;

    let fetch = async {
        let mut resp = reqwest::get(url)
            .await
            .map_err(|e| format!("Download failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Download failed: {e}"))?;
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("Could not write to {}: {e}", part.display()))?;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("Download interrupted: {e}"))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Could not write the download: {e}"))?;
        }
        file.flush()
            .await
            .map_err(|e| format!("Could not finish the download: {e}"))?;
        Ok::<(), String>(())
    };

    match tokio::time::timeout(DOWNLOAD_TIMEOUT, fetch).await {
        Err(_) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("The download timed out.".into());
        }
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
        Ok(Ok(())) => {}
    }

    // A `.deb` is megabytes; anything tiny is an error page or a
    // truncated body, and handing that to apt produces a far more
    // confusing message than this one.
    const MIN_BYTES: u64 = 512 * 1024;
    let size = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if size < MIN_BYTES {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("The downloaded package was only {size} bytes."));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o644)).await;
    }

    tokio::fs::rename(&part, &path)
        .await
        .map_err(|e| format!("Could not stage the package: {e}"))?;
    Ok(path)
}

/// `sudo -n apt-get install -y <deb>` — apt rather than `dpkg -i`, so a
/// new dependency is pulled in, exactly as the shell script does.
///
/// `-n` never prompts. The Pi has passwordless sudo; on a machine that
/// doesn't, this fails in a second instead of blocking forever on a
/// password nobody can type while driving.
async fn install(deb: &PathBuf) -> Result<(), String> {
    let run = tokio::process::Command::new("sudo")
        .args(["-n", "apt-get", "install", "-y"])
        .arg(deb)
        // apt asks questions when it thinks a human is watching.
        .env("DEBIAN_FRONTEND", "noninteractive")
        .stdin(std::process::Stdio::null())
        .output();

    let out = match tokio::time::timeout(INSTALL_TIMEOUT, run).await {
        Err(_) => return Err("The install timed out.".into()),
        Ok(r) => r.map_err(|e| format!("Could not run apt-get: {e}"))?,
    };

    if out.status.success() {
        return Ok(());
    }

    // apt's real complaint is on stderr and is usually one useful line —
    // a held dpkg lock, or sudo refusing without a password. Surface it
    // rather than a generic failure: those two have completely different
    // fixes, and the user cannot read the journal from the car.
    let stderr = String::from_utf8_lossy(&out.stderr);
    let detail = stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("apt-get failed")
        .trim();
    Err(format!("Install failed: {detail}"))
}

/// Ask systemd to restart our own unit. `true` if the job was accepted —
/// after which this process is about to be killed and started again.
///
/// `--no-block` is load-bearing. Without it `systemctl` waits for the job
/// to finish, but the job's first act is to stop the unit, and we are
/// inside that unit's cgroup: systemd kills this process, and the
/// `systemctl` child with it, while it is still waiting. The job is
/// already queued in the manager by then so it would *probably* still
/// complete — which is not a good enough word for the only way out of a
/// half-applied update. Queuing and returning removes the race.
async fn restart() -> bool {
    let ok = tokio::process::Command::new("systemctl")
        .args(["--user", "restart", "--no-block", SERVICE])
        .stdin(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        // Not fatal, and not worth exiting over: an app launched by hand
        // (a dev build, or the desktop icon) has no unit to restart, and
        // quitting on the user's behalf would look like a crash directly
        // after an update. The UI asks for a restart instead.
        eprintln!("[update] systemctl could not restart {SERVICE}");
    }
    ok
}

/// Is `remote` a higher version than `local`? Numeric, field by field. A
/// string compare would call 0.1.9 newer than 0.1.10, which is why the
/// shell script leaves this judgement to `dpkg --compare-versions`.
///
/// Non-numeric fields count as 0. Releases here are always plain X.Y.Z,
/// and the failure mode for a suffix we don't understand is "offer no
/// update" — the safe direction.
fn is_newer(remote: &str, local: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        v.split(['.', '-', '+'])
            .map(|s| s.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parts(remote), parts(local));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_fields_numerically() {
        assert!(is_newer("0.1.52", "0.1.51"));
        // The one a string compare gets wrong.
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(is_newer("0.2.0", "0.1.99"));
        assert!(!is_newer("0.1.51", "0.1.51"));
        assert!(!is_newer("0.1.50", "0.1.51"));
        // A shorter version is not newer than the same one with a zero.
        assert!(!is_newer("0.1", "0.1.0"));
        assert!(is_newer("1.0", "0.9.9"));
    }
}

//! Managed yt-dlp binary lifecycle. Ported from YTMLite's proven
//! implementation (same author, same platforms) — end users don't have
//! yt-dlp on PATH, so the app owns its copy: the official single-file
//! release for the host OS + architecture is downloaded into
//! `<app-data>/bin/yt-dlp[.exe]` on first run and self-updated via
//! `yt-dlp -U` on a 72-hour cadence.
//!
//! One deliberate change from YTMLite: state is reported through the
//! typed bus (`AppEvent::YtdlpState`) instead of a bespoke `ytdlp-state`
//! event name — Kodama-Lite has exactly one event channel, and this keeps
//! it that way.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::Manager;
use tokio::io::AsyncWriteExt;

use crate::bus::emit;
use crate::protocol::AppEvent;

#[cfg(windows)]
const BINARY_NAME: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const BINARY_NAME: &str = "yt-dlp";

/// Official single-file builds. The `latest/download/` URL redirects to
/// the newest release asset, so no GitHub API call (and no rate limit) is
/// involved. The per-arch Linux assets are self-contained PyInstaller
/// bundles — no system Python needed, which matters on Raspberry Pi OS
/// Lite.
#[cfg(windows)]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(target_os = "macos")]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
/// Raspberry Pi 4/5 on 64-bit Raspberry Pi OS — the primary target.
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
#[cfg(all(
    unix,
    not(target_os = "macos"),
    not(all(target_os = "linux", any(target_arch = "aarch64", target_arch = "x86_64")))
))]
const DOWNLOAD_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

const UPDATE_INTERVAL: Duration = Duration::from_secs(72 * 60 * 60);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(180);
/// ~18 MB on Windows, ~40 MB for the self-contained Linux builds — the
/// latter over a Pi's Wi-Fi is what this budget is really sized for.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where the managed binary lives for this install.
pub fn managed_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bin")
        .join(BINARY_NAME)
}

/// Program to spawn: the managed copy when present, otherwise bare
/// `yt-dlp` so PATH still works on dev machines. Resolved at every spawn
/// (not cached) so a download finishing mid-session takes effect on the
/// next track without a restart.
pub fn program(managed: &Path) -> PathBuf {
    if managed.exists() {
        managed.to_path_buf()
    } else {
        PathBuf::from("yt-dlp")
    }
}

fn emit_state(app: &tauri::AppHandle, phase: &str, message: Option<String>) {
    emit(
        app,
        AppEvent::YtdlpState {
            phase: phase.to_string(),
            message,
        },
    );
}

/// Idempotent "make yt-dlp available" entry point. Called once from the
/// `playback` subsystem's startup; safe to re-invoke as a retry after a
/// failed download.
///
/// Emits `ytdlp:state`: `downloading` → `ready` | `error`.
pub async fn ensure(app: tauri::AppHandle) {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;

    let managed = managed_path(&app);

    if managed.exists() {
        emit_state(&app, "ready", None);
        maybe_self_update(&managed).await;
        return;
    }

    // Dev fallback: a working PATH install means we can play right now.
    // Still fetch the managed copy in the background so this install
    // stops depending on the machine's PATH from the next launch on.
    let path_works = probe_path_install().await;
    if path_works {
        emit_state(&app, "ready", None);
    } else {
        emit_state(&app, "downloading", None);
    }

    match download(&managed).await {
        Ok(()) => {
            eprintln!("[ytdlp] downloaded managed binary to {managed:?}");
            touch_update_stamp(&managed);
            emit_state(&app, "ready", None);
        }
        Err(e) => {
            eprintln!("[ytdlp] download failed: {e}");
            if !path_works {
                emit_state(&app, "error", Some(e));
            }
        }
    }
}

/// True when a bare `yt-dlp --version` spawn succeeds (PATH install).
async fn probe_path_install() -> bool {
    let mut cmd = tokio::process::Command::new("yt-dlp");
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    match cmd.status().await {
        Ok(s) => s.success(),
        Err(_) => false,
    }
}

/// Fetch the official binary into `<managed>.part`, then rename. The
/// .part indirection means a torn download never masquerades as a
/// working binary.
async fn download(managed: &Path) -> Result<(), String> {
    if let Some(dir) = managed.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    }
    let part = managed.with_extension("part");
    let _ = tokio::fs::remove_file(&part).await;

    let fetch = async {
        let resp = reqwest::get(DOWNLOAD_URL)
            .await
            .map_err(|e| format!("request: {e}"))?
            .error_for_status()
            .map_err(|e| format!("http: {e}"))?;
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("create {part:?}: {e}"))?;
        let mut stream = resp;
        while let Some(chunk) = stream.chunk().await.map_err(|e| format!("read body: {e}"))? {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write: {e}"))?;
        }
        file.flush().await.map_err(|e| format!("flush: {e}"))?;
        Ok::<(), String>(())
    };

    match tokio::time::timeout(DOWNLOAD_TIMEOUT, fetch).await {
        Err(_) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("download timed out".into());
        }
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
        Ok(Ok(())) => {}
    }

    // Sanity floor: the smallest real asset (the zipapp) is ~3 MB; a tiny
    // payload is an error page or a truncated body, not yt-dlp.
    const MIN_BINARY_BYTES: u64 = 1024 * 1024;
    let size = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    if size < MIN_BINARY_BYTES {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("downloaded file too small ({size} bytes)"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).await;
    }

    tokio::fs::rename(&part, managed)
        .await
        .map_err(|e| format!("rename: {e}"))
}

fn update_stamp_path(managed: &Path) -> PathBuf {
    managed.with_file_name("last-update-check")
}

fn touch_update_stamp(managed: &Path) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(update_stamp_path(managed), now.to_string());
}

fn update_stamp_age(managed: &Path) -> Option<Duration> {
    let raw = std::fs::read_to_string(update_stamp_path(managed)).ok()?;
    let then = raw.trim().parse::<u64>().ok()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(Duration::from_secs(now.saturating_sub(then)))
}

/// Run `yt-dlp -U` on the managed copy when the last check is older than
/// `UPDATE_INTERVAL`. The stamp is refreshed even on failure so a broken
/// update path can't turn into a retry storm on every launch.
async fn maybe_self_update(managed: &Path) {
    match update_stamp_age(managed) {
        Some(age) if age < UPDATE_INTERVAL => return,
        _ => {}
    }
    touch_update_stamp(managed);

    let mut cmd = tokio::process::Command::new(managed);
    cmd.arg("-U");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    let run = async {
        match cmd.output().await {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let line = stdout
                    .lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("");
                eprintln!("[ytdlp] self-update ({}): {line}", out.status);
            }
            Err(e) => eprintln!("[ytdlp] self-update spawn failed: {e}"),
        }
    };
    if tokio::time::timeout(UPDATE_TIMEOUT, run).await.is_err() {
        eprintln!("[ytdlp] self-update timed out");
    }
}

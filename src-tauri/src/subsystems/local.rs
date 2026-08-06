//! Local media — the Library's "Local" tab.
//!
//! Finds a removable drive, walks it for audio files, reads each one's
//! tags, and hands the view plane a playable list. Every track it returns
//! carries a ready-to-use URL from the local stream server, so playing one
//! involves no yt-dlp, no network and no download — the file is already
//! there.
//!
//! ## Why this needs to mount anything at all
//!
//! On the Pi the drive is NOT automatically mounted. Observed on the
//! device: a 14.8GB exFAT volume present as `/dev/sda1`, `/media` empty,
//! nothing in `/etc/fstab`. Desktop automounting is done by the file
//! manager's session agent, and this app runs as a systemd *user service*
//! with no file manager in the session — so a stick that mounts fine when
//! someone is logged into the desktop stays invisible to us.
//!
//! `udisksctl` is the right tool rather than `sudo mount`: it goes through
//! udisks2 (already running) and polkit, needs no root for a removable
//! device owned by the session user, and asking the kernel to mount exFAT
//! triggers the module autoload that `mount -t exfat` would otherwise need
//! `modprobe` for. Mounting is only attempted for devices that are
//! genuinely removable — never for the SD card the OS is running from.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex;

use super::local_index::{self, ScannedFile};
use crate::bus::emit;
use crate::protocol::AppEvent;

/// Extensions worth probing — **MP3 only**, by request.
///
/// An allowlist rather than "probe everything and see": a drive full of
/// photos would otherwise cost one process spawn per photo to learn
/// nothing. Narrowing it to MP3 also sidesteps the formats WebKit cannot
/// decode anyway (WMA, ALAC), which would otherwise be listed as playable
/// and then fail on tap.
///
/// Note this filters by NAME, not by content, so a file that is `.mp3` in
/// name only still gets listed — the real drive has exactly one of those
/// (`philosophy.mp3` is ASF/WMA). `sniff_audio_mime` labels it honestly at
/// serve time so it fails as an unsupported format rather than mysteriously.
const AUDIO_EXTENSIONS: [&str; 1] = ["mp3"];

/// How deep to walk. Music on a stick is organised Artist/Album/Track at
/// worst; going deeper mostly finds backup folders.
const MAX_DEPTH: usize = 6;

/// Upper bound on tracks.
///
/// Was 2,000, chosen when every scan was a foreground wait — but that cap
/// silently *hid* the rest of a large library rather than merely delaying
/// it: a 20,000-song stick listed 2,000 tracks and gave no hint the other
/// 18,000 existed. Now that an unchanged drive costs no tag reads at all
/// (`local_index`), the wait it was protecting against is paid once, so the
/// ceiling is the real library size instead.
///
/// The whole list is handed to the view plane; `LocalTab` renders a window
/// of it rather than 50,000 DOM nodes, so "Play all" and shuffle still
/// cover the entire drive.
const MAX_TRACKS: usize = 50_000;

/// Concurrent `ffprobe` calls. Each is a process spawn reading a few KB of
/// header; four keeps a Pi 5's cores busy without making the scan itself
/// the reason the UI stutters.
const PROBE_CONCURRENCY: usize = 4;

/// One playable local file, as the view plane sees it.
#[derive(Debug, Clone, Serialize)]
pub struct LocalTrack {
    /// Stable synthetic id, also the stream-server route segment. Derived
    /// from the path so it survives a rescan — a queue saved last session
    /// still points at the same file.
    pub id: String,
    pub title: String,
    pub artist: String,
    /// Seconds. 0 when the file had no readable duration.
    pub duration: f64,
}

/// The scanned index: id → real path. The webview only ever sees ids, so
/// there is no path it can ask for that we did not put here ourselves —
/// which is what makes the `/local/:id` route immune to traversal rather
/// than merely defended against it.
pub type LocalIndex = Arc<Mutex<HashMap<String, PathBuf>>>;

/// FNV-1a over the path. Short, stable, and alphanumeric so it passes the
/// same id sanitiser the stream routes use.
fn path_id(path: &Path) -> String {
    let bytes = path.to_string_lossy();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("loc{hash:016x}")
}

/// Does this id LOOK like one of ours, regardless of whether the index
/// currently holds it?
///
/// The distinction matters because the queue is persisted across restarts
/// but the index is not. After a reboot, a queue whose last track came off
/// the USB stick asks to resolve `loc…` before anything has scanned — and
/// without this check that id went to yt-dlp as if it were a videoId,
/// which fails slowly and reports the track as unavailable rather than
/// saying the drive simply hasn't been read yet. Observed on the device
/// with `philosophy.mp3` after a service restart.
///
/// A real YouTube videoId is 11 characters, so a 19-character `loc`-prefixed
/// hex string cannot collide with one.
pub fn looks_local(id: &str) -> bool {
    id.len() == 19
        && id.starts_with("loc")
        && id[3..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// A mounted filesystem that could hold music.
struct Candidate {
    mount: PathBuf,
    label: String,
    /// Filesystem UUID — what the saved index is filed under. Falls back to
    /// the label when a filesystem has none, because two *different* sticks
    /// sharing a label is a far rarer accident than a stick having no UUID.
    key: String,
}

/// `lsblk -J -o ...` row, flattened. Only the fields we act on.
#[derive(Debug, serde::Deserialize)]
struct BlkDev {
    name: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    fstype: Option<String>,
    #[serde(default)]
    mountpoint: Option<String>,
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    rm: Option<bool>,
    #[serde(default)]
    hotplug: Option<bool>,
    #[serde(default)]
    children: Vec<BlkDev>,
}

#[derive(Debug, serde::Deserialize)]
struct BlkOutput {
    #[serde(default)]
    blockdevices: Vec<BlkDev>,
}

async fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = TokioCommand::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Every removable partition, mounted or not.
async fn list_removable() -> Vec<BlkDev> {
    let Some(json) = run(
        "lsblk",
        &[
            "-J",
            "-o",
            // UUID is what makes an index reusable across reboots — it is
            // the only property of a stick that survives being unplugged,
            // moved to the other USB port and given a new device node.
            "NAME,LABEL,FSTYPE,MOUNTPOINT,UUID,RM,HOTPLUG",
        ],
    )
    .await
    else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<BlkOutput>(&json) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for disk in parsed.blockdevices {
        // `rm` ONLY — never `hotplug`.
        //
        // This is load-bearing, and the obvious-looking `rm || hotplug` is
        // actively dangerous here. Measured on the device: the USB stick
        // reports `rm: true, hotplug: false`, while the SD card the OS
        // boots from reports `rm: false, hotplug: true` (it is, after all,
        // physically removable). Accepting `hotplug` would put `/` and
        // `/boot/firmware` in this list and send the scanner walking the
        // root filesystem.
        // Logged with both flags because "my stick isn't showing up" is
        // the failure this code will actually be debugged for, and the two
        // values are the whole answer.
        eprintln!(
            "[local] {} rm={:?} hotplug={:?} fstype={:?}",
            disk.name, disk.rm, disk.hotplug, disk.fstype
        );
        if !disk.rm.unwrap_or(false) {
            continue;
        }
        // Removability is a property of the DISK; partitions inherit it but
        // don't always report it, so the parent's flag is what we trust.
        if disk.children.is_empty() {
            out.push(disk);
        } else {
            for mut part in disk.children {
                part.rm = Some(true);
                out.push(part);
            }
        }
    }
    // A partition with no filesystem (or an extended container) can't hold
    // music and can't be mounted.
    out.retain(|d| d.fstype.as_deref().is_some_and(|f| !f.is_empty()));
    // Belt and braces against the above ever regressing: a system mount is
    // never a music library, whatever the flags claim.
    out.retain(|d| {
        d.mountpoint.as_deref().is_none_or(|m| {
            m != "/" && m != "[SWAP]" && !m.starts_with("/boot") && !m.starts_with("/usr")
        })
    });
    // Swap and other non-filesystem partitions have nothing to walk.
    out.retain(|d| !matches!(d.fstype.as_deref(), Some("swap") | Some("crypto_LUKS")));
    out
}

/// Ask udisks to mount a device, and return where it landed.
///
/// The success line is `Mounted /dev/sda1 at /media/user/USB3.`; a device
/// someone already mounted answers with an error naming the same path, and
/// that is a success for our purposes, so both are parsed.
///
/// Measured on the device, this fails out of the box:
///
/// ```text
/// Error mounting /dev/sda1: GDBus.Error:...UDisks2.Error.NotAuthorizedCanObtain:
///     Not authorized to perform operation
/// ```
///
/// `CanObtain` means polkit would allow it *given an interactive
/// authentication agent*, and a systemd `--user` service has no TTY and no
/// agent to offer one. The fix is a polkit rule granting
/// `org.freedesktop.udisks2.filesystem-mount` for removable devices — see
/// README. `mount_device` below falls back when that rule isn't installed,
/// so the feature degrades rather than breaking.
async fn udisks_mount(dev: &str) -> Option<PathBuf> {
    let out = TokioCommand::new("udisksctl")
        .args(["mount", "--no-user-interaction", "-b", dev])
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let at = text.rfind(" at ")?;
    let path = text[at + 4..].trim().trim_end_matches('.').trim();
    if path.is_empty() {
        return None;
    }
    Some(PathBuf::from(path))
}

/// Last-resort mount for a device udisks wouldn't take.
///
/// `sudo -n` — never prompting, so on a machine without passwordless sudo
/// this fails instantly and harmlessly instead of hanging a scan forever
/// waiting on a password nobody can type into a car dashboard.
///
/// Mounted read-only, and under `/media/kodama-<name>`: this app has no
/// business writing to the user's music, and `ro` also means a stick
/// yanked mid-scan can't be left with a dirty filesystem.
async fn sudo_mount(dev: &str, name: &str) -> Option<PathBuf> {
    let target = PathBuf::from(format!("/media/kodama-{name}"));
    let target_str = target.to_string_lossy().into_owned();

    let mkdir = TokioCommand::new("sudo")
        .args(["-n", "mkdir", "-p", &target_str])
        .stdin(Stdio::null())
        .status()
        .await
        .ok()?;
    if !mkdir.success() {
        return None;
    }

    // uid/gid so the app can read the files on a filesystem with no
    // ownership of its own (exFAT, FAT32), which is what these sticks are.
    let uid = unsafe { libc_getuid() };
    let opts = format!("ro,uid={uid},gid={uid}");
    let status = TokioCommand::new("sudo")
        .args(["-n", "mount", "-o", &opts, dev, &target_str])
        .stdin(Stdio::null())
        .status()
        .await
        .ok()?;
    if status.success() {
        Some(target)
    } else {
        // Some filesystems (ext4, ntfs3) reject uid/gid. Retry bare.
        let status = TokioCommand::new("sudo")
            .args(["-n", "mount", "-o", "ro", dev, &target_str])
            .stdin(Stdio::null())
            .status()
            .await
            .ok()?;
        status.success().then_some(target)
    }
}

/// Current uid, without pulling in the `libc` crate for one call.
#[cfg(unix)]
unsafe fn libc_getuid() -> u32 {
    extern "C" {
        fn getuid() -> u32;
    }
    getuid()
}

#[cfg(not(unix))]
unsafe fn libc_getuid() -> u32 {
    0
}

/// Mount a device the correct way, then the pragmatic way.
async fn mount_device(dev: &str, name: &str) -> Option<PathBuf> {
    if let Some(p) = udisks_mount(dev).await {
        return Some(p);
    }
    eprintln!("[local] udisks refused {dev}; trying sudo mount");
    sudo_mount(dev, name).await
}

/// What to file this drive's index under. UUID where the filesystem has
/// one, then label, then the kernel device name — which is the weakest of
/// the three, since `sda1` is whichever stick was plugged in first.
fn index_key(dev: &BlkDev) -> String {
    dev.uuid
        .as_deref()
        .filter(|u| !u.is_empty())
        .or(dev.label.as_deref().filter(|l| !l.is_empty()))
        .unwrap_or(&dev.name)
        .to_string()
}

/// Find something to scan: already-mounted removable volumes first, then
/// anything we can mount.
async fn find_media() -> Vec<Candidate> {
    let devices = list_removable().await;
    let mut out = Vec::new();

    for dev in &devices {
        if let Some(mp) = dev.mountpoint.as_deref().filter(|m| !m.is_empty()) {
            out.push(Candidate {
                mount: PathBuf::from(mp),
                label: dev.label.clone().unwrap_or_else(|| dev.name.clone()),
                key: index_key(dev),
            });
        }
    }
    if !out.is_empty() {
        return out;
    }

    // Nothing mounted — this is the normal state on the device, since the
    // app runs headless with no file-manager automount agent.
    for dev in &devices {
        let node = format!("/dev/{}", dev.name);
        let label = dev.label.clone().unwrap_or_else(|| dev.name.clone());
        if let Some(mount) = mount_device(&node, &dev.name).await {
            eprintln!("[local] mounted {node} at {}", mount.display());
            out.push(Candidate {
                mount,
                label,
                key: index_key(dev),
            });
        } else {
            eprintln!("[local] could not mount {node}");
        }
    }
    out
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.as_str()))
}

/// Recursively collect audio files, breadth-limited and count-limited.
///
/// Size and mtime are taken from the directory entry we already have rather
/// than by stat'ing each path again afterwards — on a 50,000-file drive
/// that second pass would be 50,000 extra syscalls to learn what the walk
/// had just been told. These two numbers are the whole staleness test, so
/// gathering them here is what lets a rescan skip ffprobe entirely.
async fn collect_files(root: &Path, mount: &Path) -> Vec<ScannedFile> {
    let mut found = Vec::new();
    let mut queue = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = queue.pop() {
        if found.len() >= MAX_TRACKS || depth > MAX_DEPTH {
            continue;
        }
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Windows and macOS both litter removable drives with metadata
            // directories full of files that look like the real ones.
            if name.starts_with('.')
                || name == "System Volume Information"
                || name == "$RECYCLE.BIN"
            {
                continue;
            }
            match entry.file_type().await {
                Ok(t) if t.is_dir() => queue.push((path, depth + 1)),
                Ok(t) if t.is_file() && is_audio(&path) => {
                    if found.len() < MAX_TRACKS {
                        // A file we cannot stat is still listed, with zeroes
                        // that can never match a saved entry — so it gets
                        // probed every time rather than being dropped.
                        let (size, mtime) = match entry.metadata().await {
                            Ok(m) => (m.len(), mtime_secs(&m)),
                            Err(_) => (0, 0),
                        };
                        let rel = local_index::relative_key(&path, mount);
                        found.push(ScannedFile {
                            path,
                            rel,
                            size,
                            mtime,
                        });
                    }
                }
                _ => {}
            }
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// Modification time as whole seconds since the epoch, or 0 if the
/// filesystem won't say. exFAT and FAT32 — which is what these sticks are —
/// keep only 2-second granularity, which is ample for "did this change".
fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Title/artist from the filename, for files with no usable tags.
///
/// `Artist - Title.mp3` is the near-universal convention and every file on
/// the test drive that lacked a tag followed it. Anything else becomes the
/// title with an empty artist, which is honest rather than invented.
fn from_filename(path: &Path) -> (String, String) {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned = stem.replace('_', " ");
    if let Some((artist, title)) = cleaned.split_once(" - ") {
        let artist = artist.trim();
        let title = title.trim();
        if !artist.is_empty() && !title.is_empty() {
            return (title.to_string(), artist.to_string());
        }
    }
    (cleaned.trim().to_string(), String::new())
}

/// Read one file's tags with ffprobe.
///
/// ffprobe rather than a Rust tag crate because it is already installed on
/// the device, understands every container in `AUDIO_EXTENSIONS`, and
/// reports a real decoded duration — including for VBR MP3s, where a
/// header-only reader guesses and is routinely wrong by tens of seconds.
/// That number is shown as the song length, so being right matters.
async fn probe(path: &Path) -> Option<LocalTrack> {
    let (mut title, mut artist) = (String::new(), String::new());
    let mut duration = 0.0f64;
    let mut codec = String::new();
    let mut probed = false;

    if let Some(out) = run(
        "ffprobe",
        &[
            "-v",
            "quiet",
            // `codec_name` on the first audio stream is what decides
            // whether this is REALLY an MP3 — see the filter below.
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name:format=duration:format_tags=title,artist",
            "-of",
            "default=noprint_wrappers=1:nokey=0",
            &path.to_string_lossy(),
        ],
    )
    .await
    {
        probed = true;
        for line in out.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            match key.trim().to_ascii_lowercase().as_str() {
                "duration" => duration = value.parse().unwrap_or(0.0),
                "codec_name" => codec = value.to_ascii_lowercase(),
                "tag:title" => title = value.to_string(),
                "tag:artist" => artist = value.to_string(),
                _ => {}
            }
        }
    }

    // "Only MP3" means only files that ARE MP3, not only files NAMED .mp3.
    //
    // The real test drive has exactly one counter-example: `philosophy.mp3`
    // is ASF/WMA with an .mp3 extension. Listed by name it looked playable,
    // and tapping it produced a bare "audio error (code 4)" — WebKit cannot
    // decode WMA. Checking the codec drops it at scan time instead, so the
    // list only ever offers tracks that will actually play.
    //
    // Guarded on `probed`: if ffprobe is missing or failed we cannot tell,
    // and dropping every file because the prober is unavailable would turn
    // a degraded scan into an empty one. Fall back to trusting the name.
    if probed && !codec.is_empty() && codec != "mp3" {
        eprintln!(
            "[local] skipping {} — codec is {codec}, not mp3",
            path.display()
        );
        return None;
    }

    // Fall back per FIELD, not all-or-nothing: a file can carry a title
    // and no artist, and the filename usually knows the missing half.
    if title.is_empty() || artist.is_empty() {
        let (fn_title, fn_artist) = from_filename(path);
        if title.is_empty() {
            title = fn_title;
        }
        if artist.is_empty() {
            artist = fn_artist;
        }
    }

    Some(LocalTrack {
        id: path_id(path),
        title,
        artist,
        duration,
    })
}

/// Register the (initially empty) index. Must run in `setup`, before any
/// request can reach the `/local/:id` route or `stream:resolve` can ask
/// whether an id is local.
pub fn init(app: &AppHandle) {
    app.manage(LocalIndex::default());
}

/// `local:scan` — find, mount, walk and probe. Emits `local:scanning`
/// immediately, then — when the saved index already knows some of the
/// drive — a `local:scanned` with `partial: true` so those tracks are
/// playable while the rest are read, progress as it probes, and a final
/// `local:scanned` with `partial: false`.
///
/// Never blocks the command call: everything below runs in a spawned task,
/// same contract as every other subsystem.
pub fn scan(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        emit(&app, AppEvent::LocalScanning);

        let candidates = find_media().await;
        if candidates.is_empty() {
            // Distinguish "no stick" from "there is a stick and we can't
            // mount it" — the first is fixed by plugging one in, the
            // second by installing the polkit rule, and one message for
            // both would send the user down the wrong path.
            let present = !list_removable().await.is_empty();
            let message = if present {
                "Found a USB drive but couldn't mount it. See the polkit rule in README."
            } else {
                "No USB drive found. Plug one in and tap Rescan."
            };
            emit(
                &app,
                AppEvent::LocalError {
                    message: message.into(),
                },
            );
            return;
        }

        let mut files = Vec::new();
        let mut labels = Vec::new();
        for c in &candidates {
            labels.push(c.label.clone());
            files.extend(collect_files(&c.mount, &c.mount).await);
            if files.len() >= MAX_TRACKS {
                files.truncate(MAX_TRACKS);
                break;
            }
        }
        // The index is filed per drive; with two sticks in at once the
        // first one's key names the combined index, which is consistent
        // because the same pair produces the same key.
        let key = candidates
            .first()
            .map(|c| c.key.clone())
            .unwrap_or_default();

        if files.is_empty() {
            emit(
                &app,
                AppEvent::LocalError {
                    message: format!(
                        "No music found on {}.",
                        labels.join(", ")
                    ),
                },
            );
            return;
        }

        let found = files.len();

        // What actually has to be read. Everything the saved index already
        // knows about — same path, same size, same mtime — keeps its tags
        // and costs nothing; this is the whole point of the exercise.
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir());
        let saved = local_index::load(&data_dir, &key).await;
        let local_index::Plan {
            reusable,
            to_probe,
        } = local_index::plan(&files, &saved, |p| path_id(p));

        let total = to_probe.len();
        eprintln!(
            "[local] {found} file(s) on {} — {} reused from index, {total} to probe",
            labels.join(", "),
            reusable.len()
        );

        let mut tracks: Vec<(PathBuf, LocalTrack)> = reusable;

        // Publish what we already know BEFORE reading a single tag, so a
        // drive that gained a few songs is playable immediately instead of
        // holding the whole library hostage to the new files. `partial`
        // keeps the tab's progress line up while the rest is read.
        if !tracks.is_empty() && total > 0 {
            publish_index(&app, &tracks).await;
            emit(
                &app,
                AppEvent::LocalScanned {
                    source: labels.join(", "),
                    tracks: tracks.iter().map(|(_, t)| t.clone()).collect(),
                    partial: true,
                },
            );
        }

        // Probe in fixed-size batches. A batch boundary is also the natural
        // place to report progress, which a first scan of a full stick needs
        // — thousands of spawns is many minutes and a silent spinner reads
        // as a hang.
        // Kept as (path, track) pairs because the probe can now REJECT a
        // file (non-MP3 content), so the surviving tracks no longer line
        // up positionally with `files` — zipping the two afterwards would
        // map ids to the wrong paths.
        let mut done = 0usize;
        for chunk in to_probe.chunks(PROBE_CONCURRENCY) {
            let mut batch = Vec::with_capacity(chunk.len());
            for f in chunk {
                let path = f.path.clone();
                batch.push(tauri::async_runtime::spawn(
                    async move { probe(&path).await },
                ));
            }
            for (handle, f) in batch.into_iter().zip(chunk.iter()) {
                done += 1;
                let path = &f.path;
                // A panicking probe must cost one track's tags, not the
                // scan — fall back to what the filename says.
                let probed = handle.await.unwrap_or_else(|_| {
                    let (title, artist) = from_filename(path);
                    Some(LocalTrack {
                        id: path_id(path),
                        title,
                        artist,
                        duration: 0.0,
                    })
                });
                if let Some(t) = probed {
                    tracks.push((path.clone(), t));
                }
            }
            emit(
                &app,
                AppEvent::LocalProgress {
                    // Progress counts files EXAMINED, not files kept —
                    // otherwise a drive full of rejects would show a bar
                    // that stalls while work is plainly still happening.
                    done: done as u64,
                    total: total as u64,
                },
            );
        }

        // Rebuilt from the files that are on the drive right now, so
        // deletions fall out on their own. Only files that survived the
        // probe are recorded — a rejected non-MP3 stays out of the index
        // and is re-examined next time, which is cheap and self-correcting.
        {
            let by_path: HashMap<&Path, &LocalTrack> =
                tracks.iter().map(|(p, t)| (p.as_path(), t)).collect();
            let entries: Vec<local_index::IndexEntry> = files
                .iter()
                .filter_map(|f| {
                    let t = by_path.get(f.path.as_path())?;
                    Some(local_index::IndexEntry {
                        path: f.rel.clone(),
                        size: f.size,
                        mtime: f.mtime,
                        title: t.title.clone(),
                        artist: t.artist.clone(),
                        duration: t.duration,
                    })
                })
                .collect();
            local_index::save(&data_dir, &key, entries).await;
        }

        if tracks.is_empty() {
            emit(
                &app,
                AppEvent::LocalError {
                    message: format!("No MP3 files found on {}.", labels.join(", ")),
                },
            );
            return;
        }

        // Reused and freshly-probed tracks arrive in two groups, so without
        // this the list would show every remembered song and then every new
        // one, rather than one library in path order.
        tracks.sort_by(|a, b| a.0.cmp(&b.0));

        // Publish the index BEFORE the event: the UI can start playback the
        // instant it renders, and a route lookup that raced the list would
        // 404 on a track the user can already see.
        publish_index(&app, &tracks).await;
        let tracks: Vec<LocalTrack> = tracks.into_iter().map(|(_, t)| t).collect();

        eprintln!("[local] scanned {} track(s)", tracks.len());
        emit(
            &app,
            AppEvent::LocalScanned {
                source: labels.join(", "),
                tracks,
                partial: false,
            },
        );
    });
}

#[cfg(test)]
mod bench {
    use super::*;

    /// End-to-end timing of a first scan against a second one.
    ///
    /// Ignored by default because it needs a real directory of real MP3s
    /// and takes as long as the scan does. Run it against a synthetic
    /// library to check the claim this whole module rests on:
    ///
    /// ```text
    /// KL_SCAN_BENCH=/tmp/synth cargo test --lib -- --ignored --nocapture
    /// ```
    ///
    /// It measures what the user actually waits for — walking, planning and
    /// tag-reading — and asserts that the second pass reads no tags at all.
    #[tokio::test]
    #[ignore]
    async fn first_scan_versus_second() {
        let Ok(root) = std::env::var("KL_SCAN_BENCH") else {
            eprintln!("set KL_SCAN_BENCH to a directory of mp3s");
            return;
        };
        let root = PathBuf::from(root);
        let data = std::env::temp_dir().join("kl-bench-data");
        let _ = std::fs::remove_dir_all(&data);

        let t0 = std::time::Instant::now();
        let files = collect_files(&root, &root).await;
        let walk = t0.elapsed();
        assert!(!files.is_empty(), "no mp3s under {}", root.display());

        // Pass 1 — nothing remembered.
        let t1 = std::time::Instant::now();
        let p1 = local_index::plan(&files, &local_index::DriveIndex::default(), |p| path_id(p));
        let mut tracks = Vec::new();
        for chunk in p1.to_probe.chunks(PROBE_CONCURRENCY) {
            let mut batch = Vec::new();
            for f in chunk {
                let path = f.path.clone();
                batch.push(tauri::async_runtime::spawn(async move { probe(&path).await }));
            }
            for (h, f) in batch.into_iter().zip(chunk.iter()) {
                if let Ok(Some(t)) = h.await {
                    tracks.push((f.clone(), t));
                }
            }
        }
        let first = t1.elapsed();

        let entries: Vec<local_index::IndexEntry> = tracks
            .iter()
            .map(|(f, t)| local_index::IndexEntry {
                path: f.rel.clone(),
                size: f.size,
                mtime: f.mtime,
                title: t.title.clone(),
                artist: t.artist.clone(),
                duration: t.duration,
            })
            .collect();
        local_index::save(&data, "BENCH", entries).await;

        // Pass 2 — the reboot.
        let t2 = std::time::Instant::now();
        let files2 = collect_files(&root, &root).await;
        let saved = local_index::load(&data, "BENCH").await;
        let p2 = local_index::plan(&files2, &saved, |p| path_id(p));
        let second = t2.elapsed();

        eprintln!(
            "\n  files ............ {}\n  walk ............. {:?}\n  FIRST scan ....... {:?}  ({} probed)\n  SECOND scan ...... {:?}  ({} probed, {} reused)\n  speed-up ......... {:.0}x\n",
            files.len(),
            walk,
            first,
            p1.to_probe.len(),
            second,
            p2.to_probe.len(),
            p2.reusable.len(),
            first.as_secs_f64() / second.as_secs_f64().max(1e-9),
        );

        assert_eq!(p2.to_probe.len(), 0, "second scan must read no tags");
        assert_eq!(p2.reusable.len(), tracks.len());
        let _ = std::fs::remove_dir_all(&data);
    }
}

/// Make these tracks resolvable by the `/local/:id` route.
///
/// Called once with the reused subset and again with the full list, so a
/// track shown during a partial update is playable the moment it appears
/// rather than 404ing until the scan finishes.
async fn publish_index(app: &AppHandle, tracks: &[(PathBuf, LocalTrack)]) {
    let index = app.state::<LocalIndex>();
    let mut map = index.lock().await;
    map.clear();
    for (file, t) in tracks {
        map.insert(t.id.clone(), file.clone());
    }
}

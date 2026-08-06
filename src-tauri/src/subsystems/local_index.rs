//! The persistent USB music index.
//!
//! ## Why this exists
//!
//! Reading tags is the entire cost of a scan, and it was paid again on
//! every single app start. Measured on the device (Pi 5, 4 cores, files on
//! local ext4 and warm in the page cache — a *floor*, a real USB stick is
//! several times worse):
//!
//! ```text
//! walking 1,001 files ................ 0.003 s
//! one ffprobe .......................... 0.139 s
//! 1,001 files at concurrency 4 ........ 49.0  s
//! ```
//!
//! So discovery is free and metadata is ~100% of the wall clock, at roughly
//! 49 ms per file. Extrapolated: 20,000 files is ~16 minutes on the SD card
//! and plausibly an hour on a USB 2.0 stick, which matches the report.
//!
//! Nothing about that work was ever kept. `LocalIndex` (the id → path map)
//! is an `Arc<Mutex<HashMap>>` built by `app.manage()` at startup, and
//! `localStore` deliberately does not persist its track list. So every
//! restart began from nothing and re-spawned ffprobe once per file.
//!
//! This module keeps the *result* of that work on disk, keyed by the
//! drive's filesystem UUID, and lets a rescan re-read tags only for files
//! whose size or mtime actually changed.
//!
//! ## Why a JSON file rather than a database
//!
//! It matches what this project already does — `app_data_dir()` for durable
//! data (the managed yt-dlp binary), `app_cache_dir()` for the audio cache,
//! serde_json throughout — and it adds no C dependency to an arm64 build
//! that currently has none. At the 50,000-track ceiling the file is a few
//! MB and parses in well under a second, which is nothing against the
//! ~40 minutes of ffprobe it replaces.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::local::LocalTrack;

/// One indexed file: enough to decide whether it changed, plus the tags
/// that were expensive to read.
///
/// `size` and `mtime` together are the staleness test. Neither alone is
/// enough — an edit that preserves length keeps the size, and some tools
/// preserve mtime while rewriting tags — but a file whose length *and*
/// modification time both match is not one whose tags moved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndexEntry {
    /// Path **relative to the mount point**, not absolute.
    ///
    /// This is load-bearing. The same stick does not reliably land on the
    /// same path twice: `udisks_mount` puts it at `/media/<user>/<label>`
    /// while the `sudo_mount` fallback uses `/media/kodama-<devname>`, and
    /// the device name itself depends on what else was plugged in first.
    /// Keying on absolute paths meant a drive that mounted somewhere new
    /// matched nothing and re-read all 20,000 tags — the exact failure this
    /// module exists to prevent, hidden behind a config that usually works.
    pub path: String,
    pub size: u64,
    /// Seconds since the Unix epoch. 0 when the filesystem wouldn't say.
    pub mtime: i64,
    pub title: String,
    pub artist: String,
    pub duration: f64,
}

/// What one drive's index file holds.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DriveIndex {
    /// Which drive this describes — the filesystem UUID where there is one.
    pub key: String,
    /// Bumped when the shape below changes incompatibly, so a stale file is
    /// discarded rather than deserialised into something wrong.
    #[serde(default)]
    pub version: u32,
    pub entries: Vec<IndexEntry>,
}

/// Current on-disk shape. Bump to invalidate every saved index.
pub const INDEX_VERSION: u32 = 1;

/// A file as the walker found it, before we know whether it needs probing.
#[derive(Debug, Clone, PartialEq)]
pub struct ScannedFile {
    /// Absolute path — what actually gets opened.
    pub path: PathBuf,
    /// The same file relative to the drive's mount point. This is what the
    /// index is keyed on, so that remounting elsewhere still matches.
    pub rel: String,
    pub size: u64,
    pub mtime: i64,
}

/// The index key for a file under `mount`.
///
/// Falls back to the full path when the file somehow isn't under the mount
/// it was found through — that only mismatches against itself, costing one
/// re-probe rather than mismatching against some *other* file's entry.
pub fn relative_key(path: &Path, mount: &Path) -> String {
    path.strip_prefix(mount)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// What a rescan has to do, worked out without touching a single tag.
#[derive(Debug, Default)]
pub struct Plan {
    /// Files whose size and mtime match the saved index — their tags are
    /// reused verbatim and ffprobe is never spawned.
    pub reusable: Vec<(PathBuf, LocalTrack)>,
    /// New or changed files. The only ones that cost a process spawn.
    pub to_probe: Vec<ScannedFile>,
}

/// Decide what actually needs reading.
///
/// Deletions need no handling of their own: the plan is built from the
/// files that are on the drive *now*, so a file that disappeared simply
/// never appears in either list and drops out of the index when it is
/// rewritten.
///
/// Pure, and separated from all the I/O around it, because this is the one
/// piece whose correctness decides whether the feature is fast or wrong —
/// and it is the only part that can be tested without a USB stick.
pub fn plan(found: &[ScannedFile], saved: &DriveIndex, id_of: impl Fn(&Path) -> String) -> Plan {
    let by_path: HashMap<&str, &IndexEntry> =
        saved.entries.iter().map(|e| (e.path.as_str(), e)).collect();

    let mut out = Plan::default();
    for f in found {
        match by_path.get(f.rel.as_str()) {
            Some(e) if e.size == f.size && e.mtime == f.mtime => {
                out.reusable.push((
                    f.path.clone(),
                    LocalTrack {
                        id: id_of(&f.path),
                        title: e.title.clone(),
                        artist: e.artist.clone(),
                        duration: e.duration,
                    },
                ));
            }
            _ => out.to_probe.push(f.clone()),
        }
    }
    out
}

/// Where a given drive's index lives.
///
/// One file per drive rather than one shared file, so plugging in a second
/// stick cannot cost you the first one's index — swapping back and forth
/// between two drives stays instant for both.
pub fn index_path(data_dir: &Path, key: &str) -> PathBuf {
    data_dir.join("local-index").join(format!("{}.json", sanitize_key(key)))
}

/// A UUID is already filename-safe; a volume label is not, and it is the
/// fallback when a filesystem has no UUID to give.
fn sanitize_key(key: &str) -> String {
    let cleaned: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

/// Read a drive's saved index, or an empty one.
///
/// Every failure — absent, unreadable, corrupt, written by an older shape —
/// degrades to "nothing saved", which costs a full scan and is always safe.
/// The alternative (surfacing an error) would strand the user on a drive
/// whose index file happened to get truncated.
pub async fn load(data_dir: &Path, key: &str) -> DriveIndex {
    let path = index_path(data_dir, key);
    let Ok(raw) = tokio::fs::read(&path).await else {
        return DriveIndex::default();
    };
    match serde_json::from_slice::<DriveIndex>(&raw) {
        Ok(idx) if idx.version == INDEX_VERSION => idx,
        Ok(_) => {
            eprintln!("[local] index for {key} is an older version — rescanning");
            DriveIndex::default()
        }
        Err(e) => {
            eprintln!("[local] index for {key} is unreadable ({e}) — rescanning");
            DriveIndex::default()
        }
    }
}

/// Write a drive's index.
///
/// Written to a temp file and renamed, so a power cut (or a car being
/// switched off, which is the same thing here) leaves either the old index
/// or the new one and never a half-written file that the next boot would
/// throw away.
pub async fn save(data_dir: &Path, key: &str, entries: Vec<IndexEntry>) {
    let path = index_path(data_dir, key);
    if let Some(dir) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(dir).await {
            eprintln!("[local] cannot create index dir: {e}");
            return;
        }
    }
    let idx = DriveIndex {
        key: key.to_string(),
        version: INDEX_VERSION,
        entries,
    };
    let Ok(json) = serde_json::to_vec(&idx) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = tokio::fs::write(&tmp, &json).await {
        eprintln!("[local] cannot write index: {e}");
        return;
    }
    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        eprintln!("[local] cannot replace index: {e}");
        let _ = tokio::fs::remove_file(&tmp).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id_of(p: &Path) -> String {
        format!("id:{}", p.to_string_lossy())
    }

    /// `path` is given in absolute form for readability; the index stores
    /// the drive-relative key, so strip the pretend mount the same way
    /// `found()` does.
    fn entry(path: &str, size: u64, mtime: i64) -> IndexEntry {
        IndexEntry {
            path: path.trim_start_matches("/m/").to_string(),
            size,
            mtime,
            title: format!("T {path}"),
            artist: "A".into(),
            duration: 100.0,
        }
    }

    fn found(path: &str, size: u64, mtime: i64) -> ScannedFile {
        ScannedFile {
            path: PathBuf::from(path),
            rel: path.trim_start_matches("/m/").to_string(),
            size,
            mtime,
        }
    }

    fn saved(entries: Vec<IndexEntry>) -> DriveIndex {
        DriveIndex {
            key: "TEST".into(),
            version: INDEX_VERSION,
            entries,
        }
    }

    #[test]
    fn an_unchanged_library_probes_nothing() {
        let idx = saved(vec![entry("/m/a.mp3", 10, 5), entry("/m/b.mp3", 20, 6)]);
        let p = plan(
            &[found("/m/a.mp3", 10, 5), found("/m/b.mp3", 20, 6)],
            &idx,
            id_of,
        );
        assert_eq!(p.to_probe.len(), 0, "nothing changed, so nothing to read");
        assert_eq!(p.reusable.len(), 2);
        // The expensive fields come back verbatim.
        assert_eq!(p.reusable[0].1.title, "T /m/a.mp3");
        assert_eq!(p.reusable[0].1.duration, 100.0);
    }

    #[test]
    fn a_first_scan_probes_everything() {
        let p = plan(
            &[found("/m/a.mp3", 10, 5), found("/m/b.mp3", 20, 6)],
            &DriveIndex::default(),
            id_of,
        );
        assert_eq!(p.to_probe.len(), 2);
        assert!(p.reusable.is_empty());
    }

    #[test]
    fn only_added_files_are_probed() {
        let idx = saved(vec![entry("/m/a.mp3", 10, 5)]);
        let p = plan(
            &[found("/m/a.mp3", 10, 5), found("/m/new.mp3", 30, 9)],
            &idx,
            id_of,
        );
        assert_eq!(p.reusable.len(), 1);
        assert_eq!(p.to_probe.len(), 1);
        assert_eq!(p.to_probe[0].path, PathBuf::from("/m/new.mp3"));
    }

    #[test]
    fn a_deleted_file_simply_leaves_the_index() {
        let idx = saved(vec![entry("/m/a.mp3", 10, 5), entry("/m/gone.mp3", 20, 6)]);
        let p = plan(&[found("/m/a.mp3", 10, 5)], &idx, id_of);
        assert_eq!(p.reusable.len(), 1);
        assert!(p.to_probe.is_empty());
        assert!(
            !p.reusable.iter().any(|(pth, _)| pth.ends_with("gone.mp3")),
            "a file that is no longer on the drive must not be listed"
        );
    }

    #[test]
    fn a_retagged_file_is_re_read() {
        // Same length, later mtime: exactly what editing a tag in place does.
        let idx = saved(vec![entry("/m/a.mp3", 10, 5)]);
        let p = plan(&[found("/m/a.mp3", 10, 99)], &idx, id_of);
        assert_eq!(p.to_probe.len(), 1, "an mtime change must invalidate tags");
        assert!(p.reusable.is_empty());
    }

    #[test]
    fn a_replaced_file_of_the_same_age_is_re_read() {
        let idx = saved(vec![entry("/m/a.mp3", 10, 5)]);
        let p = plan(&[found("/m/a.mp3", 999, 5)], &idx, id_of);
        assert_eq!(p.to_probe.len(), 1, "a size change must invalidate tags");
    }

    #[test]
    fn another_drives_index_is_never_reused() {
        // Same paths, different drive — /media/USB/a.mp3 is a plausible
        // collision between two sticks. Keys are per drive, so this is
        // enforced by the filename rather than by the diff.
        let dir = Path::new("/data");
        assert_ne!(
            index_path(dir, "1111-AAAA"),
            index_path(dir, "2222-BBBB"),
            "two drives must not share an index file"
        );
    }

    #[test]
    fn a_label_with_slashes_cannot_escape_the_index_dir() {
        let p = index_path(Path::new("/data"), "../../etc/passwd");
        assert_eq!(
            p,
            PathBuf::from("/data/local-index/______etc_passwd.json"),
            "a volume label is attacker-ish input and must not traverse"
        );
    }

    #[test]
    fn an_empty_key_still_produces_a_usable_filename() {
        assert_eq!(
            index_path(Path::new("/data"), ""),
            PathBuf::from("/data/local-index/unknown.json")
        );
    }

    // ── Round trip over real files ────────────────────────────────────
    //
    // The unit tests above use hand-built structs, which cannot catch a
    // mismatch between what the walker records and what the index stores —
    // an mtime read in millis on one side and seconds on the other would
    // pass every one of them and still re-probe the whole drive forever.
    // These go through the actual filesystem and the actual JSON.

    use std::fs;
    use std::time::UNIX_EPOCH;

    /// A scratch directory of this test's own, cleaned up at the end.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kl-index-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(dir: &Path, name: &str, body: &str) -> ScannedFile {
        let path = dir.join(name);
        fs::write(&path, body).unwrap();
        let meta = fs::metadata(&path).unwrap();
        ScannedFile {
            rel: relative_key(&path, dir),
            path,
            size: meta.len(),
            mtime: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        }
    }

    fn entries_for(files: &[ScannedFile]) -> Vec<IndexEntry> {
        files
            .iter()
            .map(|f| IndexEntry {
                path: f.rel.clone(),
                size: f.size,
                mtime: f.mtime,
                title: "T".into(),
                artist: "A".into(),
                duration: 1.0,
            })
            .collect()
    }

    #[tokio::test]
    async fn a_saved_index_survives_a_round_trip_and_probes_nothing() {
        let music = scratch("roundtrip-music");
        let data = scratch("roundtrip-data");

        let files = vec![
            write_file(&music, "a.mp3", "aaaa"),
            write_file(&music, "b.mp3", "bbbbbb"),
        ];

        // First scan: nothing saved, so everything is read.
        let first = plan(&files, &DriveIndex::default(), id_of);
        assert_eq!(first.to_probe.len(), 2);
        save(&data, "UUID-1", entries_for(&files)).await;

        // Second scan — the reboot case. Same files, untouched.
        let saved_idx = load(&data, "UUID-1").await;
        assert_eq!(saved_idx.entries.len(), 2, "the index must come back");
        let second = plan(&files, &saved_idx, id_of);
        assert_eq!(
            second.to_probe.len(),
            0,
            "an unchanged drive must not spawn a single ffprobe"
        );
        assert_eq!(second.reusable.len(), 2);

        let _ = fs::remove_dir_all(&music);
        let _ = fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn a_real_edit_is_detected_across_a_reload() {
        let music = scratch("edit-music");
        let data = scratch("edit-data");

        let a = write_file(&music, "a.mp3", "aaaa");
        let b = write_file(&music, "b.mp3", "bbbb");
        save(&data, "UUID-2", entries_for(&[a.clone(), b.clone()])).await;

        // Rewrite one file with different content, then re-stat it exactly
        // as the walker would.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let b2 = write_file(&music, "b.mp3", "bbbbbbbbbbbbbbbb");
        assert_ne!((b.size, b.mtime), (b2.size, b2.mtime));

        let idx = load(&data, "UUID-2").await;
        let p = plan(&[a, b2], &idx, id_of);
        assert_eq!(p.to_probe.len(), 1, "only the edited file is re-read");
        assert!(p.to_probe[0].path.ends_with("b.mp3"));
        assert_eq!(p.reusable.len(), 1);

        let _ = fs::remove_dir_all(&music);
        let _ = fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn a_different_drive_gets_its_own_index() {
        let data = scratch("twodrives-data");
        let music = scratch("twodrives-music");
        let files = vec![write_file(&music, "a.mp3", "aaaa")];

        save(&data, "UUID-A", entries_for(&files)).await;

        // A second stick that has never been scanned must not inherit the
        // first one's tags just because it was plugged into the same port.
        let other = load(&data, "UUID-B").await;
        assert!(other.entries.is_empty());
        assert_eq!(plan(&files, &other, id_of).to_probe.len(), 1);

        // ...and the first one is still intact.
        assert_eq!(load(&data, "UUID-A").await.entries.len(), 1);

        let _ = fs::remove_dir_all(&music);
        let _ = fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn the_same_drive_mounted_somewhere_else_still_matches() {
        // The failure this guards: udisks mounts at /media/<user>/<label>,
        // the sudo fallback at /media/kodama-<devname>. Same stick, same
        // files, different absolute paths — which used to match nothing and
        // re-read every tag.
        let old_mount = scratch("remount-old");
        let data = scratch("remount-data");

        let a = write_file(&old_mount, "a.mp3", "aaaa");
        let b = write_file(&old_mount, "b.mp3", "bbbb");
        save(&data, "UUID-R", entries_for(&[a.clone(), b.clone()])).await;

        // The same two files as they'd be discovered under a different
        // mount point: identical size and mtime, different absolute path,
        // same path relative to the drive.
        let remount = |f: &ScannedFile| ScannedFile {
            path: PathBuf::from("/media/kodama-sdb1").join(&f.rel),
            rel: f.rel.clone(),
            size: f.size,
            mtime: f.mtime,
        };
        let (a2, b2) = (remount(&a), remount(&b));
        assert_ne!(a2.path, a.path, "the absolute paths really do differ");

        let idx = load(&data, "UUID-R").await;
        let p = plan(&[a2, b2], &idx, id_of);
        assert_eq!(
            p.to_probe.len(),
            0,
            "a remount must not invalidate the index"
        );
        assert_eq!(p.reusable.len(), 2);

        let _ = fs::remove_dir_all(&old_mount);
        let _ = fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn a_corrupt_index_costs_a_rescan_rather_than_an_error() {
        let data = scratch("corrupt-data");
        let path = index_path(&data, "UUID-C");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{ this is not json").unwrap();

        let idx = load(&data, "UUID-C").await;
        assert!(idx.entries.is_empty(), "unreadable must degrade, not throw");

        let _ = fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn an_index_from_an_older_shape_is_discarded() {
        let data = scratch("version-data");
        let path = index_path(&data, "UUID-V");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // version 0 — written before INDEX_VERSION existed.
        fs::write(
            &path,
            br#"{"key":"UUID-V","version":0,"entries":[{"path":"/x.mp3","size":1,"mtime":1,"title":"t","artist":"a","duration":1.0}]}"#,
        )
        .unwrap();

        assert!(load(&data, "UUID-V").await.entries.is_empty());

        let _ = fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn a_half_written_index_never_replaces_a_good_one() {
        let data = scratch("atomic-data");
        let music = scratch("atomic-music");
        let files = vec![write_file(&music, "a.mp3", "aaaa")];
        save(&data, "UUID-D", entries_for(&files)).await;

        // A leftover temp file from an interrupted write must be ignored:
        // the real index is only ever the renamed one.
        let tmp = index_path(&data, "UUID-D").with_extension("json.tmp");
        fs::write(&tmp, b"garbage").unwrap();

        assert_eq!(load(&data, "UUID-D").await.entries.len(), 1);

        let _ = fs::remove_dir_all(&music);
        let _ = fs::remove_dir_all(&data);
    }
}

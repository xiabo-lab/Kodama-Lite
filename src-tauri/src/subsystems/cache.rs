//! Audio cache inventory. The playback subsystem already writes every
//! played track to `<app-cache>/stream/<videoId>.webm` and serves later
//! plays straight off disk — so "save the song so next time costs no
//! data" has always been true; what was missing was any way to *see* or
//! *clear* it. That's this module.
//!
//! Deliberately smaller than YTMLite's cache manager, which also lists
//! per-track entries with titles, relocates the cache directory and
//! sweeps anything outside the user's library on a schedule. Those need a
//! title sidecar, a folder picker and a library round-trip respectively;
//! stats + clear is the part that answers "how much space is this using
//! and how do I get it back", and it's honest on its own.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::bus::emit;
use crate::protocol::AppEvent;

/// Same path the stream server writes to — see `playback::start`.
pub fn cache_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("stream")
}

/// Count and total size of the cached audio. Only finished `.webm` files
/// count: a `.part` is an interrupted download the server will resume or
/// discard, and reporting it as cached audio would overstate what's
/// actually reusable offline.
async fn measure(dir: &Path) -> (u64, u64) {
    let mut count = 0u64;
    let mut bytes = 0u64;
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return (0, 0);
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("webm") {
            continue;
        }
        if let Ok(meta) = entry.metadata().await {
            if meta.is_file() {
                count += 1;
                bytes += meta.len();
            }
        }
    }
    (count, bytes)
}

/// `cache:stats` — how much audio is on disk, and where.
pub fn stats(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let dir = cache_dir(&app);
        let (count, bytes) = measure(&dir).await;
        emit(
            &app,
            AppEvent::CacheStatsReport {
                count,
                bytes,
                dir: dir.to_string_lossy().into_owned(),
            },
        );
    });
}

/// `cache:clear` — delete every cached audio file, then report the new
/// (empty) stats so the UI updates from the same event it always does.
///
/// Removes files individually rather than the directory itself: the
/// stream server holds this path and creates files under it at runtime,
/// and pulling the directory out from under a download in flight is a
/// worse failure than leaving one file behind. `.part` files go too —
/// they're resumable, not precious.
pub fn clear(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let dir = cache_dir(&app);
        if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                let ext = path.extension().and_then(|e| e.to_str());
                if matches!(ext, Some("webm") | Some("part")) {
                    if let Err(e) = tokio::fs::remove_file(&path).await {
                        eprintln!("[cache] remove {path:?}: {e}");
                    }
                }
            }
        }
        let (count, bytes) = measure(&dir).await;
        emit(
            &app,
            AppEvent::CacheStatsReport {
                count,
                bytes,
                dir: dir.to_string_lossy().into_owned(),
            },
        );
    });
}

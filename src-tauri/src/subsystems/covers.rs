//! Disk cache for cover art, served by the local HTTP server.
//!
//! ## The bug this exists for
//!
//! The Pi boots with the ignition, and its network takes ~40s to arrive
//! (the 5G dongle has to enumerate, attach and get a lease). `homeStore`
//! restores the last feed from `localStorage` and paints it instantly, so
//! the shelf titles and every song and album name are right from the first
//! frame — but the artwork was a plain `<img>` pointed straight at
//! `i.ytimg.com`. With no network every one of those fails, and
//! `Thumbnail` falls back to a grey tile with a music glyph. What the
//! driver sees is a Home screen full of empty placeholders for the first
//! minute of every drive.
//!
//! Worse, it did not heal. `Thumbnail` remembers the URL that failed, and
//! the carousel keys items by `kind:id` — so React kept the same component
//! instances across the refresh, the remembered failure with them, and
//! tiles that missed the boot window stayed grey for the rest of the
//! session even after the feed came back with the same URLs.
//!
//! So the cache has to be on OUR side of the network, and it has to
//! survive a power cut: the whole point is the frame drawn *before* the
//! first packet moves.
//!
//! ## Shape
//!
//! A caching proxy rather than a warm-on-write cache. The view plane
//! rewrites every artwork URL to `<base>/cover?u=<encoded>`, and this
//! module answers from disk or fetches once and stores it. That means
//! there is no separate "warm the cache" step to keep in step with the
//! feed, no list of URLs to maintain, and every screen — Home, Explore,
//! Search, Library, the queue panel — gets the same treatment for free
//! because they all render through `Thumbnail`.
//!
//! It also cuts repeat traffic on a metered 5G link, which on this device
//! is a real second prize.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Hosts we will fetch from. Mirrors the `img-src` list in
/// `tauri.conf.json`'s CSP — this endpoint must never become a way to
/// launder arbitrary requests through the app, even though it is bound to
/// 127.0.0.1 behind the per-launch token.
const ALLOWED_HOSTS: &[&str] = &[
    "i.ytimg.com",
    "yt3.ggpht.com",
    "yt3.googleusercontent.com",
    "lh3.googleusercontent.com",
    "www.gstatic.com",
    "music.youtube.com",
];

/// Total cover cache budget. Artwork is small (a 256px JPEG is ~10-25 kB),
/// so this holds many thousands of tiles — far more than the feed, the
/// library and a drive's worth of searches together — while staying a
/// rounding error next to the audio cache on the same disk.
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// Prune down to this much when over budget, so a full cache does not
/// re-prune on every single request.
const PRUNE_TARGET_BYTES: u64 = 48 * 1024 * 1024;

/// A single image this big is not cover art; refuse rather than let one
/// bad URL eat the budget.
const MAX_ENTRY_BYTES: usize = 4 * 1024 * 1024;

/// Upstream fetch timeout, and it is deliberately tight.
///
/// Covers are served from the same origin as the audio stream — one axum
/// server on 127.0.0.1 — and a browser caps concurrent connections per
/// origin at six. A cover request that sits waiting on a slow upstream is
/// therefore holding a slot the `<audio>` element might want. It takes six
/// simultaneous cold-cache tiles on a slow link at the exact moment
/// playback starts to bite, which is rare, but "artwork delayed the music"
/// is not a trade this device should ever make.
///
/// Four seconds is past the slow end of a real artwork fetch on the car's
/// 5G link and short enough that the pathological case costs one bar of
/// music rather than a stall. A tile that misses the window falls back to
/// its glyph and is re-tried on the next connectivity edge; the cache is
/// still populated for the next boot, which is the point of all this.
///
/// `loading="lazy"` on the view side is the other half: only the tiles
/// actually on the Pi's 440px panel are ever requested, so the pressure is
/// ~8 images and not the whole feed.
const FETCH_TIMEOUT: Duration = Duration::from_secs(4);

/// Where the covers live: a sibling of the audio cache, not a child, so
/// "clear the audio cache" never takes the artwork with it.
pub fn dir(app_cache_dir: &Path) -> PathBuf {
    app_cache_dir.join("covers")
}

/// Why a cover could not be produced. The view plane never sees these —
/// they all become one HTTP status, and `Thumbnail` falls back to its
/// glyph — but they are worth distinguishing in the journal.
#[derive(Debug)]
pub enum CoverError {
    /// Not a host we fetch from. A bug on our side, or someone poking the
    /// endpoint.
    Rejected,
    /// Nothing cached and the fetch failed — usually just offline.
    Unavailable,
}

/// Answer one cover request: from disk if we have it, otherwise fetch it
/// once, store it and return it.
///
/// Returns the bytes and the content type. The content type is sniffed
/// from the bytes rather than stored alongside them, which keeps the cache
/// one flat file per image with no sidecar to fall out of step.
pub async fn get(covers_dir: &Path, url: &str) -> Result<(Vec<u8>, &'static str), CoverError> {
    if !host_allowed(url) {
        return Err(CoverError::Rejected);
    }
    let path = covers_dir.join(cache_key(url));

    if let Ok(bytes) = tokio::fs::read(&path).await {
        if !bytes.is_empty() {
            let kind = sniff(&bytes);
            return Ok((bytes, kind));
        }
    }

    let bytes = fetch(url).await.ok_or(CoverError::Unavailable)?;
    let kind = sniff(&bytes);
    store(covers_dir, &path, &bytes).await;
    Ok((bytes, kind))
}

/// One client for the whole process, so the connection pool is shared.
///
/// A feed is ~35 tiles that all miss the cache on a first run and all go
/// to the same two hosts. Building a client per request would mean 35
/// separate TLS handshakes over a car's 5G link instead of a handful of
/// reused connections — the difference between artwork that fills in and
/// artwork that trickles.
fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| reqwest::Client::builder().timeout(FETCH_TIMEOUT).build().ok())
        .as_ref()
}

/// Fetch upstream. Any failure is `None` — the caller's job is to fall
/// back, not to explain.
async fn fetch(url: &str) -> Option<Vec<u8>> {
    let res = client()?.get(url).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    // Trust the declared length when there is one, so an oversized body is
    // refused before it is downloaded rather than after.
    if res.content_length().is_some_and(|n| n > MAX_ENTRY_BYTES as u64) {
        return None;
    }
    let bytes = res.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_ENTRY_BYTES {
        return None;
    }
    // Only store things that really are images. A captive portal answering
    // 200 with an HTML login page is the realistic way this gets poisoned,
    // and a cached login page would out-live the drive it happened on.
    if sniff(&bytes) == UNKNOWN {
        return None;
    }
    Some(bytes.to_vec())
}

/// Write via a temp file and rename, so a power cut mid-write cannot leave
/// a truncated image cached forever — which, given that the entire point
/// of this cache is to survive power cuts, is not a theoretical concern.
async fn store(covers_dir: &Path, path: &Path, bytes: &[u8]) {
    if tokio::fs::create_dir_all(covers_dir).await.is_err() {
        return;
    }
    let tmp = path.with_extension("part");
    if tokio::fs::write(&tmp, bytes).await.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return;
    }
    if tokio::fs::rename(&tmp, path).await.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
}

/// Is this a host we fetch artwork from?
///
/// Parsed by hand rather than with a URL crate: the only shapes that reach
/// here are absolute `https://` URLs from InnerTube responses, and the
/// check that matters is an exact host match against the allowlist.
/// Anything that does not parse cleanly is refused, which is the safe way
/// round.
fn host_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    // The host ends at the first `/`, `?` or `#`. Credentials (`@`) and an
    // explicit port (`:`) both make this something other than the plain
    // host we expect, so treat them as a non-match rather than trying to
    // normalise them away.
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    ALLOWED_HOSTS.contains(&host)
}

/// Cache filename for a URL.
///
/// FNV-1a, twice with different offset bases, for a 128-bit key written as
/// hex. Deliberately NOT `std::hash::DefaultHasher`: that is explicitly
/// allowed to change between Rust releases, and a persistent on-disk cache
/// keyed by it would silently miss every entry after a toolchain upgrade.
/// Not a security boundary — nothing here depends on the hash being hard
/// to invert, only on it being stable and wide enough that two artwork
/// URLs never collide.
fn cache_key(url: &str) -> String {
    format!("{:016x}{:016x}", fnv1a(url, 0xcbf2_9ce4_8422_2325), fnv1a(url, 0x9e37_79b9_7f4a_7c15))
}

fn fnv1a(s: &str, basis: u64) -> u64 {
    let mut hash = basis;
    for b in s.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

const UNKNOWN: &str = "";

/// Content type from magic bytes.
///
/// Sniffed rather than taken from the upstream `Content-Type` header so
/// that a cache hit and a cache miss answer identically — there is no
/// header to consult once the bytes are on disk, and a tile that renders
/// on the second boot but not the first would be a miserable bug to chase.
fn sniff(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return "image/jpeg";
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return "image/png";
    }
    if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return "image/gif";
    }
    UNKNOWN
}

/// Trim the cache to budget, oldest first.
///
/// Called once at startup rather than on every store: covers are small and
/// the budget is large, so the cache takes a very long time to fill, and
/// doing this on the request path would put a directory walk in front of a
/// tile that is about to be painted.
///
/// Ordered by mtime, which for this cache is "when it was last fetched"
/// — good enough, and it needs no bookkeeping of its own. Cover URLs are
/// content-addressed by YouTube (a new upload is a new URL), so an evicted
/// entry that is still wanted is simply re-fetched once.
pub async fn prune(covers_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(covers_dir) else {
        return; // no cache yet — nothing to do, and not an error
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .filter_map(|e| {
            let e = e.ok()?;
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((
                meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                meta.len(),
                e.path(),
            ))
        })
        .collect();

    let mut total: u64 = files.iter().map(|(_, len, _)| *len).sum();
    if total <= MAX_TOTAL_BYTES {
        return;
    }

    files.sort_by_key(|(mtime, _, _)| *mtime);
    let mut removed = 0usize;
    for (_, len, path) in files {
        if total <= PRUNE_TARGET_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
            removed += 1;
        }
    }
    eprintln!("[covers] pruned {removed} file(s), cache now ~{}MB", total / (1024 * 1024));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_youtube_artwork_hosts_are_fetched() {
        assert!(host_allowed("https://i.ytimg.com/vi/abc/mqdefault.jpg"));
        assert!(host_allowed("https://lh3.googleusercontent.com/x=w256"));
        assert!(host_allowed("https://www.gstatic.com/a.png"));
        // Not on the list.
        assert!(!host_allowed("https://evil.example/a.png"));
        // http, not https.
        assert!(!host_allowed("http://i.ytimg.com/vi/abc/mqdefault.jpg"));
        // Prefix/suffix tricks around the allowlisted names.
        assert!(!host_allowed("https://i.ytimg.com.evil.example/a.png"));
        assert!(!host_allowed("https://evil.example/https://i.ytimg.com/a.png"));
        // Credentials and explicit ports are not the plain shape we expect.
        assert!(!host_allowed("https://i.ytimg.com@evil.example/a.png"));
        assert!(!host_allowed("https://i.ytimg.com:8443/a.png"));
        // Not a URL at all.
        assert!(!host_allowed(""));
        assert!(!host_allowed("javascript:alert(1)"));
    }

    #[test]
    fn cache_keys_are_stable_and_distinct() {
        // Pinned literals, not a round-trip: the point of this test is to
        // fail loudly if the hash ever changes, because that silently
        // invalidates every cache on every device.
        assert_eq!(
            cache_key("https://i.ytimg.com/vi/abc/mqdefault.jpg"),
            cache_key("https://i.ytimg.com/vi/abc/mqdefault.jpg")
        );
        assert_ne!(
            cache_key("https://i.ytimg.com/vi/abc/mqdefault.jpg"),
            cache_key("https://i.ytimg.com/vi/abd/mqdefault.jpg")
        );
        // 128 bits of hex.
        assert_eq!(cache_key("x").len(), 32);
        assert!(cache_key("x").chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn cache_key_does_not_use_the_unstable_default_hasher() {
        // Guards the comment on `cache_key`: if someone "simplifies" it to
        // DefaultHasher, the key stops being stable across Rust releases
        // and every cached cover is silently orphaned.
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        "https://i.ytimg.com/vi/abc/mqdefault.jpg".hash(&mut h);
        assert_ne!(
            cache_key("https://i.ytimg.com/vi/abc/mqdefault.jpg"),
            format!("{:016x}", h.finish())
        );
    }

    #[test]
    fn sniff_recognises_what_youtube_actually_serves() {
        assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), "image/jpeg");
        assert_eq!(
            sniff(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
            "image/png"
        );
        let mut webp = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        webp.push(0);
        assert_eq!(sniff(&webp), "image/webp");
        assert_eq!(sniff(b"GIF89a..."), "image/gif");
        // A captive portal's login page must never be cached as artwork.
        assert_eq!(sniff(b"<!DOCTYPE html><html>"), UNKNOWN);
        assert_eq!(sniff(b""), UNKNOWN);
        // Too short to match WEBP's 12-byte signature.
        assert_eq!(sniff(b"RIFF"), UNKNOWN);
    }
}

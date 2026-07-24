// Ported verbatim from YTMLite's src/lib/lyrics/lrclib.ts.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Lyrics } from "@/lib/lyrics/types";
import { parseLRC } from "@/lib/lyrics/parse-lrc";

/**
 * LRCLIB (https://lrclib.net) — free, open lyrics database with synced
 * LRC-format lyrics.
 *
 * Requests go through Tauri's HTTP plugin: its reach is governed by
 * `src-tauri/capabilities/default.json`, not the page's Content-Security-
 * Policy, which is what makes an anonymous, no-CORS-preflight source like
 * this one reachable at all from a `connect-src 'self'`-locked webview.
 */

type LrclibParams = {
  title: string;
  artist?: string;
  album?: string;
  /** Duration in seconds. LRCLIB uses this to disambiguate matches. */
  duration?: number;
};

type LrclibRecord = {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  instrumental?: boolean;
};

export async function fetchLrclibLyrics(
  p: LrclibParams,
): Promise<Lyrics | null> {
  if (!p.title) return null;

  // Race /get against /search — see YTMLite's original rationale: /get is
  // the strict exact-match endpoint, /search the fuzzy fallback; running
  // both concurrently means a /get miss doesn't add /search's latency on
  // top. /get's record wins when both succeed (tighter match).
  const [get, search] = await Promise.all([
    p.artist ? lrclibGet(p) : Promise.resolve(null),
    lrclibSearch(p),
  ]);
  const rec = get ?? search;
  return rec ? mapRecord(rec) : null;
}

async function lrclibGet(p: LrclibParams): Promise<LrclibRecord | null> {
  const url = new URL("https://lrclib.net/api/get");
  url.searchParams.set("track_name", p.title);
  if (p.artist) url.searchParams.set("artist_name", p.artist);
  if (p.album) url.searchParams.set("album_name", p.album);
  if (p.duration) {
    url.searchParams.set("duration", String(Math.round(p.duration)));
  }
  const r = await tauriFetch(url.toString());
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`LRCLIB /get ${r.status}`);
  return (await r.json()) as LrclibRecord;
}

async function lrclibSearch(p: LrclibParams): Promise<LrclibRecord | null> {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("track_name", p.title);
  if (p.artist) url.searchParams.set("artist_name", p.artist);
  const r = await tauriFetch(url.toString());
  if (!r.ok) throw new Error(`LRCLIB /search ${r.status}`);
  const results = (await r.json()) as LrclibRecord[];
  if (!Array.isArray(results) || results.length === 0) return null;
  // Prefer results with synced lyrics. Then, if we know the duration,
  // prefer the closest one — YTM and LRCLIB versions occasionally
  // differ by a second or two.
  const synced = results.filter((r) => r.syncedLyrics);
  const pool = synced.length > 0 ? synced : results;
  if (!p.duration) return pool[0];
  return pool.reduce((best, cur) => {
    const bestDiff = Math.abs((best.duration ?? 0) - (p.duration ?? 0));
    const curDiff = Math.abs((cur.duration ?? 0) - (p.duration ?? 0));
    return curDiff < bestDiff ? cur : best;
  });
}

function mapRecord(r: LrclibRecord): Lyrics | null {
  if (r.instrumental) {
    return { kind: "plain", text: "🎵 Instrumental", source: "LRCLIB" };
  }
  if (typeof r.syncedLyrics === "string" && r.syncedLyrics.trim()) {
    const lines = parseLRC(r.syncedLyrics);
    if (lines.length > 0) {
      return { kind: "timed", lines, source: "LRCLIB" };
    }
  }
  if (typeof r.plainLyrics === "string" && r.plainLyrics.trim()) {
    return { kind: "plain", text: r.plainLyrics, source: "LRCLIB" };
  }
  return null;
}

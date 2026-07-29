// Ported from YTMLite's src/lib/lyrics/lrclib.ts, then extended with
// candidate search (see `searchLrclibCandidates`).

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Lyrics } from "@/lib/lyrics/types";
import type { LyricsCandidate } from "@/lib/lyrics/score";
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

/**
 * Every plausible LRCLIB record for a query, as scoreable candidates.
 *
 * LRCLIB is the one source that needs no second round trip: `/search`
 * already returns the lyric bodies inline, so a candidate list costs
 * exactly one request. `/get` (the strict exact-match endpoint) is raced
 * alongside it and its record is pinned to the front when it hits, because
 * a `/get` match is by construction the tightest one available.
 */
export async function searchLrclibCandidates(
  p: LrclibParams,
  limit: number,
): Promise<LyricsCandidate[]> {
  if (!p.title) return [];
  const [get, list] = await Promise.all([
    p.artist ? lrclibGet(p).catch(() => null) : Promise.resolve(null),
    lrclibSearchAll(p).catch(() => [] as LrclibRecord[]),
  ]);

  const records = get
    ? [get, ...list.filter((r) => r.id === undefined || r.id !== get.id)]
    : list;

  const out: LyricsCandidate[] = [];
  for (const rec of records) {
    if (out.length >= limit) break;
    const lyrics = mapRecord(rec);
    if (!lyrics) continue;
    out.push({
      source: "lrclib",
      title: rec.trackName ?? p.title,
      artist: rec.artistName ?? p.artist ?? "",
      lyrics,
    });
  }
  return out;
}

async function lrclibSearchAll(p: LrclibParams): Promise<LrclibRecord[]> {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("track_name", p.title);
  if (p.artist) url.searchParams.set("artist_name", p.artist);
  const r = await tauriFetch(url.toString());
  if (!r.ok) throw new Error(`LRCLIB /search ${r.status}`);
  const results = (await r.json()) as LrclibRecord[];
  return Array.isArray(results) ? results : [];
}

async function lrclibSearch(p: LrclibParams): Promise<LrclibRecord | null> {
  const results = await lrclibSearchAll(p);
  if (results.length === 0) return null;
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

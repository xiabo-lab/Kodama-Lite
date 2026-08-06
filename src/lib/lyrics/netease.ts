// Ported verbatim from YTMLite (only the fetch import source changed).
import { fetch as tauriFetch } from "@/lib/http";
import type { Lyrics } from "@/lib/lyrics/types";
import type { LyricsCandidate } from "@/lib/lyrics/score";
import { resolveCandidates, type SearchHit } from "@/lib/lyrics/candidates";
import { parseLRC } from "@/lib/lyrics/parse-lrc";
import { hitMatches, normalizeForMatch } from "@/lib/lyrics/match";

/**
 * NetEase Cloud Music (网易云音乐) — the largest Chinese-language lyric
 * database, and the reason this source exists: LRCLIB/Musixmatch/Genius
 * between them cover Mandarin and Cantonese catalogues poorly, so a
 * library of Chinese songs comes back empty from all three.
 *
 * Two unauthenticated calls: search for a song id, then pull its LRC.
 * Tauri's HTTP plugin is required (as for Musixmatch/Genius): the hosts
 * set no permissive CORS headers, and NetEase rejects requests without a
 * `Referer`, which the webview forbids JS from setting. The host must
 * also be listed in `src-tauri/capabilities/default.json`.
 */

const SEARCH_URL = "https://music.163.com/api/search/get/";
const LYRIC_URL = "https://music.163.com/api/song/lyric";

const HEADERS = {
  Referer: "https://music.163.com/",
  "User-Agent": "Mozilla/5.0 (X11; Linux aarch64) Kodama-Lite/1.0",
};

/** How many search hits to consider before giving up on a match. */
const SEARCH_LIMIT = 5;

type NeteaseSong = {
  id?: number;
  name?: string;
  artists?: { name?: string }[];
};

export type CnLyricsParams = {
  title: string;
  artist?: string;
};

export async function fetchNeteaseLyrics(
  p: CnLyricsParams,
): Promise<Lyrics | null> {
  if (!p.title) return null;

  const song = await searchSong(p);
  if (!song?.id) return null;

  const lrc = await fetchLyric(song.id);
  if (!lrc) return null;

  const lines = parseLRC(lrc);
  if (lines.length === 0) return null;
  return { kind: "timed", lines, source: "NetEase" };
}

/** Every NetEase hit for a query, with its lyrics, as scoreable
 *  candidates. Unlike `fetchNeteaseLyrics` this applies NO `hitMatches`
 *  veto — the whole point is to let the scorer rank them. */
export async function searchNeteaseCandidates(
  p: CnLyricsParams,
  limit: number,
): Promise<LyricsCandidate[]> {
  const hits = await searchSongs(p, limit);
  return resolveCandidates("netease", hits, fetchLyricsFor, limit);
}

async function fetchLyricsFor(id: number): Promise<Lyrics | null> {
  const lrc = await fetchLyric(id);
  if (!lrc) return null;
  const lines = parseLRC(lrc);
  return lines.length > 0 ? { kind: "timed", lines, source: "NetEase" } : null;
}

function artistOf(s: NeteaseSong): string {
  return (s.artists ?? [])
    .map((a) => a.name ?? "")
    .filter(Boolean)
    .join("/");
}

async function searchSongs(
  p: CnLyricsParams,
  limit: number,
): Promise<SearchHit<number>[]> {
  const query = [p.title, p.artist].filter(Boolean).join(" ").trim();
  if (!query) return [];

  const url = new URL(SEARCH_URL);
  url.searchParams.set("s", query);
  url.searchParams.set("type", "1"); // 1 = songs
  url.searchParams.set("limit", String(Math.max(limit, 1)));

  const r = await tauriFetch(url.toString(), { headers: HEADERS });
  if (!r.ok) throw new Error(`NetEase search ${r.status}`);
  const data = (await r.json()) as { result?: { songs?: NeteaseSong[] } };
  return (data.result?.songs ?? [])
    .filter((s): s is NeteaseSong & { id: number } => typeof s.id === "number")
    .map((s) => ({ key: s.id, title: s.name ?? "", artist: artistOf(s) }));
}

async function searchSong(p: CnLyricsParams): Promise<NeteaseSong | null> {
  const query = [p.title, p.artist].filter(Boolean).join(" ").trim();
  if (!query) return null;

  const url = new URL(SEARCH_URL);
  url.searchParams.set("s", query);
  url.searchParams.set("type", "1"); // 1 = songs
  url.searchParams.set("limit", String(SEARCH_LIMIT));

  const r = await tauriFetch(url.toString(), { headers: HEADERS });
  if (!r.ok) throw new Error(`NetEase search ${r.status}`);
  const data = (await r.json()) as { result?: { songs?: NeteaseSong[] } };
  const songs = data.result?.songs ?? [];
  if (songs.length === 0) return null;

  // Same guard as Genius: the search is fuzzy and nearly always returns
  // something, so an unverified first hit is a confidently-wrong song.
  const reqTitle = normalizeForMatch(p.title);
  const reqArtist = normalizeForMatch(p.artist ?? "");
  for (const s of songs) {
    const hitTitle = normalizeForMatch(s.name ?? "");
    const hitArtist = normalizeForMatch(
      (s.artists ?? []).map((a) => a.name ?? "").join(" "),
    );
    if (hitMatches(reqTitle, reqArtist, hitTitle, hitArtist)) return s;
  }
  return null;
}

async function fetchLyric(songId: number): Promise<string | null> {
  const url = new URL(LYRIC_URL);
  url.searchParams.set("id", String(songId));
  // lv/kv/tv select the lyric versions to return. -1 means "latest";
  // `lv` is the one we want (the plain LRC).
  url.searchParams.set("lv", "-1");
  url.searchParams.set("kv", "-1");
  url.searchParams.set("tv", "-1");

  const r = await tauriFetch(url.toString(), { headers: HEADERS });
  if (!r.ok) throw new Error(`NetEase lyric ${r.status}`);
  const data = (await r.json()) as { lrc?: { lyric?: string } };
  const lrc = data.lrc?.lyric ?? "";
  // NetEase answers with a plain "暂无歌词" ("no lyrics yet") placeholder
  // for tracks it has no lyrics for, which carries no timestamps.
  if (!lrc.trim() || !lrc.includes("[")) return null;
  return lrc;
}

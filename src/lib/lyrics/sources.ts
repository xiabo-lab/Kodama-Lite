import { fetchYtMusicLyrics } from "@/lib/lyrics/ytmusic";
import { fetchLrclibLyrics } from "@/lib/lyrics/lrclib";
import { fetchKugouLyrics } from "@/lib/lyrics/kugou";
import { fetchNeteaseLyrics } from "@/lib/lyrics/netease";
import { fetchMusixmatchLyrics } from "@/lib/lyrics/musixmatch";
import { fetchQqLyrics } from "@/lib/lyrics/qq";
import { fetchGeniusLyrics } from "@/lib/lyrics/genius";
import type { Lyrics } from "@/lib/lyrics/types";

export type LyricsSource =
  | "ytmusic"
  | "kugou"
  | "lrclib"
  | "netease"
  | "musixmatch"
  | "qq"
  | "genius";

/**
 * Auto-pick preference order — same as YTMLite's `lyrics/sources.ts`.
 *
 * YouTube Music leads because it is the only source that needs no
 * matching step: its lyrics are addressed by the exact videoId being
 * played, so it can never return a different song. Everything after it
 * has to search and then guess.
 *
 * The rest lead with the Chinese services because LRCLIB, Musixmatch and
 * Genius cover Mandarin and Cantonese catalogues poorly. Ordering them
 * ahead of the western ones is safe because every searching source
 * verifies its hit against the requested title/artist (`hitMatches`) and
 * returns null rather than a confidently-wrong different song, so a
 * track they don't carry simply falls through.
 *
 * This is a *preference* order, not a strict one: a source earlier in
 * the list only wins over a later one at the same quality level — any
 * timed source beats any plain source, because the karaoke stage is
 * built around line highlighting.
 */
export const SOURCE_ORDER: LyricsSource[] = [
  "ytmusic",
  "kugou",
  "lrclib",
  "netease",
  "musixmatch",
  "qq",
  "genius",
];

export const SOURCE_LABELS: Record<LyricsSource, string> = {
  ytmusic: "YouTube Music",
  qq: "QQ Music",
  kugou: "Kugou",
  netease: "NetEase",
  lrclib: "LRCLIB",
  musixmatch: "Musixmatch",
  genius: "Genius",
};

export type LyricsQueryParams = {
  videoId: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
};

function fetchFor(source: LyricsSource, p: LyricsQueryParams): Promise<Lyrics | null> {
  switch (source) {
    case "ytmusic":
      return fetchYtMusicLyrics(p.videoId);
    case "lrclib":
      return fetchLrclibLyrics({ title: p.title, artist: p.artist, album: p.album, duration: p.duration });
    case "kugou":
      return fetchKugouLyrics({ title: p.title, artist: p.artist });
    case "netease":
      return fetchNeteaseLyrics({ title: p.title, artist: p.artist });
    case "musixmatch":
      return fetchMusixmatchLyrics({ title: p.title, artist: p.artist });
    case "qq":
      return fetchQqLyrics({ title: p.title, artist: p.artist });
    case "genius":
      return fetchGeniusLyrics({ title: p.title, artist: p.artist });
  }
}

/**
 * Fire all 7 sources in parallel and auto-pick the best result, same
 * two-pass rule as YTMLite: the first source (in `SOURCE_ORDER`) with
 * *timed* lyrics wins; only if none have timed lyrics does the first
 * source with *plain* lyrics win. A source that errors or has nothing
 * simply falls through — never blocks or fails the others.
 */
export async function fetchBestLyrics(params: LyricsQueryParams): Promise<Lyrics | null> {
  return pickBest(await fetchLyricsTiered(params));
}

/**
 * The auto-pick rule over an already-fetched per-source map: the first
 * source (in `SOURCE_ORDER`) with *timed* lyrics wins; only if none have
 * timed lyrics does the first with *plain* lyrics win.
 */
export function pickBest(
  results: Partial<Record<LyricsSource, Lyrics | null>>,
): Lyrics | null {
  for (const s of SOURCE_ORDER) {
    if (results[s]?.kind === "timed") return results[s] ?? null;
  }
  for (const s of SOURCE_ORDER) {
    if (results[s]?.kind === "plain") return results[s] ?? null;
  }
  return null;
}

/**
 * Search order, in tiers. Everything in a tier runs in parallel; tiers run
 * one after another and stop as soon as something returns *timed* lyrics.
 *
 * Why not all seven at once, which is what this used to do: seven
 * simultaneous HTTPS requests — several to servers on the other side of
 * the world — plus seven JSON/LRC parses is enough to make a Pi 5 visibly
 * stutter, and six of those results were thrown away the moment YouTube
 * Music answered. In the common case this now makes exactly one request.
 *
 * YouTube Music leads alone because it needs no matching step: its lyrics
 * are addressed by the exact videoId being played, so it cannot return a
 * different song. Everything after it has to search and then guess, which
 * is why they're paired — two tries at a time is a reasonable trade
 * between latency and the odds of a hit.
 */
export const SEARCH_TIERS: LyricsSource[][] = [
  ["ytmusic"],
  ["kugou", "lrclib"],
  ["musixmatch", "netease"],
  ["genius", "qq"],
];

/** Did this map already answer the question, i.e. hold timed lyrics? */
function hasTimed(results: Partial<Record<LyricsSource, Lyrics | null>>): boolean {
  return Object.values(results).some((l) => l?.kind === "timed");
}

/**
 * Walk `SEARCH_TIERS` until something returns timed lyrics.
 *
 * Returns a PARTIAL map: sources in tiers that were never reached are
 * absent, which is deliberately distinct from present-and-`null` ("we
 * asked, it had nothing"). The picker relies on that difference — an
 * unsearched source is not the same as one known to be empty, and is
 * fetched on demand if the user taps it.
 *
 * Plain lyrics do NOT stop the walk: YouTube Music very often has an
 * unsynced transcript, and stopping there would mean never finding the
 * synced version the karaoke stage exists for. They're kept, so if no tier
 * produces timed lyrics `pickBest` still falls back to them.
 */
export async function fetchLyricsTiered(
  params: LyricsQueryParams,
): Promise<Partial<Record<LyricsSource, Lyrics | null>>> {
  const out: Partial<Record<LyricsSource, Lyrics | null>> = {};

  for (const tier of SEARCH_TIERS) {
    const settled = await Promise.allSettled(tier.map((s) => fetchFor(s, params)));
    tier.forEach((source, i) => {
      const r = settled[i];
      out[source] = r.status === "fulfilled" ? r.value : null;
    });
    if (hasTimed(out)) break;
  }

  return out;
}

/** Fetch ONE source, for the picker's on-demand lookups. */
export function fetchOneLyricsSource(
  source: LyricsSource,
  params: LyricsQueryParams,
): Promise<Lyrics | null> {
  return fetchFor(source, params).catch(() => null);
}

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
 *
 * All seven fetches run either way, so the network subsystem hands the
 * whole map to the view plane (`lyrics:loaded`) and lets the source picker
 * override the auto-pick locally, with no refetch. `pickBest` below is that
 * rule on its own, so the picker's "Auto" entry resolves through exactly
 * the same code path this does.
 */
export async function fetchBestLyrics(params: LyricsQueryParams): Promise<Lyrics | null> {
  return pickBest(await fetchAllLyrics(params));
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

/** Fire all 7 sources in parallel; returns every source's result (or
 *  `null` for "nothing found" / a failed fetch), keyed by source. */
export async function fetchAllLyrics(
  params: LyricsQueryParams,
): Promise<Record<LyricsSource, Lyrics | null>> {
  const settled = await Promise.allSettled(SOURCE_ORDER.map((s) => fetchFor(s, params)));
  const out = {} as Record<LyricsSource, Lyrics | null>;
  SOURCE_ORDER.forEach((s, i) => {
    const r = settled[i];
    out[s] = r.status === "fulfilled" ? r.value : null;
  });
  return out;
}

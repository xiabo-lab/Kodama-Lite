import { fetchYtMusicLyrics } from "@/lib/lyrics/ytmusic";
import { fetchLrclibLyrics, searchLrclibCandidates } from "@/lib/lyrics/lrclib";
import { fetchKugouLyrics, searchKugouCandidates } from "@/lib/lyrics/kugou";
import { fetchNeteaseLyrics, searchNeteaseCandidates } from "@/lib/lyrics/netease";
import {
  fetchMusixmatchLyrics,
  searchMusixmatchCandidates,
} from "@/lib/lyrics/musixmatch";
import { fetchQqLyrics, searchQqCandidates } from "@/lib/lyrics/qq";
import { fetchGeniusLyrics, searchGeniusCandidates } from "@/lib/lyrics/genius";
import {
  ACCEPT_SCORE,
  bestCandidate,
  relevance,
  RELEVANCE_MIN,
  scoreCandidate,
  type LyricsCandidate,
} from "@/lib/lyrics/score";
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
 * Auto-pick preference order.
 *
 * YouTube Music leads because it is the only source that needs no matching
 * step at all: its lyrics are addressed by the exact videoId being played,
 * so it can never return a different song. Everything after it has to
 * search and then guess, which is what the scorer in `score.ts` exists to
 * arbitrate.
 *
 * The rest lead with the Chinese services because LRCLIB, Musixmatch and
 * Genius cover Mandarin and Cantonese catalogues poorly.
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

/**
 * The sources a free-text (artist, song) query can actually be run
 * against — everything except YouTube Music, which has no such endpoint:
 * it is addressed by videoId and nothing else. That is why the manual
 * search covers exactly SIX sources.
 */
export const SEARCHABLE_SOURCES: LyricsSource[] = [
  "kugou",
  "qq",
  "netease",
  "lrclib",
  "musixmatch",
  "genius",
];

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
 * How deep to search each source per tier, in the AUTOMATIC path.
 *
 * Carlyrics' `CANDIDATE_QUERY_LIMIT` (4) with its `{"QQ": 1}` override,
 * for the same reasons: more candidates give the scorer more to choose
 * between, but QQ over-returns unrelated same-title songs and rate-limits
 * under rapid repeat queries, and Genius costs a full page scrape each.
 */
const AUTO_LIMITS: Partial<Record<LyricsSource, number>> = {
  qq: 1,
  genius: 2,
};
const AUTO_LIMIT_DEFAULT = 4;

/** How deep a MANUAL search goes. Higher across the board: it happens once,
 *  on purpose, and the user is waiting to look at the results — so breadth
 *  matters more than latency, which is the opposite of the automatic
 *  path's trade. */
const MANUAL_LIMITS: Partial<Record<LyricsSource, number>> = {
  qq: 3,
  genius: 3,
};
const MANUAL_LIMIT_DEFAULT = 6;

/** Search one source and return its candidates. Never throws — a source
 *  that errors contributes nothing and cannot fail the sweep. */
export async function searchSourceCandidates(
  source: LyricsSource,
  p: { title: string; artist?: string; album?: string; duration?: number },
  limit: number,
): Promise<LyricsCandidate[]> {
  try {
    switch (source) {
      case "lrclib":
        return await searchLrclibCandidates(
          { title: p.title, artist: p.artist, album: p.album, duration: p.duration },
          limit,
        );
      case "kugou":
        return await searchKugouCandidates({ title: p.title, artist: p.artist }, limit);
      case "netease":
        return await searchNeteaseCandidates({ title: p.title, artist: p.artist }, limit);
      case "musixmatch":
        return await searchMusixmatchCandidates({ title: p.title, artist: p.artist }, limit);
      case "qq":
        return await searchQqCandidates({ title: p.title, artist: p.artist }, limit);
      case "genius":
        return await searchGeniusCandidates({ title: p.title, artist: p.artist }, limit);
      case "ytmusic":
        // Not searchable by name — see SEARCHABLE_SOURCES.
        return [];
    }
  } catch {
    return [];
  }
}

/**
 * Search order, in tiers. Everything in a tier runs in parallel; tiers run
 * one after another and stop as soon as a tier produces a candidate whose
 * match score clears `ACCEPT_SCORE` (0.5).
 *
 * Why tiers rather than all seven at once: seven simultaneous HTTPS
 * requests — several to servers on the other side of the world — plus
 * seven parses is enough to make a Pi 5 visibly stutter, and six of those
 * results are thrown away the moment YouTube Music answers. In the common
 * case this makes exactly one request.
 *
 * YouTube Music is a tier of its own because it needs no matching step at
 * all. The tiers after it pair a Chinese catalogue with a western one, so
 * each tier can answer for either kind of track.
 */
export const SEARCH_TIERS: LyricsSource[][] = [
  ["ytmusic"],
  ["kugou", "lrclib"],
  ["musixmatch", "netease"],
  ["genius", "qq"],
];

/**
 * The result of an automatic lookup: every candidate that was gathered,
 * plus the winner and its score.
 *
 * The per-source map is what the picker binds to (so switching sources
 * costs no network); `best` is what actually gets displayed.
 */
export type TieredResult = {
  /** PARTIAL: sources in tiers that were never reached are absent, which
   *  is deliberately distinct from present-and-`null` ("we asked, it had
   *  nothing"). The picker relies on that difference — an unsearched
   *  source is not a known-empty one, and is fetched on demand if tapped. */
  sources: Partial<Record<LyricsSource, Lyrics | null>>;
  /** The winning candidate's score, for logging and for the picker to
   *  explain itself. Absent when nothing was found at all. */
  bestScore?: number;
};

/**
 * Walk `SEARCH_TIERS`, scoring every candidate from every source in the
 * tier, and stop at the first tier whose best candidate clears 0.5.
 *
 * This is the behaviour change the user asked for, and it replaces a rule
 * that was subtly wrong in two ways. The old walk stopped as soon as ANY
 * source returned *timed* lyrics, and each source returned its own first
 * `hitMatches`-approved hit. So a tier-2 source that confidently returned
 * a synced lyric for the wrong song ended the search — the right answer in
 * tier 3 was never requested, and nothing downstream could tell that what
 * it had was wrong. Scoring makes "how good is this?" a number rather than
 * a boolean, and 0.5 is the line below which we'd rather keep looking.
 *
 * A sub-threshold best is still KEPT, not discarded: if no tier clears the
 * bar, the highest scorer overall is better than showing nothing, and the
 * user can always override it from the picker.
 */
export async function fetchLyricsTiered(
  params: LyricsQueryParams,
): Promise<TieredResult> {
  const sources: Partial<Record<LyricsSource, Lyrics | null>> = {};
  let best: { candidate: LyricsCandidate; score: number } | null = null;
  const artist = params.artist ?? "";

  for (const tier of SEARCH_TIERS) {
    const perSource = await Promise.all(
      tier.map(async (source) => {
        // YouTube Music is addressed by videoId, so it has exactly one
        // possible answer and no candidate list to rank. Its result is
        // pinned to a perfect title/artist match because, by construction,
        // it IS the track being played.
        if (source === "ytmusic") {
          const l = await fetchFor("ytmusic", params).catch(() => null);
          return {
            source,
            candidates: l
              ? [
                  {
                    source: "ytmusic",
                    title: params.title,
                    artist,
                    lyrics: l,
                  } satisfies LyricsCandidate,
                ]
              : [],
          };
        }
        return {
          source,
          candidates: await searchSourceCandidates(
            source,
            params,
            AUTO_LIMITS[source] ?? AUTO_LIMIT_DEFAULT,
          ),
        };
      }),
    );

    for (const { source, candidates } of perSource) {
      // Each source's own best is what the picker shows for it. Recording
      // `null` for an empty source is what marks it searched-and-empty.
      const top = bestCandidate(candidates, params.title, artist);
      sources[source] = top?.candidate.lyrics ?? null;
      if (top && (!best || top.score > best.score)) best = top;
    }

    if (best && best.score >= ACCEPT_SCORE) break;
  }

  return { sources, bestScore: best?.score };
}

/**
 * The auto-pick rule over an already-fetched per-source map.
 *
 * Preference order first (`SOURCE_ORDER`), quality second: any timed
 * source beats any plain source, because the karaoke stage is built around
 * line highlighting. Cross-source *scoring* has already happened inside
 * `fetchLyricsTiered` — by the time a map reaches here each entry is
 * already that source's best-scoring candidate, so this only has to choose
 * between sources, not between hits.
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

/** Fire the tiered search and return just the winner. */
export async function fetchBestLyrics(params: LyricsQueryParams): Promise<Lyrics | null> {
  return pickBest((await fetchLyricsTiered(params)).sources);
}

/** Fetch ONE source, for the picker's on-demand lookups. */
export function fetchOneLyricsSource(
  source: LyricsSource,
  params: LyricsQueryParams,
): Promise<Lyrics | null> {
  return fetchFor(source, params).catch(() => null);
}

// ── Manual search ──────────────────────────────────────────────────────

/** A manual-search result, ready to render: the candidate plus how well it
 *  scored, so the results window can order and explain them. */
export type ScoredCandidate = {
  candidate: LyricsCandidate;
  score: number;
};

/**
 * Search all six searchable sources at once for a hand-typed (artist,
 * song) and return every plausible result, best first.
 *
 * All six run CONCURRENTLY here rather than in tiers — the whole point of
 * a manual search is to see everything at once and choose, so there is no
 * "good enough, stop early" to exploit. The Pi-stutter argument that
 * justifies tiering in the automatic path doesn't apply: this runs once,
 * on an explicit tap, while the user is looking at a progress state.
 *
 * Obviously-unrelated hits are dropped (`RELEVANCE_MIN`) so the window
 * offers plausible matches only — search engines happily return a
 * same-named but entirely different song, and those are pure clutter in a
 * list someone is reading in a car.
 */
export async function searchAllSources(
  query: { title: string; artist?: string },
  onProgress?: (done: number, total: number) => void,
): Promise<ScoredCandidate[]> {
  const artist = query.artist ?? "";
  let done = 0;
  const perSource = await Promise.all(
    SEARCHABLE_SOURCES.map(async (source) => {
      const c = await searchSourceCandidates(
        source,
        query,
        MANUAL_LIMITS[source] ?? MANUAL_LIMIT_DEFAULT,
      );
      onProgress?.(++done, SEARCHABLE_SOURCES.length);
      return c;
    }),
  );

  return perSource
    .flat()
    .filter((c) => relevance(c, query.title, artist) >= RELEVANCE_MIN)
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, query.title, artist),
    }))
    .sort((a, b) => b.score - a.score);
}

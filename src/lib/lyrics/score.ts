/**
 * Candidate scoring — ported from Carlyrics' `lyric_sources.py`
 * (`_norm` / `_sim` / `_artist_sim` / `score_candidate`).
 *
 * The problem this solves, and why the old code didn't: every source here
 * used to take its *first* search hit, run it past `hitMatches` (a boolean
 * "is this plausible?"), and return it. Search engines rank by popularity,
 * not by whether it is the song actually playing — so the first hit for
 * 七里香 is routinely a Live version, a cover by someone else, or an
 * unrelated song that happens to share a title. A boolean test cannot tell
 * those apart from the real one: they all pass it.
 *
 * Carlyrics' answer, which this reproduces: score EVERY candidate from
 * EVERY source on how well its own reported title+artist matches what was
 * asked for, and take the highest across all of them. A wrong-but-plausible
 * hit still scores, it just scores lower than the right one — which is the
 * distinction `hitMatches` structurally could not make.
 *
 * Pure functions over plain data, no network and no Tauri imports, so this
 * is unit-testable in isolation (see `score.test.ts`).
 */

import { toSimplified } from "@/lib/lyrics/zh-script";
import type { Lyrics } from "@/lib/lyrics/types";

/**
 * Everything that shouldn't affect a match: spacing, case, width, and the
 * punctuation the catalogues sprinkle differently around the same song.
 * NFKC first, so full-width CJK punctuation folds to its ASCII form before
 * being stripped.
 *
 * The traditional→simplified fold is Kodama-Lite's own addition on top of
 * Carlyrics (which never needed it — its metadata comes from the phone, not
 * from YouTube Music). YouTube Music serves 逍遙仙 where QQ/Kugou/NetEase
 * all index 逍遥仙; without the fold those read as two unrelated titles and
 * the correct hit scores near zero. See `zh-script.ts`.
 */
export function normalizeForScore(s: string): string {
  return toSimplified((s ?? "").normalize("NFKC"))
    .toLowerCase()
    .replace(
      /[\s\-_·・,，.。!！?？'’‘"“”:：;；/\\|~〜*&+()（）[\]【】「」『』<>《》]+/g,
      "",
    );
}

/** Artist fields arrive as "周杰伦/费玉清", "A & B", "X feat. Y"… */
const ARTIST_SPLIT = /[/,&;、，]|\bfeat\.?\b|\bft\.?\b|\bwith\b/i;

/**
 * Length of the longest common subsequence of two strings.
 *
 * Stands in for Python's `difflib.SequenceMatcher.ratio()`, which measures
 * the total size of its recursive longest-matching-blocks decomposition.
 * LCS is that measure's upper bound and equals it for the overwhelming
 * majority of real title pairs; where they differ LCS is very slightly more
 * generous. That is a safe direction to err in for a *relative* ranking —
 * every candidate is measured the same way, so a uniform shift cannot
 * change which one wins.
 *
 * Rolling single row, so the cost is O(n·m) time but O(min) space. Titles
 * are tens of characters; this is never hot.
 */
function lcsLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Iterate over the shorter string in the inner loop to keep the row small.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const row = new Uint32Array(short.length + 1);
  for (let i = 0; i < long.length; i++) {
    let prevDiag = 0;
    for (let j = 0; j < short.length; j++) {
      const above = row[j + 1];
      row[j + 1] =
        long[i] === short[j] ? prevDiag + 1 : Math.max(above, row[j]);
      prevDiag = above;
    }
  }
  return row[short.length];
}

/**
 * 0..1 similarity of two already-normalized strings.
 *
 * Containment scores high on purpose, because catalogues pad titles with
 * suffixes — "七里香" vs "七里香live" is the same song. The boost is scaled
 * by how much of the longer string the shorter one covers, so a 2-character
 * title sitting inside a 20-character one doesn't read as a near-perfect
 * hit (which is exactly how a wrong song wins otherwise).
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  let ratio = (2 * lcsLength(a, b)) / (a.length + b.length);
  if (a.includes(b) || b.includes(a)) {
    const cover = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    ratio = Math.max(ratio, 0.6 + 0.35 * cover);
  }
  return ratio;
}

/**
 * Best similarity over every pairing of two multi-artist fields.
 *
 * A blank request scores neutral rather than zero: when YouTube Music gives
 * us no artist we cannot judge one, and punishing every candidate equally
 * for our own missing data would just let the stub penalty decide.
 */
export function artistSimilarity(candidate: string, wanted: string): number {
  const parts = (s: string) =>
    s
      .split(ARTIST_SPLIT)
      .map((p) => normalizeForScore(p ?? ""))
      .filter(Boolean);
  const want = parts(wanted ?? "");
  const cand = parts(candidate ?? "");
  if (want.length === 0) return 0.5;
  if (cand.length === 0) return 0;
  // Compare the whole fields too: "A/B" vs "A/B" is an exact match that
  // per-part pairing alone would score no better than "A" vs "A/B".
  let best = similarity(
    normalizeForScore(candidate),
    normalizeForScore(wanted),
  );
  for (const c of cand) {
    for (const w of want) best = Math.max(best, similarity(c, w));
  }
  return best;
}

/**
 * Title carries more signal than artist: the artist string is often a
 * group name, an album artist, or absent, while the title is nearly always
 * right. Carlyrics' weights, unchanged.
 */
export const TITLE_WEIGHT = 0.65;
export const ARTIST_WEIGHT = 0.35;

/** A real synced lyric has many timed lines; some sources hand back a stub
 *  holding only credits ("[00:00.00]作词：…"). Score those below any real
 *  match. */
const MIN_SYNCED_LINES = 5;
const STUB_PENALTY = 0.35;

/**
 * Pure tie-break, never enough to overturn a real difference in similarity.
 *
 * Mirrors the search order: on an otherwise equal score prefer the sources
 * that carry per-word timing and cover the Chinese catalogues, over
 * crowd-sourced or plain-text ones.
 */
const SOURCE_BIAS: Record<string, number> = {
  ytmusic: 0.004,
  kugou: 0.003,
  qq: 0.003,
  netease: 0.001,
  lrclib: 0.0,
  musixmatch: 0.0,
  genius: -0.001,
};

/**
 * How synchronized a result is. This is what the manual-search results
 * window colours its boxes by — green for word, yellow for line — and it
 * also breaks ties in the automatic pick.
 */
export type SyncLevel = "word" | "line" | "plain";

/**
 * Do this line's words actually reconstruct its text? Same test the
 * renderer applies before drawing a line word by word (`wordsUsable` in
 * `lyrics-view.tsx`) — a result whose word list doesn't add up cannot be
 * *shown* word-synced, so it must not be *labelled* word-synced either.
 */
function lineWordsUsable(line: {
  text: string;
  words?: { text: string }[];
}): boolean {
  if (!line.words || line.words.length === 0) return false;
  return line.words.map((w) => w.text).join("").trim() === line.text.trim();
}

/**
 * Word-synced only when a real majority of the non-empty lines carry usable
 * word timings. A single word-timed line in an otherwise line-timed sheet
 * is not a word-synced lyric, and labelling it green would send the user
 * back to the picker.
 */
export function syncLevelOf(lyrics: Lyrics): SyncLevel {
  if (lyrics.kind !== "timed") return "plain";
  const sung = lyrics.lines.filter((l) => l.text.trim().length > 0);
  if (sung.length === 0) return "line";
  const withWords = sung.filter(lineWordsUsable).length;
  return withWords / sung.length >= 0.6 ? "word" : "line";
}

/** Tie-break bonus by sync level. Same order of magnitude as SOURCE_BIAS —
 *  deliberately too small to beat a genuine similarity difference, because
 *  a word-synced wrong song is still the wrong song. */
const SYNC_BONUS: Record<SyncLevel, number> = {
  word: 0.006,
  line: 0.003,
  plain: 0,
};

/** One search hit, with the provider's own idea of what it is. */
export type LyricsCandidate = {
  source: string;
  /** The provider's reported title/artist — NOT the requested ones. The
   *  whole point is to compare the two. */
  title: string;
  artist: string;
  lyrics: Lyrics;
};

/**
 * How well `candidate` matches the requested (title, artist), roughly 0..1.
 *
 * Weighted title + artist similarity, minus a penalty for lyrics too short
 * to be a real transcript, plus a hair of source/sync bias to break ties
 * deterministically.
 */
export function scoreCandidate(
  candidate: LyricsCandidate,
  title: string,
  artist: string,
): number {
  let score =
    TITLE_WEIGHT *
      similarity(normalizeForScore(candidate.title), normalizeForScore(title)) +
    ARTIST_WEIGHT * artistSimilarity(candidate.artist, artist);

  const l = candidate.lyrics;
  const timedLines = l.kind === "timed" ? l.lines.length : 0;
  // A plain transcript isn't a stub — it's a complete lyric with no
  // timings, and the estimator can still make it move. Only a *timed*
  // result with almost no lines is the credits-only stub this guards
  // against.
  if (l.kind === "timed" && timedLines < MIN_SYNCED_LINES) {
    score -= STUB_PENALTY;
  }

  return (
    score +
    (SOURCE_BIAS[candidate.source] ?? 0) +
    SYNC_BONUS[syncLevelOf(candidate.lyrics)]
  );
}

/**
 * The relevance floor a candidate must clear to be *offered* in the manual
 * results window — similarity only, with no stub penalty or bias, so a
 * short-but-correct lyric isn't judged on its length here.
 *
 * Carlyrics' `GRID_RELEVANCE_MIN`. Search engines (QQ especially) return
 * same-named but entirely different songs — the Japanese ドラえもんのうた
 * for a Mandarin 多啦A夢 — and those are pure clutter in a picker.
 */
export const RELEVANCE_MIN = 0.3;

export function relevance(
  candidate: LyricsCandidate,
  title: string,
  artist: string,
): number {
  return (
    TITLE_WEIGHT *
      similarity(normalizeForScore(candidate.title), normalizeForScore(title)) +
    ARTIST_WEIGHT * artistSimilarity(candidate.artist, artist)
  );
}

/**
 * The score below which the automatic search gives up on a tier and moves
 * to the next one.
 *
 * 0.5 is the user's specification ("if the matching score is below 50%,
 * switch to the 2nd-tier source, then the 3rd"). It sits naturally between
 * the two populations: a right answer with a padded title scores ~0.75+
 * (containment floor 0.6 on the title alone, times 0.65, plus a decent
 * artist), while a same-title-different-song scores under 0.45 once the
 * artist disagrees.
 */
export const ACCEPT_SCORE = 0.5;

/** The best-scoring candidate, or null for an empty list. Ties resolve to
 *  the earlier entry, i.e. that source's own ranking. */
export function bestCandidate(
  candidates: LyricsCandidate[],
  title: string,
  artist: string,
): { candidate: LyricsCandidate; score: number } | null {
  let best: LyricsCandidate | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const s = scoreCandidate(c, title, artist);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best ? { candidate: best, score: bestScore } : null;
}

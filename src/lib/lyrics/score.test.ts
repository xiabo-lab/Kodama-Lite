import { describe, expect, it } from "vitest";
import {
  ACCEPT_SCORE,
  artistSimilarity,
  bestCandidate,
  normalizeForScore,
  scoreCandidate,
  similarity,
  syncLevelOf,
  type LyricsCandidate,
} from "@/lib/lyrics/score";
import type { Lyrics } from "@/lib/lyrics/types";

const timed = (n = 8): Lyrics => ({
  kind: "timed",
  lines: Array.from({ length: n }, (_, i) => ({ start: i, text: `line ${i}` })),
});

const wordTimed = (): Lyrics => ({
  kind: "timed",
  lines: Array.from({ length: 8 }, (_, i) => ({
    start: i,
    text: "ab",
    words: [
      { start: i, end: i + 0.5, text: "a" },
      { start: i + 0.5, end: i + 1, text: "b" },
    ],
  })),
});

const cand = (
  title: string,
  artist: string,
  lyrics: Lyrics = timed(),
  source = "kugou",
): LyricsCandidate => ({ source, title, artist, lyrics });

describe("normalizeForScore", () => {
  it("strips the punctuation catalogues disagree on", () => {
    expect(normalizeForScore("Swear it All Over Again")).toBe(
      "swearitalloveragain",
    );
    expect(normalizeForScore("七里香 (Live)")).toBe(normalizeForScore("七里香live"));
  });

  it("folds traditional Chinese to simplified", () => {
    // YouTube Music serves 逍遙仙; QQ/Kugou/NetEase index 逍遥仙. Without
    // this fold a correct hit reads as an unrelated title.
    expect(normalizeForScore("逍遙仙")).toBe(normalizeForScore("逍遥仙"));
  });

  it("folds full-width punctuation via NFKC before stripping", () => {
    expect(normalizeForScore("一念之間（Live）")).toBe(
      normalizeForScore("一念之間(Live)"),
    );
  });
});

describe("similarity", () => {
  it("is 1 for identical strings and 0 when either side is empty", () => {
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("", "abc")).toBe(0);
  });

  it("scores containment high but scales it by coverage", () => {
    // A padded title is the same song. The containment floor puts this at
    // 0.6 + 0.35 * (3/7) = 0.75 exactly.
    expect(similarity("七里香live", "七里香")).toBeGreaterThanOrEqual(0.75);
    // …but a 2-character title inside a 20-character one is not a
    // near-perfect hit, which is how a wrong song wins otherwise.
    const buried = similarity("aa", "aabbbbbbbbbbbbbbbbbb");
    expect(buried).toBeLessThan(0.7);
  });

  it("ranks a near-miss below an exact match", () => {
    expect(similarity("blazeaway", "blazeaway")).toBeGreaterThan(
      similarity("blazeaway", "blazeofglory"),
    );
  });
});

describe("artistSimilarity", () => {
  it("scores a blank request neutral rather than zero", () => {
    // We cannot judge an artist we were never given; punishing every
    // candidate equally would just hand the decision to the stub penalty.
    expect(artistSimilarity("TRAX", "")).toBe(0.5);
  });

  it("matches one artist inside a multi-artist field", () => {
    expect(artistSimilarity("周杰伦/费玉清", "周杰伦")).toBeGreaterThan(0.9);
    expect(artistSimilarity("A & B", "B")).toBeGreaterThan(0.9);
    expect(artistSimilarity("X feat. Y", "X")).toBeGreaterThan(0.9);
  });

  it("still scores an exact whole-field match perfectly", () => {
    expect(artistSimilarity("A/B", "A/B")).toBe(1);
  });
});

describe("syncLevelOf", () => {
  it("labels plain, line and word results", () => {
    expect(syncLevelOf({ kind: "plain", text: "x" })).toBe("plain");
    expect(syncLevelOf(timed())).toBe("line");
    expect(syncLevelOf(wordTimed())).toBe("word");
  });

  it("does not call a mostly-line sheet word-synced", () => {
    // One word-timed line among eight is not a word-synced lyric, and a
    // green box promising word sync would send the user back to the picker.
    const mixed: Lyrics = {
      kind: "timed",
      lines: [
        { start: 0, text: "ab", words: [{ start: 0, end: 1, text: "ab" }] },
        ...Array.from({ length: 7 }, (_, i) => ({ start: i + 1, text: "x" })),
      ],
    };
    expect(syncLevelOf(mixed)).toBe("line");
  });

  it("ignores word lists that don't reconstruct their line", () => {
    // Same test the renderer applies before drawing word by word: a list
    // that doesn't add up cannot be shown word-synced, so it must not be
    // labelled word-synced either.
    const broken: Lyrics = {
      kind: "timed",
      lines: Array.from({ length: 8 }, (_, i) => ({
        start: i,
        text: "hello world",
        words: [{ start: i, end: i + 1, text: "hello" }],
      })),
    };
    expect(syncLevelOf(broken)).toBe("line");
  });
});

describe("scoreCandidate", () => {
  const T = "Blaze Away";
  const A = "TRAX";

  it("scores an exact match above the accept threshold", () => {
    expect(scoreCandidate(cand(T, A), T, A)).toBeGreaterThanOrEqual(ACCEPT_SCORE);
  });

  it("scores a same-title-different-artist song below the threshold", () => {
    // The case a boolean `hitMatches` could not distinguish: plausible
    // enough to pass a containment test, wrong enough to keep searching.
    const score = scoreCandidate(cand("Blaze of Glory", "Bon Jovi"), T, A);
    expect(score).toBeLessThan(ACCEPT_SCORE);
  });

  it("accepts a padded title by the same artist", () => {
    expect(
      scoreCandidate(cand("Blaze Away (Live)", "TRAX"), T, A),
    ).toBeGreaterThanOrEqual(ACCEPT_SCORE);
  });

  it("ranks a credits-only stub below a real match for the same song", () => {
    // The penalty is a RANKING device, not a veto — a stub for the right
    // song still beats a full lyric for the wrong one, which is the
    // correct priority. So this asserts the ordering, not a threshold.
    const stub = scoreCandidate(cand(T, A, timed(2)), T, A);
    const real = scoreCandidate(cand(T, A, timed(20)), T, A);
    const wrongButLong = scoreCandidate(
      cand("Blaze of Glory", "Bon Jovi", timed(20)),
      T,
      A,
    );
    expect(stub).toBeLessThan(real);
    expect(stub).toBeGreaterThan(wrongButLong);
  });

  it("does not treat a plain transcript as a stub", () => {
    // Plain lyrics have no timed lines by definition; the estimator can
    // still make them move, so they must not be penalised for it.
    const plain = scoreCandidate(
      cand(T, A, { kind: "plain", text: "a full transcript" }),
      T,
      A,
    );
    expect(plain).toBeGreaterThanOrEqual(ACCEPT_SCORE);
  });

  it("lets sync level break a tie but never overturn a real difference", () => {
    const word = scoreCandidate(cand(T, A, wordTimed()), T, A);
    const line = scoreCandidate(cand(T, A, timed()), T, A);
    expect(word).toBeGreaterThan(line);

    // A word-synced WRONG song still loses to a line-synced right one —
    // the bonus is a tie-break, not a thumb on the scale.
    const wrongWord = scoreCandidate(
      cand("Blaze of Glory", "Bon Jovi", wordTimed()),
      T,
      A,
    );
    expect(wrongWord).toBeLessThan(line);
  });
});

describe("bestCandidate", () => {
  const T = "一念之间";
  const A = "陶喆";

  it("picks the right song over a source's own first hit", () => {
    // The exact failure this whole module exists for: search engines rank
    // by popularity, so the wrong version is routinely returned first.
    const best = bestCandidate(
      [cand("一念之间 (Live)", "群星"), cand(T, A), cand("一念", "某人")],
      T,
      A,
    );
    expect(best?.candidate.title).toBe(T);
    expect(best?.score).toBeGreaterThanOrEqual(ACCEPT_SCORE);
  });

  it("returns null for an empty list", () => {
    expect(bestCandidate([], T, A)).toBeNull();
  });

  it("resolves ties to the earlier entry, i.e. the source's own ranking", () => {
    const first = cand(T, A);
    const second = cand(T, A);
    expect(bestCandidate([first, second], T, A)?.candidate).toBe(first);
  });

  it("matches across scripts when the services disagree on one", () => {
    // Traditional-vs-simplified used to cost a correct hit outright.
    const best = bestCandidate([cand("一念之間", "陶喆")], T, A);
    expect(best?.score).toBeGreaterThanOrEqual(ACCEPT_SCORE);
  });
});

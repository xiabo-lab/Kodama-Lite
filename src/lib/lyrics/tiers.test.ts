import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Lyrics } from "@/lib/lyrics/types";
import type { LyricsCandidate } from "@/lib/lyrics/score";

/**
 * Each provider is mocked so the tier walk can be observed directly: which
 * sources were asked, in what order, and when it stopped.
 *
 * The mocks answer with CANDIDATES now, not with a single lyric, because
 * that is what the tier walk consumes — every source hands back its search
 * hits with their own reported title/artist, and the scorer decides. The
 * key property under test is the one that changed: the walk stops on a good
 * enough SCORE, not on the mere presence of synced lyrics.
 */
const calls: string[] = [];
const answers: Record<string, LyricsCandidate[]> = {};

const mkSearch = (name: string) =>
  vi.fn(async () => {
    calls.push(name);
    return answers[name] ?? [];
  });
// YouTube Music has no candidate search — it's fetched by videoId.
const ytFetch = vi.fn(async () => {
  calls.push("ytmusic");
  return (answers.ytmusic ?? [])[0]?.lyrics ?? null;
});

vi.mock("@/lib/lyrics/ytmusic", () => ({ fetchYtMusicLyrics: ytFetch }));
vi.mock("@/lib/lyrics/kugou", () => ({
  fetchKugouLyrics: vi.fn(),
  searchKugouCandidates: mkSearch("kugou"),
}));
vi.mock("@/lib/lyrics/lrclib", () => ({
  fetchLrclibLyrics: vi.fn(),
  searchLrclibCandidates: mkSearch("lrclib"),
}));
vi.mock("@/lib/lyrics/netease", () => ({
  fetchNeteaseLyrics: vi.fn(),
  searchNeteaseCandidates: mkSearch("netease"),
}));
vi.mock("@/lib/lyrics/musixmatch", () => ({
  fetchMusixmatchLyrics: vi.fn(),
  searchMusixmatchCandidates: mkSearch("musixmatch"),
}));
vi.mock("@/lib/lyrics/qq", () => ({
  fetchQqLyrics: vi.fn(),
  searchQqCandidates: mkSearch("qq"),
}));
vi.mock("@/lib/lyrics/genius", () => ({
  fetchGeniusLyrics: vi.fn(),
  searchGeniusCandidates: mkSearch("genius"),
}));

const { fetchLyricsTiered, SEARCH_TIERS, SEARCHABLE_SOURCES } = await import(
  "@/lib/lyrics/sources"
);

/** Enough timed lines to clear the stub penalty (MIN_SYNCED_LINES = 5). */
const timed: Lyrics = {
  kind: "timed",
  lines: Array.from({ length: 8 }, (_, i) => ({
    start: i,
    text: `line ${i}`,
  })),
};
const plain: Lyrics = { kind: "plain", text: "a plain transcript" };

const params = { videoId: "v", title: "Blaze Away", artist: "TRAX" };

/** A candidate that matches the request exactly — scores ~1. */
const exact = (source: string, lyrics: Lyrics = timed): LyricsCandidate => ({
  source,
  title: params.title,
  artist: params.artist,
  lyrics,
});

/** A candidate for a different song that merely shares a word — the case
 *  the old boolean `hitMatches` could not distinguish from a real hit. */
const wrongSong = (source: string): LyricsCandidate => ({
  source,
  title: "Blaze of Glory",
  artist: "Someone Else Entirely",
  lyrics: timed,
});

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});

describe("tiered lyrics search", () => {
  it("stops after YouTube Music when it has lyrics", async () => {
    answers.ytmusic = [exact("ytmusic")];
    const out = await fetchLyricsTiered(params);
    expect(calls).toEqual(["ytmusic"]);
    // Untouched sources are ABSENT, not null — "not asked" ≠ "nothing".
    expect(out.sources.kugou).toBeUndefined();
    expect(out.sources.ytmusic).toBe(timed);
    expect(out.bestScore).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps searching past a confident but WRONG match", async () => {
    // This is the whole point of the change. Kugou answers first with
    // synced lyrics for a different song; the old walk stopped dead here
    // and displayed them. Scoring rejects it and moves on.
    answers.kugou = [wrongSong("kugou")];
    answers.netease = [exact("netease")];
    const out = await fetchLyricsTiered(params);
    expect(calls).toContain("netease");
    expect(out.sources.netease).toBe(timed);
    expect(out.bestScore).toBeGreaterThanOrEqual(0.5);
  });

  it("stops as soon as a tier produces a good enough score", async () => {
    answers.lrclib = [exact("lrclib")];
    const out = await fetchLyricsTiered(params);
    expect(calls).toEqual(["ytmusic", "kugou", "lrclib"]);
    // Tier 3 was never reached.
    expect(out.sources.musixmatch).toBeUndefined();
    expect(out.sources.netease).toBeUndefined();
  });

  it("walks every tier when nothing scores well, keeping the best it saw", async () => {
    answers.kugou = [wrongSong("kugou")];
    const out = await fetchLyricsTiered(params);
    expect(calls).toEqual([
      "ytmusic", "kugou", "lrclib", "musixmatch", "netease", "genius", "qq",
    ]);
    // A sub-threshold best is kept rather than discarded — better than an
    // empty stage, and the picker can override it.
    expect(out.sources.kugou).toBe(timed);
    expect(out.bestScore).toBeLessThan(0.5);
  });

  it("records a searched-but-empty source as null, not absent", async () => {
    answers.kugou = [];
    answers.lrclib = [exact("lrclib")];
    const out = await fetchLyricsTiered(params);
    expect(out.sources.kugou).toBeNull();
  });

  it("keeps a plain transcript when that is the best on offer", async () => {
    answers.ytmusic = [exact("ytmusic", plain)];
    const out = await fetchLyricsTiered(params);
    expect(out.sources.ytmusic).toBe(plain);
  });

  it("covers all seven sources across the tiers exactly once", () => {
    const flat = SEARCH_TIERS.flat();
    expect(flat).toHaveLength(7);
    expect(new Set(flat).size).toBe(7);
    expect(SEARCH_TIERS[0]).toEqual(["ytmusic"]);
  });

  it("offers exactly the six name-searchable sources", () => {
    // YouTube Music is addressed by videoId and has no text search, so a
    // hand-typed query can only reach the other six.
    expect(SEARCHABLE_SOURCES).toHaveLength(6);
    expect(SEARCHABLE_SOURCES).not.toContain("ytmusic");
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Lyrics } from "@/lib/lyrics/types";

// Each provider is mocked so the tier walk can be observed directly:
// which sources were asked, in what order, and when it stopped.
const calls: string[] = [];
const answers: Record<string, Lyrics | null> = {};
const mk = (name: string) =>
  vi.fn(async () => {
    calls.push(name);
    return answers[name] ?? null;
  });

vi.mock("@/lib/lyrics/ytmusic", () => ({ fetchYtMusicLyrics: mk("ytmusic") }));
vi.mock("@/lib/lyrics/kugou", () => ({ fetchKugouLyrics: mk("kugou") }));
vi.mock("@/lib/lyrics/lrclib", () => ({ fetchLrclibLyrics: mk("lrclib") }));
vi.mock("@/lib/lyrics/netease", () => ({ fetchNeteaseLyrics: mk("netease") }));
vi.mock("@/lib/lyrics/musixmatch", () => ({ fetchMusixmatchLyrics: mk("musixmatch") }));
vi.mock("@/lib/lyrics/qq", () => ({ fetchQqLyrics: mk("qq") }));
vi.mock("@/lib/lyrics/genius", () => ({ fetchGeniusLyrics: mk("genius") }));

const { fetchLyricsTiered, SEARCH_TIERS } = await import("@/lib/lyrics/sources");

const timed: Lyrics = { kind: "timed", lines: [{ start: 0, text: "x" }] };
const plain: Lyrics = { kind: "plain", text: "x" };
const params = { videoId: "v", title: "t" };

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});

describe("tiered lyrics search", () => {
  it("stops after YouTube Music when it has synced lyrics", async () => {
    answers.ytmusic = timed;
    const out = await fetchLyricsTiered(params);
    expect(calls).toEqual(["ytmusic"]);
    // Untouched sources are ABSENT, not null — "not asked" ≠ "nothing".
    expect(out.kugou).toBeUndefined();
    expect(out.ytmusic).toBe(timed);
  });

  it("keeps searching when YouTube Music is only unsynced", async () => {
    answers.ytmusic = plain;
    answers.lrclib = timed;
    const out = await fetchLyricsTiered(params);
    expect(calls).toEqual(["ytmusic", "kugou", "lrclib"]);
    expect(out.musixmatch).toBeUndefined();
    expect(out.ytmusic).toBe(plain);
  });

  it("walks every tier when nothing is synced, keeping the plain fallback", async () => {
    answers.ytmusic = plain;
    const out = await fetchLyricsTiered(params);
    expect(calls).toEqual([
      "ytmusic", "kugou", "lrclib", "musixmatch", "netease", "genius", "qq",
    ]);
    expect(out.ytmusic).toBe(plain);
  });

  it("reaches the third tier only when the first two miss", async () => {
    answers.qq = timed;
    const out = await fetchLyricsTiered(params);
    expect(calls).toContain("qq");
    expect(out.qq).toBe(timed);
  });

  it("covers all seven sources across the tiers exactly once", () => {
    const flat = SEARCH_TIERS.flat();
    expect(flat).toHaveLength(7);
    expect(new Set(flat).size).toBe(7);
    expect(SEARCH_TIERS[0]).toEqual(["ytmusic"]);
  });
});

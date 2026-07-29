import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Lyrics } from "@/lib/lyrics/types";

const dispatched: { type?: string }[] = [];
vi.mock("@/lib/network", () => ({
  dispatchContent: (c: { type?: string }) => dispatched.push(c),
}));

const CACHE_KEY = "kl:lyrics-cache";

const timed = (text: string): Lyrics => ({
  kind: "timed",
  lines: [{ start: 0, text }],
  source: "Kugou",
});

const params = { videoId: "v1", title: "Song", artist: "Artist" };

/** The store reads `window.localStorage`; node has neither. */
function stubStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = storage;
  g.window = { localStorage: storage };
  return map;
}

/**
 * A store whose cache memo has not been populated yet.
 *
 * `lyricsCache` is memoised on first read, so seeding storage after the
 * module has been touched is invisible — the same trap the lyrics cache
 * has bitten this project with before. Re-importing is the only way to
 * exercise a cold read.
 */
async function freshStore(seed: Record<string, string> = {}) {
  const map = stubStorage(seed);
  vi.resetModules();
  dispatched.length = 0;
  const { useLyricsStore } = await import("@/store/lyricsStore");
  return { store: useLyricsStore, map };
}

beforeEach(() => {
  dispatched.length = 0;
  stubStorage();
});

/**
 * The rule this whole area exists for: nothing reaches the persistent
 * cache until a human confirms it. The old behaviour cached every search
 * result on arrival, which made a wrong match permanent — and because a
 * cache hit skips the search, it could never correct itself.
 */
describe("confirmation gates the cache", () => {
  it("does NOT persist lyrics that merely arrived from a search", async () => {
    const { store, map } = await freshStore();
    store.getState().load(params);
    store.getState().applyEvents([
      { type: "lyrics:loaded", videoId: "v1", sources: { kugou: timed("a") } },
    ]);
    expect(store.getState().lyrics).not.toBeNull();
    expect(store.getState().confirmed).toBe(false);
    expect(map.get(CACHE_KEY)).toBeUndefined();
  });

  it("does NOT persist a hand-picked result on its own", async () => {
    const { store, map } = await freshStore();
    store.getState().load(params);
    store.getState().pickManual(timed("picked"));
    expect(store.getState().lyrics).toEqual(timed("picked"));
    expect(store.getState().confirmed).toBe(false);
    expect(map.get(CACHE_KEY)).toBeUndefined();
  });

  it("persists only once confirm() is called", async () => {
    const { store, map } = await freshStore();
    store.getState().load(params);
    store.getState().applyEvents([
      { type: "lyrics:loaded", videoId: "v1", sources: { kugou: timed("a") } },
    ]);
    store.getState().confirm();
    expect(store.getState().confirmed).toBe(true);
    expect(JSON.parse(map.get(CACHE_KEY)!).v1.confirmed.lines[0].text).toBe("a");
  });

  it("serves a confirmed lyric on the next play with no network", async () => {
    const seeded = JSON.stringify({ v1: { confirmed: timed("a") } });
    const { store } = await freshStore({ [CACHE_KEY]: seeded });
    store.getState().load(params);
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.confirmed).toBe(true);
    expect(s.lyrics?.kind === "timed" && s.lyrics.lines[0].text).toBe("a");
    expect(dispatched).toHaveLength(0);
  });

  it("unconfirm() removes it from the cache", async () => {
    const seeded = JSON.stringify({ v1: { confirmed: timed("a") } });
    const { store, map } = await freshStore({ [CACHE_KEY]: seeded });
    store.getState().load(params);
    store.getState().unconfirm();
    expect(store.getState().confirmed).toBe(false);
    expect(JSON.parse(map.get(CACHE_KEY)!)).toEqual({});
  });

  it("drops confirmation when the displayed lyric changes", async () => {
    // What is on screen is no longer what was confirmed, so the green
    // button must go back to unpressed rather than claim the new lyric
    // was approved.
    const seeded = JSON.stringify({ v1: { confirmed: timed("a") } });
    const { store } = await freshStore({ [CACHE_KEY]: seeded });
    store.getState().load(params);
    expect(store.getState().confirmed).toBe(true);
    store.getState().pickManual(timed("different"));
    expect(store.getState().confirmed).toBe(false);
  });

  it("discards legacy auto-cached entries rather than trusting them", async () => {
    // They were written without confirmation — exactly the behaviour being
    // removed — so carrying them forward would preserve the wrong lyrics
    // this change exists to stop serving.
    const legacy = JSON.stringify({ v1: { sources: { kugou: timed("stale") } } });
    const { store } = await freshStore({ [CACHE_KEY]: legacy });
    store.getState().load(params);
    expect(store.getState().status).toBe("loading");
    expect(dispatched.some((d) => d.type === "lyrics:load")).toBe(true);
  });
});

describe("search results survive closing the screen", () => {
  const results = [
    {
      candidate: { source: "kugou", title: "A", artist: "X", lyrics: timed("a") },
      score: 0.9,
    },
  ] as never;

  it("keeps results after one is picked", async () => {
    const { store } = await freshStore();
    store.getState().load(params);
    store.getState().applyEvents([
      { type: "lyrics:search:results", videoId: "v1", results },
    ]);
    expect(store.getState().searchResults).toHaveLength(1);

    // "Try the next one down" is the whole point of a results list, so
    // picking one must not throw the list away.
    store.getState().pickManual(timed("a"));
    expect(store.getState().searchResults).toHaveLength(1);
    expect(store.getState().searchStatus).toBe("done");
  });

  it("clears results when the track changes", async () => {
    const { store } = await freshStore();
    store.getState().load(params);
    store.getState().applyEvents([
      { type: "lyrics:search:results", videoId: "v1", results },
    ]);
    store.getState().load({ ...params, videoId: "v2" });
    expect(store.getState().searchResults).toEqual([]);
    expect(store.getState().searchStatus).toBe("idle");
  });

  it("ignores results that arrive after the track moved on", async () => {
    const { store } = await freshStore();
    store.getState().load(params);
    store.getState().load({ ...params, videoId: "v2" });
    store.getState().applyEvents([
      { type: "lyrics:search:results", videoId: "v1", results },
    ]);
    expect(store.getState().searchResults).toEqual([]);
  });

  it("remembers the query that produced them", async () => {
    const { store } = await freshStore();
    store.getState().load(params);
    store.getState().search({ title: "Corrected", artist: "Fixed" });
    expect(store.getState().searchQuery).toEqual({
      title: "Corrected",
      artist: "Fixed",
    });
    expect(dispatched.some((d) => d.type === "lyrics:search")).toBe(true);
  });
});

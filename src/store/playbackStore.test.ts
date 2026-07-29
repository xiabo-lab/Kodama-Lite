import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePlaybackStore, type Track } from "@/store/playbackStore";

/**
 * Pure store-logic tests for the playback slice — the part of Phase 2 that
 * doesn't need a DOM or a real `<audio>` element to verify. These lock in
 * two things a manual browser check can't reliably repeat:
 *
 *   1. Queue navigation (next/prev boundaries, repeat modes) — the same
 *      "restart vs. go back", "stop vs. loop" edge cases YTMLite's own
 *      `playback.test.ts` covers, ported to the same rules.
 *   2. `applyEvents`'s staleness guard — a `stream:ready`/`stream:error`
 *      for a track the user has since navigated away from must be
 *      silently dropped, never applied to whatever's current now.
 */

function track(videoId: string, duration = 180): Track {
  return { videoId, title: videoId, duration };
}

beforeEach(() => {
  // Reset to a clean slate between tests — `create()` only runs once, so
  // state otherwise leaks across tests in the same file.
  usePlaybackStore.setState({
    queue: [],
    index: -1,
    playing: false,
    status: "idle",
    streamUrl: undefined,
    position: 0,
    duration: 0,
    shuffle: false,
    repeat: "off",
    error: undefined,
  });
});

describe("playQueue / next / prev", () => {
  it("starts at the given index and requests its stream", () => {
    const tracks = [track("a"), track("b"), track("c")];
    usePlaybackStore.getState().playQueue(tracks, 1);
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(1);
    expect(s.playing).toBe(true);
    expect(s.status).toBe("loading");
    expect(s.streamUrl).toBeUndefined();
  });

  it("next() advances to the next track", () => {
    usePlaybackStore.getState().playQueue([track("a"), track("b")], 0);
    usePlaybackStore.getState().next();
    expect(usePlaybackStore.getState().index).toBe(1);
  });

  it("next() at the end of the queue stops (repeat off)", () => {
    usePlaybackStore.getState().playQueue([track("a"), track("b")], 1);
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(1); // unchanged
    expect(s.playing).toBe(false);
  });

  it("next() at the end loops to 0 when repeat is 'all'", () => {
    usePlaybackStore.getState().playQueue([track("a"), track("b")], 1);
    usePlaybackStore.setState({ repeat: "all" });
    usePlaybackStore.getState().next();
    expect(usePlaybackStore.getState().index).toBe(0);
  });

  it("next() replays the same track when repeat is 'one'", () => {
    usePlaybackStore.getState().playQueue([track("a"), track("b")], 0);
    usePlaybackStore.setState({ repeat: "one", position: 42 });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(0); // same track
    expect(s.position).toBe(0); // restarted
    expect(s.playing).toBe(true);
  });

  it("prev() restarts the current track when >3s in", () => {
    usePlaybackStore.getState().playQueue([track("a"), track("b")], 1);
    usePlaybackStore.setState({ position: 10 });
    usePlaybackStore.getState().prev();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(1); // stayed put
    expect(s.position).toBe(0);
  });

  it("prev() goes to the previous track when <3s in", () => {
    usePlaybackStore.getState().playQueue([track("a"), track("b")], 1);
    usePlaybackStore.setState({ position: 1 });
    usePlaybackStore.getState().prev();
    expect(usePlaybackStore.getState().index).toBe(0);
  });

  it("prev() on the first track just restarts it, regardless of position", () => {
    usePlaybackStore.getState().playQueue([track("a"), track("b")], 0);
    usePlaybackStore.setState({ position: 1 });
    usePlaybackStore.getState().prev();
    expect(usePlaybackStore.getState().index).toBe(0);
  });
});

describe("applyEvents staleness guard", () => {
  it("applies stream:ready for the CURRENT track", () => {
    usePlaybackStore.getState().playQueue([track("a")], 0);
    usePlaybackStore.getState().applyEvents([
      { type: "stream:ready", videoId: "a", url: "http://x/a" },
    ]);
    const s = usePlaybackStore.getState();
    expect(s.streamUrl).toBe("http://x/a");
    expect(s.status).toBe("ready");
  });

  it("ignores stream:ready for a track that's no longer current", () => {
    usePlaybackStore.getState().playQueue([track("a"), track("b")], 0);
    usePlaybackStore.getState().next(); // now on "b"
    usePlaybackStore.getState().applyEvents([
      // A slow resolve for "a" arriving after the user already skipped —
      // must not clobber "b"'s (still-loading) state.
      { type: "stream:ready", videoId: "a", url: "http://x/a" },
    ]);
    const s = usePlaybackStore.getState();
    expect(s.streamUrl).toBeUndefined();
    expect(s.status).toBe("loading");
  });

  it("ignores stream:error for a stale track and applies it for the current one", () => {
    usePlaybackStore.getState().playQueue([track("a")], 0);
    usePlaybackStore.getState().applyEvents([
      { type: "stream:error", videoId: "not-a", message: "boom" },
    ]);
    expect(usePlaybackStore.getState().status).toBe("loading"); // untouched

    usePlaybackStore.getState().applyEvents([
      { type: "stream:error", videoId: "a", message: "boom" },
    ]);
    const s = usePlaybackStore.getState();
    expect(s.status).toBe("error");
    expect(s.playing).toBe(false);
    expect(s.error).toBe("boom");
  });

  it("folds ytdlp:state into ytdlpPhase", () => {
    usePlaybackStore.getState().applyEvents([{ type: "ytdlp:state", phase: "ready" }]);
    expect(usePlaybackStore.getState().ytdlpPhase).toBe("ready");
  });
});

/**
 * Volume has to survive a restart. It used to boot at a hardcoded 1, so
 * every launch came back at full volume; the workaround was to turn the
 * PipeWire stream down instead, which left the in-app slider reading 100%
 * while the output sat at 45%. These lock the slider in as the control
 * that actually holds.
 *
 * The store is created at import time, so rehydration can only be tested
 * against a freshly imported module — hence `resetModules` plus a dynamic
 * import rather than the top-level `usePlaybackStore`.
 */
describe("volume persistence", () => {
  function stubStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed));
    (globalThis as unknown as Record<string, unknown>).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
    };
    return map;
  }

  async function freshStore(seed: Record<string, string> = {}) {
    stubStorage(seed);
    vi.resetModules();
    return (await import("@/store/playbackStore")).usePlaybackStore;
  }

  it("writes the volume to storage when it changes", () => {
    const map = stubStorage();
    usePlaybackStore.getState().setVolume(0.4);
    expect(JSON.parse(map.get("kl:volume")!)).toEqual({
      volume: 0.4,
      muted: false,
    });
  });

  it("boots at the saved volume instead of full", async () => {
    const store = await freshStore({
      "kl:volume": JSON.stringify({ volume: 0.25, muted: false }),
    });
    expect(store.getState().volume).toBe(0.25);
  });

  it("boots at full volume when nothing is saved", async () => {
    const store = await freshStore();
    expect(store.getState().volume).toBe(1);
    expect(store.getState().muted).toBe(false);
  });

  it("round-trips mute", async () => {
    const store = await freshStore({
      "kl:volume": JSON.stringify({ volume: 0.6, muted: true }),
    });
    expect(store.getState().muted).toBe(true);
    expect(store.getState().volume).toBe(0.6);
  });

  // A bad value must not be able to make the car silent or deafening.
  it.each([
    ["out of range high", JSON.stringify({ volume: 42 })],
    ["negative", JSON.stringify({ volume: -1 })],
    ["not a number", JSON.stringify({ volume: "loud" })],
    ["corrupt json", "{not json"],
  ])("falls back to full volume on %s", async (_label, raw) => {
    const store = await freshStore({ "kl:volume": raw });
    expect(store.getState().volume).toBe(1);
  });
});

/**
 * Failed-track recovery. Both of these are races that only show up when a
 * download fails, which is exactly when nobody is in a position to debug
 * them — so they're pinned here.
 */
describe("recovering from a failed track", () => {
  it("keeps the data plane's reason over the audio element's code", () => {
    // Both fire on a failed download: `stream:error` carries a classified,
    // readable sentence, then the <audio> element errors on the 502 with a
    // MEDIA_ERR code. The element's message arrives second and must not
    // overwrite the explanation.
    usePlaybackStore.getState().playQueue([track("a")], 0);
    usePlaybackStore.getState().applyEvents([
      {
        type: "stream:error",
        videoId: "a",
        message: "This track is DRM protected.",
      },
    ]);
    usePlaybackStore.getState().setPlayError("audio error (code 4)");
    expect(usePlaybackStore.getState().error).toBe("This track is DRM protected.");
  });

  it("still reports the element's error when nothing else explained it", () => {
    usePlaybackStore.getState().playQueue([track("a")], 0);
    usePlaybackStore.getState().setPlayError("audio error (code 4)");
    expect(usePlaybackStore.getState().error).toBe("audio error (code 4)");
  });

  it("clears the error on the next track, so it can't go stale", () => {
    usePlaybackStore.getState().playQueue([track("a"), track("b")], 0);
    usePlaybackStore.getState().setPlayError("audio error (code 4)");
    usePlaybackStore.getState().next();
    expect(usePlaybackStore.getState().error).toBeUndefined();
  });

  it("re-resolves on resume after a failure", () => {
    // `stream:resolve` answers instantly with a deterministic URL, so after
    // a failure `streamUrl` is still set and resume used to skip the
    // resolve entirely — leaving the track unplayable until you navigated
    // away and back. Dropping the URL is what makes the retry real.
    usePlaybackStore.getState().playQueue([track("a")], 0);
    usePlaybackStore.getState().applyEvents([
      { type: "stream:ready", videoId: "a", url: "http://127.0.0.1/x/stream/a" },
    ]);
    usePlaybackStore.getState().applyEvents([
      { type: "stream:error", videoId: "a", message: "Couldn't download." },
    ]);
    expect(usePlaybackStore.getState().streamUrl).toBe("http://127.0.0.1/x/stream/a");

    usePlaybackStore.getState().resume();
    const s = usePlaybackStore.getState();
    expect(s.streamUrl).toBeUndefined();
    expect(s.status).toBe("loading");
    expect(s.error).toBeUndefined();
    expect(s.playing).toBe(true);
  });

  it("does not re-resolve a healthy track on resume", () => {
    usePlaybackStore.getState().playQueue([track("a")], 0);
    usePlaybackStore.getState().applyEvents([
      { type: "stream:ready", videoId: "a", url: "http://127.0.0.1/x/stream/a" },
    ]);
    usePlaybackStore.setState({ playing: false });
    usePlaybackStore.getState().resume();
    expect(usePlaybackStore.getState().streamUrl).toBe("http://127.0.0.1/x/stream/a");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
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

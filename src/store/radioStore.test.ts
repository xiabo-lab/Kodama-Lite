import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShelfItem } from "@/lib/innertube/types";

const dispatched: Array<{ type: string; videoId?: string }> = [];
vi.mock("@/lib/network", () => ({
  dispatchContent: (command: { type: string; videoId?: string }) =>
    dispatched.push(command),
}));

import { usePlaybackStore, type Track } from "@/store/playbackStore";
import { useRadioStore } from "@/store/radioStore";

function track(videoId: string): Track {
  return { videoId, title: videoId, duration: 180 };
}

function shelfSong(id: string): ShelfItem {
  return {
    kind: "song",
    id,
    title: id,
    duration: 180,
    thumbnails: [],
  };
}

beforeEach(() => {
  vi.useRealTimers();
  dispatched.length = 0;
  usePlaybackStore.setState({
    queue: [],
    index: -1,
    playing: false,
    status: "idle",
    started: false,
    streamUrl: undefined,
    position: 0,
    duration: 0,
    repeat: "off",
    waitingForNext: false,
    error: undefined,
  });
  useRadioStore.setState({
    requestedSeed: undefined,
    pendingAdvance: undefined,
    error: undefined,
  });
});

describe("radio continuation", () => {
  it("turns an in-flight proactive request into an advance when the album ends", () => {
    usePlaybackStore.getState().playQueue([track("album-1"), track("album-last")], 1);
    useRadioStore.getState().request("album-last");
    expect(dispatched).toEqual([{ type: "radio:load", videoId: "album-last" }]);

    // The track ends before that already-running request returns.
    usePlaybackStore.getState().next();
    useRadioStore.getState().request("album-last", true);
    expect(dispatched).toHaveLength(1); // no duplicate request

    useRadioStore.getState().applyEvents([
      {
        type: "radio:loaded",
        seed: "album-last",
        tracks: [shelfSong("album-last"), shelfSong("similar-1"), shelfSong("similar-2")],
      },
    ]);

    const p = usePlaybackStore.getState();
    expect(p.queue.map((t) => t.videoId)).toEqual([
      "album-1",
      "album-last",
      "similar-1",
      "similar-2",
    ]);
    expect(p.index).toBe(2);
    expect(p.queue[p.index].videoId).toBe("similar-1");
    expect(p.waitingForNext).toBe(false);
    expect(p.playing).toBe(true);
  });

  it("appends but does not advance when the user pauses while waiting", () => {
    usePlaybackStore.getState().playQueue([track("last")], 0);
    usePlaybackStore.getState().next();
    useRadioStore.getState().request("last", true);
    usePlaybackStore.getState().toggle(); // Pause cancels waiting.

    useRadioStore.getState().applyEvents([
      { type: "radio:loaded", seed: "last", tracks: [shelfSong("next")] },
    ]);

    const p = usePlaybackStore.getState();
    expect(p.queue.map((t) => t.videoId)).toEqual(["last", "next"]);
    expect(p.index).toBe(0);
    expect(p.playing).toBe(false);
  });

  it("retries a failed urgent continuation while playback is still wanted", () => {
    vi.useFakeTimers();
    usePlaybackStore.getState().playQueue([track("last")], 0);
    usePlaybackStore.getState().next();
    useRadioStore.getState().request("last", true);
    useRadioStore.getState().applyEvents([
      { type: "radio:error", seed: "last", message: "temporary" },
    ]);

    expect(dispatched).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(dispatched).toEqual([
      { type: "radio:load", videoId: "last" },
      { type: "radio:load", videoId: "last" },
    ]);
    expect(useRadioStore.getState().pendingAdvance).toBe("last");
  });

  it("treats an all-duplicate station as retryable instead of staying stuck", () => {
    vi.useFakeTimers();
    usePlaybackStore.getState().playQueue([track("last")], 0);
    usePlaybackStore.getState().next();
    useRadioStore.getState().request("last", true);
    useRadioStore.getState().applyEvents([
      { type: "radio:loaded", seed: "last", tracks: [shelfSong("last")] },
    ]);

    expect(useRadioStore.getState().requestedSeed).toBeUndefined();
    vi.advanceTimersByTime(2_000);
    expect(dispatched).toHaveLength(2);
  });
});

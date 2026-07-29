import { describe, expect, it, beforeEach, vi } from "vitest";
import { useLocalStore, toTrack } from "@/store/localStore";
import type { LocalTrack } from "@/protocol";

vi.mock("@/bus/bus", () => ({ dispatch: vi.fn() }));

function local(id: string, title = id, artist = "A", duration = 100): LocalTrack {
  return { id, title, artist, duration };
}

const library = [
  local("loc1", "One"),
  local("loc2", "Two"),
  local("loc3", "Three"),
  local("loc4", "Four"),
];

beforeEach(() => {
  useLocalStore.setState({
    status: "ready",
    tracks: library,
    playMode: "normal",
    progress: { done: 0, total: 0 },
    error: undefined,
    source: "USB3",
  });
});

describe("toTrack", () => {
  it("maps a scanned file onto the playback queue's shape", () => {
    const t = toTrack(local("loc9", "Song", "Artist", 42));
    // The local id IS the videoId — the data plane recognises it and
    // resolves it to the local route, so nothing in the view plane needs
    // to branch on where a track came from.
    expect(t.videoId).toBe("loc9");
    expect(t.title).toBe("Song");
    expect(t.subtitle).toBe("Artist");
    expect(t.duration).toBe(42);
  });

  it("leaves an unknown artist and a zero duration undefined", () => {
    // `undefined` renders as the UI's own placeholder; empty string and 0
    // would render as a blank artist and a 0:00 length.
    const t = toTrack(local("loc9", "Song", "", 0));
    expect(t.subtitle).toBeUndefined();
    expect(t.duration).toBeUndefined();
  });
});

describe("buildQueue", () => {
  it("plays in order from the tapped track", () => {
    const q = useLocalStore.getState().buildQueue(2);
    expect(q.tracks.map((t) => t.videoId)).toEqual([
      "loc1", "loc2", "loc3", "loc4",
    ]);
    expect(q.index).toBe(2);
    expect(q.shuffle).toBe(false);
    expect(q.repeat).toBe("off");
  });

  it("wraps the whole list in repeat mode", () => {
    useLocalStore.setState({ playMode: "repeat" });
    const q = useLocalStore.getState().buildQueue(0);
    expect(q.repeat).toBe("all");
    expect(q.shuffle).toBe(false);
  });

  it("puts the tapped track first when shuffling", () => {
    // Pressing a song and hearing a different one reads as a bug no matter
    // which mode is selected, so the tap always wins.
    useLocalStore.setState({ playMode: "shuffle" });
    for (let i = 0; i < 20; i++) {
      const q = useLocalStore.getState().buildQueue(2);
      expect(q.tracks[0].videoId).toBe("loc3");
      expect(q.index).toBe(0);
    }
  });

  it("keeps every track exactly once when shuffling", () => {
    useLocalStore.setState({ playMode: "shuffle" });
    const q = useLocalStore.getState().buildQueue(1);
    expect(q.tracks).toHaveLength(library.length);
    expect(new Set(q.tracks.map((t) => t.videoId)).size).toBe(library.length);
  });

  it("wraps when shuffling, so a pass doesn't stop the music dead", () => {
    useLocalStore.setState({ playMode: "shuffle" });
    const q = useLocalStore.getState().buildQueue(0);
    expect(q.shuffle).toBe(true);
    expect(q.repeat).toBe("all");
  });

  it("clamps an out-of-range start", () => {
    expect(useLocalStore.getState().buildQueue(99).index).toBe(3);
    expect(useLocalStore.getState().buildQueue(-5).index).toBe(0);
  });

  it("returns an empty queue for an empty library", () => {
    useLocalStore.setState({ tracks: [] });
    expect(useLocalStore.getState().buildQueue(0).tracks).toEqual([]);
  });
});

describe("applyEvents", () => {
  it("drops the list when a rescan fails", () => {
    // The previous drive's ids are gone from the data plane's index, so
    // leaving them on screen would offer tracks that all 404 on tap.
    useLocalStore.getState().applyEvents([
      { type: "local:error", message: "No USB drive found." },
    ]);
    const s = useLocalStore.getState();
    expect(s.status).toBe("error");
    expect(s.tracks).toEqual([]);
    expect(s.source).toBeUndefined();
  });

  it("records scan progress", () => {
    useLocalStore.getState().applyEvents([
      { type: "local:progress", done: 12, total: 40 },
    ]);
    expect(useLocalStore.getState().progress).toEqual({ done: 12, total: 40 });
  });

  it("ignores events it doesn't own", () => {
    useLocalStore.getState().applyEvents([{ type: "pong", ts: 1 }]);
    expect(useLocalStore.getState().tracks).toEqual(library);
  });
});

import { describe, expect, it, beforeEach, vi } from "vitest";
import { useLocalStore, toTrack, visibleRows } from "@/store/localStore";
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

describe("visibleRows", () => {
  const big = Array.from({ length: 1200 }, (_, i) =>
    local(`loc${i}`, `Song ${i}`, i % 2 === 0 ? "Ada" : "Grace"),
  );

  it("caps what gets rendered but counts everything that matched", () => {
    const { rows, matched } = visibleRows(big, "", 500);
    expect(rows).toHaveLength(500);
    // The tab says "showing 500 of 1,200" off this number — capping it too
    // would hide the fact that anything is hidden.
    expect(matched).toBe(1200);
  });

  it("keeps each row's index into the FULL list, not the filtered one", () => {
    const { rows } = visibleRows(big, "Grace", 500);
    // Grace is every odd track, so the first match is index 1 — a filtered
    // index of 0 here would start playback on the wrong song.
    expect(rows[0].index).toBe(1);
    expect(rows[1].index).toBe(3);
    expect(rows[0].track.artist).toBe("Grace");
  });

  it("still maps correctly when the filter is narrow and deep in the list", () => {
    const { rows, matched } = visibleRows(big, "Song 1199", 500);
    expect(matched).toBe(1);
    expect(rows[0].index).toBe(1199);
    expect(big[rows[0].index].id).toBe(rows[0].track.id);
  });

  it("matches on artist as well as title, case-insensitively", () => {
    expect(visibleRows(big, "ada", 500).matched).toBe(600);
    // Substring, not exact: "Song 42" also matches "Song 420".."Song 429".
    expect(visibleRows(big, "SONG 42", 500).matched).toBe(11);
    expect(visibleRows(big, "SONG 1199", 500).matched).toBe(1);
  });

  it("returns nothing for a query that matches nothing", () => {
    const { rows, matched } = visibleRows(big, "nonexistent", 500);
    expect(rows).toHaveLength(0);
    expect(matched).toBe(0);
  });

  it("handles a library smaller than the window", () => {
    const { rows, matched } = visibleRows(library, "", 500);
    expect(rows).toHaveLength(4);
    expect(matched).toBe(4);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });
});

describe("a partial scan", () => {
  it("shows the restored list as ready and playable, not as a spinner", () => {
    useLocalStore.setState({ status: "scanning", tracks: [], updating: false });
    useLocalStore.getState().applyEvents([
      { type: "local:scanned", source: "USB3", tracks: library, partial: true },
    ]);
    const s = useLocalStore.getState();
    expect(s.status).toBe("ready");
    expect(s.tracks).toEqual(library);
    expect(s.updating).toBe(true);
  });

  it("clears the updating flag when the full list lands", () => {
    useLocalStore.setState({ updating: true });
    useLocalStore.getState().applyEvents([
      { type: "local:scanned", source: "USB3", tracks: library, partial: false },
    ]);
    expect(useLocalStore.getState().updating).toBe(false);
  });
});

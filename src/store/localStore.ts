import { create } from "zustand";
import { dispatch } from "@/bus/bus";
import type { AppEvent, LocalTrack } from "@/protocol";
import type { Track } from "@/store/playbackStore";

/**
 * The Library's Local tab — music on a USB stick.
 *
 * Deliberately NOT cached to localStorage, unlike Home's shelves. The list
 * is only meaningful while that exact drive is plugged in: painting a
 * remembered library for a stick that isn't there would offer tracks whose
 * every tap 404s.
 *
 * That is still true, and it is *not* what made rescanning expensive. The
 * cost was always re-reading tags, and that result is now kept on the Rust
 * side keyed by the drive's filesystem UUID
 * (`subsystems/local_index.rs`) — so a scan still happens on every mount,
 * proving the drive is really there, but an unchanged one spawns no
 * ffprobe at all and returns in well under a second.
 *
 * `playMode` is persisted, though — how you want a local playlist played
 * is a preference about you, not about the drive.
 */

export type LocalStatus = "idle" | "scanning" | "ready" | "error";

/**
 * How the Local tab plays its list.
 *
 * Kept separate from `playbackStore`'s global `shuffle`/`repeat` on
 * purpose: this is the mode a *playlist* is started in, chosen before
 * pressing play, whereas those two are live transport toggles the user
 * flips mid-song. Starting a shuffled play sets both, so the player bar
 * still tells the truth about what is happening.
 */
export type PlayMode = "normal" | "shuffle" | "repeat";

const MODE_KEY = "kl:local-play-mode";

function loadMode(): PlayMode {
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    if (raw === "shuffle" || raw === "repeat" || raw === "normal") return raw;
  } catch {
    /* private mode — fall through to the default */
  }
  return "normal";
}

function saveMode(mode: PlayMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* non-fatal — the mode still holds for this session */
  }
}

/** Fisher-Yates over a copy. */
function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * How many rows the tab puts in the DOM at once.
 *
 * The store holds the whole library — up to 50,000 tracks — because "Play
 * all" and shuffle have to cover the real drive. But `LocalTab` renders
 * with a plain `.map()` and no virtualisation, and 50,000 rows is 50,000
 * DOM nodes in a WebKitGTK view on a Pi, which is not a list, it is a
 * freeze. So the list is a window and the search box is how you reach past
 * it.
 */
export const LOCAL_ROW_LIMIT = 500;

/** One rendered row, carrying its index into the FULL track list. */
export type LocalRow = { track: LocalTrack; index: number };

/**
 * The rows to render for a query, each remembering where it came from.
 *
 * The index matters more than it looks: `buildQueue` takes a position in
 * the complete `tracks` array, so handing it the position within a
 * *filtered* list would start playback on a different song than the one
 * tapped — the exact bug the shuffle path already guards against.
 *
 * Pure, so both the filtering and that index mapping are testable without
 * a DOM.
 */
export function visibleRows(
  tracks: LocalTrack[],
  query: string,
  limit: number = LOCAL_ROW_LIMIT,
): { rows: LocalRow[]; matched: number } {
  const q = query.trim().toLowerCase();
  const rows: LocalRow[] = [];
  let matched = 0;

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (q && !`${t.title} ${t.artist}`.toLowerCase().includes(q)) continue;
    matched++;
    // Counting continues past the limit so the tab can say how many more
    // there are — "showing 500 of 12,000" is what tells someone to type
    // rather than to scroll looking for something that was never rendered.
    if (rows.length < limit) rows.push({ track: t, index: i });
  }

  return { rows, matched };
}

/** A scanned file as the playback queue wants it. */
export function toTrack(t: LocalTrack): Track {
  return {
    videoId: t.id,
    title: t.title,
    subtitle: t.artist || undefined,
    duration: t.duration || undefined,
  };
}

interface LocalState {
  status: LocalStatus;
  tracks: LocalTrack[];
  /** Which drive the list came from, for the tab header. */
  source?: string;
  error?: string;
  progress: { done: number; total: number };
  /** Tags are still being read for files the index didn't already know,
   *  while `tracks` is already showing and playable. */
  updating: boolean;
  playMode: PlayMode;

  /** Ask the data plane to (mount and) scan a removable drive. */
  scan: () => void;
  setPlayMode: (mode: PlayMode) => void;
  /**
   * Build the queue for a play action and hand back what the playback
   * store needs: the ordered tracks, where to start, and the transport
   * flags the chosen mode implies.
   *
   * Pure, so the ordering rules are testable without a store or a DOM.
   */
  buildQueue: (startIndex: number) => {
    tracks: Track[];
    index: number;
    shuffle: boolean;
    repeat: "off" | "all" | "one";
  };

  applyEvents: (events: AppEvent[]) => void;
}

export const useLocalStore = create<LocalState>((set, get) => ({
  status: "idle",
  tracks: [],
  progress: { done: 0, total: 0 },
  updating: false,
  playMode: loadMode(),

  scan: () => {
    set({
      status: "scanning",
      error: undefined,
      progress: { done: 0, total: 0 },
      updating: false,
    });
    dispatch({ type: "local:scan" });
  },

  setPlayMode: (playMode) => {
    saveMode(playMode);
    set({ playMode });
  },

  buildQueue: (startIndex) => {
    const { tracks, playMode } = get();
    const all = tracks.map(toTrack);
    if (all.length === 0) {
      return { tracks: [], index: 0, shuffle: false, repeat: "off" };
    }

    if (playMode === "shuffle") {
      // The tapped track still plays FIRST, with everything else shuffled
      // behind it. Shuffling the whole list including the tap would mean
      // pressing a song and hearing a different one, which reads as a bug
      // no matter what mode is selected.
      const picked = all[startIndex];
      const rest = shuffled(all.filter((_, i) => i !== startIndex));
      return {
        tracks: [picked, ...rest],
        index: 0,
        shuffle: true,
        // Shuffle without wrap stops dead at the end of one pass, which is
        // not what anyone means by "shuffle play" in a car.
        repeat: "all",
      };
    }

    return {
      tracks: all,
      index: Math.max(0, Math.min(startIndex, all.length - 1)),
      shuffle: false,
      repeat: playMode === "repeat" ? "all" : "off",
    };
  },

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "local:scanning":
          set({ status: "scanning", error: undefined });
          break;
        case "local:progress":
          set({ progress: { done: e.done, total: e.total } });
          break;
        case "local:scanned":
          set({
            status: "ready",
            tracks: e.tracks,
            source: e.source,
            error: undefined,
            // A partial list is the saved index restored: usable now, with
            // the changed files still being read behind it. Keeping the
            // status at "ready" is the point — the tab renders the list
            // rather than a spinner, and `updating` is what drives the
            // small progress line above it.
            updating: e.partial,
          });
          break;
        case "local:error":
          // A failed rescan clears the list rather than leaving the
          // previous drive's tracks on screen: those ids are no longer in
          // the data plane's index, so every one of them would 404 on tap.
          set({
            status: "error",
            error: e.message,
            tracks: [],
            source: undefined,
            updating: false,
          });
          break;
        default:
          break;
      }
    }
  },
}));

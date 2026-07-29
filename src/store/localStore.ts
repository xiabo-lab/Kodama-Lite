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
 * every tap 404s. A scan is cheap and explicit instead.
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
  playMode: loadMode(),

  scan: () => {
    set({ status: "scanning", error: undefined, progress: { done: 0, total: 0 } });
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
          });
          break;
        case "local:error":
          // A failed rescan clears the list rather than leaving the
          // previous drive's tracks on screen: those ids are no longer in
          // the data plane's index, so every one of them would 404 on tap.
          set({ status: "error", error: e.message, tracks: [], source: undefined });
          break;
        default:
          break;
      }
    }
  },
}));

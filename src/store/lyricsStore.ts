import { create } from "zustand";
import { dispatchContent, type ContentEvent } from "@/lib/network";
import { pickBest, SOURCE_ORDER, type LyricsSource } from "@/lib/lyrics/sources";
import type { Lyrics } from "@/lib/lyrics/types";
import type { FeedStatus } from "@/store/homeStore";

/** "auto" defers to `pickBest`; anything else pins that provider. */
export type SourceChoice = LyricsSource | "auto";

const CHOICE_STORAGE_KEY = "kl:lyrics-source";

function emptySources(): Record<LyricsSource, Lyrics | null> {
  const out = {} as Record<LyricsSource, Lyrics | null>;
  for (const s of SOURCE_ORDER) out[s] = null;
  return out;
}

/** The picked source is a standing preference, not a per-track one — you
 *  pick LRCLIB because you like its timings, and you mean it for the next
 *  song too. Persisted for the same reason. */
function loadChoice(): SourceChoice {
  try {
    const raw = window.localStorage.getItem(CHOICE_STORAGE_KEY);
    if (raw === "auto") return "auto";
    if (raw && (SOURCE_ORDER as string[]).includes(raw)) return raw as LyricsSource;
  } catch {
    /* private mode etc — fall through to auto */
  }
  return "auto";
}

function saveChoice(choice: SourceChoice): void {
  try {
    window.localStorage.setItem(CHOICE_STORAGE_KEY, choice);
  } catch {
    /* non-fatal — the choice still holds for this session */
  }
}

/**
 * Resolve what to actually display. A pinned source that has nothing for
 * *this* track silently falls back to the auto-pick rather than showing
 * "No lyrics found": the preference is "prefer LRCLIB", not "show me
 * nothing unless it's LRCLIB", and the picker still marks which sources
 * are unavailable so the fallback isn't a mystery.
 */
function resolve(
  sources: Record<LyricsSource, Lyrics | null>,
  choice: SourceChoice,
): Lyrics | null {
  if (choice !== "auto") {
    const pinned = sources[choice];
    if (pinned) return pinned;
  }
  return pickBest(sources);
}

interface LyricsState {
  videoId?: string;
  status: FeedStatus;
  /** Every provider's result for the current track — `null` where that
   *  provider had nothing or failed. Drives the picker's availability
   *  markers as well as the switch itself. */
  sources: Record<LyricsSource, Lyrics | null>;
  choice: SourceChoice;
  /** What the views render: `resolve(sources, choice)`. Derived, but kept
   *  in state so `LyricsBody` stays a one-line subscription. */
  lyrics: Lyrics | null;
  error?: string;
  /** Fetch lyrics for a track. Call whenever the current track changes;
   *  a no-op if it's already loading/loaded for this exact videoId. */
  load: (params: {
    videoId: string;
    title: string;
    artist?: string;
    album?: string;
    duration?: number;
  }) => void;
  /** Switch providers. Local and instant — every source was already
   *  fetched for this track, so nothing goes back over the network. */
  setChoice: (choice: SourceChoice) => void;
  applyEvents: (events: ContentEvent[]) => void;
}

export const useLyricsStore = create<LyricsState>((set, get) => ({
  status: "idle",
  sources: emptySources(),
  choice: loadChoice(),
  lyrics: null,

  load: (params) => {
    if (get().videoId === params.videoId && get().status !== "idle") return;
    set({
      videoId: params.videoId,
      status: "loading",
      sources: emptySources(),
      lyrics: null,
      error: undefined,
    });
    dispatchContent({ type: "lyrics:load", ...params });
  },

  setChoice: (choice) => {
    saveChoice(choice);
    set({ choice, lyrics: resolve(get().sources, choice) });
  },

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "lyrics:loading":
          if (get().videoId === e.videoId) set({ status: "loading" });
          break;
        case "lyrics:loaded":
          if (get().videoId === e.videoId) {
            set({
              status: "ready",
              sources: e.sources,
              lyrics: resolve(e.sources, get().choice),
              error: undefined,
            });
          }
          break;
        case "lyrics:error":
          if (get().videoId === e.videoId) {
            set({
              status: "error",
              sources: emptySources(),
              lyrics: null,
              error: e.message,
            });
          }
          break;
        default:
          break;
      }
    }
  },
}));

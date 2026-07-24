import { create } from "zustand";
import { dispatchContent, type ContentEvent } from "@/lib/network";
import type { Lyrics } from "@/lib/lyrics/types";
import type { FeedStatus } from "@/store/homeStore";

interface LyricsState {
  videoId?: string;
  status: FeedStatus;
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
  applyEvents: (events: ContentEvent[]) => void;
}

export const useLyricsStore = create<LyricsState>((set, get) => ({
  status: "idle",
  lyrics: null,

  load: (params) => {
    if (get().videoId === params.videoId && get().status !== "idle") return;
    set({ videoId: params.videoId, status: "loading", lyrics: null, error: undefined });
    dispatchContent({ type: "lyrics:load", ...params });
  },

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "lyrics:loading":
          if (get().videoId === e.videoId) set({ status: "loading" });
          break;
        case "lyrics:loaded":
          if (get().videoId === e.videoId) {
            set({ status: "ready", lyrics: e.lyrics, error: undefined });
          }
          break;
        case "lyrics:error":
          if (get().videoId === e.videoId) {
            set({ status: "error", lyrics: null, error: e.message });
          }
          break;
        default:
          break;
      }
    }
  },
}));

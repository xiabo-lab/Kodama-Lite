import { create } from "zustand";
import type { ContentEvent } from "@/lib/network";
import type { ShelfItem } from "@/lib/innertube/types";
import type { PlaylistFirstPage } from "@/lib/innertube/playlist";
import type { FeedStatus } from "@/store/homeStore";

interface PlaylistEntry {
  status: FeedStatus;
  page?: PlaylistFirstPage;
  tracks: ShelfItem[];
  nextCursor?: string;
  error?: string;
}

interface PlaylistState {
  /** Keyed by playlist id — a user visiting several playlists in a
   *  session keeps each one's scroll-loaded tracks cached instead of
   *  re-fetching from scratch on every back-navigation. */
  byId: Record<string, PlaylistEntry>;
  /**
   * Fold a like/unlike into a cached Liked Music page.
   *
   * `LM` is YouTube Music's magic id for Liked Music, and it's cached here
   * like any other playlist — so after the first visit it kept showing the
   * list it loaded, and a track liked afterwards only appeared on restart.
   * Both spellings are patched: the page is fetched as `LM`, but the
   * Library links to it by its browse id `VLLM`.
   */
  applyLikeChange: (track: ShelfItem, liked: boolean) => void;
  applyEvents: (events: ContentEvent[]) => void;
}

/** The ids Liked Music can be cached under. */
const LIKED_IDS = ["LM", "VLLM"];

export const usePlaylistStore = create<PlaylistState>((set, get) => ({
  byId: {},

  applyLikeChange: (track, liked) => {
    const byId = get().byId;
    const next = { ...byId };
    let touched = false;
    for (const id of LIKED_IDS) {
      const cur = next[id];
      if (!cur) continue;
      const without = cur.tracks.filter((t) => t.id !== track.id);
      next[id] = { ...cur, tracks: liked ? [track, ...without] : without };
      touched = true;
    }
    if (touched) set({ byId: next });
  },

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "playlist:loading": {
          const byId = get().byId;
          const cur = byId[e.id];
          set({
            byId: {
              ...byId,
              [e.id]: cur ?? { status: "loading", tracks: [] },
            },
          });
          break;
        }
        case "playlist:loaded":
          set({
            byId: {
              ...get().byId,
              [e.id]: {
                status: "ready",
                page: e.page,
                tracks: e.page.tracks,
                nextCursor: e.page.continuationToken,
                error: undefined,
              },
            },
          });
          break;
        case "playlist:more:loaded": {
          const byId = get().byId;
          const cur = byId[e.id];
          if (!cur) break;
          set({
            byId: {
              ...byId,
              [e.id]: {
                ...cur,
                tracks: [...cur.tracks, ...e.tracks],
                nextCursor: e.nextCursor,
              },
            },
          });
          break;
        }
        case "playlist:error": {
          const byId = get().byId;
          const cur = byId[e.id];
          set({
            byId: {
              ...byId,
              [e.id]: { ...cur, status: "error", tracks: cur?.tracks ?? [], error: e.message },
            },
          });
          break;
        }
        default:
          break;
      }
    }
  },
}));

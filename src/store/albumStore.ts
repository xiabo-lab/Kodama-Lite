import { create } from "zustand";
import type { ContentEvent } from "@/lib/network";
import type { AlbumPage } from "@/lib/innertube/types";
import type { FeedStatus } from "@/store/homeStore";

interface AlbumEntry {
  status: FeedStatus;
  page?: AlbumPage;
  error?: string;
}

interface AlbumState {
  byId: Record<string, AlbumEntry>;
  applyEvents: (events: ContentEvent[]) => void;
}

export const useAlbumStore = create<AlbumState>((set, get) => ({
  byId: {},

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "album:loading": {
          const byId = get().byId;
          set({ byId: { ...byId, [e.id]: byId[e.id] ?? { status: "loading" } } });
          break;
        }
        case "album:loaded":
          set({
            byId: { ...get().byId, [e.id]: { status: "ready", page: e.page } },
          });
          break;
        case "album:error": {
          const byId = get().byId;
          const cur = byId[e.id];
          set({
            byId: {
              ...byId,
              [e.id]: { ...cur, status: "error", error: e.message },
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

import { create } from "zustand";
import type { ContentEvent } from "@/lib/network";
import type { ArtistPage } from "@/lib/innertube/types";
import type { FeedStatus } from "@/store/homeStore";

interface ArtistEntry {
  status: FeedStatus;
  page?: ArtistPage;
  error?: string;
}

interface ArtistState {
  byId: Record<string, ArtistEntry>;
  applyEvents: (events: ContentEvent[]) => void;
}

export const useArtistStore = create<ArtistState>((set, get) => ({
  byId: {},

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "artist:loading": {
          const byId = get().byId;
          set({ byId: { ...byId, [e.id]: byId[e.id] ?? { status: "loading" } } });
          break;
        }
        case "artist:loaded":
          set({
            byId: { ...get().byId, [e.id]: { status: "ready", page: e.page } },
          });
          break;
        case "artist:error": {
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

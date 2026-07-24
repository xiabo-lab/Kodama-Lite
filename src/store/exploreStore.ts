import { create } from "zustand";
import type { ContentEvent, ExploreFeed } from "@/lib/network";
import type { Shelf } from "@/lib/innertube/types";
import type { FeedStatus } from "@/store/homeStore";

interface FeedState {
  status: FeedStatus;
  shelves: Shelf[];
  nextCursor?: string;
  error?: string;
}

const EMPTY: FeedState = { status: "idle", shelves: [] };

interface ExploreState {
  feeds: Record<ExploreFeed, FeedState>;
  applyEvents: (events: ContentEvent[]) => void;
}

const initialFeeds: Record<ExploreFeed, FeedState> = {
  explore: { ...EMPTY },
  charts: { ...EMPTY },
  newReleases: { ...EMPTY },
  moods: { ...EMPTY },
};

/**
 * Explore's four sub-feeds (Explore, Charts, New releases, Moods & genres)
 * share one store keyed by feed — same cache-first shape as `homeStore`,
 * just fanned out over four slots instead of one. No disk persistence for
 * these (Home is the one feed worth surviving a cold boot); a Phase-4-ish
 * follow-up could extend the pattern if that turns out to matter.
 */
export const useExploreStore = create<ExploreState>((set, get) => ({
  feeds: initialFeeds,

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "explore:loading": {
          const feeds = get().feeds;
          const cur = feeds[e.feed];
          set({
            feeds: {
              ...feeds,
              [e.feed]: { ...cur, status: cur.shelves.length ? "ready" : "loading" },
            },
          });
          break;
        }
        case "explore:loaded": {
          const feeds = get().feeds;
          const cur = feeds[e.feed];
          set({
            feeds: {
              ...feeds,
              [e.feed]: {
                status: "ready",
                shelves: e.append ? [...cur.shelves, ...e.shelves] : e.shelves,
                nextCursor: e.nextCursor,
                error: undefined,
              },
            },
          });
          break;
        }
        case "explore:error": {
          const feeds = get().feeds;
          const cur = feeds[e.feed];
          set({
            feeds: {
              ...feeds,
              [e.feed]: {
                ...cur,
                status: cur.shelves.length ? "ready" : "error",
                error: e.message,
              },
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

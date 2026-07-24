import { create } from "zustand";
import { dispatchContent, type ContentEvent } from "@/lib/network";
import type { SearchFilter } from "@/lib/innertube/search";
import type { SearchResults } from "@/lib/innertube/types";
import type { FeedStatus } from "@/store/homeStore";

interface SearchState {
  query: string;
  filter: SearchFilter;
  status: FeedStatus;
  results: SearchResults;
  error?: string;
  /** Dispatches `search:query` for the given text/filter and updates the
   *  store's notion of "what search is this?" so late results can be
   *  ignored if the user has since typed something else. */
  search: (query: string, filter?: SearchFilter) => void;
  setFilter: (filter: SearchFilter) => void;
  applyEvents: (events: ContentEvent[]) => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: "",
  filter: "all",
  status: "idle",
  results: { query: "", shelves: [] },

  search: (query, filter) => {
    const f = filter ?? get().filter;
    set({ query, filter: f });
    dispatchContent({ type: "search:query", query, filter: f });
  },

  setFilter: (filter) => {
    const { query } = get();
    set({ filter });
    if (query.trim()) dispatchContent({ type: "search:query", query, filter });
  },

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "search:loading": {
          const s = get();
          // Ignore a loading flag for a query/filter combo we've since
          // moved on from (fast typing outracing the previous request).
          if (s.query !== e.query || s.filter !== e.filter) break;
          set({ status: "loading" });
          break;
        }
        case "search:loaded": {
          const s = get();
          if (s.query !== e.query || s.filter !== e.filter) break;
          set({ status: "ready", results: e.results, error: undefined });
          break;
        }
        case "search:error": {
          const s = get();
          if (s.query !== e.query || s.filter !== e.filter) break;
          set({ status: "error", error: e.message });
          break;
        }
        default:
          break;
      }
    }
  },
}));

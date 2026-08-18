import { create } from "zustand";
import type { ContentEvent } from "@/lib/network";
import type { Shelf } from "@/lib/innertube/types";

export type FeedStatus = "idle" | "loading" | "ready" | "error";

interface HomeState {
  status: FeedStatus;
  shelves: Shelf[];
  /** true when the shown data is from cache and a revalidate is pending
   *  or failed. */
  stale: boolean;
  /** A revalidate is in flight *right now*.
   *
   *  Distinct from `status === "loading"`, which is deliberately only ever
   *  true when there is nothing cached to paint — the whole cache-first
   *  design is that a refresh must not blank the screen. That leaves a
   *  manual refresh with no way to show it is doing anything, so the
   *  button spins on this instead. */
  refreshing: boolean;
  error?: string;
  applyEvents: (events: ContentEvent[]) => void;
}

const HOME_CACHE_KEY = "kl:home";

function loadCache(): Shelf[] {
  try {
    const raw = localStorage.getItem(HOME_CACHE_KEY);
    if (raw) return JSON.parse(raw) as Shelf[];
  } catch {
    /* corrupt cache — boot empty */
  }
  return [];
}

function saveCache(shelves: Shelf[]): void {
  try {
    localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(shelves));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

export const useHomeStore = create<HomeState>((set, get) => {
  const cached = loadCache();
  return {
    // Cached data boots as "ready" and "stale": the screen paints
    // immediately, and a background revalidate refreshes it.
    status: cached.length ? "ready" : "idle",
    shelves: cached,
    stale: cached.length > 0,
    refreshing: false,

    applyEvents: (events) => {
      for (const e of events) {
        switch (e.type) {
          case "home:loading": {
            const s = get();
            // Keep showing cached shelves; only show a spinner when there's
            // genuinely nothing to show yet.
            set({ status: s.shelves.length ? "ready" : "loading", refreshing: true });
            break;
          }
          case "home:loaded":
            set({
              status: "ready",
              shelves: e.shelves,
              stale: false,
              refreshing: false,
              error: undefined,
            });
            saveCache(e.shelves);
            break;
          case "home:error": {
            const s = get();
            // An error never blanks the screen: with cache, keep it and
            // just mark it stale; only surface an error with no cache.
            if (s.shelves.length) {
              set({ status: "ready", stale: true, refreshing: false, error: e.message });
            } else {
              set({ status: "error", refreshing: false, error: e.message });
            }
            break;
          }
          default:
            break;
        }
      }
    },
  };
});

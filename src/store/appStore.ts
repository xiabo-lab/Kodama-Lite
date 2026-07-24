import { create } from "zustand";
import type { AppEvent } from "@/protocol";

/**
 * App-level Store slice: connectivity + navigation. Content data (home,
 * explore, search, playlist/album/artist pages, lyrics) lives in its own
 * per-domain store — see `store/homeStore.ts` etc. — each with the exact
 * same cache-first, event-driven shape this one pioneered in Phase 1.
 */

export type Route =
  | { kind: "home" }
  | { kind: "explore" }
  | { kind: "search" }
  | { kind: "library" }
  | { kind: "playlist"; id: string }
  | { kind: "album"; id: string }
  | { kind: "artist"; id: string };

const MAX_HISTORY = 50;

export interface AppState {
  online: boolean;
  /** In-memory back/forward stack — `history[index]` is the current
   *  route. No History API integration (no URLs to bookmark on a Pi
   *  kiosk); this is enough for the TopBar's back/forward buttons and
   *  the sidebar/card navigation to feel like a real app. */
  history: Route[];
  index: number;
  route: Route;
  navigate: (route: Route) => void;
  back: () => void;
  forward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  applyEvents: (events: AppEvent[]) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  online: true,
  history: [{ kind: "home" }],
  index: 0,
  route: { kind: "home" },

  navigate: (route) =>
    set((s) => {
      // Re-navigating to the exact same route (e.g. clicking Home while
      // already there) is a no-op — don't pollute the history stack.
      const current = s.history[s.index];
      if (
        current.kind === route.kind &&
        (!("id" in current) || current.id === (route as { id?: string }).id)
      ) {
        return {};
      }
      const truncated = s.history.slice(0, s.index + 1);
      const history = [...truncated, route].slice(-MAX_HISTORY);
      return { history, index: history.length - 1, route };
    }),

  back: () =>
    set((s) => {
      if (s.index <= 0) return {};
      const index = s.index - 1;
      return { index, route: s.history[index] };
    }),

  forward: () =>
    set((s) => {
      if (s.index >= s.history.length - 1) return {};
      const index = s.index + 1;
      return { index, route: s.history[index] };
    }),

  canGoBack: () => get().index > 0,
  canGoForward: () => get().index < get().history.length - 1,

  applyEvents: (events) => {
    for (const e of events) {
      if (e.type === "net:status") {
        set({ online: e.online });
      }
    }
  },
}));

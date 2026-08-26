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
  | { kind: "settings" }
  | { kind: "playlist"; id: string }
  | { kind: "album"; id: string }
  | { kind: "artist"; id: string };

const MAX_HISTORY = 50;

const SIDEBAR_STORAGE_KEY = "kl:sidebar-collapsed";

/** The collapsed/expanded rail is a deliberate, sticky user choice (on a
 *  440px-tall bar panel the extra 144px of width matters), so it outlives
 *  a reload. Same tiny localStorage pattern the InnerTube visitor token
 *  uses — a private-mode throw just degrades to the default. */
function loadSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    /* private mode etc — the in-memory value still applies this session */
  }
}

export interface AppState {
  online: boolean;
  /** Whether a reachability probe has actually answered yet. `online`
   *  starts optimistically `true` so a cold boot doesn't flash an offline
   *  banner before the first probe returns — which means `online === true`
   *  on its own can't distinguish "the internet answered" from "nobody has
   *  asked yet". Anything that must wait for a *confirmed* connection
   *  (resume-on-startup) checks this too. */
  netChecked: boolean;
  /** Where cover art is fetched from — the local server's `/cover`
   *  endpoint, which caches to disk. Undefined until `cover:base` answers,
   *  and `Thumbnail` falls back to the CDN directly in the meantime, so a
   *  data plane that never answers costs the cache and not the artwork. */
  coverBase?: string;
  /** Bumped every time connectivity is regained.
   *
   *  `Thumbnail` remembers which image URL failed so it doesn't retry a
   *  dead request on every render — but the URL never changes, and the
   *  carousel keys items by `kind:id`, so React keeps the same component
   *  instance across a feed refresh and the remembered failure with it.
   *  A tile that missed the boot window therefore stayed a grey glyph for
   *  the rest of the session, on a screen that had long since come back
   *  online. Including this counter in that memory is what expires it:
   *  the network coming back is the one event that makes a previous
   *  failure worth re-testing. */
  netEpoch: number;
  /** Sidebar rail state: `true` renders the icon-only rail. Toggled by the
   *  title bar's panel button. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
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
  netChecked: false,
  netEpoch: 0,
  history: [{ kind: "home" }],
  index: 0,
  route: { kind: "home" },
  sidebarCollapsed: loadSidebarCollapsed(),

  toggleSidebar: () =>
    set((s) => {
      const sidebarCollapsed = !s.sidebarCollapsed;
      saveSidebarCollapsed(sidebarCollapsed);
      return { sidebarCollapsed };
    }),

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
        // Only the offline→online edge bumps the epoch. Bumping on every
        // probe would re-attempt every failed image every 20 seconds for
        // the whole of an outage, which is the opposite of what the
        // memory is for.
        const regained = e.online && !get().online;
        set((s) => ({
          online: e.online,
          netChecked: true,
          netEpoch: regained ? s.netEpoch + 1 : s.netEpoch,
        }));
      } else if (e.type === "cover:base") {
        set({ coverBase: e.url });
      }
    }
  },
}));

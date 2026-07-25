import { create } from "zustand";
import type { ContentEvent, LibraryTab } from "@/lib/network";
import type { LibrarySection } from "@/lib/innertube/library";
import type { ShelfItem } from "@/lib/innertube/types";
import type { FeedStatus } from "@/store/homeStore";

/**
 * Library — one slot per tab, same cache-first, event-driven shape as
 * `exploreStore`: switching tabs is instant, each tab keeps whatever it
 * last loaded, and a failure never blanks a tab that already has content.
 *
 * Deliberately NOT persisted to localStorage, unlike Home's shelves. This
 * is per-account data: caching it to disk would mean the previous user's
 * playlists painting on the first frame after someone else signs in.
 * `reset()` clears it whenever the session changes.
 */

interface TabState {
  status: FeedStatus;
  sections: LibrarySection[];
  tracks: ShelfItem[];
  error?: string;
}

const EMPTY_TAB: TabState = { status: "idle", sections: [], tracks: [] };

export const LIBRARY_TABS: { id: LibraryTab; label: string }[] = [
  { id: "playlists", label: "Playlists" },
  { id: "songs", label: "Songs" },
  { id: "albums", label: "Albums" },
  { id: "artists", label: "Artists" },
];

interface LibraryState {
  tabs: Record<LibraryTab, TabState>;
  /** Drop everything — called on sign-in and sign-out. */
  reset: () => void;
  applyEvents: (events: ContentEvent[]) => void;
}

function emptyTabs(): Record<LibraryTab, TabState> {
  return {
    playlists: EMPTY_TAB,
    songs: EMPTY_TAB,
    albums: EMPTY_TAB,
    artists: EMPTY_TAB,
  };
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tabs: emptyTabs(),

  reset: () => set({ tabs: emptyTabs() }),

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "library:loading": {
          const prev = get().tabs[e.tab];
          set((s) => ({
            tabs: {
              ...s.tabs,
              // Keep showing what's there; only spin when there's nothing.
              [e.tab]: {
                ...prev,
                status:
                  prev.sections.length || prev.tracks.length
                    ? "ready"
                    : "loading",
              },
            },
          }));
          break;
        }
        case "library:loaded":
          set((s) => ({
            tabs: {
              ...s.tabs,
              [e.tab]: {
                status: "ready",
                sections: e.sections,
                tracks: e.tracks,
                error: undefined,
              },
            },
          }));
          break;
        case "library:error": {
          const prev = get().tabs[e.tab];
          const hasContent = prev.sections.length > 0 || prev.tracks.length > 0;
          set((s) => ({
            tabs: {
              ...s.tabs,
              [e.tab]: {
                ...prev,
                // An error never wipes a tab that already loaded — same
                // rule the content feeds follow.
                status: hasContent ? "ready" : "error",
                error: e.message,
              },
            },
          }));
          break;
        }
        default:
          break;
      }
    }
  },
}));

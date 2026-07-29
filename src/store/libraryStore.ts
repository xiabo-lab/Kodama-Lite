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

/**
 * `local` is a tab of this screen but NOT of this store: it holds music
 * from a USB drive, has no account behind it, and is owned by
 * `localStore`. It is listed here only because the tab strip is one
 * control and has to render in one order — Local last, under Artists.
 */
export const LIBRARY_TABS: { id: LibraryTab | "local"; label: string }[] = [
  { id: "playlists", label: "Playlists" },
  { id: "songs", label: "Songs" },
  { id: "albums", label: "Albums" },
  { id: "artists", label: "Artists" },
  { id: "local", label: "Local" },
];

interface LibraryState {
  tabs: Record<LibraryTab, TabState>;
  /** Drop everything — called on sign-in and sign-out. */
  reset: () => void;
  /**
   * Fold a like/unlike into the already-loaded Songs tab.
   *
   * The Library only fetches a tab whose status is still `idle`, so once
   * Songs had loaded it kept the list it was born with: liking a track
   * reached the account (verified in the phone app) but the Liked Songs
   * list here did not move until a restart. Patching the loaded list is
   * what makes the change show at the moment of the tap, rather than
   * refiring a ~100-track browse on every heart press.
   *
   * A tab that hasn't loaded is left alone — it will fetch the truth when
   * it's first opened, and seeding it here would strand a one-row list
   * looking like a complete library.
   */
  applyLikeChange: (track: ShelfItem, liked: boolean) => void;
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

  applyLikeChange: (track, liked) => {
    const songs = get().tabs.songs;
    if (songs.status === "idle") return;
    const without = songs.tracks.filter((t) => t.id !== track.id);
    // Newest-first, which is the order YouTube Music returns Liked Music
    // in — so an insert at the front is where the server will put it too.
    const tracks = liked ? [track, ...without] : without;
    set((s) => ({
      tabs: { ...s.tabs, songs: { ...s.tabs.songs, tracks } },
    }));
  },

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

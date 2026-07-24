import { create } from "zustand";

/**
 * Local-only "liked songs" — a client-side heart toggle, not a sync with
 * the user's real YouTube Music account. Liking a track there requires a
 * signed-in cookie session (`likeTrack`/`removeRating` in YTMLite's
 * `lib/innertube/mutations.ts`), and Kodama-Lite has no accounts/sign-in
 * subsystem yet (`authHeaders()` is stubbed to `{}` — see
 * `src/lib/innertube/shared.ts`). Rather than a like button that silently
 * fails against an unauthenticated request, this persists the liked set
 * to localStorage so the heart still does something real (toggles,
 * survives a restart) until accounts land and this can be swapped for
 * the genuine server-synced version.
 */
interface LikedSongsState {
  ids: Set<string>;
  isLiked: (videoId: string) => boolean;
  toggle: (videoId: string) => void;
}

const STORAGE_KEY = "kl:liked-songs";

function loadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* corrupt cache — start empty */
  }
  return new Set();
}

function saveIds(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* quota / private mode — non-fatal, in-memory state still works */
  }
}

export const useLikedSongsStore = create<LikedSongsState>((set, get) => ({
  ids: loadIds(),

  isLiked: (videoId) => get().ids.has(videoId),

  toggle: (videoId) => {
    const ids = new Set(get().ids);
    if (ids.has(videoId)) ids.delete(videoId);
    else ids.add(videoId);
    saveIds(ids);
    set({ ids });
  },
}));

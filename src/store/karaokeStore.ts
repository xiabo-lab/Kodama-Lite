import { create } from "zustand";

/** Whether the full-screen karaoke lyrics overlay is open. Its own tiny
 *  store (rather than a field on `playbackStore`) so opening/closing it
 *  never touches anything playback-related. */
interface KaraokeState {
  open: boolean;
  setOpen: (open: boolean) => void;
  /**
   * Whether the Search Lyrics screen is up over the stage.
   *
   * This lived in `LyricsSearchButton` as a local `useState`, mirrored into
   * a second `useState` in the karaoke view so the stage could narrow its
   * lyrics column while it was open. Two copies of one fact, and neither
   * reachable from outside React — which is what a spoken "search lyric"
   * needs, since `voiceControl` may only go through the same store action
   * the button calls. One flag here, read by both.
   */
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
}

export const useKaraokeStore = create<KaraokeState>((set) => ({
  open: false,
  setOpen: (open) =>
    // The search screen belongs to the stage. Leaving it flagged open after
    // the stage closes would put it straight back up on the next "karaoke".
    set(open ? { open } : { open, searchOpen: false }),
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}));

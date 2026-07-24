import { create } from "zustand";

/** Whether the full-screen karaoke lyrics overlay is open. Its own tiny
 *  store (rather than a field on `playbackStore`) so opening/closing it
 *  never touches anything playback-related. */
interface KaraokeState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useKaraokeStore = create<KaraokeState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

import { create } from "zustand";

/** Whether the queue panel popover is open — its own tiny store, same
 *  rationale as `karaokeStore`. */
interface QueuePanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useQueuePanelStore = create<QueuePanelState>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
}));

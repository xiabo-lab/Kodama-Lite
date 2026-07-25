import { create } from "zustand";
import { dispatch } from "@/bus/bus";
import type { AppEvent } from "@/protocol";

/**
 * Audio-cache inventory, mirrored from the data plane. The cache itself
 * has always existed — the stream server writes every played track to
 * disk and serves later plays from it — so this store isn't what makes
 * offline replay work; it's what makes it *visible* and clearable.
 */
export interface CacheState {
  /** `undefined` until the first `cache:stats` event lands. */
  count?: number;
  bytes?: number;
  dir?: string;
  loading: boolean;
  refresh: () => void;
  clear: () => void;
  applyEvents: (events: AppEvent[]) => void;
}

export const useCacheStore = create<CacheState>((set) => ({
  loading: false,

  refresh: () => {
    set({ loading: true });
    dispatch({ type: "cache:stats" });
  },

  clear: () => {
    set({ loading: true });
    // The data plane answers a clear with fresh stats, so there's no
    // separate "cleared" event to handle — the numbers just drop to zero.
    dispatch({ type: "cache:clear" });
  },

  applyEvents: (events) => {
    for (const e of events) {
      if (e.type === "cache:stats") {
        set({ count: e.count, bytes: e.bytes, dir: e.dir, loading: false });
      }
    }
  },
}));

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

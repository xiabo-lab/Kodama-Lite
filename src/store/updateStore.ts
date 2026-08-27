import { create } from "zustand";
import { dispatch } from "@/bus/bus";
import type { AppEvent, UpdatePhase } from "@/protocol";

/**
 * The in-app updater's progress, mirrored from the data plane's
 * `subsystems/update.rs`. All the work happens there; this store exists
 * so the About row can say which step it is on.
 *
 * Not persisted, and reset to `idle` on every launch — after a successful
 * update the app is restarted by systemd, so the very next thing this
 * store sees is a fresh process running the new version. Carrying
 * "installing" across that restart would be a lie.
 */
export interface UpdateStoreState {
  /** `idle` until the user presses the button for the first time. */
  phase: UpdatePhase | "idle";
  /** The version `phase` is about — installed for `up-to-date`, incoming
   *  for everything after it. */
  version?: string;
  /** Only ever set alongside `error`. */
  message?: string;
  check: () => void;
  applyEvents: (events: AppEvent[]) => void;
}

/** Phases where a run is in flight, so the button should not be pressable
 *  again. `restarting` counts: the process is about to be killed, and a
 *  second press in that window would start a fresh check against a
 *  version that is already installed. */
export const UPDATE_BUSY_PHASES: readonly (UpdatePhase | "idle")[] = [
  "checking",
  "downloading",
  "installing",
  "restarting",
];

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  phase: "idle",

  check: () => {
    // Optimistic, for the same reason the data plane emits `checking`
    // itself: the round trip is short but not free, and the button has to
    // stop looking pressable the instant it is pressed. The event that
    // follows sets the same phase again, harmlessly.
    set({ phase: "checking", version: undefined, message: undefined });
    dispatch({ type: "update:check" });
  },

  applyEvents: (events) => {
    for (const e of events) {
      if (e.type === "update:state") {
        set({ phase: e.phase, version: e.version, message: e.message });
      }
    }
  },
}));

import { create } from "zustand";
import { dispatchContent, type ContentEvent } from "@/lib/network";
import { usePlaybackStore } from "@/store/playbackStore";
import { shelfItemToTrack } from "@/lib/track";

/**
 * Radio continuation, view-plane half. Holds no data of its own — a
 * station is appended to the queue and then forgotten — so this exists
 * purely to fold `radio:loaded` into `playbackStore` from inside the
 * normal batched event fan-out, rather than having the network layer
 * reach into the playback store directly.
 *
 * The `error` field is kept only so a failure is inspectable; nothing
 * renders it. A station that fails to load isn't worth interrupting
 * playback to report — the queue simply ends, exactly as it did before
 * this feature existed.
 */
interface RadioState {
  /** The seed we've asked for and not yet been refused. Dedupe lives here
   *  rather than in a ref inside the audio engine so that a FAILED station
   *  clears it — with the ref, one transient network error meant the queue
   *  ended and never extended again, however long you stayed on the
   *  track. */
  requestedSeed?: string;
  error?: string;
  request: (seed: string) => void;
  applyEvents: (events: ContentEvent[]) => void;
}

export const useRadioStore = create<RadioState>((set, get) => ({
  request: (seed) => {
    if (get().requestedSeed === seed) return;
    set({ requestedSeed: seed, error: undefined });
    dispatchContent({ type: "radio:load", videoId: seed });
  },

  applyEvents: (events) => {
    for (const e of events) {
      if (e.type === "radio:loaded") {
        const s = usePlaybackStore.getState();
        const current = s.index >= 0 ? s.queue[s.index]?.videoId : undefined;
        // Drop a stale station: the user may have started something else
        // while this was in flight, in which case these tracks have
        // nothing to do with what's playing now. Also require the seed to
        // still be *last* — if the queue grew meanwhile, appending would
        // bolt a station onto the middle of someone's album.
        if (current !== e.seed || s.index < s.queue.length - 1) continue;
        const tracks = e.tracks
          .filter((t) => t.id !== e.seed)
          .map(shelfItemToTrack);
        if (tracks.length) s.appendToQueue(tracks);
        set({ error: undefined });
      } else if (e.type === "radio:error") {
        // Clear the seed so the next render of the same last-in-queue
        // track tries again — a station that failed once is worth one more
        // attempt before the music simply stops.
        set({ requestedSeed: undefined, error: e.message });
      }
    }
  },
}));

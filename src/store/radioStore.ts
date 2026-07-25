import { create } from "zustand";
import type { ContentEvent } from "@/lib/network";
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
  error?: string;
  applyEvents: (events: ContentEvent[]) => void;
}

export const useRadioStore = create<RadioState>((set) => ({
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
        set({ error: e.message });
      }
    }
  },
}));

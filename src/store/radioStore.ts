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
 * renders it. A proactive station failure stays quiet while the current
 * song plays. If the queue is already exhausted, failures are retried in
 * the background until music can continue or the user pauses/navigates.
 */
interface RadioState {
  /** The seed we've asked for and not yet been refused. Dedupe lives here
   *  rather than in a ref inside the audio engine so that a FAILED station
   *  clears it — with the ref, one transient network error meant the queue
   *  ended and never extended again, however long you stayed on the
   *  track. */
  requestedSeed?: string;
  /** This seed exhausted the queue and must advance as soon as its radio
   *  tracks arrive. Distinct from a proactive request made while the last
   *  song is still playing. */
  pendingAdvance?: string;
  error?: string;
  request: (seed: string, advance?: boolean) => void;
  applyEvents: (events: ContentEvent[]) => void;
}

const RETRY_MS = 2_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export const useRadioStore = create<RadioState>((set, get) => {
  const cancelRetry = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  /** Keep trying only while this exact track is still waiting at the end
   *  and the user still wants playback. Pause, Previous, or choosing
   *  another song cancels the condition without any cross-store action. */
  const retryIfStillWanted = (seed: string) => {
    cancelRetry();
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      const p = usePlaybackStore.getState();
      const r = get();
      const current = p.index >= 0 ? p.queue[p.index]?.videoId : undefined;
      if (
        r.pendingAdvance === seed &&
        current === seed &&
        p.index === p.queue.length - 1 &&
        p.waitingForNext &&
        p.playing
      ) {
        r.request(seed, true);
      } else if (r.pendingAdvance === seed) {
        set({ pendingAdvance: undefined });
      }
    }, RETRY_MS);
  };

  const failed = (seed: string, message: string) => {
    if (get().requestedSeed !== seed) return;
    const urgent = get().pendingAdvance === seed;
    set({ requestedSeed: undefined, error: message });
    if (urgent) retryIfStillWanted(seed);
  };

  return {
    request: (seed, advance = false) => {
      const current = get();
      // A proactive request may already be running when the song ends.
      // Recording the urgency BEFORE this dedupe is the load-bearing bit:
      // its eventual result must now advance, not merely append.
      if (advance && current.pendingAdvance !== seed) {
        set({ pendingAdvance: seed });
      }
      if (current.requestedSeed === seed) return;
      cancelRetry();
      set({
        requestedSeed: seed,
        pendingAdvance: advance ? seed : undefined,
        error: undefined,
      });
      dispatchContent({ type: "radio:load", videoId: seed });
    },

    applyEvents: (events) => {
      for (const e of events) {
        if (e.type === "radio:loaded") {
          // A late answer/error for an older seed must not clear or satisfy
          // the station now being fetched for a newer song.
          if (get().requestedSeed !== e.seed) continue;
          const s = usePlaybackStore.getState();
          const current = s.index >= 0 ? s.queue[s.index]?.videoId : undefined;
          // Drop a stale station: the user may have started something else
          // while this was in flight. Also require the seed to still be
          // last, or this would bolt a station into the middle of an album.
          if (current !== e.seed || s.index < s.queue.length - 1) {
            set({ requestedSeed: undefined, pendingAdvance: undefined });
            continue;
          }

          const seen = new Set(s.queue.map((t) => t.videoId));
          const tracks = e.tracks
            .filter((t) => t.id !== e.seed && !seen.has(t.id))
            .map(shelfItemToTrack);
          if (tracks.length === 0) {
            failed(e.seed, "The station returned no new songs.");
            continue;
          }

          s.appendToQueue(tracks);
          const shouldAdvance =
            get().pendingAdvance === e.seed && s.waitingForNext && s.playing;
          cancelRetry();
          set({
            requestedSeed: undefined,
            pendingAdvance: undefined,
            error: undefined,
          });
          if (shouldAdvance) usePlaybackStore.getState().next();
        } else if (e.type === "radio:error") {
          failed(e.seed, e.message);
        }
      }
    },
  };
});

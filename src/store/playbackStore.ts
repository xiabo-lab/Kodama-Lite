import { create } from "zustand";
import { dispatch } from "@/bus/bus";
import type { AppEvent, YtdlpPhase } from "@/protocol";

/**
 * Playback — queue, transport, and the current stream URL.
 *
 * Deliberately NOT bus-driven end to end: queue navigation (`next`,
 * `prev`, `playNow`, shuffle, repeat, volume) is pure UI-domain state and
 * changes it instantly and locally, exactly like the rest of the view
 * plane. The one genuinely async part — turning a videoId into bytes — is
 * the only thing that crosses the bus: whenever the current track changes,
 * this store fires a `stream:resolve` command and moves on; the URL
 * arrives later as a `stream:ready` event and is folded in by
 * `applyEvents`. Nothing here ever awaits that round-trip.
 *
 * The actual `<audio>` element lives in `lib/audioEngine.ts`, which reads
 * this store and drives play/pause/seek/volume — see its docs for why
 * playback itself has to live in the webview rather than behind the bus.
 */

export interface Track {
  videoId: string;
  title: string;
  subtitle?: string;
  thumbnail?: string;
  duration?: number;
}

export type PlaybackStatus = "idle" | "loading" | "ready" | "error";
export type RepeatMode = "off" | "all" | "one";

interface PlaybackState {
  queue: Track[];
  index: number;
  playing: boolean;
  status: PlaybackStatus;
  streamUrl?: string;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  error?: string;
  /** Managed yt-dlp binary lifecycle — surfaced so the player bar can show
   *  a "preparing audio engine" hint instead of a confusing play failure
   *  on a very first launch. */
  ytdlpPhase: YtdlpPhase;

  playNow: (track: Track) => void;
  playQueue: (tracks: Track[], startIndex: number) => void;
  /** Jump to an already-queued slot (e.g. clicking a row in the queue
   *  panel) without replacing the queue itself. */
  jumpTo: (index: number) => void;
  /** Drop a queued (not currently playing) track. */
  removeAt: (index: number) => void;
  /** Drop everything after the current track. */
  clearQueue: () => void;
  /** Append tracks to the end of the queue without disturbing playback.
   *  Used by the radio continuation. Dedupes against what's already
   *  queued so a re-fetch can't stack the same station twice. */
  appendToQueue: (tracks: Track[]) => void;
  toggle: () => void;
  /** Start the current track, resolving its stream first if it hasn't
   *  been. Needed because a queue restored from the last session has a
   *  track and an index but no `streamUrl` — only `loadTrackAt` fires a
   *  resolve, and nothing calls it on rehydrate. */
  resume: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  setShuffle: (on: boolean) => void;
  cycleRepeat: () => void;

  /** Driven by the audio element itself (see `useAudioEngine`), not a user
   *  intent — kept separate from the action list above. */
  setPosition: (s: number) => void;
  setDuration: (s: number) => void;
  setPlayError: (message: string) => void;

  /** The playback slice's half of the app's single bus subscription (see
   *  App.tsx) — ignores every event type it doesn't own. */
  applyEvents: (events: AppEvent[]) => void;
}

const QUEUE_CACHE_KEY = "kl:playback-queue";

function loadQueueCache(): { queue: Track[]; index: number } {
  try {
    const raw = localStorage.getItem(QUEUE_CACHE_KEY);
    if (raw) return JSON.parse(raw) as { queue: Track[]; index: number };
  } catch {
    /* corrupt cache — boot empty */
  }
  return { queue: [], index: -1 };
}

function saveQueueCache(queue: Track[], index: number): void {
  try {
    localStorage.setItem(QUEUE_CACHE_KEY, JSON.stringify({ queue, index }));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

const VOLUME_CACHE_KEY = "kl:volume";

/**
 * Volume survives a restart, in its own key rather than the queue cache —
 * it's a device preference, not part of "what was playing", and clearing
 * the queue must not reset how loud the car is.
 *
 * It used to boot at a hardcoded 1, so every launch came back at full
 * volume no matter what it was set to before. The user's workaround was to
 * turn the *system* stream down (PipeWire remembers per-role volume, and
 * WirePlumber keys it by `media.role=Music`), which left the in-app slider
 * sitting at 100% while the output was at 45% — two attenuators, only one
 * of them visible. Persisting this makes the slider the control that
 * actually holds, so the system one can stay where it belongs.
 */
function loadVolume(): { volume: number; muted: boolean } {
  try {
    const raw = localStorage.getItem(VOLUME_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { volume?: number; muted?: boolean };
      const v = Number(parsed.volume);
      // A corrupt or out-of-range value must not be able to make the next
      // launch silent OR deafening — fall back to full rather than trust it.
      if (Number.isFinite(v) && v >= 0 && v <= 1) {
        return { volume: v, muted: !!parsed.muted };
      }
    }
  } catch {
    /* corrupt — fall through to the default */
  }
  return { volume: 1, muted: false };
}

function saveVolume(volume: number, muted: boolean): void {
  try {
    localStorage.setItem(VOLUME_CACHE_KEY, JSON.stringify({ volume, muted }));
  } catch {
    /* quota / private mode — non-fatal, in-memory state still works */
  }
}

/** Fire a `stream:resolve` for the now-current track. Never awaited — the
 *  URL arrives later as a `stream:ready` event. */
function requestStream(videoId: string | undefined): void {
  if (!videoId) return;
  dispatch({ type: "stream:resolve", videoId });
}

/** Warm the cache for the track after the current one, same rationale as
 *  YTMLite: by the time the user hits "next" it's usually already on disk. */
function prefetchNext(queue: Track[], index: number): void {
  const next = queue[index + 1];
  if (next) dispatch({ type: "stream:prefetch", videoId: next.videoId });
}

/** Shared shape for "jump to this queue slot and start resolving it." */
function loadTrackAt(
  set: (partial: Partial<PlaybackState>) => void,
  queue: Track[],
  index: number,
): void {
  const track = queue[index];
  set({
    queue,
    index,
    playing: true,
    status: "loading",
    position: 0,
    duration: track.duration ?? 0,
    streamUrl: undefined,
    error: undefined,
  });
  saveQueueCache(queue, index);
  requestStream(track.videoId);
  prefetchNext(queue, index);
}

export const usePlaybackStore = create<PlaybackState>((set, get) => {
  const cached = loadQueueCache();
  const savedVolume = loadVolume();
  return {
    queue: cached.queue,
    index: cached.index,
    // Never resume auto-playing from a cached session — a fresh launch
    // stays silent; the cache only pre-fills what the player bar shows.
    playing: false,
    status: "idle",
    position: 0,
    duration: cached.queue[cached.index]?.duration ?? 0,
    volume: savedVolume.volume,
    muted: savedVolume.muted,
    shuffle: false,
    repeat: "off",
    ytdlpPhase: "downloading",

    playNow: (track) => loadTrackAt(set, [track], 0),

    playQueue: (tracks, startIndex) => {
      if (tracks.length === 0) return;
      const index = Math.max(0, Math.min(startIndex, tracks.length - 1));
      loadTrackAt(set, tracks, index);
    },

    jumpTo: (index) => {
      const { queue } = get();
      if (index < 0 || index >= queue.length) return;
      loadTrackAt(set, queue, index);
    },

    removeAt: (index) => {
      const { queue, index: current } = get();
      if (index < 0 || index >= queue.length || index === current) return;
      const nextQueue = queue.slice(0, index).concat(queue.slice(index + 1));
      const nextIndex = index < current ? current - 1 : current;
      set({ queue: nextQueue });
      saveQueueCache(nextQueue, nextIndex);
      if (index < current) set({ index: nextIndex });
    },

    clearQueue: () => {
      const { queue, index } = get();
      if (index < 0) {
        set({ queue: [] });
        saveQueueCache([], -1);
        return;
      }
      const nextQueue = queue.slice(0, index + 1);
      set({ queue: nextQueue });
      saveQueueCache(nextQueue, index);
    },

    appendToQueue: (tracks) => {
      if (tracks.length === 0) return;
      const { queue, index } = get();
      const seen = new Set(queue.map((t) => t.videoId));
      const fresh = tracks.filter((t) => !seen.has(t.videoId));
      if (fresh.length === 0) return;
      const nextQueue = [...queue, ...fresh];
      set({ queue: nextQueue });
      saveQueueCache(nextQueue, index);
      // The appended track is now the one after the current, so warm it.
      prefetchNext(nextQueue, index);
    },

    // Pausing is a pure flag flip; starting goes through `resume` so the
    // restored-queue case resolves a stream instead of setting
    // `playing: true` against a `<audio>` element with no src — which is
    // what the play button did after a relaunch.
    toggle: () => {
      const { index, playing } = get();
      if (index < 0) return set({ playing: false });
      if (playing) return set({ playing: false });
      get().resume();
    },

    resume: () => {
      const { queue, index, streamUrl } = get();
      if (index < 0 || index >= queue.length) return;
      if (!streamUrl) {
        set({ status: "loading", error: undefined });
        requestStream(queue[index].videoId);
        prefetchNext(queue, index);
      }
      set({ playing: true });
    },

    next: () => {
      const { queue, index, repeat } = get();
      if (queue.length === 0) return;
      if (repeat === "one") {
        set({ position: 0, playing: true });
        return;
      }
      let nextIndex = index + 1;
      if (nextIndex >= queue.length) {
        if (repeat !== "all") {
          set({ playing: false });
          return;
        }
        nextIndex = 0;
      }
      loadTrackAt(set, queue, nextIndex);
      // Shuffle-on-advance (reordering the upcoming portion) is a full
      // feature-parity concern that lands with the rest of the queue UI
      // in Phase 3 — the toggle exists now so the player bar has
      // something real to bind to.
    },

    prev: () => {
      const { queue, index, position } = get();
      if (queue.length === 0) return;
      // >3s in, or already first: restart the current track rather than
      // actually going back — matches YTMLite.
      if (index <= 0 || position > 3) {
        set({ position: 0 });
        return;
      }
      loadTrackAt(set, queue, index - 1);
    },

    seek: (seconds) => set({ position: Math.max(0, seconds) }),

    setVolume: (v) => {
      const volume = Math.max(0, Math.min(1, v));
      saveVolume(volume, false);
      set({ volume, muted: false });
    },
    toggleMute: () =>
      set((s) => {
        const muted = !s.muted;
        saveVolume(s.volume, muted);
        return { muted };
      }),
    setShuffle: (on) => set({ shuffle: on }),
    cycleRepeat: () =>
      set((s) => ({
        repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off",
      })),

    setPosition: (position) => set({ position }),
    setDuration: (duration) => set({ duration }),
    setPlayError: (message) => set({ status: "error", playing: false, error: message }),

    applyEvents: (events) => {
      for (const e of events) {
        switch (e.type) {
          case "stream:ready": {
            const { queue, index } = get();
            const current = index >= 0 ? queue[index] : undefined;
            // Guard against a stale resolve for a track we've since
            // navigated away from (rapid skips) — the audio engine only
            // ever reads `streamUrl` for the CURRENT track, so an event
            // for anything else is simply dropped here.
            if (current?.videoId === e.videoId) {
              set({ streamUrl: e.url, status: "ready", error: undefined });
            }
            break;
          }
          case "stream:error": {
            const { queue, index } = get();
            const current = index >= 0 ? queue[index] : undefined;
            if (current?.videoId === e.videoId) {
              set({ status: "error", playing: false, error: e.message });
            }
            break;
          }
          case "ytdlp:state":
            set({ ytdlpPhase: e.phase });
            break;
          // A transport button pressed in the car (or `playerctl`). These
          // drive exactly the same store actions the on-screen buttons
          // do, so there is one implementation of "next" and the car can
          // never diverge from the UI. `play` goes through `resume` for
          // the same reason `toggle` does — the track may not have a
          // resolved stream yet.
          case "media:control":
            switch (e.action) {
              case "play":
                get().resume();
                break;
              case "pause":
              case "stop":
                set({ playing: false });
                break;
              case "toggle":
                get().toggle();
                break;
              case "next":
                get().next();
                break;
              case "previous":
                get().prev();
                break;
              case "seek":
                if (typeof e.position === "number") get().seek(e.position);
                break;
            }
            break;
          default:
            break;
        }
      }
    },
  };
});

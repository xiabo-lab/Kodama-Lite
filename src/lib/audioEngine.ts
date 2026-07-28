import { useEffect, useRef } from "react";
import { dispatch } from "@/bus/bus";
import { useAppStore } from "@/store/appStore";
import { useLyricsStore } from "@/store/lyricsStore";
import { useRadioStore } from "@/store/radioStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * Owns the single `<audio>` element for the app's lifetime and wires it to
 * `playbackStore` in both directions:
 *
 *   store → element — a new `streamUrl` sets `.src`; `playing` toggles
 *     play()/pause(); volume/muted apply a perceptual (cubic) curve.
 *   element → store — timeupdate/durationchange/ended/error drive
 *     position, duration, auto-advance, and the error state.
 *
 * Why this lives in the view plane rather than behind the bus: only the
 * webview can decode and play audio (`HTMLMediaElement`) — Rust has no
 * native audio pipeline here, nor should it grow one just to satisfy an
 * architecture diagram. By the time this hook has a `streamUrl` at all,
 * the actual async work (resolving the videoId, and the disk-cache /
 * yt-dlp fetch behind the local server) has already happened in the data
 * plane; `el.play()` triggers the browser's own async media pipeline,
 * which was never something the render path waited on.
 */
export function useAudioEngine(): void {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Resume-on-startup. The store already restores the queue and index
  // from the last session (see `loadQueueCache`) with `position: 0` and
  // `playing: false`; this decides whether to actually press play, and
  // the track therefore starts from its beginning rather than where it
  // was interrupted — which is the behaviour the setting promises.
  //
  // Two gates, not a mount-time fire, and both are about the same thing:
  // a resolve issued too early fails and leaves the bar showing an error
  // the user never asked for, on a screen they may not even be looking at.
  //
  //   yt-dlp ready — on a very first launch the managed binary is still
  //     downloading, so there is nothing to resolve with yet.
  //   a *confirmed* connection — `online` starts optimistically `true`
  //     before any probe has run, so `netChecked` is what distinguishes
  //     "the internet answered" from "nobody has asked yet". In the car
  //     this is the normal case: the Pi powers on with the ignition and
  //     wins the race against the phone's hotspot every time. `App`
  //     re-probes while offline, so this effect simply re-runs and fires
  //     on the transition — the music starts when the network arrives,
  //     with no play button involved.
  //
  // The ref makes it strictly one-shot: only the first launch auto-plays,
  // and a connection that drops and returns mid-session doesn't restart
  // whatever the user had deliberately paused.
  const ytdlpPhase = usePlaybackStore((s) => s.ytdlpPhase);
  const online = useAppStore((s) => s.online);
  const netChecked = useAppStore((s) => s.netChecked);
  const didResumeRef = useRef(false);
  useEffect(() => {
    if (didResumeRef.current) return;
    if (ytdlpPhase !== "ready") return;
    if (!netChecked || !online) return;
    didResumeRef.current = true;
    if (!useSettingsStore.getState().resumeOnStartup) return;
    const s = usePlaybackStore.getState();
    if (s.index < 0 || s.index >= s.queue.length) return;
    if (s.playing) return;
    s.resume();
  }, [ytdlpPhase, online, netChecked]);

  // ── OS media controls (MPRIS → Bluetooth AVRCP → the car) ───────────
  //
  // Pushed on track / play-state / duration change, plus a light 2s
  // refresh while playing so the head unit's scrubber doesn't drift and
  // a seek shows up. Not on every `timeupdate`: that's ~4 D-Bus round
  // trips a second for a scrubber the client interpolates anyway.
  // Values are read imperatively so this sync never re-triggers the
  // resolve/playback effects below.
  const track = usePlaybackStore((s) => (s.index >= 0 ? s.queue[s.index] : undefined));
  const playingForMedia = usePlaybackStore((s) => s.playing);
  const durationForMedia = usePlaybackStore((s) => s.duration);
  useEffect(() => {
    const push = () => {
      const s = usePlaybackStore.getState();
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      if (!t) {
        dispatch({ type: "media:clear" });
        return;
      }
      dispatch({
        type: "media:update",
        title: t.title,
        artist: t.subtitle ?? "",
        album: "",
        thumbnail: t.thumbnail ?? "",
        duration: Number.isFinite(s.duration) ? s.duration : 0,
        elapsed: s.position,
        paused: !s.playing,
      });
    };
    push();
    if (!playingForMedia) return;
    const id = window.setInterval(push, 2000);
    return () => window.clearInterval(id);
  }, [track, playingForMedia, durationForMedia]);

  // ── The *other* MPRIS player ────────────────────────────────────────
  //
  // WebKitGTK publishes an MPRIS service of its own for any playing media
  // element — `org.mpris.MediaPlayer2.org.webkit.app-<hash>.Sandboxed
  // .instance-N` — alongside the one `subsystems/media.rs` registers. Two
  // players, one stream. `mpris-proxy` bridges MPRIS to Bluetooth AVRCP,
  // and which one a head unit ends up addressing is a race at connect
  // time; the `instance-N` counter moves whenever the media session is
  // rebuilt, so it can differ between drives.
  //
  // Unfed, WebKit's player falls back to the document title, with no
  // artist and no art. Read off the Pi while a track was playing:
  //
  //   kodamalite  → title "伯虎说", artist "伯爵Johnny, 唐伯虎Annie", artUrl
  //   webkit      → title "Kodama-Lite", artist [""], album "", no art
  //
  // That is exactly the Tesla showing no song information and its
  // transport buttons doing nothing — a bare `<audio>` element has no
  // action handlers, so Next/Previous reach WebKit and die there.
  //
  // Suppressing WebKit's player is possible (the `MediaSessionEnabled`
  // runtime feature, via `webkit_settings_set_feature_enabled`) but means
  // FFI against the webview to remove a service the platform is right to
  // publish. Feeding it is both simpler and strictly more robust: whichever
  // player the car addresses, it now gets correct metadata and working
  // controls. This is also the idiomatic answer — the audio really is
  // coming from a media element, and `navigator.mediaSession` is how a page
  // describes it to the OS.
  //
  // Guarded because the browser harness and the unit tests have no
  // `mediaSession`, and Safari/WebKit throws on unknown action names.
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms) return;
    const set = (action: MediaSessionAction, handler: () => void) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* action unsupported by this engine — the others still bind */
      }
    };
    const store = usePlaybackStore.getState;
    set("play", () => store().resume());
    set("pause", () => usePlaybackStore.setState({ playing: false }));
    set("stop", () => usePlaybackStore.setState({ playing: false }));
    set("nexttrack", () => store().next());
    set("previoustrack", () => store().prev());
    try {
      ms.setActionHandler("seekto", (details) => {
        if (typeof details.seekTime === "number") store().seek(details.seekTime);
      });
    } catch {
      /* no seek support — the scrubber stays read-only */
    }
    return () => {
      for (const a of [
        "play",
        "pause",
        "stop",
        "nexttrack",
        "previoustrack",
        "seekto",
      ] as MediaSessionAction[]) {
        try {
          ms.setActionHandler(a, null);
        } catch {
          /* never bound */
        }
      }
    };
  }, []);

  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms) return;
    if (!track) {
      ms.metadata = null;
      ms.playbackState = "none";
      return;
    }
    ms.metadata = new MediaMetadata({
      title: track.title,
      artist: track.subtitle ?? "",
      artwork: track.thumbnail ? [{ src: track.thumbnail }] : [],
    });
    ms.playbackState = playingForMedia ? "playing" : "paused";
  }, [track, playingForMedia]);

  // Position is pushed on the same 2s cadence as the MPRIS scrubber above
  // rather than on `timeupdate`, for the same reason. `setPositionState`
  // throws on a duration that isn't a finite positive number, or on a
  // position past it — both of which happen normally while a track loads.
  const positionForMedia = usePlaybackStore((s) => s.position);
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms?.setPositionState) return;
    if (!Number.isFinite(durationForMedia) || durationForMedia <= 0) return;
    try {
      ms.setPositionState({
        duration: durationForMedia,
        position: Math.min(Math.max(positionForMedia, 0), durationForMedia),
        playbackRate: 1,
      });
    } catch {
      /* transient inconsistency while a track swaps — next tick fixes it */
    }
  }, [durationForMedia, positionForMedia]);

  // ── Lyrics ──────────────────────────────────────────────────────────
  //
  // Fetched here, on every track change, rather than from the karaoke
  // stage. It used to live in `KaraokeStage`, which only mounts while the
  // overlay is open — so a track you never opened the lyrics for never had
  // its lyrics fetched or cached, while its audio was cached on the first
  // play regardless. That's why the cached-audio and cached-lyrics counts
  // in Settings > Storage drifted apart.
  //
  // Doing it here also means the lyrics are already in the store by the
  // time the stage opens, so `L` shows words instead of "Loading lyrics…".
  // A cache hit costs nothing: `load()` returns synchronously without
  // dispatching.
  const lyricsTrack = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index] : undefined,
  );
  const loadLyrics = useLyricsStore((s) => s.load);
  useEffect(() => {
    if (!lyricsTrack) return;
    loadLyrics({
      videoId: lyricsTrack.videoId,
      title: lyricsTrack.title,
      artist: lyricsTrack.subtitle,
      duration: lyricsTrack.duration,
    });
  }, [lyricsTrack?.videoId, loadLyrics]);

  // ── Radio continuation ──────────────────────────────────────────────
  //
  // Extend the queue with similar tracks once the current one is the last
  // queued, so playback carries on past the end instead of stopping — the
  // behaviour the YouTube Music app has when you start a single song.
  // Fired at the *start* of the last track rather than when it ends, so
  // the next track is already queued and prefetched by the time it's
  // needed and there's no gap.
  const autoRadio = useSettingsStore((s) => s.autoRadio);
  const queueLen = usePlaybackStore((s) => s.queue.length);
  const queueIndex = usePlaybackStore((s) => s.index);
  const seedVideoId = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index]?.videoId : undefined,
  );
  useEffect(() => {
    if (!autoRadio) return;
    if (queueIndex < 0 || !seedVideoId) return;
    // Only when the current track is the last one queued.
    if (queueIndex < queueLen - 1) return;
    // Dedupe lives in the store, not a ref here, so a failed station can
    // be retried — see `radioStore.request`.
    useRadioStore.getState().request(seedVideoId);
  }, [autoRadio, queueIndex, queueLen, seedVideoId]);

  // The element itself: created once, torn down on unmount.
  useEffect(() => {
    const el = new Audio();
    el.preload = "auto";
    audioRef.current = el;
    return () => {
      el.pause();
      el.src = "";
      audioRef.current = null;
    };
  }, []);

  // Element → store.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const store = usePlaybackStore.getState;

    const onTimeUpdate = () => store().setPosition(el.currentTime);
    const onDurationChange = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        store().setDuration(el.duration);
      }
    };
    const onEnded = () => store().next();
    const onError = () => {
      const msg = el.error ? `audio error (code ${el.error.code})` : "unknown audio error";
      store().setPlayError(msg);
    };
    const onPlaying = () => {
      if (store().status !== "ready") usePlaybackStore.setState({ status: "ready" });
    };

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    el.addEventListener("playing", onPlaying);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      el.removeEventListener("playing", onPlaying);
    };
  }, []);

  // A freshly-resolved stream URL for the CURRENT track: load it, and
  // resume playback if the user still wants it playing (they may have
  // paused, or skipped again, while the resolve was in flight).
  const streamUrl = usePlaybackStore((s) => s.streamUrl);
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !streamUrl) return;
    el.src = streamUrl;
    el.load();
    if (usePlaybackStore.getState().playing) {
      void el.play().catch((e) => {
        if (e?.name === "AbortError") return; // superseded by a newer load
        usePlaybackStore.getState().setPlayError(e?.message ?? String(e));
      });
    }
  }, [streamUrl]);

  // Play/pause follows the store's intent.
  const playing = usePlaybackStore((s) => s.playing);
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !el.src) return;
    if (playing) {
      void el.play().catch((e) => {
        if (e?.name === "AbortError") return;
        usePlaybackStore.getState().setPlayError(e?.message ?? String(e));
      });
    } else {
      el.pause();
    }
  }, [playing]);

  // Volume / mute.
  //
  // Loudness perception is logarithmic; a linear slider crams almost all the
  // perceivable change into the bottom ~20%. A cubic curve tracks perceived
  // loudness instead (same curve YTMLite uses).
  //
  // That curve also happens to line the slider up exactly with the system
  // mixer, which is worth knowing before "simplifying" it away. On the Pi,
  // `el.volume` is written straight through to the PipeWire stream's
  // `channelVolumes`, and `wpctl` displays the cube root of that — so
  // `cbrt(slider³)` is `slider`. Measured on device: slider 0.37 →
  // `wpctl get-volume` 0.37. The app slider IS the system stream volume,
  // on the same scale. There is no second attenuator to fight.
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, volume)) ** 3;
    el.muted = muted;
  }, [volume, muted]);

  // Assert that volume onto the stream once the stream actually exists.
  //
  // This is the fix for "the bar says 100% but it plays at 45%". WebKit
  // only propagates a *change* to `el.volume`, and the PipeWire stream node
  // isn't created until playback really starts — at which point WirePlumber
  // restores its own remembered volume for the `media.role=Music` stream
  // (a value shared with YTMLite, which declares the same role). The effect
  // above has already run by then, and if our target equals what the
  // element is holding, assigning it again is a no-op. So WirePlumber's
  // value won, silently, and the slider had no way to show it.
  //
  // Two passes because the node's creation races this, and a nudge through
  // a slightly *lower* value first so the assignment is always a real
  // change. Never nudge upward: a momentary jump to full volume is exactly
  // the thing this whole area of the code is trying not to do.
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    const assert = () => {
      const el = audioRef.current;
      if (cancelled || !el) return;
      const s = usePlaybackStore.getState();
      const target = Math.max(0, Math.min(1, s.volume)) ** 3;
      if (el.volume === target) el.volume = target * 0.98;
      el.volume = target;
      el.muted = s.muted;
    };
    const first = window.setTimeout(assert, 150);
    const second = window.setTimeout(assert, 800);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }, [playing, streamUrl]);

  // Seek requests. `position` is ALSO written by `onTimeUpdate` above, so
  // this only pushes to the element when the two have genuinely diverged
  // (a user scrub) — otherwise it would fight the element's own progress
  // on every tick.
  const position = usePlaybackStore((s) => s.position);
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration)) return;
    if (Math.abs(el.currentTime - position) > 1) {
      el.currentTime = position;
    }
  }, [position]);
}

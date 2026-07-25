import { useEffect, useRef } from "react";
import { dispatch } from "@/bus/bus";
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
  // Gated on the yt-dlp binary being ready rather than firing at mount:
  // on a very first launch the managed binary is still downloading, and
  // a resolve issued before then fails and leaves the bar in an error
  // state the user never asked for. The ref makes it strictly one-shot,
  // so toggling the setting later never retriggers it.
  const ytdlpPhase = usePlaybackStore((s) => s.ytdlpPhase);
  const didResumeRef = useRef(false);
  useEffect(() => {
    if (didResumeRef.current) return;
    if (ytdlpPhase !== "ready") return;
    didResumeRef.current = true;
    if (!useSettingsStore.getState().resumeOnStartup) return;
    const s = usePlaybackStore.getState();
    if (s.index < 0 || s.index >= s.queue.length) return;
    if (s.playing) return;
    s.resume();
  }, [ytdlpPhase]);

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
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // Loudness perception is logarithmic; a linear slider crams almost all
    // the perceivable change into the bottom ~20%. A cubic curve tracks
    // perceived loudness instead (same curve YTMLite uses).
    el.volume = Math.max(0, Math.min(1, volume)) ** 3;
    el.muted = muted;
  }, [volume, muted]);

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

import { useEffect, useRef } from "react";
import { usePlaybackStore } from "@/store/playbackStore";

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

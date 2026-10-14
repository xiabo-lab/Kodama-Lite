import { useEffect, useRef, useState } from "react";
import { emptyFrame, sampleAt, type Analysis } from "@/lib/screensaver/analyze";
import { idleRemainingMs, screenSaverEligible } from "@/lib/screensaver/idle";
import { analyzeTrack, MAX_ANALYSIS_SECONDS, workerStatus } from "@/lib/screensaver/pipeline";
import { startWaveLoop } from "@/lib/screensaver/renderer";
import { logLine } from "@/lib/log";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { useKaraokeStore } from "@/store/karaokeStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { useQueuePanelStore } from "@/store/queuePanelStore";
import { useSettingsStore } from "@/store/settingsStore";

const LOG = "Kodama ScreenSaver";

/** What counts as someone using the screen. `pointermove` only fires
 *  during contact on the touch panel, so it is a drag, not a hover. */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "touchstart", "wheel", "keydown"] as const;

/** How long the wake fade lasts — and how long the overlay keeps catching
 *  touches after the one that woke it. */
const WAKE_MS = 300;

/**
 * Decides when the sound-wave screen saver is up. Mounted once, beside the
 * karaoke overlay.
 *
 * It only ever counts down on Home with nothing open over it (see
 * `screenSaverEligible`). Leaving Home, opening the karaoke stage or the
 * queue panel hides it at once and starts the count from zero when Home
 * is back; so does any touch. A track change does not count as activity —
 * the saver is showing the music, and the next song is no reason to stop.
 */
export function ScreenSaverHost() {
  const route = useAppStore((s) => s.route);
  const karaokeOpen = useKaraokeStore((s) => s.open);
  const queueOpen = useQueuePanelStore((s) => s.open);
  const delayMin = useSettingsStore((s) => s.screenSaverDelayMin);
  const eligible = screenSaverEligible(route, karaokeOpen, queueOpen);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!eligible) setActive(false);
  }, [eligible]);

  // One timer, re-armed for whatever is left rather than on every event:
  // `pointermove` arrives at the display's frame rate during a drag, and
  // the only thing it needs to do is move `last`.
  useEffect(() => {
    if (!eligible || active) return;
    const delayMs = delayMin * 60_000;
    let last = performance.now();
    let timer = 0;
    const check = () => {
      const left = idleRemainingMs(last, performance.now(), delayMs);
      if (left === 0) setActive(true);
      else timer = window.setTimeout(check, left);
    };
    timer = window.setTimeout(check, delayMs);
    const onActivity = () => {
      last = performance.now();
    };
    for (const e of ACTIVITY_EVENTS) {
      window.addEventListener(e, onActivity, { capture: true, passive: true });
    }
    return () => {
      window.clearTimeout(timer);
      for (const e of ACTIVITY_EVENTS) {
        window.removeEventListener(e, onActivity, { capture: true });
      }
    };
  }, [eligible, active, delayMin]);

  if (!active) return null;
  return <ScreenSaver onWake={() => setActive(false)} />;
}

// ── Analysis cache ─────────────────────────────────────────────────────
//
// Module-level so it outlives the overlay: waking and idling again on the
// same song must not decode it a second time. Keyed by stream URL, which is
// one track's bytes for the life of the stream server. A few hundred KB per
// entry, so three is generous.

const CACHE_SIZE = 3;
const analyses = new Map<string, Analysis>();
/** URLs that failed once this session. Retrying a file the engine cannot
 *  decode would cost the same decode every time the saver comes up. */
const failed = new Set<string>();

function remember(url: string, a: Analysis): void {
  analyses.delete(url);
  analyses.set(url, a);
  while (analyses.size > CACHE_SIZE) {
    const oldest = analyses.keys().next().value;
    if (oldest === undefined) break;
    analyses.delete(oldest);
  }
}

/**
 * The overlay: full screen, above everything, black behind the wave.
 *
 * **The first touch only wakes it.** The overlay starts fading on
 * `pointerdown` but stays where it is, catching events, until the fade is
 * over — so the finger's release lands here and not on whichever Home tile
 * happens to be underneath. Without that, waking the screen would also
 * start a playlist.
 */
function ScreenSaver({ onWake }: { onWake: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analysisRef = useRef<Analysis | null>(null);
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);

  const wake = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    window.setTimeout(onWake, WAKE_MS);
  };
  const wakeRef = useRef(wake);
  wakeRef.current = wake;

  useEffect(() => {
    logLine(LOG, "on");
    // Next frame, so the opacity transition has a start to run from.
    const id = requestAnimationFrame(() => setShown(true));
    const onKey = () => wakeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Analyse whatever is current, and again on every track change while the
  // overlay is up. Until a result lands — or if it never does — the wave
  // is a flat line: it only ever moves in step with the music.
  const streamUrl = usePlaybackStore((s) => s.streamUrl);
  const videoId = usePlaybackStore((s) => (s.index >= 0 ? s.queue[s.index]?.videoId : undefined));
  useEffect(() => {
    analysisRef.current = null;
    if (!streamUrl) return;
    const cached = analyses.get(streamUrl);
    if (cached) {
      analysisRef.current = cached;
      return;
    }
    if (failed.has(streamUrl)) return;
    const s = usePlaybackStore.getState();
    const duration = s.duration || s.queue[s.index]?.duration || 0;
    if (duration > MAX_ANALYSIS_SECONDS) {
      failed.add(streamUrl);
      logLine(LOG, `${videoId}: ${Math.round(duration)}s is too long to analyse — flat line`);
      return;
    }
    const ctrl = new AbortController();
    analyzeTrack(streamUrl, ctrl.signal).then(
      (r) => {
        remember(streamUrl, r.analysis);
        analysisRef.current = r.analysis;
        // Every stage, so one line from the car says which path ran and
        // where the time went.
        logLine(
          LOG,
          `${videoId}: analysed ${r.analysis.frames} frames — fetch ${r.fetchMs}ms via ${r.via}, ` +
            `decode ${r.decodeMs}ms, analysis ${r.analyzeMs}ms on ${r.where}` +
            (r.workerFailure ? ` (worker unavailable: ${r.workerFailure})` : ""),
        );
      },
      (e: unknown) => {
        if ((e as Error)?.name === "AbortError") return;
        failed.add(streamUrl);
        logLine(
          LOG,
          `${videoId}: analysis failed (${(e as Error)?.message ?? String(e)}; ${workerStatus()}) — flat line`,
        );
      },
    );
    return () => ctrl.abort();
  }, [streamUrl, videoId]);

  // The draw loop. Reads the stores imperatively, so 60 frames a second
  // never reach React.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const frame = emptyFrame();

    // The playback clock, interpolated between the ~4Hz `timeupdate`
    // writes the same way the karaoke sweep does it, and rebased on every
    // write and on play/pause.
    let base = { pos: usePlaybackStore.getState().position, at: performance.now() };
    const unsub = usePlaybackStore.subscribe((s, prev) => {
      if (s.position !== prev.position || s.playing !== prev.playing) {
        base = { pos: s.position, at: performance.now() };
      }
    });

    const loop = startWaveLoop(
      canvas,
      (now) => {
        const a = analysisRef.current;
        if (!a) return null;
        const s = usePlaybackStore.getState();
        // Nothing audible, nothing to react to: a straight line.
        if (!s.playing || !s.started || s.muted || s.volume <= 0) return null;
        // Capped so a stalled element (buffering) can't run the picture
        // ahead of the sound indefinitely.
        const elapsed = Math.min(1, (now - base.at) / 1000);
        // The lyrics offset is the Bluetooth latency compensation the user
        // already tuned by ear; the wave is late by the same amount.
        const t = base.pos + elapsed - useSettingsStore.getState().lyricsOffsetSec;
        return sampleAt(a, t, frame);
      },
      (level, gap) => logLine(LOG, `quality stepped down to ${level} (median frame ${gap.toFixed(1)}ms)`),
    );
    return () => {
      const st = loop.stop();
      unsub();
      // One line per screen-saver session: enough to tell from the journal
      // whether the panel kept up, without logging anything per frame.
      logLine(
        LOG,
        st.movingFrames === 0
          ? `off after ${st.seconds}s — flat the whole time (no sound, or no analysis)`
          : `off after ${st.seconds}s — ${st.movingFps}fps while moving, worst second ${st.worstSecondFps}fps, ` +
              `longest gap ${st.longestGapMs}ms, quality ${st.quality}`,
      );
    };
  }, []);

  return (
    <div
      aria-hidden
      onPointerDown={wake}
      onWheel={wake}
      className={cn(
        "fixed inset-0 z-[70] cursor-none bg-[#03040b] transition-opacity",
        leaving ? "duration-300" : "duration-1000",
        shown && !leaving ? "opacity-100" : "opacity-0",
      )}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

import type { AnalysisFrame } from "./analyze";

/**
 * The screen saver's sound wave, drawn on a 2D canvas.
 *
 * Shape: a fan of thin lines through one horizontal axis. Each line is the
 * same wave at a different amplitude and a slightly different phase, which
 * reads as a twisted ribbon rather than a single curve. The wave's height
 * along the axis is a sum of Gaussian "packets", one or two per frequency
 * band — bass in the middle, treble towards the edges.
 *
 * **Every movement comes from the music.** With no sound — paused, muted,
 * between songs, a silent intro, or before the track has been analysed —
 * it settles to a still, straight line. The first version also drifted,
 * breathed and wobbled on its own clock, and that motion buried the beat:
 * on the car's panel it was hard to see that the wave was following the
 * song at all. So nothing here moves unless a band, the loudness or an
 * onset says so: lobe heights follow their band with a fast attack and a
 * short release, onsets kick the whole wave, and the wave only travels
 * sideways in proportion to loudness.
 *
 * **Dim greys on black, constant brightness.** Colour and beat-flashes were
 * a distraction in a moving car. The brightest line is ~57% grey.
 *
 * Built for the Pi's WebKitGTK:
 *
 *   - Lines are exactly 1 device pixel: Skia's hairline fast path. Measured
 *     in Chrome, 1.15px cost 9x more on the GPU and 2.5x more on the CPU.
 *   - Lines are opaque and drawn `source-over`, dimmed by colour, never by
 *     alpha: a hairline is drawn segment by segment, and with translucency
 *     the shared end pixel of each segment is painted twice — a bright tick
 *     at every vertex.
 *   - Nothing but a fill, ≤20 hairlines and a 1px rect per frame. v0.1.59
 *     also blitted a full-screen background image and up to nine large
 *     scaled glow sprites with additive blending every frame — millions of
 *     blended pixels for a CPU-rasterised canvas.
 *   - No allocation per frame, so no garbage-collection hitches.
 *   - 30fps, and no drawing at all while the line is flat and still.
 *   - `startWaveLoop` steps quality down if frames still come too slowly.
 */

const BACKGROUND = "#000";
/** Inner (low, dim) to outer (tall, brightest) line tiers. */
const TIER_COLORS = ["rgb(62, 62, 64)", "rgb(98, 98, 101)", "rgb(146, 146, 150)"];
const AXIS_COLOR = "rgb(92, 92, 95)";

const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;

interface Packet {
  /** Centre, as a fraction of the width. */
  x: number;
  /** Gaussian half-width, as a fraction of the width. */
  sigma: number;
  /** Which analysis band drives it. */
  band: number;
  /** Carrier wavelength, as a fraction of the width — tighter for treble. */
  lambda: number;
  /** How hard its band can push it. */
  gain: number;
}

/** The tallest lobes just left of centre (bass), smaller ones trailing off
 *  towards both edges (treble). */
const PACKETS: Packet[] = [
  { x: 0.08, sigma: 0.04, band: 7, lambda: 0.11, gain: 0.55 },
  { x: 0.19, sigma: 0.05, band: 5, lambda: 0.13, gain: 0.7 },
  { x: 0.29, sigma: 0.055, band: 3, lambda: 0.15, gain: 0.8 },
  { x: 0.39, sigma: 0.06, band: 1, lambda: 0.18, gain: 1.0 },
  { x: 0.48, sigma: 0.065, band: 0, lambda: 0.2, gain: 1.0 },
  { x: 0.58, sigma: 0.06, band: 2, lambda: 0.17, gain: 0.9 },
  { x: 0.68, sigma: 0.055, band: 4, lambda: 0.15, gain: 0.8 },
  { x: 0.78, sigma: 0.05, band: 6, lambda: 0.13, gain: 0.7 },
  { x: 0.9, sigma: 0.04, band: 7, lambda: 0.11, gain: 0.55 },
];

interface Quality {
  lines: number;
  /** Distance between path points, in CSS px. */
  step: number;
  /** Backing-store resolution relative to the CSS size. */
  scale: number;
}

const QUALITY: Quality[] = [
  { lines: 20, step: 10, scale: 1 },
  { lines: 16, step: 12, scale: 1 },
  { lines: 12, step: 14, scale: 0.75 },
  { lines: 10, step: 16, scale: 0.5 },
];

/** Below this every lobe is under a pixel: the wave is a straight line. */
const FLAT = 0.002;

/** Exponential approach with a time constant, frame-rate independent. */
function approach(current: number, target: number, dt: number, tau: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export class WaveRenderer {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private quality = 0;

  // Smoothed state, carried between frames.
  private heights = new Float32Array(PACKETS.length);
  private level = 0;
  private kick = 0;
  private phase = 0;
  private lastT = -1;
  private flat = false;

  // Scratch, sized on resize. Per point: the packets' summed sin and cos
  // terms, and the point's x as a fraction of the width.
  private sumSin = new Float32Array(0);
  private sumCos = new Float32Array(0);
  private xf = new Float32Array(0);
  /** Per line: amplitude × cos/sin of its phase offset. Fixed per quality. */
  private lineCos = new Float32Array(0);
  private lineSin = new Float32Array(0);

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.resize();
  }

  get qualityLevel(): number {
    return this.quality;
  }

  /** True when the wave is a straight line and nothing is driving it, so
   *  another frame would draw exactly the same pixels. */
  get settled(): boolean {
    return this.flat;
  }

  /** Step down one quality level. Returns false at the floor. */
  degrade(): boolean {
    if (this.quality >= QUALITY.length - 1) return false;
    this.quality++;
    this.resize();
    return true;
  }

  resize(): void {
    const q = QUALITY[this.quality];
    const cssW = this.canvas.clientWidth || 1920;
    const cssH = this.canvas.clientHeight || 440;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2) * q.scale;
    this.width = Math.max(1, Math.round(cssW * this.dpr));
    this.height = Math.max(1, Math.round(cssH * this.dpr));
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    const points = Math.ceil(cssW / q.step) + 1;
    this.sumSin = new Float32Array(points);
    this.sumCos = new Float32Array(points);
    this.xf = new Float32Array(points);
    for (let i = 0; i < points; i++) this.xf[i] = Math.min(1, (i * q.step) / cssW);

    this.lineCos = new Float32Array(q.lines);
    this.lineSin = new Float32Array(q.lines);
    for (let l = 0; l < q.lines; l++) {
      const u = q.lines > 1 ? l / (q.lines - 1) : 1;
      const amp = 0.12 + 0.88 * u ** 0.8;
      const delta = (u - 0.5) * 1.1;
      this.lineCos[l] = Math.cos(delta) * amp;
      this.lineSin[l] = Math.sin(delta) * amp;
    }
    // A resize clears the canvas; make sure the next frame repaints it.
    this.flat = false;
  }

  /**
   * Draw one frame. `frame` is the analysis at the moment being heard, or
   * null for "no sound" — the wave then eases down to a straight line.
   */
  render(nowMs: number, frame: AnalysisFrame | null): void {
    const t = nowMs / 1000;
    // Real elapsed time, capped only against absurd jumps (a hidden tab).
    // v0.1.59 capped it at 0.1s, so whenever frames came slower than 10 a
    // second the whole animation ran in slow motion — on top of the lag,
    // the wave then fell visibly behind the music. The smoothing below is
    // exponential and stable for any step, so there is no need to cap it.
    const dt = this.lastT < 0 ? FRAME_MS / 1000 : Math.min(0.5, Math.max(0, t - this.lastT));
    this.lastT = t;

    const q = QUALITY[this.quality];
    const { ctx, width: W, height: H, dpr } = this;
    const cy = H / 2;
    const maxAmp = H * 0.47;

    // ── Drive ──────────────────────────────────────────────────────────
    this.level = approach(this.level, frame ? frame.level : 0, dt, 0.12);
    this.kick = Math.max(this.kick * Math.exp(-dt / 0.12), frame ? frame.onset : 0);
    let tallest = 0;
    for (let k = 0; k < PACKETS.length; k++) {
      const p = PACKETS[k];
      const target = frame ? Math.min(1.3, frame.bands[p.band] ** 1.3 * p.gain) : 0;
      // Fast attack so a hit lands on the beat; a short release so the
      // lobe is down again before the next one. A little slower when the
      // sound stops altogether, so pausing settles (flat in ~1.6s) rather
      // than snaps.
      const tau = target > this.heights[k] ? 0.03 : frame ? 0.14 : 0.25;
      this.heights[k] = approach(this.heights[k], target, dt, tau);
      if (this.heights[k] > tallest) tallest = this.heights[k];
    }
    // Sideways travel only while there is sound, and only as fast as it is
    // loud. Silence stands still.
    this.phase += dt * 2.6 * this.level;
    const boost = 1 + 0.5 * this.kick;
    const wasFlat = this.flat;
    this.flat = !frame && tallest * boost < FLAT;

    // ── Per-point sums, shared by every line ──────────────────────────
    //
    // Line l at x is   Σ_k h_k·g_k(x)·sin(A_k(x) + δ_l)
    //                = cos δ_l · Σ h·g·sin A  +  sin δ_l · Σ h·g·cos A
    // so the two sums are computed once per point and each line is a
    // linear combination of them.
    const points = this.sumSin.length;
    if (!this.flat) {
      for (let i = 0; i < points; i++) {
        const xf = this.xf[i];
        let s = 0;
        let c = 0;
        for (let k = 0; k < PACKETS.length; k++) {
          const p = PACKETS[k];
          const d = (xf - p.x) / p.sigma;
          if (d > 3.2 || d < -3.2) continue;
          const env = this.heights[k] * Math.exp(-d * d);
          if (env < 1e-4) continue;
          const a = (2 * Math.PI * (xf - p.x)) / p.lambda - this.phase * (k % 2 ? 1 : -0.8) + k * 0.6;
          s += env * Math.sin(a);
          c += env * Math.cos(a);
        }
        // Kick boost first, then a soft limit to 1, so stacked packets and
        // a hard hit approach the panel's edge but never cross it.
        s *= boost;
        c *= boost;
        const m = Math.hypot(s, c);
        if (m > 0.0001) {
          const lim = Math.tanh(m) / m;
          s *= lim;
          c *= lim;
        }
        // Taper to nothing at both edges.
        const edge = Math.min(1, xf / 0.03, (1 - xf) / 0.03);
        this.sumSin[i] = s * edge * maxAmp;
        this.sumCos[i] = c * edge * maxAmp;
      }
    }

    // ── Draw ──────────────────────────────────────────────────────────
    if (this.flat && wasFlat) return; // identical to what is on screen
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, W, H);

    if (!this.flat) {
      ctx.lineWidth = 1;
      const lines = q.lines;
      const stepPx = q.step * dpr;
      let tier = -1;
      for (let l = 0; l < lines; l++) {
        const want = Math.min(TIER_COLORS.length - 1, Math.floor((l / lines) * TIER_COLORS.length));
        if (want !== tier) {
          tier = want;
          ctx.strokeStyle = TIER_COLORS[tier];
        }
        const cd = this.lineCos[l];
        const sd = this.lineSin[l];
        ctx.beginPath();
        ctx.moveTo(0, cy + cd * this.sumSin[0] + sd * this.sumCos[0]);
        for (let i = 1; i < points; i++) {
          ctx.lineTo(i * stepPx, cy + cd * this.sumSin[i] + sd * this.sumCos[i]);
        }
        ctx.stroke();
      }
    }

    // The axis, always there: it is what the wave settles back into.
    ctx.fillStyle = AXIS_COLOR;
    ctx.fillRect(0, Math.round(cy - 0.5 * dpr), W, Math.max(1, Math.round(dpr)));
  }
}

/** What a run of the loop looked like, for the journal. */
export interface WaveStats {
  seconds: number;
  /** Frames drawn while the wave was moving. 0 = flat the whole time. */
  movingFrames: number;
  /** Frames drawn per second while the wave was moving. */
  movingFps: number;
  /** The worst whole second while moving. */
  worstSecondFps: number;
  /** Longest gap between two moving frames — a single hitch shows here. */
  longestGapMs: number;
  quality: number;
}

/** Median frame gap above which a window counts as slow: 20fps. */
const SLOW_GAP_MS = 50;
const WINDOW_MS = 3000;

/**
 * Run a `WaveRenderer` on `canvas` until `stop()` is called; `stop()`
 * returns what the run looked like. `getFrame` is asked for the analysis
 * frame at most 30 times a second.
 *
 * Steps quality down when the *median* gap between drawn frames stays over
 * 50ms (under 20fps) for two 3-second windows in a row. The median, so a
 * one-off stall (a garbage collection, a screenshot) cannot permanently
 * degrade a renderer that is keeping up. Gaps over 250ms (a hidden tab)
 * are ignored outright, as are the periods when the line is flat and
 * nothing is drawn at all.
 */
export function startWaveLoop(
  canvas: HTMLCanvasElement,
  getFrame: (nowMs: number) => AnalysisFrame | null,
  onDegrade?: (level: number, medianGapMs: number) => void,
): { stop: () => WaveStats } {
  const renderer = new WaveRenderer(canvas);
  const started = performance.now();
  let raf = 0;
  let lastDraw = -1;
  let lastMoving = -1;

  // Governor window.
  let windowStart = -1;
  let gaps: number[] = [];
  let slowWindows = 0;

  // Stats.
  let movingFrames = 0;
  let movingMs = 0;
  let longestGap = 0;
  let secondStart = -1;
  let secondFrames = 0;
  let worstSecond = Infinity;

  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas);

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    // 30fps: on a 60Hz panel this draws every other vsync. The slack keeps
    // vsync jitter from skipping a frame we meant to draw.
    if (lastDraw >= 0 && now - lastDraw < FRAME_MS - 4) return;
    const frame = getFrame(now);
    if (frame === null && renderer.settled) {
      lastMoving = -1; // a pause is not a slow frame
      return;
    }
    lastDraw = now;
    renderer.render(now, frame);

    if (lastMoving >= 0) {
      const gap = now - lastMoving;
      if (gap < 250) {
        movingFrames++;
        movingMs += gap;
        if (gap > longestGap) longestGap = gap;
        if (secondStart < 0) secondStart = now;
        secondFrames++;
        if (now - secondStart >= 1000) {
          worstSecond = Math.min(worstSecond, (1000 * secondFrames) / (now - secondStart));
          secondStart = now;
          secondFrames = 0;
        }
        if (now - started > 2000) {
          if (windowStart < 0) windowStart = now;
          gaps.push(gap);
          if (now - windowStart > WINDOW_MS) {
            gaps.sort((a, b) => a - b);
            const median = gaps[gaps.length >> 1];
            slowWindows = median > SLOW_GAP_MS ? slowWindows + 1 : 0;
            if (slowWindows >= 2) {
              if (renderer.degrade()) onDegrade?.(renderer.qualityLevel, median);
              slowWindows = 0;
            }
            windowStart = -1;
            gaps = [];
          }
        }
      } else {
        secondStart = -1;
        secondFrames = 0;
      }
    }
    lastMoving = now;
  };
  raf = requestAnimationFrame(loop);

  return {
    stop: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      return {
        seconds: Math.round((performance.now() - started) / 1000),
        movingFrames,
        movingFps: movingMs > 0 ? Math.round((1000 * movingFrames) / movingMs) : 0,
        worstSecondFps: Number.isFinite(worstSecond) ? Math.round(worstSecond) : 0,
        longestGapMs: Math.round(longestGap),
        quality: renderer.qualityLevel,
      };
    },
  };
}

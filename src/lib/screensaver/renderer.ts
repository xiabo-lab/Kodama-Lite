import type { AnalysisFrame } from "./analyze";

/**
 * The screen saver's sound wave, drawn on a 2D canvas.
 *
 * Shape: a fan of thin lines through one horizontal axis. Each line is the
 * same wave at a different amplitude and a slightly different phase, which
 * is what reads as a twisted glowing ribbon rather than a single curve.
 * The wave's height along the axis is a sum of Gaussian "packets", one or
 * two per frequency band — bass in the middle, treble towards the edges —
 * so the music visibly pushes different parts of the screen.
 *
 * Built for the Pi's WebKitGTK as much as for a desktop browser:
 *
 *   - No `shadowBlur`. It is the obvious way to get glow and the most
 *     expensive thing a 2D canvas can be asked to do per frame. Glow comes
 *     from a few pre-rendered radial sprites added on top instead.
 *   - Lines are exactly 1 device pixel: Skia's hairline fast path. Measured
 *     in Chrome, 1.15px cost 9x more on the GPU and 2.5x more on the CPU
 *     for the same lines, because anything wider goes through the general
 *     stroker and a full path fill per line.
 *   - Lines are opaque and drawn `source-over`, dimmed by colour rather
 *     than alpha. A hairline is drawn segment by segment, and adjacent
 *     segments share their end pixel — with any translucency or additive
 *     blending that pixel is painted twice, which showed as a bright tick at
 *     every vertex. Opaque paint over itself is invisible.
 *   - The dimming lives in a small pool of pre-built gradients (brightness
 *     level × tier), and a frame switches between at most three of them:
 *     on Skia's CPU path every `strokeStyle` change rebuilds the shader,
 *     and one gradient per line measured ~7x slower.
 *   - Per line, per point, the cost is two multiplies and an add. Every
 *     trig call is hoisted into per-point sums shared by all lines (see
 *     `render`), so the line count is nearly free.
 *   - `startWaveLoop` steps quality down if the frame rate sags, ending at
 *     three-quarter resolution and 30fps rather than at a stutter.
 */

/** The reference image's palette, left to right. */
const STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [255, 59, 78]],
  [0.12, [122, 92, 255]],
  [0.3, [184, 77, 255]],
  [0.45, [77, 125, 255]],
  [0.55, [58, 160, 255]],
  [0.65, [163, 92, 255]],
  [0.78, [255, 92, 176]],
  [0.9, [192, 96, 255]],
  [1.0, [63, 230, 255]],
];

const BACKGROUND = "#03040b";

/** Lines are split into tiers, inner (low, dim) to outer (tall, bright),
 *  each with its own pre-dimmed gradient. */
const TIERS = [0.5, 0.75, 1.0];
/** Pre-built overall brightness steps, so the beat can brighten the lines
 *  without per-frame gradient construction. Fine enough that a step is
 *  not visible through the smoothing. */
const BRIGHT_LEVELS = 10;
const BRIGHT_MIN = 0.7;
const BRIGHT_MAX = 1.15;

function colorAt(t: number): [number, number, number] {
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i];
    if (t <= p1) {
      const [p0, c0] = STOPS[i - 1];
      const w = (t - p0) / (p1 - p0 || 1);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * w)) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

interface Packet {
  /** Centre, as a fraction of the width. */
  x: number;
  /** Gaussian half-width, as a fraction of the width. */
  sigma: number;
  /** Which analysis band drives it. */
  band: number;
  /** Carrier wavelength, as a fraction of the width — tighter for treble. */
  lambda: number;
  /** Resting height when nothing is playing, as a fraction of max. */
  idle: number;
  /** How hard its band can push it. */
  gain: number;
}

/** Laid out after the reference: the tallest lobes just left of centre,
 *  smaller ones trailing off towards both edges. */
const PACKETS: Packet[] = [
  { x: 0.08, sigma: 0.04, band: 7, lambda: 0.11, idle: 0.1, gain: 0.55 },
  { x: 0.19, sigma: 0.05, band: 5, lambda: 0.13, idle: 0.16, gain: 0.7 },
  { x: 0.29, sigma: 0.055, band: 3, lambda: 0.15, idle: 0.22, gain: 0.8 },
  { x: 0.39, sigma: 0.06, band: 1, lambda: 0.18, idle: 0.42, gain: 1.0 },
  { x: 0.48, sigma: 0.065, band: 0, lambda: 0.2, idle: 0.32, gain: 1.0 },
  { x: 0.58, sigma: 0.06, band: 2, lambda: 0.17, idle: 0.34, gain: 0.9 },
  { x: 0.68, sigma: 0.055, band: 4, lambda: 0.15, idle: 0.24, gain: 0.8 },
  { x: 0.78, sigma: 0.05, band: 6, lambda: 0.13, idle: 0.22, gain: 0.7 },
  { x: 0.9, sigma: 0.04, band: 7, lambda: 0.11, idle: 0.12, gain: 0.55 },
];

interface Quality {
  lines: number;
  /** Distance between path points, in CSS px. */
  step: number;
  /** Backing-store resolution relative to the CSS size. */
  scale: number;
  /** Draw every Nth animation frame. */
  every: number;
}

const QUALITY: Quality[] = [
  { lines: 28, step: 8, scale: 1, every: 1 },
  { lines: 20, step: 10, scale: 1, every: 1 },
  { lines: 14, step: 12, scale: 1, every: 1 },
  { lines: 12, step: 12, scale: 0.75, every: 2 },
];

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
  private background: HTMLCanvasElement | null = null;
  /** `[brightnessLevel][tier]` — see BRIGHT_LEVELS and TIERS. */
  private strokes: CanvasGradient[][] = [];
  /** Full-brightness gradient, for the axis. */
  private axis: CanvasGradient | null = null;
  private sprites: HTMLCanvasElement[] = [];

  // Smoothed state, carried between frames.
  private heights = new Float32Array(PACKETS.length);
  private level = 0;
  private kick = 0;
  /** 0 = idle breathing, 1 = fully driven by the analysis. */
  private reactive = 0;
  private phase = 0;
  private lastT = -1;

  // Per-frame scratch, sized on resize.
  private sumSin = new Float32Array(0);
  private sumCos = new Float32Array(0);

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.heights.set(PACKETS.map((p) => p.idle));
    this.resize();
  }

  get qualityLevel(): number {
    return this.quality;
  }

  get frameDivisor(): number {
    return QUALITY[this.quality].every;
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
    this.buildStatics();
  }

  private buildStatics(): void {
    const { width: W, height: H } = this;

    // Background: near-black with a faint blue haze along the axis, drawn
    // once and blitted every frame.
    const bg = document.createElement("canvas");
    bg.width = W;
    bg.height = H;
    const b = bg.getContext("2d")!;
    b.fillStyle = BACKGROUND;
    b.fillRect(0, 0, W, H);
    b.save();
    b.translate(W / 2, H / 2);
    b.scale(1, (H / W) * 1.6);
    const haze = b.createRadialGradient(0, 0, 0, 0, 0, W * 0.55);
    haze.addColorStop(0, "rgba(46, 70, 190, 0.22)");
    haze.addColorStop(0.5, "rgba(40, 50, 140, 0.08)");
    haze.addColorStop(1, "rgba(0, 0, 0, 0)");
    b.fillStyle = haze;
    b.fillRect(-W, -W, W * 2, W * 2);
    b.restore();
    this.background = bg;

    const gradient = (k: number) => {
      const g = this.ctx.createLinearGradient(0, 0, W, 0);
      for (const [p, rgb] of STOPS) {
        const [r, gg, bb] = rgb.map((v) => Math.min(255, Math.round(v * k)));
        g.addColorStop(p, `rgb(${r}, ${gg}, ${bb})`);
      }
      return g;
    };
    this.strokes = Array.from({ length: BRIGHT_LEVELS }, (_, level) => {
      const b = BRIGHT_MIN + ((BRIGHT_MAX - BRIGHT_MIN) * level) / (BRIGHT_LEVELS - 1);
      return TIERS.map((tier) => gradient(b * tier));
    });
    this.axis = gradient(1);

    // One soft bloom per packet, tinted with the palette at its position.
    this.sprites = PACKETS.map((p) => {
      const [r, gg, bb] = colorAt(p.x);
      const s = document.createElement("canvas");
      s.width = s.height = 128;
      const c = s.getContext("2d")!;
      const rg = c.createRadialGradient(64, 64, 0, 64, 64, 64);
      rg.addColorStop(0, `rgba(${r}, ${gg}, ${bb}, 0.55)`);
      rg.addColorStop(0.4, `rgba(${r}, ${gg}, ${bb}, 0.18)`);
      rg.addColorStop(1, `rgba(${r}, ${gg}, ${bb}, 0)`);
      c.fillStyle = rg;
      c.fillRect(0, 0, 128, 128);
      return s;
    });
  }

  /**
   * Draw one frame. `frame` is the analysis at the moment being heard, or
   * null for "nothing to react to" — paused, muted, not analysed yet — in
   * which case the wave eases into its slow idle breathing.
   */
  render(nowMs: number, frame: AnalysisFrame | null): void {
    const t = nowMs / 1000;
    const dt = this.lastT < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;

    const q = QUALITY[this.quality];
    const { ctx, width: W, height: H, dpr } = this;
    const cy = H / 2;
    const maxAmp = H * 0.47;

    // ── Smoothed drive ─────────────────────────────────────────────────
    this.reactive = approach(this.reactive, frame ? 1 : 0, dt, 0.8);
    const r = this.reactive;
    this.level = approach(this.level, frame ? frame.level : 0, dt, 0.25);
    this.kick = Math.max(this.kick * Math.exp(-dt / 0.18), frame ? frame.onset : 0);
    const kick = this.kick * r;

    for (let k = 0; k < PACKETS.length; k++) {
      const p = PACKETS[k];
      // Idle: each packet breathes on an 8s cycle, out of step with its
      // neighbours so the wave rolls rather than pulses.
      const idle = p.idle * (0.75 + 0.25 * Math.sin((2 * Math.PI * t) / 8 + k * 0.9));
      const band = frame ? frame.bands[p.band] : 0;
      const driven = 0.12 + 1.15 * band ** 1.2 * p.gain;
      const target = (1 - r) * idle + r * driven;
      // Fast attack, slow release: hits land, decays glide.
      const tau = target > this.heights[k] ? 0.05 : 0.3;
      this.heights[k] = approach(this.heights[k], target, dt, tau);
    }

    this.phase += dt * (0.35 + r * (0.5 + 1.6 * this.level));
    const bright = Math.min(BRIGHT_MAX, 0.72 + r * (0.25 * this.level + 0.35 * kick) + (1 - r) * 0.1);
    const boost = 1 + 0.3 * kick;

    // ── Per-point sums, shared by every line ──────────────────────────
    //
    // Line l at x is   Σ_k h_k·g_k(x)·sin(A_k(x) + δ_l)
    //                = cos δ_l · Σ h·g·sin A  +  sin δ_l · Σ h·g·cos A
    // so the two sums are computed once per point and each line is a
    // linear combination of them.
    const points = this.sumSin.length;
    const stepPx = q.step * dpr;
    const centres = PACKETS.map((p, k) => p.x + 0.015 * Math.sin(t * 0.07 + k * 1.7));
    for (let i = 0; i < points; i++) {
      const xf = Math.min(1, (i * stepPx) / W);
      let s = 0;
      let c = 0;
      for (let k = 0; k < PACKETS.length; k++) {
        const p = PACKETS[k];
        const d = (xf - centres[k]) / p.sigma;
        if (d > 3.2 || d < -3.2) continue;
        const env = this.heights[k] * Math.exp(-d * d);
        const a = (2 * Math.PI * (xf - centres[k])) / p.lambda - this.phase * (k % 2 ? 1 : -0.8) + k * 0.6;
        s += env * Math.sin(a);
        c += env * Math.cos(a);
      }
      // Soft limit to 1, applied after the kick boost, so stacked packets
      // and a hard hit can approach the panel's edge but never cross it.
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

    // ── Draw ──────────────────────────────────────────────────────────
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    if (this.background) ctx.drawImage(this.background, 0, 0);

    // Lines first, inner (dim) to outer (bright) so the brightest are on
    // top. Opaque — see the header for why that matters.
    const level = Math.round(
      Math.min(1, Math.max(0, (bright - BRIGHT_MIN) / (BRIGHT_MAX - BRIGHT_MIN))) *
        (BRIGHT_LEVELS - 1),
    );
    const palette = this.strokes[level];
    ctx.lineWidth = 1;
    const lines = q.lines;
    let tier = -1;
    for (let l = 0; l < lines; l++) {
      const u = lines > 1 ? l / (lines - 1) : 1;
      const amp = 0.12 + 0.88 * u ** 0.8;
      const delta = (u - 0.5) * 1.1 + 0.22 * Math.sin(t * 0.5 + l * 0.37);
      const cd = Math.cos(delta) * amp;
      const sd = Math.sin(delta) * amp;
      const want = Math.min(TIERS.length - 1, Math.floor(u * TIERS.length));
      if (want !== tier) {
        tier = want;
        ctx.strokeStyle = palette[tier];
      }
      ctx.beginPath();
      ctx.moveTo(0, cy + cd * this.sumSin[0] + sd * this.sumCos[0]);
      for (let i = 1; i < points; i++) {
        ctx.lineTo(i * stepPx, cy + cd * this.sumSin[i] + sd * this.sumCos[i]);
      }
      ctx.stroke();
    }

    // Glow, added over the lines: a bloom behind each lobe, scaled with
    // its height, then the axis as stacked rectangles — the cheapest thing
    // a canvas draws. Three soft bands, then a bright core.
    ctx.globalCompositeOperation = "lighter";
    for (let k = 0; k < PACKETS.length; k++) {
      const h = this.heights[k] * boost;
      const a = Math.min(1, h * 1.3) * bright * 0.8;
      if (a < 0.02) continue;
      const w = PACKETS[k].sigma * W * 5;
      const hh = Math.max(H * 0.25, h * maxAmp * 2.6);
      ctx.globalAlpha = Math.min(1, a);
      ctx.drawImage(this.sprites[k], centres[k] * W - w / 2, cy - hh / 2, w, hh);
    }

    ctx.fillStyle = this.axis!;
    for (const [half, alpha] of [
      [6, 0.05],
      [3, 0.09],
      [1.5, 0.14],
    ]) {
      ctx.globalAlpha = alpha * bright;
      ctx.fillRect(0, cy - half * dpr, W, 2 * half * dpr);
    }
    ctx.globalAlpha = Math.min(1, 0.85 * bright);
    ctx.fillRect(0, cy - 0.75 * dpr, W, Math.max(1, 1.5 * dpr));

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }
}

/** Median rAF gap above which a window counts as slow: ~45fps. */
const SLOW_GAP_MS = 22;
const WINDOW_MS = 3000;

/**
 * Run a `WaveRenderer` on `canvas` until the returned function is called.
 * `getFrame` is asked for the analysis frame on every drawn frame.
 *
 * Watches its own frame rate and steps quality down when the *median*
 * frame gap stays over ~22ms (under ~45fps) for two 3-second windows in a
 * row. The median, not the mean, on purpose: the track analysis runs on
 * this same thread in slices, and a garbage collection or a screenshot
 * stalls a few frames — a mean counted those and degraded a renderer that
 * was keeping up fine, permanently. A renderer that is genuinely too
 * expensive is slow on most frames, which is what a median sees. Gaps
 * over 250ms (a hidden tab) are ignored outright. `onDegrade` hears about
 * each step, with the median gap that caused it.
 */
export function startWaveLoop(
  canvas: HTMLCanvasElement,
  getFrame: (nowMs: number) => AnalysisFrame | null,
  onDegrade?: (level: number, medianGapMs: number) => void,
): () => void {
  const renderer = new WaveRenderer(canvas);
  let raf = 0;
  let tick = 0;
  let last = -1;
  let windowStart = -1;
  let gaps: number[] = [];
  let slowWindows = 0;
  const started = performance.now();

  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas);

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    tick++;
    if (last >= 0) {
      const gap = now - last;
      if (gap < 250 && now - started > 2000) {
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
    }
    last = now;
    if (tick % renderer.frameDivisor !== 0) return;
    renderer.render(now, getFrame(now));
  };
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
  };
}

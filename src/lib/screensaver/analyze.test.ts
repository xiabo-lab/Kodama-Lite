import { describe, expect, it } from "vitest";
import { analyzeBuffer, bandBins, BANDS, emptyFrame, sampleAt, type Analysis } from "./analyze";
import { fft } from "./fft";

const RATE = 11025;

/** A tone that is on for one second and off for the next, repeated — a
 *  constant tone would normalise to nothing, since every band is scaled
 *  between its own quiet and loud moments. */
function gatedTone(hz: number, seconds: number): Float32Array {
  const out = new Float32Array(RATE * seconds);
  for (let i = 0; i < out.length; i++) {
    const on = Math.floor(i / RATE) % 2 === 0;
    out[i] = on ? 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE) : 0;
  }
  return out;
}

/** Index of the loudest band in a frame. */
function loudestBand(a: Analysis, frame: number): number {
  let best = 0;
  for (let b = 1; b < BANDS; b++) {
    if (a.bands[frame * BANDS + b] > a.bands[frame * BANDS + best]) best = b;
  }
  return best;
}

describe("fft", () => {
  it("puts a pure bin-centred tone in its bin", () => {
    const n = 64;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
    fft(re, im);
    const mag = Array.from(re, (r, i) => Math.hypot(r, im[i]));
    expect(mag[5]).toBeCloseTo(n / 2, 3);
    expect(mag[59]).toBeCloseTo(n / 2, 3); // its mirror
    expect(mag[4]).toBeLessThan(1e-3);
  });
});

describe("bandBins", () => {
  for (const rate of [11025, 22050, 44100]) {
    it(`gives ${BANDS} contiguous, non-empty, in-range bands at ${rate}Hz`, () => {
      const bins = bandBins(rate);
      expect(bins).toHaveLength(BANDS);
      for (let b = 0; b < BANDS; b++) {
        const [lo, hi] = bins[b];
        expect(hi).toBeGreaterThan(lo);
        expect(lo).toBeGreaterThanOrEqual(1);
        expect(hi).toBeLessThanOrEqual(512);
        if (b > 0) expect(lo).toBe(bins[b - 1][1]);
      }
    });
  }
});

describe("analyzeBuffer", () => {
  it("lands a bass tone in a low band and a treble tone in the top band", async () => {
    const low = await analyzeBuffer([gatedTone(100, 4)], RATE);
    const high = await analyzeBuffer([gatedTone(3000, 4)], RATE);
    // Half a second in: the tone is on.
    const f = Math.round(0.5 * low.fps);
    expect(loudestBand(low, f)).toBe(1); // 73–134 Hz
    expect(low.bands[f * BANDS + 1]).toBeGreaterThan(0.9);
    expect(low.bands[f * BANDS + 7]).toBeLessThan(0.05);
    expect(loudestBand(high, f)).toBe(7); // 2.7–5 kHz
    expect(high.bands[f * BANDS + 0]).toBeLessThan(0.05);
  });

  it("reads the gated-off second as quiet", async () => {
    const a = await analyzeBuffer([gatedTone(100, 4)], RATE);
    const off = Math.round(1.5 * a.fps);
    expect(a.bands[off * BANDS + 1]).toBeLessThan(0.05);
    expect(a.level[off]).toBeLessThan(0.05);
    expect(a.level[Math.round(0.5 * a.fps)]).toBeGreaterThan(0.9);
  });

  it("turns silence into zeros, not NaN", async () => {
    const a = await analyzeBuffer([new Float32Array(RATE * 2)], RATE);
    expect(a.frames).toBe(60);
    for (const arr of [a.bands, a.level, a.onset]) {
      for (const v of arr) expect(v).toBe(0);
    }
  });

  it("puts onsets on the frames where a click train hits", async () => {
    const pcm = new Float32Array(RATE * 4);
    const hits = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
    for (const t of hits) {
      const start = Math.round(t * RATE);
      for (let i = 0; i < 200; i++) pcm[start + i] = (i % 2 ? -1 : 1) * Math.exp(-i / 40);
    }
    const a = await analyzeBuffer([pcm], RATE);
    const strong = Array.from(a.onset, (v, f) => [v, f] as const)
      .filter(([v]) => v > 0.5)
      .map(([, f]) => f / a.fps);
    expect(strong.length).toBeGreaterThan(0);
    // Every strong onset sits on (or one frame either side of) a click.
    for (const t of strong) {
      expect(hits.some((h) => Math.abs(h - t) <= 1.5 / a.fps)).toBe(true);
    }
  });

  it("mixes stereo down rather than reading one channel", async () => {
    const left = gatedTone(100, 2);
    const silent = new Float32Array(left.length);
    const a = await analyzeBuffer([silent, left], RATE);
    expect(a.bands[Math.round(0.5 * a.fps) * BANDS + 1]).toBeGreaterThan(0.9);
  });

  it("stops when aborted", async () => {
    const ctrl = new AbortController();
    const run = analyzeBuffer([gatedTone(100, 30)], RATE, ctrl.signal);
    ctrl.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("sampleAt", () => {
  const a: Analysis = {
    fps: 10,
    frames: 3,
    bands: Float32Array.from({ length: 3 * BANDS }, (_, i) => Math.floor(i / BANDS) * 0.5),
    level: Float32Array.from([0, 0.5, 1]),
    onset: Float32Array.from([0, 1, 0]),
  };

  it("interpolates between frames", () => {
    const f = sampleAt(a, 0.05, emptyFrame()); // halfway from frame 0 to 1
    expect(f.bands[3]).toBeCloseTo(0.25);
    expect(f.level).toBeCloseTo(0.25);
  });

  it("keeps an onset spike rather than halving it", () => {
    expect(sampleAt(a, 0.08, emptyFrame()).onset).toBe(1);
  });

  it("reads silence outside the track", () => {
    for (const t of [-1, 0.21, 99, Number.NaN]) {
      const f = sampleAt(a, t, emptyFrame());
      expect(f.level).toBe(0);
      expect(Array.from(f.bands).every((v) => v === 0)).toBe(true);
    }
  });
});

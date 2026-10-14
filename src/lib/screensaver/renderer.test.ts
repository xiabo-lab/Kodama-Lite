import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BANDS, emptyFrame, type AnalysisFrame } from "./analyze";
import { WaveRenderer } from "./renderer";

/**
 * The renderer against a recording fake canvas — enough to pin down what
 * the user asked for in v0.1.60 without a browser: still and straight when
 * there is no sound, grey rather than colour, hairlines only, and no work
 * at all while it is settled.
 */

interface Call {
  op: string;
  args: number[];
  style?: string;
}

function fakeCanvas() {
  const calls: Call[] = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1 };
  const ctx = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    fillRect: (...args: number[]) => calls.push({ op: "fillRect", args, style: state.fillStyle }),
    beginPath: () => calls.push({ op: "beginPath", args: [] }),
    moveTo: (...args: number[]) => calls.push({ op: "moveTo", args }),
    lineTo: (...args: number[]) => calls.push({ op: "lineTo", args }),
    stroke: () => calls.push({ op: "stroke", args: [state.lineWidth], style: state.strokeStyle }),
  };
  const canvas = {
    clientWidth: 1920,
    clientHeight: 440,
    width: 0,
    height: 0,
    getContext: () => ctx,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, calls };
}

function loud(): AnalysisFrame {
  const f = emptyFrame();
  f.bands.fill(0.9);
  f.level = 0.8;
  f.onset = 1;
  return f;
}

/** Render `n` frames 33ms apart, starting at `t0` ms. */
function run(r: WaveRenderer, t0: number, n: number, frame: () => AnalysisFrame | null): number {
  for (let i = 0; i < n; i++) r.render(t0 + i * 33, frame());
  return t0 + n * 33;
}

function rgb(style: string): number[] {
  return (style.match(/\d+/g) ?? []).map(Number);
}

beforeAll(() => {
  vi.stubGlobal("window", { devicePixelRatio: 1 });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("WaveRenderer", () => {
  it("with no sound, draws a straight line and nothing else", () => {
    const { canvas, calls } = fakeCanvas();
    const r = new WaveRenderer(canvas);
    r.render(0, null);
    expect(calls.filter((c) => c.op === "stroke")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "fillRect")).toHaveLength(2); // background + axis
    expect(r.settled).toBe(true);
  });

  it("does no drawing at all while settled", () => {
    const { canvas, calls } = fakeCanvas();
    const r = new WaveRenderer(canvas);
    r.render(0, null);
    calls.length = 0;
    run(r, 33, 30, () => null);
    expect(calls).toHaveLength(0);
  });

  it("stays a straight line through a silent passage of a playing song", () => {
    const { canvas, calls } = fakeCanvas();
    const r = new WaveRenderer(canvas);
    run(r, 0, 30, () => emptyFrame()); // analysed, playing, all bands zero
    const ys = calls.filter((c) => c.op === "lineTo" || c.op === "moveTo").map((c) => c.args[1]);
    for (const y of ys) expect(Math.abs(y - 220)).toBeLessThan(1);
  });

  it("moves with the music, in 1px grey lines that stay on the panel", () => {
    const { canvas, calls } = fakeCanvas();
    const r = new WaveRenderer(canvas);
    run(r, 0, 10, loud);
    const strokes = calls.filter((c) => c.op === "stroke");
    expect(strokes.length).toBeGreaterThan(0);
    for (const s of strokes) {
      expect(s.args[0]).toBe(1); // hairline
      const [red, green, blue] = rgb(s.style!);
      // Grey: no channel more than a few steps from the others.
      expect(Math.max(red, green, blue) - Math.min(red, green, blue)).toBeLessThanOrEqual(6);
      // Dim: nothing near full white.
      expect(Math.max(red, green, blue)).toBeLessThanOrEqual(160);
    }
    const ys = calls.filter((c) => c.op === "lineTo").map((c) => c.args[1]);
    const spread = Math.max(...ys) - Math.min(...ys);
    expect(spread).toBeGreaterThan(200); // a real wave, not a twitch
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(440);
    }
  });

  it("settles back to a still line within a second or two of the sound stopping", () => {
    const { canvas, calls } = fakeCanvas();
    const r = new WaveRenderer(canvas);
    const t = run(r, 0, 30, loud);
    expect(r.settled).toBe(false);
    run(r, t, 60, () => null); // 2s of silence
    expect(r.settled).toBe(true);
    calls.length = 0;
    r.render(t + 61 * 33, null);
    expect(calls).toHaveLength(0);
  });

  it("does not move sideways on its own: a held, unchanging sound is a still picture", () => {
    // Steady bands, no onset, zero loudness: nothing should travel.
    const steady = emptyFrame();
    steady.bands.fill(0.6);
    steady.level = 0;
    const { canvas, calls } = fakeCanvas();
    const r = new WaveRenderer(canvas);
    const t = run(r, 0, 60, () => steady); // let heights converge
    calls.length = 0;
    r.render(t, steady);
    const a = calls.filter((c) => c.op === "lineTo").map((c) => c.args[1]);
    calls.length = 0;
    r.render(t + 2000, steady);
    const b = calls.filter((c) => c.op === "lineTo").map((c) => c.args[1]);
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.5);
  });

  it("uses one band per packet, so the frame shape matters", () => {
    expect(emptyFrame().bands).toHaveLength(BANDS);
  });
});

// Dev-only preview of the screen saver wave. Served by `npx vite` at
// /docs/screensaver-preview.html; not part of the app build.
import {
  analyzeBuffer,
  emptyFrame,
  sampleAt,
  BANDS,
  type Analysis,
  type AnalysisFrame,
} from "../src/lib/screensaver/analyze";
import { startWaveLoop } from "../src/lib/screensaver/renderer";

type Mode = "idle" | "demo" | "file" | "sim";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("wave");
const stage = $<HTMLDivElement>("stage");
const statusEl = $<HTMLSpanElement>("status");
const hint = $<HTMLSpanElement>("hint");
const meter = $<HTMLDivElement>("meter");
const bars: HTMLSpanElement[] = [];
for (let b = 0; b < BANDS; b++) bars.push(meter.appendChild(document.createElement("span")));

let mode: Mode = "idle";
let analysis: Analysis | null = null;
let demoAnalysis: Analysis | null = null;
let demoBuffer: AudioBuffer | null = null;
let ctx: AudioContext | null = null;
let demoSource: AudioBufferSourceNode | null = null;
let demoStart = 0;
let simStart = 0;
const audio = new Audio();
let timing: Record<string, number> = {};
const frame: AnalysisFrame = emptyFrame();

function setStatus(s: string) {
  statusEl.textContent = s;
}

function setMode(m: Mode) {
  mode = m;
  for (const [id, on] of [
    ["demo", m === "demo"],
    ["idle", m === "idle"],
    ["sim", m === "sim"],
  ] as const) {
    $(id).classList.toggle("on", on);
  }
  if (m !== "demo" && demoSource) {
    demoSource.stop();
    demoSource = null;
  }
  if (m !== "file") audio.pause();
}

// ── The generated demo track ─────────────────────────────────────────
//
// 120 BPM, 16 bars: kick, snare, hats, a sawtooth bass line and a pad, with
// a two-bar breakdown (no drums) in bars 9-10 so the wave visibly calms
// and then hits again.

const BPM = 120;
const BEAT = 60 / BPM;
const BARS = 16;
const DEMO_SECONDS = BARS * 4 * BEAT;

function noiseBuffer(c: BaseAudioContext): AudioBuffer {
  const b = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/** One bar in its own small OfflineAudioContext. Scheduling the whole
 *  track in one context made Chrome process every not-yet-started node on
 *  every render quantum — 12s for 32s of audio. */
const TAIL = 0.6;
async function renderBar(bar: number, rate: number): Promise<AudioBuffer> {
  const c = new OfflineAudioContext(2, Math.ceil((4 * BEAT + TAIL) * rate), rate);
  const master = c.createGain();
  master.gain.value = 0.55;
  master.connect(c.destination);
  const noise = noiseBuffer(c);

  const kick = (t: number) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.3);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.45);
  };
  const snare = (t: number) => {
    const n = c.createBufferSource();
    n.buffer = noise;
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1200;
    const g = c.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    n.connect(hp).connect(g).connect(master);
    n.start(t);
    n.stop(t + 0.25);
    const o = c.createOscillator();
    const og = c.createGain();
    o.frequency.value = 190;
    og.gain.setValueAtTime(0.35, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(og).connect(master);
    o.start(t);
    o.stop(t + 0.15);
  };
  const hat = (t: number, v: number) => {
    const n = c.createBufferSource();
    n.buffer = noise;
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = c.createGain();
    g.gain.setValueAtTime(0.18 * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(hp).connect(g).connect(master);
    n.start(t);
    n.stop(t + 0.06);
  };
  const note = (t: number, dur: number, hz: number, type: OscillatorType, vol: number, cutoff: number) => {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = cutoff;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.setTargetAtTime(0, t + dur * 0.7, dur * 0.2);
    o.connect(lp).connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.3);
  };

  // A minor: Am, F, C, G — bass roots and pad triads.
  const roots = [55, 43.65, 65.41, 49];
  const triads = [
    [220, 261.63, 329.63],
    [174.61, 220, 261.63],
    [261.63, 329.63, 392],
    [196, 246.94, 293.66],
  ];
  {
    const t0 = 0;
    const breakdown = bar === 8 || bar === 9;
    const chord = bar % 4;
    for (let beat = 0; beat < 4; beat++) {
      const t = t0 + beat * BEAT;
      if (!breakdown) {
        kick(t);
        if (beat === 1 || beat === 3) snare(t);
      }
      hat(t, breakdown ? 0.3 : 1);
      hat(t + BEAT / 2, breakdown ? 0.2 : 0.7);
    }
    for (let e = 0; e < 8; e++) {
      if (breakdown && e % 2) continue;
      note(t0 + (e * BEAT) / 2, BEAT / 2, roots[chord] * (e % 4 === 3 ? 2 : 1), "sawtooth", 0.32, 420);
    }
    for (const hz of triads[chord]) note(t0, 4 * BEAT, hz, "triangle", breakdown ? 0.12 : 0.07, 2500);
    // A high arpeggio in the second half, for the treble packets.
    if (bar >= 10) {
      for (let s = 0; s < 16; s++) {
        note(t0 + (s * BEAT) / 4, BEAT / 4, triads[chord][s % 3] * 4, "square", 0.025, 6000);
      }
    }
  }
  return c.startRendering();
}

async function renderDemo(rate: number): Promise<AudioBuffer> {
  const bars = await Promise.all(Array.from({ length: BARS }, (_, b) => renderBar(b, rate)));
  const length = Math.ceil(DEMO_SECONDS * rate);
  const out = new AudioBuffer({ length, numberOfChannels: 2, sampleRate: rate });
  for (let ch = 0; ch < 2; ch++) {
    const dst = out.getChannelData(ch);
    bars.forEach((b, i) => {
      const src = b.getChannelData(ch);
      // Overlap-add, wrapping the last bar's tail onto the start so the
      // loop point is seamless.
      const off = Math.round(i * 4 * BEAT * rate);
      for (let k = 0; k < src.length; k++) dst[(off + k) % length] += src[k];
    });
  }
  return out;
}

/** Resample through an OfflineAudioContext at 11025Hz, exactly what the
 *  app's decodeAudioData does to a real track before analysing it. */
async function resample(buf: AudioBuffer, rate: number): Promise<AudioBuffer> {
  const c = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(buf.duration * rate), rate);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  src.start();
  return c.startRendering();
}

async function ensureDemo(): Promise<void> {
  if (demoBuffer && demoAnalysis) return;
  setStatus("Generating demo track…");
  const t0 = performance.now();
  demoBuffer = await renderDemo(44100);
  const t1 = performance.now();
  const low = await resample(demoBuffer, 11025);
  const t2 = performance.now();
  demoAnalysis = await analyzeBuffer([low.getChannelData(0), low.getChannelData(1)], low.sampleRate, { sliceMs: 5 });
  const t3 = performance.now();
  timing = { render: t1 - t0, resample: t2 - t1, analyze: t3 - t2, frames: demoAnalysis.frames };
  setStatus(`Demo analyzed: ${demoAnalysis.frames} frames in ${Math.round(t3 - t2)} ms.`);
}

// ── Controls ─────────────────────────────────────────────────────────

$("demo").addEventListener("click", async () => {
  ctx ??= new AudioContext();
  await ctx.resume();
  await ensureDemo();
  setMode("demo");
  analysis = demoAnalysis;
  demoSource = ctx.createBufferSource();
  demoSource.buffer = demoBuffer;
  demoSource.loop = true;
  demoSource.connect(ctx.destination);
  demoStart = ctx.currentTime + 0.05;
  demoSource.start(demoStart);
  setStatus("Playing demo beat. The breakdown comes at about 0:16.");
});

$("sim").addEventListener("click", async () => {
  await ensureDemo();
  setMode("sim");
  analysis = demoAnalysis;
  simStart = performance.now();
  setStatus("Simulating the demo beat with no sound.");
});

$("idle").addEventListener("click", () => {
  setMode("idle");
  setStatus("Idle: nothing playing.");
});

$<HTMLInputElement>("file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  setMode("idle");
  setStatus(`Decoding and analyzing “${file.name}”…`);
  try {
    const t0 = performance.now();
    // Same decode the app does: resample to 11025Hz while decoding.
    const decoded = await new OfflineAudioContext(1, 1, 11025).decodeAudioData(await file.arrayBuffer());
    const chans = Array.from({ length: Math.min(2, decoded.numberOfChannels) }, (_, c) => decoded.getChannelData(c));
    analysis = await analyzeBuffer(chans, decoded.sampleRate, { sliceMs: 5 });
    const ms = Math.round(performance.now() - t0);
    audio.src = URL.createObjectURL(file);
    await audio.play();
    setMode("file");
    setStatus(`Playing “${file.name}”. Analyzed ${analysis.frames} frames in ${ms} ms.`);
  } catch (err) {
    setStatus(`Couldn't analyze that file: ${(err as Error).message}`);
  }
});
audio.addEventListener("ended", () => {
  setMode("idle");
  setStatus("Idle: nothing playing.");
});

$("full").addEventListener("click", () => {
  void stage.requestFullscreen?.();
});
const exitFull = () => {
  if (document.fullscreenElement) void document.exitFullscreen();
};
stage.addEventListener("pointerdown", exitFull);
window.addEventListener("keydown", exitFull);
document.addEventListener("fullscreenchange", () => {
  hint.textContent = document.fullscreenElement ? "tap or press any key to exit" : "";
});

// ── The loop ─────────────────────────────────────────────────────────

function currentTime(now: number): number | null {
  switch (mode) {
    case "demo":
      if (!ctx) return null;
      // Subtract the output latency so the picture matches the speakers,
      // the same job lyricsOffsetSec does for Bluetooth in the app.
      return (ctx.currentTime - demoStart - (ctx.outputLatency || 0)) % DEMO_SECONDS;
    case "sim":
      return ((now - simStart) / 1000) % DEMO_SECONDS;
    case "file":
      return audio.paused ? null : audio.currentTime;
    default:
      return null;
  }
}

startWaveLoop(canvas, (now) => {
  const t = currentTime(now);
  if (t === null || t < 0 || !analysis) {
    for (const b of bars) b.style.height = "2px";
    return null;
  }
  sampleAt(analysis, t, frame);
  for (let b = 0; b < BANDS; b++) bars[b].style.height = `${2 + frame.bands[b] * 38}px`;
  return frame;
}, (level, gap) => {
  hint.textContent = `quality stepped down to level ${level} (median frame ${gap.toFixed(1)} ms)`;
});

// Handy for driving the page from devtools.
(window as unknown as Record<string, unknown>).__saver = { setMode, ensureDemo, timing: () => timing };

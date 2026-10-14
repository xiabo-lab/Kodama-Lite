import { fft } from "./fft";

/**
 * Offline band analysis for the screen saver's sound wave — the pure part,
 * safe to run in a Web Worker, in tests, or on the main thread.
 *
 * **Why offline, and not an `AnalyserNode` on the playing element.** The
 * live route is `createMediaElementSource(el)`, and that moves the app's
 * audio off the element's own PipeWire stream and onto the AudioContext's.
 * `el.volume` is written straight through to that stream's
 * `channelVolumes` — the whole measured volume model in `audioEngine.ts`,
 * including the post-start re-assert, depends on it. Rerouting playback
 * for a visual is not a trade worth making in a car, where a volume
 * mistake is full volume.
 *
 * So the wave reads a second copy instead (see `pipeline.ts` for fetching
 * and decoding it), reduced here to a few floats per frame.
 */

export const BANDS = 8;
export const FPS = 30;
/**
 * 512 at 11025Hz is a 46ms window: half the cost of 1024, and twice the
 * time resolution, which is the part that matters — a kick drum is a
 * ~50ms event, and a 93ms window smeared it across three frames, which is
 * a large part of why the first version's wave looked loosely attached to
 * the beat. 21.5Hz bins are still fine enough for the lowest band.
 */
export const FFT_SIZE = 512;
const MIN_HZ = 40;
const MAX_HZ = 5000;
/** Band energies below this (dB of FFT power) are treated as silence, so a
 *  fade-out's dither floor cannot be normalised up into a full-height wave. */
const SILENCE_DB = -40;

export interface Analysis {
  fps: number;
  frames: number;
  /** `frames × BANDS`, each 0..1, normalised per track. */
  bands: Float32Array;
  /** Overall loudness per frame, 0..1. */
  level: Float32Array;
  /** Onset strength per frame, 0..1 — mostly kick and snare. */
  onset: Float32Array;
}

/** One instant of an `Analysis`, as the renderer consumes it. */
export interface AnalysisFrame {
  bands: Float32Array;
  level: number;
  onset: number;
}

export function emptyFrame(): AnalysisFrame {
  return { bands: new Float32Array(BANDS), level: 0, onset: 0 };
}

export function abortError(): Error {
  const e = new Error("analysis aborted");
  e.name = "AbortError";
  return e;
}

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

/** FFT bin ranges `[lo, hi)` for log-spaced bands between MIN_HZ and MAX_HZ,
 *  each at least one bin wide. */
export function bandBins(sampleRate: number): Array<[number, number]> {
  const binHz = sampleRate / FFT_SIZE;
  const top = Math.min(MAX_HZ, sampleRate / 2);
  const out: Array<[number, number]> = [];
  let prev = Math.max(1, Math.round(MIN_HZ / binHz));
  for (let b = 1; b <= BANDS; b++) {
    const hz = MIN_HZ * (top / MIN_HZ) ** (b / BANDS);
    let hi = Math.round(hz / binHz);
    hi = Math.min(FFT_SIZE / 2, Math.max(prev + 1, hi));
    out.push([prev, hi]);
    prev = hi;
  }
  return out;
}

function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Map dB values, in place, to 0..1 between the track's own 10th and 98th
 *  percentile. Returns the 98th percentile, so bands can be weighed against
 *  each other afterwards. */
function normalise(db: Float32Array): number {
  const hi = percentile(db, 0.98);
  const lo = Math.max(percentile(db, 0.1), SILENCE_DB);
  const span = hi - lo;
  for (let i = 0; i < db.length; i++) {
    db[i] = span < 1 ? 0 : Math.min(1, Math.max(0, (db[i] - lo) / span));
  }
  return hi;
}

/** Average channels into one. Returns the input itself when it is mono. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const len = channels[0]?.length ?? 0;
  const mono = new Float32Array(len);
  const k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] * k;
  return mono;
}

export interface AnalyzeOptions {
  signal?: AbortSignal;
  /**
   * Main-thread mode: work at most this many milliseconds before yielding
   * to the event loop. Omitted or 0 means never yield — right for a
   * worker, where nothing else is waiting on the thread.
   *
   * A time budget, not a frame count. The first version yielded every 240
   * frames, which is ~35ms in Chrome on a desktop and several times that on
   * the Pi — so while a track was being analysed the wave dropped to a
   * handful of frames a second, on every track change.
   */
  sliceMs?: number;
}

/**
 * Reduce decoded mono PCM to per-frame band energies, loudness and onsets.
 */
export async function analyzeMono(
  mono: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): Promise<Analysis> {
  const { signal, sliceMs = 0 } = opts;
  const len = mono.length;
  const hop = sampleRate / FPS;
  const frames = Math.max(0, Math.floor(len / hop));
  const bins = bandBins(sampleRate);
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  // Per-band dB series, transposed so each band normalises on its own.
  const bandDb = Array.from({ length: BANDS }, () => new Float32Array(frames));
  const levelDb = new Float32Array(frames);

  let sliceStart = performance.now();
  for (let f = 0; f < frames; f++) {
    if ((f & 15) === 0) {
      if (signal?.aborted) throw abortError();
      if (sliceMs > 0 && performance.now() - sliceStart > sliceMs) {
        await nextTick();
        if (signal?.aborted) throw abortError();
        sliceStart = performance.now();
      }
    }
    // Centred on the frame, so frame f describes the sound at f / FPS.
    const start = Math.round(f * hop + hop / 2 - FFT_SIZE / 2);
    let sq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const j = start + i;
      const s = j >= 0 && j < len ? mono[j] : 0;
      sq += s * s;
      re[i] = s * window[i];
      im[i] = 0;
    }
    // +60 puts SILENCE_DB at about -100 dBFS: only true silence is floored.
    levelDb[f] = 10 * Math.log10(sq / FFT_SIZE + 1e-12) + 60;
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      const [lo, hi] = bins[b];
      let p = 0;
      for (let k = lo; k < hi; k++) p += re[k] * re[k] + im[k] * im[k];
      bandDb[b][f] = 10 * Math.log10(p / (hi - lo) + 1e-12);
    }
  }
  if (signal?.aborted) throw abortError();

  // Per-band normalisation lets a quiet track still move, but taken alone
  // it would also blow a band that is nearly empty for this track up to
  // full height. Weigh each band by how far its peak sits below the
  // loudest band's.
  const peaks = bandDb.map(normalise);
  const loudest = Math.max(...peaks);
  const bands = new Float32Array(frames * BANDS);
  for (let b = 0; b < BANDS; b++) {
    const weight = Math.min(1, Math.max(0.25, 1 - (loudest - peaks[b]) / 40));
    const series = bandDb[b];
    for (let f = 0; f < frames; f++) bands[f * BANDS + b] = series[f] * weight;
  }
  normalise(levelDb);

  // Onsets: positive spectral flux, weighted towards the low bands (kick,
  // bass, snare body), minus a short running mean so a sustained loud
  // passage doesn't read as one long hit.
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    let sum = 0;
    for (let b = 0; b < BANDS; b++) {
      const d = bands[f * BANDS + b] - bands[(f - 1) * BANDS + b];
      if (d > 0) sum += b < 3 ? d : d * 0.5;
    }
    flux[f] = sum;
  }
  const onset = new Float32Array(frames);
  const MEAN_WINDOW = 8;
  let running = 0;
  for (let f = 0; f < frames; f++) {
    running += flux[f];
    if (f >= MEAN_WINDOW) running -= flux[f - MEAN_WINDOW];
    const mean = running / Math.min(f + 1, MEAN_WINDOW);
    onset[f] = Math.max(0, flux[f] - mean);
  }
  const onsetPeak = percentile(onset, 0.99);
  for (let f = 0; f < frames; f++) {
    onset[f] = onsetPeak > 1e-6 ? Math.min(1, onset[f] / onsetPeak) : 0;
  }

  return { fps: FPS, frames, bands, level: levelDb, onset };
}

/** `analyzeMono` over one or more channels. */
export function analyzeBuffer(
  channels: Float32Array[],
  sampleRate: number,
  opts: AnalyzeOptions = {},
): Promise<Analysis> {
  return analyzeMono(mixToMono(channels), sampleRate, opts);
}

/**
 * The analysis at time `t` seconds, linearly interpolated, written into
 * `out`. Outside the track it reads as silence rather than holding the
 * first or last frame.
 */
export function sampleAt(a: Analysis, t: number, out: AnalysisFrame): AnalysisFrame {
  const p = t * a.fps;
  if (!(p >= 0) || p > a.frames - 1 || a.frames === 0) {
    out.bands.fill(0);
    out.level = 0;
    out.onset = 0;
    return out;
  }
  const i = Math.floor(p);
  const j = Math.min(a.frames - 1, i + 1);
  const w = p - i;
  for (let b = 0; b < BANDS; b++) {
    out.bands[b] = a.bands[i * BANDS + b] * (1 - w) + a.bands[j * BANDS + b] * w;
  }
  out.level = a.level[i] * (1 - w) + a.level[j] * w;
  // Onsets are spikes; interpolating would halve every one that falls
  // between frames. Take the larger neighbour instead.
  out.onset = Math.max(a.onset[i], w > 0.5 ? a.onset[j] : 0);
  return out;
}

import { fetch as dataPlaneFetch } from "@/lib/http";
import { abortError, analyzeMono, mixToMono, type Analysis } from "./analyze";
import type { WorkerReply, WorkerRequest } from "./analysis.worker";

/**
 * Turns the playing track's stream URL into an `Analysis`: fetch the bytes,
 * decode them, analyse — every step of which has a fallback, because none
 * of them had run on the Pi before v0.1.59 shipped, and a failure anywhere
 * leaves the wave flat for the whole song.
 */

export const MAX_ANALYSIS_BYTES = 60 * 1024 * 1024;
export const MAX_ANALYSIS_SECONDS = 15 * 60;
/** Main-thread fallback: work per slice before yielding. Small enough that
 *  a 30fps wave (33ms a frame) keeps drawing while it runs. */
const MAIN_THREAD_SLICE_MS = 5;
/** How long a worker gets to say it loaded at all. */
const WORKER_READY_MS = 3000;

export interface TrackAnalysis {
  analysis: Analysis;
  /** Which HTTP stack delivered the bytes. */
  via: "webview" | "data-plane";
  /** Where the FFT work ran. */
  where: "worker" | "main thread";
  fetchMs: number;
  decodeMs: number;
  analyzeMs: number;
  /** Why the worker was given up on, the first time it was. */
  workerFailure?: string;
}

class HttpStatusError extends Error {}

/**
 * The webview's own `fetch` first; the data plane's HTTP client if the
 * webview refuses.
 *
 * Before the screen saver nothing in the app had ever fetched the local
 * stream server from the webview — `<audio>` and `<img>` load from it, but
 * those are media loads, which WebKit treats more leniently. The page is
 * served from `tauri://localhost`, a secure custom scheme, and a `fetch` of
 * plain `http://127.0.0.1` from a secure origin is exactly the request a
 * mixed-content check blocks. That surfaces as a TypeError, never as an
 * HTTP status, and the Rust side is not subject to it. A real status from
 * the server is a different matter and is not retried: it is the same
 * server either way.
 */
async function fetchBytes(url: string, signal: AbortSignal): Promise<{ data: ArrayBuffer; via: TrackAnalysis["via"] }> {
  const read = async (res: Response) => {
    if (!res.ok) throw new HttpStatusError(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_ANALYSIS_BYTES) throw new HttpStatusError(`too large (${declared} bytes)`);
    const data = await res.arrayBuffer();
    if (data.byteLength > MAX_ANALYSIS_BYTES) throw new HttpStatusError(`too large (${data.byteLength} bytes)`);
    return data;
  };
  try {
    return { data: await read(await fetch(url, { signal })), via: "webview" };
  } catch (e) {
    if (signal.aborted) throw abortError();
    if (e instanceof HttpStatusError) throw e;
    // The stream handler holds the response until a download finishes —
    // up to 120s — so the data plane's usual 15s deadline would cut off a
    // track that is merely still arriving.
    const res = await dataPlaneFetch(url, { signal, timeoutMs: 130_000 });
    return { data: await read(res), via: "data-plane" };
  }
}

/** An OfflineAudioContext at the lowest rate the engine accepts — decoding
 *  resamples to it, which is what keeps a four-minute track at ~20MB of PCM
 *  instead of ~85MB. */
function makeDecoder(): BaseAudioContext {
  for (const rate of [11025, 22050, 44100]) {
    try {
      return new OfflineAudioContext(1, 1, rate);
    } catch {
      /* rate unsupported by this engine — try the next */
    }
  }
  throw new Error("no OfflineAudioContext");
}

// ── Worker ─────────────────────────────────────────────────────────────

/** Cleared for the rest of the session the first time a worker fails, so a
 *  platform that cannot run one pays the ready timeout once, not per song. */
let workerUsable = true;
let workerFailure: string | undefined;

class WorkerUnavailable extends Error {}

function analyzeInWorker(mono: Float32Array, sampleRate: number, signal: AbortSignal): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      reject(new WorkerUnavailable(`could not start: ${(e as Error)?.message ?? e}`));
      return;
    }
    let ready = false;
    const finish = (settle: () => void) => {
      window.clearTimeout(readyTimer);
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      settle();
    };
    const readyTimer = window.setTimeout(() => {
      if (!ready) finish(() => reject(new WorkerUnavailable(`no ready signal in ${WORKER_READY_MS}ms`)));
    }, WORKER_READY_MS);
    const onAbort = () => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const m = e.data;
      if (m.type === "ready") {
        ready = true;
        window.clearTimeout(readyTimer);
        // Sent only now, so a worker that never loads never takes the PCM
        // with it: the fallback below still has it to work on.
        const req: WorkerRequest = { mono, sampleRate };
        worker.postMessage(req, [mono.buffer]);
      } else if (m.type === "done") {
        finish(() => resolve(m.analysis));
      } else {
        finish(() => reject(new Error(m.message)));
      }
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      const why = ev.message || "failed to load";
      finish(() => reject(ready ? new Error(`worker failed: ${why}`) : new WorkerUnavailable(why)));
    };
  });
}

/**
 * Fetch, decode and analyse one track. Throws on anything not worth (or
 * not possible) to analyse; the caller shows a flat line for that song.
 */
export async function analyzeTrack(url: string, signal: AbortSignal): Promise<TrackAnalysis> {
  const t0 = performance.now();
  const { data, via } = await fetchBytes(url, signal);
  const t1 = performance.now();
  // WebKit decodes on its own thread; only the promise lands here.
  const audio = await makeDecoder().decodeAudioData(data);
  if (signal.aborted) throw abortError();
  if (audio.duration > MAX_ANALYSIS_SECONDS) throw new Error(`too long (${Math.round(audio.duration)}s)`);
  const t2 = performance.now();

  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(audio.getChannelData(c));

  let analysis: Analysis | undefined;
  let where: TrackAnalysis["where"] = "worker";
  let failure: string | undefined;
  if (workerUsable && typeof Worker !== "undefined") {
    // An owned copy, never the AudioBuffer's own storage: it is transferred.
    const mono = channels.length === 1 ? channels[0].slice() : mixToMono(channels);
    try {
      analysis = await analyzeInWorker(mono, audio.sampleRate, signal);
    } catch (e) {
      if (signal.aborted || (e as Error)?.name === "AbortError") throw abortError();
      workerUsable = false;
      workerFailure = (e as Error)?.message ?? String(e);
      failure = workerFailure;
    }
  }
  if (!analysis) {
    where = "main thread";
    analysis = await analyzeMono(mixToMono(channels), audio.sampleRate, {
      signal,
      sliceMs: MAIN_THREAD_SLICE_MS,
    });
  }
  const t3 = performance.now();
  return {
    analysis,
    via,
    where,
    fetchMs: Math.round(t1 - t0),
    decodeMs: Math.round(t2 - t1),
    analyzeMs: Math.round(t3 - t2),
    workerFailure: failure,
  };
}

/** For the journal: why the worker is off, if it is. */
export function workerStatus(): string {
  return workerUsable ? "worker ok" : `worker off (${workerFailure})`;
}

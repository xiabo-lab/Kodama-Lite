/**
 * Runs `analyzeMono` off the main thread, so analysing a track never costs
 * the wave a frame. The main thread decodes (WebKit decodes on its own
 * thread anyway) and hands over mono PCM; this hands back the analysis.
 *
 * Says `ready` the moment it loads: the caller uses that to tell a worker
 * that is merely busy from one that never started — on WebKitGTK a worker
 * served from the app's custom `tauri://` scheme is not something this
 * code has seen run, and a silent load failure must not leave the wave
 * waiting on it.
 */
import { analyzeMono, type Analysis } from "./analyze";

export type WorkerRequest = { mono: Float32Array; sampleRate: number };
export type WorkerReply =
  | { type: "ready" }
  | { type: "done"; analysis: Analysis }
  | { type: "error"; message: string };

const scope = self as unknown as {
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

scope.onmessage = (e) => {
  const { mono, sampleRate } = e.data;
  analyzeMono(mono, sampleRate).then(
    (analysis) =>
      scope.postMessage({ type: "done", analysis }, [
        analysis.bands.buffer,
        analysis.level.buffer,
        analysis.onset.buffer,
      ]),
    (err: unknown) => scope.postMessage({ type: "error", message: String((err as Error)?.message ?? err) }),
  );
};

scope.postMessage({ type: "ready" });

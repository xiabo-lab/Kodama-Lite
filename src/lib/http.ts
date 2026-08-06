import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * Every outbound HTTP request in the view plane, with a deadline.
 *
 * The plugin's `fetch` has **no timeout of any kind** unless you ask for
 * one: `connectTimeout` is applied only when supplied
 * (`tauri-plugin-http/src/commands.rs` — `if let Some(timeout)`), and
 * nothing sets a read timeout, so reqwest's default of "wait forever"
 * stands. A socket that opens and then stalls never settles the promise.
 *
 * That is not a theoretical case here. The Pi wins the boot race against
 * the phone hotspot every time, so it associates before the hotspot has
 * upstream connectivity; and a car drives out of coverage mid-request as a
 * matter of routine. Both produce a connected-but-dead socket rather than a
 * refused one, which is precisely the shape that hangs.
 *
 * A hung request is worse than a failed one because nothing downstream is
 * written to expect it. `Promise.all` over the six lyrics sources never
 * resolves if one stalls, so `lyrics:search` publishes neither
 * `:results` nor `:error` and `searchStatus` sits at `"searching"` — a
 * spinner with no way out but changing track. The tiered `lyrics:load`
 * leaves `status: "loading"` the same way, as do the Home, library and
 * search feeds. One deadline here fixes all of them, because every
 * `tauriFetch` call site in `src/lib` imports from this module.
 *
 * Aborting surfaces as a rejection, which is the behaviour the callers
 * already handle: a lyrics source that throws is treated as a source with
 * nothing to offer, so a single stalled provider degrades to five results
 * instead of freezing the sweep.
 */

/**
 * How long any single request may take, start to finish.
 *
 * This is a whole-request deadline, not just a connect one, because the
 * stall being defended against happens *after* the connection is up. Every
 * response the app fetches is a small JSON document, so there is no
 * legitimate slow-but-progressing download that this would cut off — the
 * audio stream is served by the Rust side over localhost and never comes
 * through here.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

export type FetchOptions = Parameters<typeof tauriFetch>[1] & {
  /** Override the deadline for one call. */
  timeoutMs?: number;
};

/**
 * `fetch`, but it always settles.
 *
 * Drop-in for the plugin's own: same arguments, same result, so call sites
 * only change which module they import from.
 */
export async function fetch(
  input: Parameters<typeof tauriFetch>[0],
  init?: FetchOptions,
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = init ?? {};

  const controller = new AbortController();
  const onTimeout = () =>
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError"));
  const timer = setTimeout(onTimeout, timeoutMs);

  // A caller's own signal still has to work — chained rather than replaced,
  // so whichever fires first wins. Nothing passes one today; this is here
  // so that adding a cancel button later doesn't silently lose the deadline.
  const onCallerAbort = () => controller.abort((callerSignal as AbortSignal).reason);
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    return await tauriFetch(input, {
      ...rest,
      // Belt and braces: this one covers the TCP handshake itself, where a
      // dead gateway leaves us waiting on the OS's own long default.
      connectTimeout: Math.min(timeoutMs, 10_000),
      signal: controller.signal,
    });
  } finally {
    // Both must go on every exit path. The timer would otherwise hold a
    // reference to the controller for its full duration after a fast
    // response, and the listener would outlive a caller signal that gets
    // reused across requests.
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Fallback flush interval when `requestAnimationFrame` isn't ticking. */
const HIDDEN_TAB_FLUSH_MS = 100;

/**
 * Generic "coalesce into at most one flush per animation frame" queue —
 * the mechanism both the Rust-routed bus (`bus.ts`) and the JS-routed
 * content bus (`contentBus.ts`) use, so every subsystem gets the same two
 * guarantees regardless of which side of the process boundary it lives on:
 *
 *   1. No matter how many events arrive in a burst, consumers see at most
 *      one batch per frame — the data plane can never drive more re-renders
 *      than the display can show.
 *   2. `requestAnimationFrame` is throttled to roughly once a second — or
 *      paused outright — whenever the window is hidden or unfocused
 *      (confirmed while building Phase 2: a backgrounded tab stalled the
 *      bus forever). `schedule` races rAF against a short timer and takes
 *      whichever fires first, so a stall degrades to ~10 Hz instead of
 *      freezing.
 */
export function createBatcher<T>(applyBatch: (batch: T[]) => void) {
  let queue: T[] = [];
  let raf = 0;
  let timeout = 0;

  const flush = () => {
    raf = 0;
    if (timeout) {
      clearTimeout(timeout);
      timeout = 0;
    }
    const batch = queue;
    queue = [];
    if (batch.length) applyBatch(batch);
  };

  const push = (item: T) => {
    queue.push(item);
    if (raf || timeout) return;
    raf = requestAnimationFrame(flush);
    timeout = window.setTimeout(flush, HIDDEN_TAB_FLUSH_MS);
  };

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    if (timeout) clearTimeout(timeout);
  };

  return { push, stop };
}

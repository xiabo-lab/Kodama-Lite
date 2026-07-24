import type { AppEvent, Command } from "@/protocol";
import type { Transport } from "@/bus/transport";
import { createTauriTransport } from "@/bus/tauriTransport";
import { createMockTransport } from "@/bus/mockTransport";
import { createBatcher } from "@/bus/batcher";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const transport: Transport = IS_TAURI
  ? createTauriTransport()
  : createMockTransport();

/**
 * Send an intent to the data plane. Synchronous and fire-and-forget — the
 * caller (a component handler, an effect) returns immediately; the result
 * arrives later as an event. This is what keeps the network off the render
 * path.
 */
export function dispatch(command: Command): void {
  transport.send(command);
}

/**
 * Start the event pump. Incoming events are coalesced per animation frame
 * (see `createBatcher`) so the data plane can never drive more than 60
 * re-render passes per second. The returned function tears the pump down.
 */
export function startBus(applyEvents: (events: AppEvent[]) => void): () => void {
  const batcher = createBatcher<AppEvent>(applyEvents);
  const unsubscribe = transport.onEvent(batcher.push);
  return () => {
    unsubscribe();
    batcher.stop();
  };
}

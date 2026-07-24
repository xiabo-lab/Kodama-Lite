import type { AppEvent, Command } from "@/protocol";

/**
 * The bus transport: how commands leave the view plane and how events
 * arrive. Abstracted so the same UI runs against the real Rust data plane
 * (Tauri IPC) or a mock in-browser data plane (for UI development and for
 * `vite preview` in a plain browser). The rest of the app never knows
 * which is in play.
 */
export interface Transport {
  /** Fire a command at the data plane. Never returns a promise the UI
   *  awaits — results come back as events. */
  send(command: Command): void;
  /** Subscribe to events from the data plane. Returns an unsubscribe fn. */
  onEvent(handler: (event: AppEvent) => void): () => void;
}

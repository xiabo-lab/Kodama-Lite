import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CMD_CHANNEL, EVENT_CHANNEL, type AppEvent, type Command } from "@/protocol";
import type { Transport } from "@/bus/transport";

/**
 * Real transport: commands go to the Rust `dispatch` command, events come
 * back over a Tauri event channel. This is the only file in the view plane
 * that touches Tauri IPC — everything above it speaks the typed bus.
 */
export function createTauriTransport(): Transport {
  return {
    send(command: Command) {
      // Fire-and-forget. A failed dispatch surfaces as an event (or is
      // retried by the subsystem), never as a thrown promise in the UI.
      void invoke(CMD_CHANNEL, { command }).catch((e) => {
        console.error("[bus] dispatch failed:", command.type, e);
      });
    },
    onEvent(handler) {
      let disposed = false;
      let unlisten: (() => void) | undefined;
      void listen<AppEvent>(EVENT_CHANNEL, (e) => handler(e.payload)).then(
        (un) => {
          if (disposed) un();
          else unlisten = un;
        },
      );
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
}

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
  // Commands wait for the event listener to actually exist.
  //
  // `listen()` is asynchronous: it round-trips to Rust to register the
  // channel subscription. `dispatch()` is issued on the very next line of
  // `App`'s mount effect, so without this gate a subsystem that answers
  // *faster than the registration completes* emits into nothing and the
  // reply is lost forever — there is no replay, and every boot-time
  // handshake is a single request.
  //
  // That is not hypothetical: it froze the car. On a cold boot the app
  // starts before Wi-Fi has associated, so `connectivity:check`'s TCP
  // connect fails with ENETUNREACH in microseconds rather than taking the
  // usual milliseconds. Its `net:status` beat the listener, `netChecked`
  // stayed false for the whole session, and resume-on-startup — which
  // waits for a confirmed connection — never fired. The panel sat lit with
  // a track loaded and never played. A warm restart always worked, because
  // with the network already up the probe took long enough to lose the
  // race. Every other boot command (auth, yt-dlp, volume) was one lucky
  // scheduling decision away from the same fate.
  //
  // Queueing here rather than in `bus.ts` keeps the fix where the
  // asymmetry is: the mock transport subscribes synchronously and never
  // had the problem. `send` stays synchronous and fire-and-forget — the
  // caller still returns immediately — and promise callbacks are FIFO, so
  // commands reach Rust in the order they were dispatched.
  let ready: Promise<void> | undefined;
  let markReady: (() => void) | undefined;

  const post = (command: Command) => {
    // Fire-and-forget. A failed dispatch surfaces as an event (or is
    // retried by the subsystem), never as a thrown promise in the UI.
    void invoke(CMD_CHANNEL, { command }).catch((e) => {
      console.error("[bus] dispatch failed:", command.type, e);
    });
  };

  return {
    send(command: Command) {
      // No subscriber yet (or a re-subscribe in flight, as React's strict
      // mode double-mount produces): hold the command until there is one.
      if (!ready) {
        ready = new Promise<void>((resolve) => (markReady = resolve));
      }
      void ready.then(() => post(command));
    },
    onEvent(handler) {
      let disposed = false;
      let unlisten: (() => void) | undefined;
      if (!ready) {
        ready = new Promise<void>((resolve) => (markReady = resolve));
      }
      void listen<AppEvent>(EVENT_CHANNEL, (e) => handler(e.payload)).then(
        (un) => {
          if (disposed) {
            un();
            return;
          }
          unlisten = un;
          markReady?.();
          markReady = undefined;
        },
      );
      return () => {
        disposed = true;
        unlisten?.();
        // A torn-down bus must not let the next mount's commands go out
        // against a listener that no longer exists.
        if (markReady === undefined) {
          ready = undefined;
        }
      };
    },
  };
}

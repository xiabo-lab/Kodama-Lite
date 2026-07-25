import type { AppEvent, Command } from "@/protocol";
import type { Transport } from "@/bus/transport";
// Raw import: Vite inlines the file's text content as a string. This is a
// ~1.2s silent WAV (generated once, checked in as text so it's diffable) —
// letting the mock `stream:ready` point `<audio>` at *real*, playable
// bytes via a data: URI, with zero network and zero Tauri/yt-dlp. That
// means the whole resolve → ready → play → ended → next loop is exercised
// end to end in a plain browser, not just simulated.
import silenceWavBase64 from "@/bus/mock-silence.base64.txt?raw";

/**
 * A tiny in-browser stand-in for the Rust data plane, used when Tauri isn't
 * present (plain `vite dev` / `vite preview` in a browser). It models the
 * same async, event-driven contract: a command comes in, work "happens"
 * after a delay, results come back as events — so the whole view plane can
 * be developed and demoed without the backend compiled.
 *
 * It deliberately simulates latency and lets you toggle offline (see
 * `mockOffline`) to feel the cache-first, never-blocking behaviour.
 */

const SILENCE_DATA_URL = `data:audio/wav;base64,${silenceWavBase64.trim()}`;

/** Flip these in the devtools console to feel offline / slow behaviour. */
declare global {
  interface Window {
    mockOffline?: boolean;
  }
}

export function createMockTransport(): Transport {
  const listeners = new Set<(e: AppEvent) => void>();
  const emit = (e: AppEvent) => listeners.forEach((l) => l(e));
  // `typeof window` guard: this module is also reachable from plain-node
  // unit tests (importing a store pulls in `bus.ts`, which constructs a
  // transport at module scope) where there is no `window` at all — treat
  // that as "online" rather than throwing.
  const online = () => typeof window === "undefined" || !window.mockOffline;

  // Announce readiness shortly after boot, like the real subsystems.
  setTimeout(() => {
    emit({ type: "net:status", online: online() });
    emit({ type: "ytdlp:state", phase: "ready" });
  }, 300);

  return {
    send(command: Command) {
      switch (command.type) {
        case "ping":
          setTimeout(() => emit({ type: "pong", ts: Date.now() }), 50);
          break;
        case "connectivity:check":
          setTimeout(() => emit({ type: "net:status", online: online() }), 100);
          break;
        case "stream:resolve":
          // The real subsystem never waits on the download — it only waits
          // for the (near-instant) local server to be listening. Mirror
          // that here: succeed almost immediately, offline or not, since
          // "resolve" isn't the network call, playback itself is.
          setTimeout(() => {
            if (online()) {
              emit({
                type: "stream:ready",
                videoId: command.videoId,
                url: SILENCE_DATA_URL,
              });
            } else {
              emit({
                type: "stream:error",
                videoId: command.videoId,
                message: "offline",
              });
            }
          }, 80);
          break;
        case "stream:prefetch":
          // Silent, fire-and-forget — matches the real subsystem.
          break;
        case "auth:check":
        case "auth:signOut":
          // No cookie jar to read in a plain browser tab.
          setTimeout(() => emit({ type: "auth:state", signedIn: false }), 60);
          break;
        case "auth:signIn":
          // Deliberately NOT faked. Signing in means reading HttpOnly
          // cookies out of a real webview's cookie store (see
          // `subsystems/auth.rs`); there is no way to do that from a
          // browser tab, and a mock "signed in" with no credentials would
          // make every authenticated InnerTube call fail confusingly
          // later instead of here.
          setTimeout(
            () =>
              emit({
                type: "auth:error",
                message:
                  "Sign-in needs the desktop app — the mock data plane has no cookie jar.",
              }),
            120,
          );
          break;
      }
    },
    onEvent(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

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
                message: "offline", cause: "track" });
            }
          }, 80);
          break;
        case "stream:prefetch":
          // Silent, fire-and-forget — matches the real subsystem.
          break;
        case "local:scan":
          // A browser tab has no block devices, no udisks and no ffprobe,
          // so this is the one command whose *result* has to be invented
          // to be useful at all. It is faked rather than left silent
          // because the alternative is a Local tab stuck on "Looking for a
          // drive…" forever in dev — which looks exactly like the bug this
          // feature is most likely to have on the device, and would train
          // everyone to ignore it.
          //
          // The staged progress is not decoration: the real scan spawns an
          // ffprobe per file and a full stick takes tens of seconds, so the
          // progress path is load-bearing UI and needs to be exercisable.
          setTimeout(() => emit({ type: "local:scanning" }), 40);
          {
            const mock = [
              { id: "locmock00000001", title: "Blaze Away", artist: "TRAX", duration: 228.4 },
              { id: "locmock00000002", title: "Forever Memories Remix", artist: "w-inds.", duration: 349.9 },
              { id: "locmock00000003", title: "philosophy", artist: "w-inds.", duration: 180 },
              { id: "locmock00000004", title: "无尽旋转", artist: "SNH48", duration: 279.1 },
              { id: "locmock00000005", title: "Swear it All Over Again", artist: "WestLife", duration: 250.1 },
              { id: "locmock00000006", title: "Because of you", artist: "w-inds.", duration: 203.6 },
              { id: "locmock00000007", title: "How crazy", artist: "YUI", duration: 218.8 },
              { id: "locmock00000008", title: "一念之间", artist: "陶喆", duration: 282.8 },
            ];
            mock.forEach((_, i) =>
              setTimeout(
                () =>
                  emit({
                    type: "local:progress",
                    done: i + 1,
                    total: mock.length,
                  }),
                120 + i * 60,
              ),
            );
            setTimeout(
              () =>
                emit({
                  type: "local:scanned",
                  source: "USB3 (browser mock)",
                  tracks: mock,
                  partial: false,
                }),
              120 + mock.length * 60,
            );
          }
          break;
        case "ytdlp:check":
          setTimeout(() => emit({ type: "ytdlp:state", phase: "ready" }), 60);
          break;
        case "auth:check":
        case "auth:signOut":
          // No cookie jar to read in a plain browser tab.
          setTimeout(() => emit({ type: "auth:state", signedIn: false }), 60);
          break;
        case "log:line":
          // In a browser tab the console IS the journal, so the one in
          // `lib/log.ts` has already shown this line.
          break;
        case "media:update":
        case "media:clear":
          // No D-Bus in a browser tab, and nothing to fake: MPRIS is
          // outbound-only until a real client presses a button.
          break;
        case "cache:clear":
        case "cache:stats":
          // The disk cache belongs to the Rust stream server, which isn't
          // running here. Report an empty one rather than inventing a
          // size — a fabricated "1.2 GB cached" in dev would be a lie the
          // Storage screen presents as fact.
          setTimeout(
            () =>
              emit({
                type: "cache:stats",
                count: 0,
                bytes: 0,
                dir: "(no data plane — browser mock)",
              }),
            80,
          );
          break;
        case "volume:get":
          // A browser tab has no PipeWire to move. Answering "unavailable"
          // straight away — rather than staying silent — is what stops the
          // view plane's probe retrying twenty times before it concludes
          // the same thing, and puts it on the webview fallback path where
          // the slider does work in dev.
          setTimeout(
            () =>
              emit({
                type: "volume:state",
                volume: 1,
                muted: false,
                available: false,
              }),
            30,
          );
          break;
        case "update:check":
          // Deliberately NOT faked, for the same reason as `auth:signIn`
          // below: the interesting half of this command is `apt-get
          // install` and a systemd restart, neither of which exists in a
          // browser tab. A mock "you're up to date" would make the row
          // look like it worked somewhere it cannot.
          setTimeout(
            () =>
              emit({
                type: "update:state",
                phase: "error",
                message:
                  "Updating needs the desktop app — the mock data plane has no package manager.",
              }),
            120,
          );
          break;
        case "app:quit":
          // A browser tab can't close itself unless script opened it, and
          // faking it (blanking the page) would make the Quit row look
          // like it worked somewhere it can't. Left visibly inert instead.
          console.warn("[mock] app:quit — no app to quit in a browser tab");
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

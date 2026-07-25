/**
 * The bus contract — the seam between the view plane (this webview) and
 * the data plane (the Rust subsystems that genuinely need to be Rust:
 * connectivity, and the local audio-streaming server). Both sides import
 * these types; a drift is a compile error, never a runtime surprise.
 *
 * `Command` flows DOWN (UI intent → data plane). `AppEvent` flows UP
 * (data plane result → UI). Nothing else crosses this particular boundary.
 *
 * NOTE: YouTube Music content (home/explore/search/playlist/album/artist)
 * and lyrics do NOT live here — see `src/lib/network.ts` for why (they
 * run as a JS-side "network subsystem" instead of a Rust one) and for
 * their own, richer command/event types, which never need a Rust mirror.
 */

// ── Commands: view plane → data plane ─────────────────────────────────

export type Command =
  | { type: "ping" }
  | { type: "connectivity:check" }
  /** Resolve a videoId to a playable URL. Never blocks on yt-dlp — see
   *  `subsystems::playback` on the Rust side for why. */
  | { type: "stream:resolve"; videoId: string }
  /** Warm the disk cache for a track without playing it. */
  | { type: "stream:prefetch"; videoId: string }
  /** Re-read the webview's cookie jar and report whether a signed-in
   *  YouTube Music session is already there (fired once on boot). */
  | { type: "auth:check" }
  /** Open the Google sign-in webview and watch for the session cookies. */
  | { type: "auth:signIn" }
  /** Drop every Google/YouTube cookie from the jar. */
  | { type: "auth:signOut" };

// ── Events: data plane → view plane ───────────────────────────────────

export type YtdlpPhase = "downloading" | "ready" | "error";

export type AppEvent =
  | { type: "pong"; ts: number }
  | { type: "net:status"; online: boolean }
  /** A videoId is now playable at `url` (the local stream server). */
  | { type: "stream:ready"; videoId: string; url: string }
  | { type: "stream:error"; videoId: string; message: string }
  | { type: "ytdlp:state"; phase: YtdlpPhase; message?: string }
  /** The current account session. `cookie` is the `Cookie:` header value
   *  for music.youtube.com and `sapisid` the SAPISID value the
   *  `Authorization: SAPISIDHASH` digest is built from — both absent when
   *  signed out. Deliberately never persisted on this side: the webview's
   *  own cookie jar is the single source of truth, re-read via
   *  `auth:check` on every boot. */
  | {
      type: "auth:state";
      signedIn: boolean;
      cookie?: string;
      sapisid?: string;
    }
  | { type: "auth:error"; message: string };

/** Wire names (kept in one place so both transports agree). `CMD_CHANNEL`
 *  is the Tauri command that receives every dispatch; `EVENT_CHANNEL` is the
 *  Tauri event the data plane emits results on. */
export const CMD_CHANNEL = "handle_command";
export const EVENT_CHANNEL = "kl:event";

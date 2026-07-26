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
  /** Re-report the managed yt-dlp binary's phase. The data plane emits
   *  `ytdlp:state` once from its setup hook, which runs before the webview
   *  exists — so without asking again on mount the UI's `ytdlpPhase` stays
   *  at its initial value for the whole session. Fired once on boot,
   *  alongside `connectivity:check` and `auth:check`. */
  | { type: "ytdlp:check" }
  /** Re-read the webview's cookie jar and report whether a signed-in
   *  YouTube Music session is already there (fired once on boot). */
  | { type: "auth:check" }
  /** Open the Google sign-in webview and watch for the session cookies. */
  | { type: "auth:signIn" }
  /** Drop every Google/YouTube cookie from the jar. */
  | { type: "auth:signOut" }
  /** Publish the current track + transport state to the OS media
   *  controls (MPRIS on Linux). This is what a car head unit reads over
   *  Bluetooth AVRCP — see `subsystems/media.rs`. */
  | {
      type: "media:update";
      title: string;
      artist: string;
      album: string;
      thumbnail: string;
      duration: number;
      elapsed: number;
      paused: boolean;
    }
  /** Tell the OS nothing is playing (queue emptied). */
  | { type: "media:clear" }
  /** How much audio is on disk, and where. */
  | { type: "cache:stats" }
  /** Delete every cached audio file. */
  | { type: "cache:clear" }
  /** Ask what the speakers are actually at. The slider drives the PipeWire
   *  stream rather than the webview — see `subsystems/volume.rs` for why
   *  attenuating in the webview made the bar lie. */
  | { type: "volume:get" }
  | { type: "volume:set"; volume: number; muted: boolean }
  /** Close the app. The Pi boots straight into this window full-screen
   *  with no desktop chrome around it, so Settings' Quit row is the only
   *  way out that isn't an SSH session. */
  | { type: "app:quit" };

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
  | { type: "auth:error"; message: string }
  /** A transport button pressed on the OS media controls — the steering
   *  wheel / touchscreen in the car, or `playerctl`. `position` is only
   *  present for `seek`. */
  | {
      type: "media:control";
      action: "play" | "pause" | "toggle" | "next" | "previous" | "stop" | "seek";
      position?: number;
    }
  | { type: "cache:stats"; count: number; bytes: number; dir: string }
  /** The real output volume, linear 0..1. `available: false` means there is
   *  no mixer to talk to — no audio stream yet, or no `pw-dump`/`wpctl`, as
   *  in a plain browser — and the view plane attenuates in the webview
   *  instead. */
  | { type: "volume:state"; volume: number; muted: boolean; available: boolean };

/** Wire names (kept in one place so both transports agree). `CMD_CHANNEL`
 *  is the Tauri command that receives every dispatch; `EVENT_CHANNEL` is the
 *  Tauri event the data plane emits results on. */
export const CMD_CHANNEL = "handle_command";
export const EVENT_CHANNEL = "kl:event";

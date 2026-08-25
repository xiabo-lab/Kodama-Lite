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
      /** Stable identity for the track (the videoId), so `mpris:trackid`
       *  changes between songs. It was a hardcoded constant before, which
       *  left a head unit unable to tell one track from the next. */
      trackId: string;
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
  /** A diagnostic line, printed by the data plane so it reaches the
   *  journal. The Pi has no devtools and webview `console.log` output goes
   *  nowhere, so this is the only way a boot can be reconstructed after
   *  the fact. See `lib/log.ts`. */
  | { type: "log:line"; scope: string; message: string }
  /** How much audio is on disk, and where. */
  | { type: "cache:stats" }
  /** Delete every cached audio file. */
  | { type: "cache:clear" }
  /** What is the output currently set to? Used once, on a profile that
   *  has never set a volume, so a fresh install starts where the system
   *  already is instead of at full. The slider itself reaches the stream
   *  through `el.volume` — see `lib/audioEngine.ts`. */
  | { type: "volume:get" }
  /** Scan a removable drive for playable audio — the Library's Local tab.
   *  Mounts the drive first if nothing else has; see
   *  `subsystems/local.rs` for why that has to be the app's job here. */
  | { type: "local:scan" }
  /** Close the app. The Pi boots straight into this window full-screen
   *  with no desktop chrome around it, so Settings' Quit row is the only
   *  way out that isn't an SSH session. */
  | { type: "app:quit" };

// ── Events: data plane → view plane ───────────────────────────────────

export type YtdlpPhase = "downloading" | "ready" | "error";

/**
 * Why a track wouldn't play.
 *
 * - `offline`  — the network is gone. Outranks everything: during an
 *   outage every track fails, and blaming YouTube's API while the user is
 *   in a tunnel is worse than saying nothing.
 * - `systemic` — several *different* tracks failed in a row with the
 *   network up, so extraction itself is broken, not this song.
 * - `track`    — this one video: DRM, region, age gate, or a transient
 *   miss worth another tap.
 */
export type StreamErrorCause = "offline" | "systemic" | "track";

export type AppEvent =
  | { type: "pong"; ts: number }
  | { type: "net:status"; online: boolean }
  /** A videoId is now playable at `url` (the local stream server). */
  | { type: "stream:ready"; videoId: string; url: string }
  | {
      type: "stream:error";
      videoId: string;
      message: string;
      /** What to blame. `message` is already human-readable, so this is
       *  not for wording — it lets the UI treat "no internet" and
       *  "extraction is broken for everything" as states of the app
       *  rather than as properties of one song. Mirrors
       *  `AppEvent::StreamError::cause` in `protocol.rs`. */
      cause: StreamErrorCause;
    }
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
      action:
        | "play"
        | "pause"
        | "toggle"
        | "next"
        | "previous"
        | "stop"
        /** Absolute — `position` is where to go, in seconds. */
        | "seek"
        /** Relative — `position` is a signed offset in seconds. MPRIS `Seek`
         *  is relative, which is what a head unit's fast-forward sends. */
        | "seek_by"
        /** Absolute volume 0..1, in `volume`. A head unit's volume knob. */
        | "volume";
      position?: number;
      volume?: number;
    }
  /** A command from the local control endpoint — the voice assistant.
   *
   *  Shaped like `media:control` on purpose, and handled the same way: it
   *  drives the very same store actions the on-screen controls do, so a
   *  spoken "shuffle on" and a tap on the shuffle button cannot drift
   *  apart. Transport verbs are absent because MPRIS already carries them.
   *
   *  `argument` is free text whose meaning depends on the action — a song
   *  to search for, a volume percentage, "on"/"off". */
  | {
      type: "control:command";
      action:
        | "play"
        | "search"
        | "volume"
        | "shuffle"
        | "repeat"
        | "like"
        | "lyrics"
        /** Re-run the lyrics lookup for the current track and show the
         *  Search Lyrics screen — the karaoke stage's magnifier button.
         *  Distinct from `lyrics`, which only displays what is already
         *  found; these are two different buttons and two different
         *  spoken commands. */
        | "lyrics_search"
        /** Commit the lyric on screen to the persistent cache — the green
         *  tick on the karaoke stage. */
        | "lyrics_save"
        | "karaoke"
        /** Go back to the Home screen. Navigation only — whatever is
         *  playing keeps playing. */
        | "home"
        /** Play the USB stick's library, the Library's Local tab.
         *
         *  There is only one offline library on this device. The audio cache
         *  is an inventory of already-played tracks, not a browsable list,
         *  so "play local music" and "play from USB" are the same request
         *  and both arrive here. */
        | "play_local"
        /** Open Liked Music and play it. */
        | "play_liked"
        | "quit";
      argument?: string;
    }
  | { type: "cache:stats"; count: number; bytes: number; dir: string }
  /** The real output volume, linear 0..1. `available: false` means there is
   *  no mixer to talk to — no audio stream yet, or no `pw-dump`/`wpctl`, as
   *  in a plain browser — and the view plane attenuates in the webview
   *  instead. */
  | { type: "volume:state"; volume: number; muted: boolean; available: boolean }
  | { type: "local:scanning" }
  /** Tag-reading progress — a full stick is thousands of `ffprobe` spawns
   *  and tens of seconds, which a bare spinner misrepresents as a hang. */
  | { type: "local:progress"; done: number; total: number }
  /** The library. `source` names the drive it came from.
   *
   *  `partial` is true for the subset restored from the saved index while
   *  new or changed files are still being read — the list is live and
   *  playable at that point, so a drive that gained ten songs doesn't hide
   *  the other 20,000 while those ten are probed. A final event with
   *  `partial: false` always follows. */
  | { type: "local:scanned"; source: string; tracks: LocalTrack[]; partial: boolean }
  /** No drive, no music on it, or it couldn't be mounted — always with a
   *  message saying which, because the three have different fixes. */
  | { type: "local:error"; message: string };

/**
 * One playable file from a USB drive.
 *
 * `id` doubles as the track's `videoId` throughout the playback store.
 * That is not a hack: the data plane's `stream:resolve` recognises a local
 * id and answers with the local route instead of the yt-dlp one (see
 * `subsystems/playback/mod.rs`), so a USB track goes down the exact same
 * queue → resolve → `<audio>` path as a streamed one, with no branch
 * anywhere in the view plane. MPRIS, the karaoke stage, lyrics lookup and
 * the queue panel all work on it unmodified.
 */
export type LocalTrack = {
  id: string;
  title: string;
  artist: string;
  /** Seconds; 0 when the file had no readable duration. */
  duration: number;
};

/** Wire names (kept in one place so both transports agree). `CMD_CHANNEL`
 *  is the Tauri command that receives every dispatch; `EVENT_CHANNEL` is the
 *  Tauri event the data plane emits results on. */
export const CMD_CHANNEL = "handle_command";
export const EVENT_CHANNEL = "kl:event";

# Kodama-Lite

A fluid YouTube Music client for the Raspberry Pi 5 in-car display.

**Same UI, features, workflow and keyboard shortcuts as [YTMLite]**, rebuilt on a
decoupled, event-driven architecture inspired by **Kodama** — so the interface stays
at a locked 60 FPS even when the network is slow, unstable, or gone.

See **[DESIGN.md](./DESIGN.md)** for the full architecture proposal.

## The idea in one picture

```
VIEW PLANE (React)  ──commands──▶  ┃  ──▶  DATA PLANE (Rust subsystems)
  reads a local cache,             ┃         connectivity · playback
  never awaits I/O            EVENT ┃ / CMD  (streaming server + yt-dlp)
  renders at 60 FPS                ┃
        ▲──────────────events──────┃─────────────┘

  + a second, JS-routed "network subsystem" (src/lib/network.ts) for
    InnerTube content + lyrics — same command/event pattern, same
    never-blocks-the-UI guarantee, just running in-process instead of
    behind a Rust boundary. See its doc comment for why.
```

- The **view plane** renders only from a local reactive Store (hydrated from disk on
  boot). It dispatches typed **commands** and folds in typed **events** — batched to
  ≤1 re-render per animation frame. It never `await`s the network.
- The **Rust data plane** owns connectivity and the local audio-streaming server (the
  two things that genuinely benefit from being native code). All I/O there lives off
  the UI thread. The **bus** (`src/protocol.ts` ⇄ `src-tauri/src/protocol.rs`) is that
  half's only seam; a drift between the two is a compile error.
- **Content and lyrics** (home/explore/search/playlist/album/artist/lyrics) run as a
  second, JS-side subsystem (`src/lib/network.ts`) using the Tauri HTTP plugin instead
  of a Rust subsystem — a disclosed Phase 3 deviation from the original plan; see
  Status below.

## Status

**Phase 1 (foundation) — done.** The bus (both sides), the reactive cache Store with
the rAF-batched applier, the typed protocol, a browser-runnable mock data plane, and
the app shell (sidebar, top bar, player bar, Home) that boots cache-first and stays
fluid offline.

**Phase 2 (playback core) — done.** Real transport state (queue, current track,
play/pause, shuffle/repeat, position) lives in `store/playbackStore.ts` as ordinary,
instant, local store actions — only the genuinely async part, turning a videoId into
bytes, crosses the bus (`stream:resolve`/`stream:prefetch` → `stream:ready`/
`stream:error`). On the data plane, `subsystems/playback` (+ the ported `ytdlp.rs` and
its local Range-serving `server.rs`) resolves a videoId to a URL without ever waiting
on yt-dlp itself — the download happens lazily inside the HTTP handler when the
`<audio>` element's own GET arrives, so `resolve` is effectively instantaneous even on
an uncached first play. `lib/audioEngine.ts` owns the single `<audio>` element and
wires it to the store in both directions.

Verified: `npm run build`, `tsc`, and `npm test` (12 store-logic tests covering queue
navigation and the stale-event guard) all pass. Manually exercised via the mock
transport with a real embedded audio clip — this is how a genuine bug got caught and
fixed: `requestAnimationFrame` is throttled to near-zero on a hidden/unfocused window,
which would have silently stalled the whole bus (stream resolution, connectivity, any
future event) if that ever happened on a real device. `bus.ts`'s flush now races rAF
against a 100ms fallback timer, so a stall degrades to ~10 Hz instead of freezing.
**Not independently confirmed from this environment:** that `<audio>.play()` itself
resolves under a real tap — Chromium's autoplay policy blocks it without a genuine
user gesture, and the only way to give the test browser one turned out to be outside
what this sandbox's automation could deliver to a backgrounded tab. The code path
being exercised is the same `HTMLMediaElement` API YTMLite already runs in production,
so this isn't a live concern — it's simply the one link Phase 2 leans on trust for
rather than direct observation, worth a real first check when this runs on hardware.

Known Phase 2 simplifications, carried into Phase 3: the stream cache has no
ephemeral/persistent split (tied to account/Premium status — see Phase 3 accounts
note below); shuffle doesn't yet reorder the upcoming queue on `next()`.

**Phase 3 (feature port) — mostly done, with disclosed cuts.** Home/Explore/Search/
Playlist/Album/Artist all now run on real InnerTube data (YouTube Music's internal
API), ported near-verbatim from YTMLite's `src/lib/innertube/`, plus lyrics (YTM +
LRCLIB) and a full-screen karaoke stage with scroll-synced highlighting.

A deliberate, disclosed architecture change from the original Phase 1 plan: the
network/lyrics code runs in the **view plane**, not behind a Rust subsystem — see the
doc comment at the top of `src/lib/network.ts` for the full reasoning (porting
InnerTube's ~3,000 lines of parsing logic to Rust, uncompiled and unverified in this
environment, was judged a worse trade than reusing YTMLite's proven TypeScript
parsers behind the same bus *pattern*: commands down, events up, ≤1 batched flush per
frame via the same `createBatcher` the Rust-routed bus uses). The property this whole
architecture protects — the UI never awaits the network, never blocks a render —
holds identically either way; only *which process* the fetch runs in changed.

What's real:
- `Home` / `Explore` (4 sub-feeds) / `Search` (all + per-type filters, top-result
  hero) / `Playlist` / `Album` / `Artist`, all cache-first and non-blocking on
  failure (an error card + Retry, never a frozen spinner or a blank screen).
- Lyrics: all 7 of YTMLite's sources (YouTube Music, LRCLIB, Kugou, NetEase,
  Musixmatch, QQ Music, Genius — `src/lib/lyrics/`), same auto-pick preference order
  and "timed beats plain" rule as YTMLite. No manual source-picker dropdown yet
  (`fetchAllLyrics` exposes the per-source map for one, ready to build); the karaoke
  stage scrolls and highlights the active line with the same easing/timing engine as
  YTMLite, opened via the player bar's lyrics/full-screen buttons or the `L` shortcut.
- A queue panel (now playing / up next, jump-to, remove) anchored to the player bar.
- A "like" heart on the karaoke stage — local-only (`likedSongsStore`, persisted to
  localStorage), not synced to a real YouTube Music account: liking a track for real
  needs the same signed-in cookie session accounts/sign-in is waiting on. Disclosed in
  the button's own doc comment rather than silently faking a synced like.

What's deliberately cut for tonight's deadline (all disclosed in-line where they'd
otherwise be expected):
- **Accounts/sign-in.** Every request goes out anonymous — `authHeaders()` in
  `src/lib/innertube/shared.ts` is stubbed to `{}` and is the one seam a real cookie
  jar will plug into later. `Library` is an honest stub screen, not a dead link.
- **Playlist/album/artist headers** render as a plain inline block instead of
  YTMLite's title-bar-integrated hero header — same data, simpler placement (see
  `components/shared/entity-header.tsx`).
- No search history, no "my library" search scope, no playlist sort/search-in-list,
  no drag-to-reorder queue, no Autoplay/radio continuation, no moods/genre tile
  drill-down, no virtualized track lists (fine at the list lengths a Pi 5 sees).

Verified from this environment: `tsc --noEmit`, `vite build`, and `vitest run` (12
tests) all pass. Exercised live via `claude-in-chrome` browser automation against the
mock Rust bus (there's no Rust toolchain in this environment, so the real Tauri HTTP
plugin can't be invoked here) — this **is** how a real bug got caught and fixed:
Album/Artist/Playlist stores had an error handler that merged the failure message
into the cached entry without ever flipping `status` away from `"loading"`, so a
failed fetch left those three screens spinning forever instead of showing the error
card. Confirmed navigation, back/forward, search, the karaoke overlay + `L` shortcut,
and the queue panel all work and that every InnerTube-call failure (expected here,
since there's no live `tauriFetch` outside a real Tauri window) surfaces as a
handled, non-blocking `*:error` event — never an uncaught exception or a frozen UI.
**Not independently confirmed from this environment:** a real InnerTube response
successfully round-tripping end to end (needs the actual Tauri HTTP plugin + a real
network, i.e. the Pi or a real `cargo tauri dev`) and everything Phase 2's own
"not confirmed" note already covers (`<audio>.play()` under a real tap).

```bash
npm install
npm run dev          # or: npm run build && npm run preview
# In the devtools console, `window.mockOffline = true` then reload
# to feel the offline / stale-cache behaviour.
# Append ?debug=1 to the URL to expose window.__klAppStore /
# window.__klPlaybackStore for direct state inspection.
npm test             # store-logic unit tests
```

Next: accounts/sign-in → Pi integration (streaming, Bluetooth/MPRIS, updater) → 60 FPS
polish on the device.

## Layout

```
src/                    view plane
  protocol.ts           the bus contract, Rust-routed half (ping/connectivity/stream)
  lib/network.ts        the JS-routed "network subsystem" (home/explore/search/
                         playlist/album/artist/lyrics) — see its doc comment
  lib/innertube/        InnerTube client + parsers (ported from YTMLite)
  lib/lyrics/           LRC parsing + 7 sources (YTM/LRCLIB/Kugou/NetEase/
                         Musixmatch/QQ/Genius) + best-source aggregator
  bus/                  transport (tauri | mock) + rAF-batched event pump (both buses)
  store/                one store per domain: app (route/online), playback, home,
                         explore, search, playlist, album, artist, lyrics, karaoke,
                         queuePanel
  lib/audioEngine.ts    owns the <audio> element, wires it to playbackStore
  components/shared/    shelf card/carousel/grid/section, track list, entity header,
                         thumbnail — shared across every content screen
  components/layout/    lyrics view, karaoke stage, queue panel
  app/  screens/        shell + screens (YTMLite look)
src-tauri/src/          data plane (connectivity + local audio-streaming server only
                         — see the network-subsystem note above for why content/
                         lyrics aren't here)
  protocol.rs           Rust mirror of the Rust-routed half of the contract
  bus.rs                command router + event emitter
  ytdlp.rs              managed yt-dlp binary lifecycle (ported from YTMLite)
  subsystems/           connectivity, playback (+ its local stream server)
Reference Project/      Kodama (read-only architecture reference)
DESIGN.md               architecture proposal
```

## Toolchain

Node 18+, Rust stable, Tauri 2. The Rust data plane needs a machine with `cargo`
to compile (`cd src-tauri && cargo check`); the view plane builds on its own with
`npm run build`.

[YTMLite]: ../YTMLite

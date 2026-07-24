# Kodama-Lite — Design Proposal

> A YouTube Music player for the Raspberry Pi 5 in-car display. **Same UI, features,
> workflow, and keyboard shortcuts as YTMLite**, rebuilt on a decoupled, event-driven
> architecture inspired by **Kodama**, so the interface stays fluid at a locked 60 FPS
> even when the network is slow, unstable, or gone.

---

## 1. What we're keeping vs. what we're changing

| | Reference | Kodama-Lite takes… |
|---|---|---|
| **UI, layout, components, shortcuts, UX** | **YTMLite** | Everything. Users relearn nothing: same sidebar, player bar, karaoke stage, playlist/home/search/library screens, settings, hotkeys. |
| **Internal architecture** | **Kodama** | The *philosophy* — a **separate data-plane service** that owns all network/lyrics/cache, so the UI never blocks on I/O. |

**Kodama's good idea (adopt):** put every network/data/cache operation behind a service the UI talks to *asynchronously*. The UI process cannot stall on a slow request because the request lives elsewhere.

**Kodama's bad idea (reject):** a single 5,000-line `App.jsx` and a 6,700-line `server.py`. We take the *decoupling*, not the monolith. Kodama-Lite is **modular** — each subsystem is a small, independent module with a typed contract.

**YTMLite's weakness we fix:** its React-Query calls hit the network *in the component render path*. When Wi-Fi is down at boot, the screen shows "Couldn't load / Sign in" and only recovers on a retry. In Kodama-Lite the UI **never awaits the network** — it renders from a local cache instantly and reconciles later via events.

---

## 2. Core principles (from the requirements)

1. **Smoothness is priority #1.** 60 FPS, instant interaction. We trade CPU/RAM for fluidity freely — the Pi 5 has headroom.
2. **The UI never touches the network.** It reads a local reactive **cache** and dispatches **intents**. Results arrive later as **events**.
3. **Everything I/O is async and off the render path.** Network, lyrics, stream resolution, disk cache — all in the data-plane service.
4. **Event-driven & modular.** Subsystems (ui, playback, lyrics, network, cache, media-keys…) communicate only through a typed **event bus** + **command bus**. No subsystem imports another's internals.
5. **Offline is a first-class state, not an error.** Stale-while-revalidate everywhere; the app is fully navigable with zero connectivity.

---

## 3. Architecture at a glance

Three planes, one bus between them:

```
┌──────────────────────────── VIEW PLANE (webview, React) ────────────────────────────┐
│  Pure UI. Renders from the local Store. Dispatches Commands. Subscribes to Events.   │
│  Never awaits I/O. Same components/screens/shortcuts as YTMLite.                     │
│                                                                                      │
│   Store (reactive, cache-first)   ◀── selectors ──   Components                      │
│        ▲                                                   │                          │
│        │ events (state deltas)                             │ commands (intents)       │
└────────┼───────────────────────────────────────────────────┼─────────────────────────┘
         │                         EVENT / COMMAND BUS                                   │
┌────────┼───────────────────────────────────────────────────┼─────────────────────────┐
│        │                    DATA PLANE (Rust, async)         ▼                          │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐          │
│   │ network │  │ lyrics  │  │  cache  │  │playback │  │ library │  │ accounts│  …       │
│   │ (yt)    │  │(sources)│  │(disk+mem)│ │(stream) │  │ (feeds) │  │(session)│          │
│   └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘          │
│         each subsystem: independent, async, emits events, handles commands             │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **View plane** = the webview. It owns *nothing but pixels and intent*. It reads a synchronous in-memory Store (hydrated from disk on boot) and paints. Interactions dispatch **commands** (`play(track)`, `openPlaylist(id)`, `search(q)`). It subscribes to **events** (`store:patch`, `playback:tick`, `lyrics:ready`) and re-renders reactively.
- **Data plane** = a Rust async runtime (Tauri backend) split into independent subsystem actors. Each consumes commands, does I/O off the UI thread, and emits events. Reuses YTMLite's proven InnerTube client, streaming server, and disk cache — but reorganized as isolated modules behind the bus.
- **The bus** = the single seam. Commands go down, events come up. Both are typed, versioned messages. This is the *only* coupling between UI and data.

---

## 4. How each requirement is met

### 60 FPS & instant interaction
- The render path is **pure and synchronous**: components read the Store and return JSX. No `await`, no fetch, no promise in a render or an event handler's critical path.
- **Cache-first**: every screen has data to show *immediately* from the last session (persisted Store), then silently reconciles.
- Heavy lists use **virtualization** (`@tanstack/react-virtual`, as YTMLite already does).
- Animations are **transform/opacity only** (GPU-composited) — carried over from YTMLite's karaoke/scroll work, which we already tuned for the Pi's V3D.
- A **frame-budgeted event applier**: bursts of events from the data plane are coalesced and flushed once per animation frame (`requestAnimationFrame`), so a flood of network results can never cause more than one re-render per frame.

### UI decoupled from network / never blocks
- Components call `dispatch(command)` and return. They *never* hold a promise the frame depends on.
- The Store always returns *something* (cached, stale, or an explicit `loading`/`offline` placeholder the component renders without waiting).
- Network lives in the data plane, a separate async world. A 10-second timeout there is invisible to the UI — the frame already painted from cache.

### Event-driven & modular
- Each data-plane subsystem is an **actor**: an async task with an inbox (commands) and an outbox (events). It knows nothing of other subsystems or the UI.
- Cross-subsystem needs go through events, not direct calls (e.g. `playback` doesn't call `lyrics`; it emits `playback:track-changed`, and `lyrics` reacts).
- Adding a feature = adding a subsystem + its command/event types. No existing module changes.

### Offline smoothness
- **Stale-while-revalidate** is the default read model: cache returns instantly, a background revalidate fires, and if it succeeds an event patches the Store.
- A **connectivity subsystem** watches real reachability and emits `net:online/offline`; the UI shows an unobtrusive indicator, never a blocking error screen.
- On reconnect, subsystems auto-replay the intents that failed offline (this is the generalized, principled version of the `useNetworkRecovery` patch we just shipped to YTMLite).

---

## 5. Module breakdown

**View plane (`src/`)**
- `app/` — shell, routing, providers (mirrors YTMLite's `app-shell`).
- `screens/` — Home, Explore, Search, Library, Playlist, Album, Artist, Settings, Karaoke.
- `components/` — the YTMLite component set (sidebar, player bar, track list, thumbnails, dialogs…), ported 1:1 in look.
- `store/` — the reactive cache Store + selectors (one module per domain slice: playback, library, lyrics, ui).
- `bus/` — the command dispatcher + event subscriber (the UI half of the bus).
- `shortcuts/` — the global keyboard map (identical bindings to YTMLite).

**Data plane (`src-tauri/src/`)**
- `bus/` — command router + event emitter (the Rust half).
- `subsystems/network/` — InnerTube/YouTube (ported from YTMLite's `lib.rs` networking).
- `subsystems/lyrics/` — the multi-source aggregator (LRCLIB, YTM, QQ, Kugou, NetEase, Musixmatch, Genius — ported from YTMLite's `lib/lyrics`).
- `subsystems/cache/` — mem + disk, stale-while-revalidate, budgets.
- `subsystems/playback/` — stream resolution + the local streaming server (ported from YTMLite).
- `subsystems/library/` — home/liked/playlists/albums feeds.
- `subsystems/accounts/` — session/cookies (ported from YTMLite, incl. the DPAPI/XChaCha jar).
- `subsystems/connectivity/` — reachability watcher + reconnect replay.

**Shared contract (`packages/protocol/` or `src/protocol.ts` + generated Rust)**
- The typed command & event definitions — the single source of truth both planes import. A drift here is a compile error, not a runtime bug.

---

## 6. Data-flow examples

**Open a playlist while offline**
1. User clicks a playlist → `dispatch(openPlaylist(id))`. Component returns immediately.
2. Store already holds last session's rows for that id → the list **paints this frame**.
3. `library` subsystem receives the command, tries to revalidate, fails (offline) → emits `library:playlist-stale(id)`.
4. UI shows a tiny "offline — showing saved" chip. No spinner, no error, no blank screen.
5. Later `net:online` fires → `library` replays → `store:patch` → rows update in place.

**Play a track**
1. `dispatch(play(track))` → UI flips to "playing" optimistically (Store patch is local & instant).
2. `playback` resolves the stream (cache hit = instant; miss = async yt-dlp) and starts the local server, emitting `playback:ready` / `playback:tick`.
3. `playback:track-changed` → `lyrics` subsystem fetches/loads lyrics async → `lyrics:ready` patches the Store → karaoke updates. The UI never waited.

---

## 7. Technology decisions

| Concern | Decision | Why |
|---|---|---|
| Shell | **Tauri 2** | Same as both references; best fit for Pi kiosk. |
| UI | **React 19 + TypeScript + Tailwind v4 + Radix/shadcn** | Exactly YTMLite's stack → pixel-identical UI, zero relearning, and we reuse its components. |
| UI state | **Reactive Store (Zustand-style) + rAF-batched event applier** | Synchronous reads for a pure render path; batching guarantees ≤1 re-render/frame. |
| Data plane | **Rust async (Tokio), in the Tauri process, as isolated actor modules** | ⟵ *see decision below* |
| UI ↔ data | **Tauri IPC** (commands down) **+ Tauri events** (events up), both typed | Zero-copy, no localhost HTTP port, lowest latency on the Pi. |
| Persistence | Disk cache + a small state snapshot, hydrated on boot | Cache-first boot with no network. |

### The one foundational fork — the data-plane process model

Kodama runs its data plane as a **separate Python process**. That's the purest expression of "the UI can't block on I/O," but on a Pi 5 it costs a slow PyInstaller-ARM cold start, extra RAM, and a second language to maintain. Three options:

- **(A) Rust actors, in-process (recommended).** The data plane is a set of isolated async modules inside the Tauri backend, decoupled from the UI by the bus — *not* by a process boundary. Best Pi performance, reuses YTMLite's battle-tested Rust networking/streaming/cache, single binary, one language. Achieves the same "UI never blocks" guarantee because the UI thread and the Tokio runtime are already separate.
- **(B) Separate Rust service process.** Same code, but the data plane runs as its own sidecar the UI talks to over local IPC — a true process boundary like Kodama, still Rust, still fast. More moving parts (spawn/lifecycle/crash-recovery) for a guarantee (A) already gives on the Pi.
- **(C) Python Flask sidecar (literal Kodama).** Maximum fidelity to the reference, but the heaviest option on the Pi and a second toolchain.

**My recommendation: (A).** It honors Kodama's *philosophy* (decoupled, event-driven data plane) while being the fastest and simplest on the Pi 5, and lets us port YTMLite's proven Rust backend rather than reimplement it in Python. (B) is a clean upgrade path later if we ever want the hard process isolation.

---

## 8. Feature-parity map (YTMLite → Kodama-Lite modules)

- Home / Explore / Search / Library feeds → `library` + `network` subsystems, `screens/*`.
- Playback, queue, shuffle/repeat, media keys → `playback` subsystem, `store/playback`.
- Multi-source synced lyrics + karaoke stage + timing offset → `lyrics` subsystem, `screens/Karaoke`.
- Google sign-in, multi-account, session-keeper → `accounts` subsystem (ported wholesale).
- Streaming via local server + disk cache + prefetch → `playback`/`cache`.
- Settings (theme, playback resume, lyrics timing, storage) → `store/ui` + relevant subsystems.
- In-app updates (Pi `.deb`), Bluetooth/MPRIS, resume-on-startup, network-recovery → carried over as subsystems, now first-class rather than patches.

---

## 9. Folder structure (target)

```
Kodama-Lite/
├── DESIGN.md                     ← this file
├── Reference Project/            ← Kodama (read-only reference)
├── package.json  vite.config.ts  tailwind …
├── src/                          ← view plane
│   ├── app/  screens/  components/  store/  bus/  shortcuts/  protocol.ts
├── src-tauri/                    ← data plane
│   └── src/
│       ├── bus/  protocol.rs
│       └── subsystems/{network,lyrics,cache,playback,library,accounts,connectivity}/
└── docs/                         ← ADRs, per-subsystem contracts
```

---

## 10. Phased roadmap

1. **Foundation — done.** Scaffold, the bus (command/event) both sides, the reactive Store + rAF applier, the protocol contract, an app shell that boots offline from cache. *Deliverable: an empty-but-fluid shell that never blocks.*
2. **Playback core — done.** Real queue/transport state in `playbackStore` (instant, local); `stream:resolve`/`stream:prefetch` cross the bus for the one genuinely async part; `subsystems::playback` + the ported `ytdlp`/local streaming server resolve a videoId to a URL without ever waiting on the download; `lib/audioEngine.ts` drives the `<audio>` element from the store. *Deliverable: the cache-first, event-driven loop proven end-to-end, plus a real bug found and fixed along the way — see README's Status section.*
3. **Feature port — mostly done, accounts deferred.** Home/Explore/Search/Playlist/Album/Artist run on real InnerTube data; lyrics (YTM + LRCLIB) and a full-screen karaoke stage are wired to the player bar and the `L` shortcut. Network/lyrics fetching ended up living in the view plane rather than behind a Rust subsystem — a disclosed deviation from this doc's original plan; see `src/lib/network.ts`'s doc comment and README's Status section for the reasoning and for the full list of what got cut (accounts/sign-in chief among them — `Library` is an honest stub) to hit the same session's deadline.
4. **Pi integration** — streaming server, Bluetooth/MPRIS, resume, updater, connectivity replay.
5. **Polish** — 60 FPS audit under `pw-top`/frame profiling on the actual Pi, offline soak test.

Each phase builds and runs; no phase requires rewriting a previous one — that's the point of the bus seam.


import { useCallback, useEffect } from "react";
import { dispatch, startBus } from "@/bus/bus";
import type { AppEvent } from "@/protocol";
import { startContentBus, dispatchContent, type ContentEvent } from "@/lib/network";
import { handleControlCommand } from "@/lib/voiceControl";
import { logLine } from "@/lib/log";
import { useAppStore } from "@/store/appStore";
import { useAuthStore } from "@/store/authStore";
import { useCacheStore } from "@/store/cacheStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { useHomeStore } from "@/store/homeStore";
import { useExploreStore } from "@/store/exploreStore";
import { useSearchStore } from "@/store/searchStore";
import { usePlaylistStore } from "@/store/playlistStore";
import { useAlbumStore } from "@/store/albumStore";
import { useArtistStore } from "@/store/artistStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useRadioStore } from "@/store/radioStore";
import { useLyricsStore } from "@/store/lyricsStore";
import { useLikedSongsStore } from "@/store/likedSongsStore";
import { useLocalStore } from "@/store/localStore";
import { useUpdateStore } from "@/store/updateStore";
import { AppShell } from "@/app/AppShell";

/**
 * Root. Its only job beyond mounting the shell is to run the two buses for
 * the app's lifetime and fire the initial, non-blocking loads. Note there is
 * no `await` and no loading gate here: the shell renders from cache on the
 * very first frame; these dispatches merely revalidate in the background.
 *
 * There are exactly TWO bus subscriptions for the whole app (below) — one
 * per bus, each the sole owner of its own rAF batcher. Each fans its batch
 * out to every domain store that might care; a store's own `applyEvents`
 * ignores event types it doesn't own, so the fan-out call itself never
 * triggers a render by itself — only the `set()` calls inside a store that
 * actually matched an event do.
 */
export default function App() {
  const applyEvents = useCallback((events: AppEvent[]) => {
    useAppStore.getState().applyEvents(events);
    useAuthStore.getState().applyEvents(events);
    useCacheStore.getState().applyEvents(events);
    usePlaybackStore.getState().applyEvents(events);
    useLocalStore.getState().applyEvents(events);
    useUpdateStore.getState().applyEvents(events);
    // Voice commands are not a store — most of them span several — so they
    // are handled here rather than being fanned out like the rest. See
    // `lib/voiceControl.ts`; every branch calls the same store action the
    // on-screen control does.
    for (const event of events) {
      if (event.type === "control:command") handleControlCommand(event);
    }
  }, []);

  const applyContentEvents = useCallback((events: ContentEvent[]) => {
    useHomeStore.getState().applyEvents(events);
    useExploreStore.getState().applyEvents(events);
    useSearchStore.getState().applyEvents(events);
    usePlaylistStore.getState().applyEvents(events);
    useAlbumStore.getState().applyEvents(events);
    useArtistStore.getState().applyEvents(events);
    useLibraryStore.getState().applyEvents(events);
    useRadioStore.getState().applyEvents(events);
    useLyricsStore.getState().applyEvents(events);
  }, []);

  useEffect(() => {
    const stopBus = startBus(applyEvents);
    const stopContentBus = startContentBus(applyContentEvents);
    dispatch({ type: "connectivity:check" });
    // Re-read the webview's cookie jar. A session that survived the last
    // run makes this a silent, instant sign-in; otherwise it answers
    // "signed out" and nothing changes. `authStore` fetches Home when the
    // answer comes back signed-in, which is what makes the feed
    // personalized.
    dispatch({ type: "auth:check" });
    // Same reason as the two above: the data plane's boot-time `ytdlp:state`
    // is emitted from the setup hook, before this webview could possibly be
    // listening. Without asking again here, `ytdlpPhase` never leaves its
    // initial value and resume-on-startup waits forever.
    dispatch({ type: "ytdlp:check" });
    // Where to fetch artwork from. Asked as early as the other three,
    // because until it answers every `Thumbnail` points at the CDN — and
    // on a cold boot the CDN is exactly what is not reachable yet. The
    // answer is local (the server has already bound its port by now), so
    // in practice it lands within a frame or two of the first paint.
    dispatch({ type: "cover:base" });
    // No `home:load` here any more, and its absence is the point.
    //
    // It used to fire on this line, necessarily **anonymous** — the
    // cookie-jar read above is async, so it cannot have landed yet — and
    // on a signed-in device its result is then discarded by `homeSeq` the
    // moment the personalized fetch comes back. On a desktop that is a
    // wasted request. On this Pi it is not remotely free: measured on
    // device, one `FEmusic_home` browse takes **25 to 35 seconds** end to
    // end — a few seconds of network, and the rest carrying a
    // multi-megabyte response across Tauri's IPC and parsing it on a Pi 5.
    // Two of those overlapping is half a minute of the boot spent
    // computing a feed nobody will ever see.
    //
    // `useHomeStartupRefresh` owns the startup fetch now: it waits for the
    // session, adopts the load `authStore` starts if there is one, and
    // otherwise makes the single request itself.
    return () => {
      stopBus();
      stopContentBus();
    };
  }, [applyEvents, applyContentEvents]);

  useOfflineRetry();
  useVolumeProbe();
  useHomeStartupRefresh();
  useHomeAutoRefresh();

  return <AppShell />;
}

/** How long to wait for `auth:check` to answer before fetching Home
 *  anyway.
 *
 *  The cookie-jar read is local and normally answers in well under a
 *  second, but a boot reply that gets lost is a failure mode this app has
 *  actually had (see `tauriTransport`), and waiting forever on it would
 *  trade a stale feed for no feed. Eight seconds is long enough that the
 *  normal case never hits it and short enough that the pathological one
 *  still ends with fresh — if anonymous — content on screen. */
const AUTH_SETTLE_GRACE_MS = 8_000;

/** Backoff between startup refresh attempts, in ms. Measured from when an
 *  attempt *finishes*, not when it starts — see the deadline note below.
 *  Runs out after eight tries, at which point `useHomeAutoRefresh`'s
 *  20-minute timer and `useOfflineRetry`'s connectivity edge are the
 *  remaining backstops. */
const STARTUP_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000];

/** How long to wait for an attempt to settle before giving up on hearing
 *  about it.
 *
 *  A backstop, and it has to clear the real thing by a wide margin. This
 *  was 20s on the reasoning that `lib/http.ts` caps a request at 15s —
 *  which is true and still missed, because the 15s covers the HTTP
 *  exchange and not what follows it. Measured on the Pi, a single
 *  `FEmusic_home` browse settles in **25 to 35 seconds**: a few seconds of
 *  network, then a multi-megabyte JSON body crossing Tauri's IPC and being
 *  parsed and mapped on a Pi 5. A 20s deadline therefore fired *during*
 *  every healthy fetch and queued a retry that superseded it — the retry
 *  loop reliably outrunning its own success, three times in a row in the
 *  journal.
 *
 *  45s is comfortably past the slow end of that range. It should never
 *  fire; it exists so a dropped event cannot wedge the loop permanently. */
const ATTEMPT_DEADLINE_MS = 45_000;

/**
 * Guarantee exactly one *successful* Home refresh per launch.
 *
 * The reported bug: after a Pi boot the Home feed showed the previous
 * run's content, and only opening another screen and coming back put it
 * right. Nothing on the way back to Home refetches anything, so the
 * navigation was not the cure — it was the delay.
 *
 * What actually happens is that Home's fetch is dispatched **exactly
 * twice** per launch, both inside the boot window: once from the mount
 * effect above (anonymous, because the cookie-jar read is async and cannot
 * have landed yet) and once from `authStore` when `auth:state` comes back
 * signed-in. Neither is retried, and worse, they collide — `homeSeq` in
 * `lib/network.ts` discards whichever finishes first, by design, so the
 * personalized second request is the *only* one that can paint. If it
 * fails, or simply loses its race, the screen keeps its localStorage
 * shelves and raises the "showing saved" chip, and the next thing that
 * would have refreshed the feed is the 20-minute timer. On a car panel
 * that is the whole drive. Reproduced on the device: the Pi's Home showed
 * "showing saved" while `curl` from the same machine got HTTP 200 from
 * InnerTube in 5.6s.
 *
 * So: wait until the app is genuinely ready, ask once, and keep asking
 * until the network actually answers. The mechanism is the existing
 * `home:load` — the same command the refresh button and the 20-minute
 * timer send — not a second refresh path.
 *
 * Two things this must not do, both learned the hard way:
 *
 *   * **Fire on a fixed timer.** Retrying every 2s against a fetch that
 *     takes ~6s means every attempt bumps `homeSeq` and invalidates the
 *     one still in flight, so the loop reliably outruns its own success.
 *     Each attempt therefore waits for its predecessor to *settle* before
 *     the backoff even starts.
 *   * **Race the cookie jar.** Waiting on `authStore.checked` is what
 *     stops this from being a third redundant anonymous request: by the
 *     time it fires, the session is in place.
 */
function useHomeStartupRefresh(): void {
  useEffect(() => {
    logLine("Kodama Home", "Startup refresh requested");

    // Two timers, deliberately not one. They belong to different phases —
    // "poll until the app is ready" and "wait out / back off an attempt" —
    // and sharing a variable between them let a load started by somebody
    // else re-arm the deadline while we were still in the waiting phase.
    // With `attempt` still 0, `settled()` then walked off the front of the
    // backoff table and declared defeat 20 seconds into a boot, without
    // ever having made a single request. Measured, in exactly those words:
    // "Waiting for music service" at 22:16:36, "gave up" at 22:16:56.
    let waitTimer: number | undefined;
    let attemptTimer: number | undefined;
    let attempt = 0;
    /** True only between dispatching a `home:load` and hearing how it
     *  went. Everything the store subscription does is gated on it, so
     *  activity that isn't ours can never advance our state machine. */
    let inFlight = false;
    let waitingLogged = false;
    let done = false;
    const startedAt = Date.now();

    const clearTimers = () => {
      if (waitTimer !== undefined) window.clearTimeout(waitTimer);
      if (attemptTimer !== undefined) window.clearTimeout(attemptTimer);
      waitTimer = undefined;
      attemptTimer = undefined;
    };

    const ready = () => {
      const app = useAppStore.getState();
      if (!app.netChecked || !app.online) return false;
      // Auth is a soft gate: a lost `auth:check` reply must not cost the
      // feed entirely, so the grace window releases it.
      if (useAuthStore.getState().checked) return true;
      return Date.now() - startedAt >= AUTH_SETTLE_GRACE_MS;
    };

    const finish = () => {
      if (done) return;
      done = true;
      clearTimers();
      unsubscribe();
      logLine("Kodama Home", "Home data refreshed successfully");
    };

    const fire = () => {
      if (done) return;
      waitTimer = undefined;
      if (!ready()) {
        if (!waitingLogged) {
          logLine("Kodama Home", "Waiting for music service");
          waitingLogged = true;
        }
        // Not being ready yet is not a failed attempt, so it does not
        // consume a backoff slot.
        waitTimer = window.setTimeout(fire, 1_000);
        return;
      }
      attempt += 1;
      inFlight = true;
      // Adopt a load that is already running rather than starting a
      // second one. On a signed-in boot `authStore` dispatches its own
      // `home:load` the moment the cookie jar answers, which is normally
      // a beat before this hook is released by the same event — so on the
      // happy path the startup refresh costs **zero** extra requests and
      // this only supervises the one already in flight. It matters
      // because a duplicate would not merely be wasteful: `homeSeq` would
      // discard the older of the two, throwing away half a minute of work
      // on a device where that is what a home feed costs.
      if (useHomeStore.getState().refreshing) {
        logLine("Kodama Home", `Fetching latest content (attempt ${attempt}, adopted)`);
      } else {
        logLine("Kodama Home", `Fetching latest content (attempt ${attempt})`);
        dispatchContent({ type: "home:load" });
      }
      attemptTimer = window.setTimeout(attemptOver, ATTEMPT_DEADLINE_MS);
    };

    /** This attempt ended without a `home:loaded`. Back off and try again. */
    const attemptOver = () => {
      if (done || !inFlight) return;
      inFlight = false;
      if (attemptTimer !== undefined) window.clearTimeout(attemptTimer);
      attemptTimer = undefined;
      const delay = STARTUP_RETRY_MS[attempt - 1];
      if (delay === undefined) {
        // Everything is still on screen from cache and the periodic
        // refresh remains armed; say so once rather than failing silently.
        logLine(
          "Kodama Home",
          "Startup refresh gave up; cached content is still showing",
        );
        done = true;
        unsubscribe();
        return;
      }
      attemptTimer = window.setTimeout(fire, delay);
    };

    // Driven by the store rather than polled, so a load triggered by
    // anything else — authStore's refetch, the offline edge, the user
    // pressing refresh — also satisfies this and stops the retries. One
    // successful refresh is the goal, not one made by us.
    const unsubscribe = useHomeStore.subscribe((s, prev) => {
      if (done) return;
      if (s.lastLoadedAt !== prev.lastLoadedAt && s.lastLoadedAt !== undefined) {
        finish();
        return;
      }
      if (!inFlight) return;
      // Someone else started a load on top of ours. `homeSeq` discards a
      // superseded request without publishing anything, so our own
      // attempt's outcome will now never arrive — wait for theirs instead
      // of counting down against it and queueing a pointless retry.
      if (!prev.refreshing && s.refreshing) {
        if (attemptTimer !== undefined) window.clearTimeout(attemptTimer);
        attemptTimer = window.setTimeout(attemptOver, ATTEMPT_DEADLINE_MS);
        return;
      }
      // A revalidate that started and ended without loading anything is a
      // failed attempt — react to it now instead of waiting out the
      // deadline.
      if (prev.refreshing && !s.refreshing) attemptOver();
    });
    if (useHomeStore.getState().lastLoadedAt !== undefined) {
      finish();
      return;
    }

    fire();
    return () => {
      done = true;
      clearTimers();
      unsubscribe();
    };
  }, []);
}

/** How often the Home feed re-fetches itself while the app is running.
 *
 *  The Pi is an appliance: it powers on with the ignition and stays up for
 *  the whole drive, so without this the feed you saw was whatever the
 *  boot-time `home:load` returned — potentially hours old by the time
 *  anyone looked at it, and never updated no matter how long the car ran.
 *  Twenty minutes is short enough that "Listen again" reflects a drive's
 *  worth of listening and long enough to be invisible: it is roughly one
 *  request per commute, and the response only repaints if the shelves
 *  actually changed. */
const HOME_REFRESH_MS = 20 * 60 * 1000;

/** Refresh the Home feed on a timer, and never while offline.
 *
 *  The offline guard is not an optimisation. `home:load` failing marks the
 *  feed stale, and `useOfflineRetry` already owns the offline→online edge
 *  and refetches there — so firing into a dead network would do nothing
 *  but raise the "showing saved" chip on a screen that was fine.
 *
 *  `setInterval`, not a self-rescheduling timeout: this must not drift
 *  with how long a fetch takes, and `home:load` is already sequenced
 *  (`homeSeq` in `lib/network.ts`), so a tick landing on top of an
 *  in-flight request is resolved there rather than needing to be
 *  prevented here. */
function useHomeAutoRefresh(): void {
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!useAppStore.getState().online) return;
      dispatchContent({ type: "home:load" });
    }, HOME_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
}

/** When to ask what the output is already set to. The PipeWire node only
 *  exists once audio is playing, so a single probe at mount would usually
 *  find nothing — hence a couple of later attempts. */
const VOLUME_PROBE_MS = [0, 2000, 6000];

/**
 * Ask the data plane for the current output volume, so a profile that has
 * never set one starts where the system already is rather than at full.
 *
 * `playbackStore` ignores the answer once it has a remembered value, so
 * these are cheap no-ops on every launch but the first — which is why this
 * is a short fixed schedule and not a poll. A plain browser answers
 * `available: false` immediately and nothing happens at all.
 */
function useVolumeProbe(): void {
  useEffect(() => {
    const timers = VOLUME_PROBE_MS.map((delay) =>
      window.setTimeout(() => dispatch({ type: "volume:get" }), delay),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
}

/** How often to re-probe while offline. Long enough that a car parked in a
 *  basement isn't opening a socket every second, short enough that pulling
 *  out of one feels immediate. */
const OFFLINE_RETRY_MS = 5000;

/**
 * Keep asking while the answer is "offline", and refetch what the offline
 * window cost us once it clears.
 *
 * The connectivity subsystem answers on demand and never volunteers a
 * transition, so before this the single boot-time probe was the whole
 * story: a Pi that powers on with the ignition and loses the race to the
 * phone's hotspot — the normal case, not an edge one — stayed marked
 * offline for the entire drive, with the banner up and resume-on-startup
 * never firing, until someone found Settings and pressed "Check now".
 *
 * The same boot race also cost the Home feed, and nothing put it back:
 * `home:load` went out once at mount and once on an `auth:state`, and if
 * both landed in that dead window the screen kept whatever was in
 * localStorage until the next launch — while telling the user, in
 * `Home.tsx`, that "it will retry automatically once you're back online".
 * It did not. It does now.
 *
 * Deliberately a `subscribe` rather than a `useAppStore(...)` selector:
 * this component's only child is the entire app, so re-rendering it on a
 * connectivity flip would reconcile the whole tree for a boolean that four
 * leaf components already read for themselves.
 */
function useOfflineRetry(): void {
  useEffect(() => {
    let timer: number | undefined;

    // Keep asking until the probe has actually *answered* — not merely
    // until `online` looks true.
    //
    // `online` starts optimistically `true`, so "offline" was the only
    // state that armed this retry, and an answer that never arrived left
    // nothing to retry: the app looked online, asked nobody, and
    // resume-on-startup waited on `netChecked` forever. Treating
    // unanswered as unsettled means a lost or failed boot probe costs at
    // most one interval instead of the whole session. `tauriTransport`
    // closes the race that lost it in the first place; this is what makes
    // the boot handshake recover from *any* lost reply rather than from
    // that one known cause.
    const settled = (s: { online: boolean; netChecked: boolean }) =>
      s.online && s.netChecked;

    const sync = (s: { online: boolean; netChecked: boolean }) => {
      if (settled(s)) {
        if (timer !== undefined) {
          window.clearInterval(timer);
          timer = undefined;
        }
        return;
      }
      if (timer === undefined) {
        timer = window.setInterval(
          () => dispatch({ type: "connectivity:check" }),
          OFFLINE_RETRY_MS,
        );
      }
    };

    sync(useAppStore.getState());
    const unsubscribe = useAppStore.subscribe((s, prev) => {
      if (s.online === prev.online && s.netChecked === prev.netChecked) return;
      sync(s);
      // Coming back: re-request the two things that are silently wrong
      // rather than visibly missing when they fail. Everything else in
      // the app is fetched on navigation, so it recovers by being looked
      // at; these two are fetched once at boot and never again.
      //
      // Strictly the offline→online edge. `netChecked` flipping now wakes
      // this subscriber too, and on an ordinary boot — where the first
      // probe simply succeeds — `online` was already optimistically true,
      // so `s.online` alone would refetch a feed that mount had just
      // fetched, on every single launch.
      if (s.online && !prev.online) {
        dispatchContent({ type: "home:load" });
        useLikedSongsStore.getState().sync();
      }
    });

    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, []);
}

import { useCallback, useEffect } from "react";
import { dispatch, startBus } from "@/bus/bus";
import type { AppEvent } from "@/protocol";
import { startContentBus, dispatchContent, type ContentEvent } from "@/lib/network";
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
    // "signed out" and nothing changes. It's a local read, but still an
    // event — so the `home:load` below genuinely does go out anonymous on
    // a cold boot. `authStore` refetches Home when the answer comes back
    // signed-in, which is what makes the feed personalized.
    dispatch({ type: "auth:check" });
    // Same reason as the two above: the data plane's boot-time `ytdlp:state`
    // is emitted from the setup hook, before this webview could possibly be
    // listening. Without asking again here, `ytdlpPhase` never leaves its
    // initial value and resume-on-startup waits forever.
    dispatch({ type: "ytdlp:check" });
    dispatchContent({ type: "home:load" });
    return () => {
      stopBus();
      stopContentBus();
    };
  }, [applyEvents, applyContentEvents]);

  useOfflineRetry();
  useVolumeProbe();

  return <AppShell />;
}

/** How often to ask the data plane for the real output volume while we
 *  still don't have it, and how many times before giving up. */
const VOLUME_PROBE_MS = 3000;
const VOLUME_PROBE_TRIES = 20;

/**
 * Find the real mixer, then stop asking.
 *
 * `volume:get` can only answer once our PipeWire stream exists, and that
 * doesn't happen until audio actually plays — so a single probe at mount
 * would almost always come back `available: false` and leave the slider
 * attenuating in the webview for the whole session. Poll until it answers,
 * and start the count again whenever playback begins, which is the moment
 * the node is most likely to have appeared.
 *
 * Bounded because "no mixer" is a legitimate permanent answer — a plain
 * browser has no `wpctl` and never will, and an interval that never stops
 * would spawn a dead command every three seconds forever.
 */
function useVolumeProbe(): void {
  useEffect(() => {
    let tries = 0;
    let timer: number | undefined;

    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    const tick = () => {
      if (usePlaybackStore.getState().volumeMixer === "system") {
        stop();
        return;
      }
      if (tries++ >= VOLUME_PROBE_TRIES) {
        stop();
        return;
      }
      dispatch({ type: "volume:get" });
    };

    const start = () => {
      tries = 0;
      if (timer === undefined) timer = window.setInterval(tick, VOLUME_PROBE_MS);
      tick();
    };

    start();

    // Playback starting is the event that creates the stream node, so it's
    // worth a fresh round even if an earlier one gave up.
    const unsubscribe = usePlaybackStore.subscribe((s, prev) => {
      if (s.playing && !prev.playing && s.volumeMixer !== "system") start();
    });

    return () => {
      unsubscribe();
      stop();
    };
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

    const sync = (online: boolean) => {
      if (online) {
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

    sync(useAppStore.getState().online);
    const unsubscribe = useAppStore.subscribe((s, prev) => {
      if (s.online === prev.online) return;
      sync(s.online);
      // Coming back: re-request the two things that are silently wrong
      // rather than visibly missing when they fail. Everything else in
      // the app is fetched on navigation, so it recovers by being looked
      // at; these two are fetched once at boot and never again.
      if (s.online) {
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

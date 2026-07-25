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
    dispatchContent({ type: "home:load" });
    return () => {
      stopBus();
      stopContentBus();
    };
  }, [applyEvents, applyContentEvents]);

  useOfflineRetry();

  return <AppShell />;
}

/** How often to re-probe while offline. Long enough that a car parked in a
 *  basement isn't opening a socket every second, short enough that pulling
 *  out of one feels immediate. */
const OFFLINE_RETRY_MS = 5000;

/**
 * Keep asking while the answer is "offline".
 *
 * The connectivity subsystem answers on demand and never volunteers a
 * transition, so before this the single boot-time probe was the whole
 * story: a Pi that powers on with the ignition and loses the race to the
 * phone's hotspot — the normal case, not an edge one — stayed marked
 * offline for the entire drive, with the banner up and resume-on-startup
 * never firing, until someone found Settings and pressed "Check now".
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
      if (s.online !== prev.online) sync(s.online);
    });

    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, []);
}

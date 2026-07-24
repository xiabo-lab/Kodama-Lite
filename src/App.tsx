import { useCallback, useEffect } from "react";
import { dispatch, startBus } from "@/bus/bus";
import type { AppEvent } from "@/protocol";
import { startContentBus, dispatchContent, type ContentEvent } from "@/lib/network";
import { useAppStore } from "@/store/appStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { useHomeStore } from "@/store/homeStore";
import { useExploreStore } from "@/store/exploreStore";
import { useSearchStore } from "@/store/searchStore";
import { usePlaylistStore } from "@/store/playlistStore";
import { useAlbumStore } from "@/store/albumStore";
import { useArtistStore } from "@/store/artistStore";
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
    usePlaybackStore.getState().applyEvents(events);
  }, []);

  const applyContentEvents = useCallback((events: ContentEvent[]) => {
    useHomeStore.getState().applyEvents(events);
    useExploreStore.getState().applyEvents(events);
    useSearchStore.getState().applyEvents(events);
    usePlaylistStore.getState().applyEvents(events);
    useAlbumStore.getState().applyEvents(events);
    useArtistStore.getState().applyEvents(events);
    useLyricsStore.getState().applyEvents(events);
  }, []);

  useEffect(() => {
    const stopBus = startBus(applyEvents);
    const stopContentBus = startContentBus(applyContentEvents);
    dispatch({ type: "connectivity:check" });
    dispatchContent({ type: "home:load" });
    return () => {
      stopBus();
      stopContentBus();
    };
  }, [applyEvents, applyContentEvents]);

  return <AppShell />;
}

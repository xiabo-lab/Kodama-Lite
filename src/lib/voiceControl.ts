import type { AppEvent } from "@/protocol";
import { dispatch } from "@/bus/bus";
import { dispatchContent } from "@/lib/network";
import { shelfItemToTrack } from "@/lib/track";
import type { SearchResults, ShelfItem } from "@/lib/innertube/types";
import { useAppStore } from "@/store/appStore";
import { useKaraokeStore } from "@/store/karaokeStore";
import { useLikedSongsStore } from "@/store/likedSongsStore";
import { useLocalStore } from "@/store/localStore";
import { useLyricsStore } from "@/store/lyricsStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { usePlaylistStore } from "@/store/playlistStore";
import { useSearchStore } from "@/store/searchStore";

/**
 * The voice assistant's commands, applied to the app.
 *
 * Every branch here calls the *same* store action the on-screen control
 * calls — never a private path of its own. That is the rule `media:control`
 * already follows for the car's transport buttons, and it is what stops a
 * spoken "shuffle on" from drifting away from what the shuffle button does
 * as the app changes.
 *
 * This lives outside the stores because most of these commands span more
 * than one of them: "play that song" is a search followed by a playback
 * action, and neither store should have to know the other exists.
 *
 * Transport verbs (play/pause/next/previous/stop/seek) are deliberately
 * *not* here — MPRIS already carries them, and duplicating them would mean
 * two implementations to keep in step.
 */
export type ControlCommand = Extract<AppEvent, { type: "control:command" }>;

/** How long to wait for search results before giving up on a spoken "play X".
 *  Long enough for a slow network, short enough that the user is not left
 *  wondering whether it heard them. */
const SEARCH_TIMEOUT_MS = 8000;

/** The track that is loaded right now, if any. `playbackStore` keeps a queue
 *  and an index rather than a `current` field, so this is the one place that
 *  needs to know that. */
function currentTrack() {
  const { queue, index } = usePlaybackStore.getState();
  return queue[index];
}

/** Longest queue a spoken request will build. Well past what anyone listens
 *  through in one sitting, and it stops a broad query from loading hundreds
 *  of tracks into memory on a Pi. */
const MAX_QUEUE = 50;

const isPlayable = (item: ShelfItem) => item.kind === "song" || item.kind === "video";

/**
 * Turn a result set into a queue, and say where in it to start.
 *
 * Not just the single best hit: "播放五月天" means *play some 五月天*, so the
 * rest of the results become the queue behind it and "下一首" has somewhere to
 * go. Loading only the top result — which this did at first — produced a
 * one-track queue where skipping silently did nothing, while MPRIS went on
 * advertising `CanGoNext: true`.
 *
 * The starting point still prefers the "Top result" hero, because that is
 * YouTube Music's own answer to "which one did they mean" and it beats
 * first-in-list, particularly for a spoken query that arrives without the
 * disambiguating punctuation a typed one has. When the hero also appears
 * further down the results, playback starts at that position rather than
 * queueing it twice.
 */
function buildQueue(results: SearchResults): { items: ShelfItem[]; start: number } | null {
  const items: ShelfItem[] = [];
  for (const shelf of results.shelves) {
    for (const item of shelf.items) {
      if (isPlayable(item)) items.push(item);
      if (items.length >= MAX_QUEUE) break;
    }
    if (items.length >= MAX_QUEUE) break;
  }

  const hero = results.topResult && isPlayable(results.topResult) ? results.topResult : null;
  if (hero) {
    const existing = items.findIndex((item) => item.id === hero.id);
    if (existing >= 0) return { items, start: existing };
    return { items: [hero, ...items].slice(0, MAX_QUEUE), start: 0 };
  }

  return items.length ? { items, start: 0 } : null;
}

/** Run a search and play the results as a queue.
 *
 *  Results arrive as bus events rather than from a promise, so this waits on
 *  the store instead of awaiting a call. The subscription unsubscribes on
 *  every exit path — including the timeout — because a leaked one would fire
 *  against a later, unrelated search. */
function playSearchResults(query: string): void {
  const search = useSearchStore.getState();
  search.search(query, "songs");

  let done = false;
  const finish = () => {
    if (done) return true;
    done = true;
    clearTimeout(timer);
    unsubscribe();
    return false;
  };

  const timer = setTimeout(() => {
    if (!finish()) console.warn("[voice] search for %o timed out", query);
  }, SEARCH_TIMEOUT_MS);

  const unsubscribe = useSearchStore.subscribe((state) => {
    // A newer search has replaced ours — stop watching, and let whoever
    // started that one deal with it.
    if (state.query !== query) {
      finish();
      return;
    }
    if (state.status === "error") {
      finish();
      console.warn("[voice] search for %o failed: %s", query, state.error);
      return;
    }
    if (state.status !== "ready") return;

    finish();
    const queue = buildQueue(state.results);
    if (!queue) {
      console.warn("[voice] nothing playable for %o", query);
      return;
    }
    console.info("[voice] %o -> %d track(s), starting at %d",
      query, queue.items.length, queue.start);
    usePlaybackStore
      .getState()
      .playQueue(queue.items.map(shelfItemToTrack), queue.start);
  });
}

/** YouTube Music's own id for Liked Music. `playlistStore` already knows it —
 *  `LIKED_IDS` — because liking a track has to be folded into that list. */
const LIKED_PLAYLIST_ID = "LM";

/** How long to wait for a library to arrive before giving up.
 *
 *  Longer than a search, because both of these can be doing real work: a USB
 *  scan proves the drive is really there on every mount, and Liked Music is
 *  fetched a page at a time. */
const LIBRARY_TIMEOUT_MS = 15000;

/**
 * Wait for a store to be ready, then act on it. Gives up loudly.
 *
 * The same shape as `playSearchResults`: subscribe, take the first state that
 * satisfies `ready`, and make sure exactly one of the timeout and the
 * subscription wins. Spoken commands cannot show a spinner, so the failure
 * has to end up somewhere a person can find it later.
 */
function whenReady<T>(
  store: {
    getState: () => T;
    subscribe: (listener: (state: T) => void) => () => void;
  },
  ready: (state: T) => boolean,
  act: (state: T) => void,
  what: string,
): void {
  if (ready(store.getState())) {
    act(store.getState());
    return;
  }

  let done = false;
  const finish = () => {
    if (done) return true;
    done = true;
    clearTimeout(timer);
    unsubscribe();
    return false;
  };

  const timer = setTimeout(() => {
    if (!finish()) console.warn("[voice] %s did not arrive in time", what);
  }, LIBRARY_TIMEOUT_MS);

  const unsubscribe = store.subscribe((state) => {
    if (!ready(state)) return;
    finish();
    act(state);
  });
}

/**
 * Play the USB stick.
 *
 * Deliberately does not navigate. The Library's tab strip is React state
 * inside that screen rather than anything a store owns, so voice cannot
 * select the Local tab without lifting it out — and showing the Library on
 * its default Playlists tab would be a worse lie than showing nothing. The
 * player bar names what is playing either way.
 */
function playLocalLibrary(): void {
  const local = useLocalStore.getState();
  if (local.tracks.length === 0) local.scan();

  whenReady(
    useLocalStore,
    (state) => state.tracks.length > 0,
    () => {
      const queue = useLocalStore.getState().buildQueue(0);
      if (queue.tracks.length === 0) {
        console.warn("[voice] the USB library is empty");
        return;
      }
      console.info("[voice] local -> %d track(s)", queue.tracks.length);
      usePlaybackStore.getState().playQueue(queue.tracks, queue.index);
      // The transport toggles follow the chosen play mode, exactly as they do
      // when the Local tab is played by hand. See `LocalTab`.
      usePlaybackStore.getState().setShuffle(queue.shuffle);
      usePlaybackStore.setState({ repeat: queue.repeat });
    },
    "the USB library",
  );
}

/** Open Liked Music and play it from the top. */
function playLikedMusic(): void {
  useAppStore.getState().navigate({ kind: "playlist", id: LIKED_PLAYLIST_ID });
  // The screen loads it on mount, but this must work whether or not that
  // render has happened yet, and `playlist:load` on an entry already loading
  // is what the retry button sends too.
  if (!usePlaylistStore.getState().byId[LIKED_PLAYLIST_ID]) {
    dispatchContent({ type: "playlist:load", id: LIKED_PLAYLIST_ID });
  }

  whenReady(
    usePlaylistStore,
    (state) => (state.byId[LIKED_PLAYLIST_ID]?.tracks.length ?? 0) > 0,
    (state) => {
      const tracks = state.byId[LIKED_PLAYLIST_ID]!.tracks;
      console.info("[voice] liked -> %d track(s)", tracks.length);
      usePlaybackStore.getState().playQueue(tracks.map(shelfItemToTrack), 0);
    },
    "Liked Music",
  );
}

/** Parse a spoken volume into 0..1.
 *
 *  The assistant sends a percentage as plain text ("50"), because that is
 *  what a person says. A bare 0..1 float is also accepted so a caller that
 *  already speaks the store's units is not forced to scale up and back. */
function parseVolume(argument: string | undefined): number | null {
  if (!argument) return null;
  const value = Number.parseFloat(argument.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(value)) return null;
  if (value > 1) return Math.min(1, value / 100);
  return Math.max(0, value);
}

/** "on" / "off" / "toggle", tolerant of what a recogniser produces. */
function parseSwitch(argument: string | undefined): boolean | "toggle" {
  const text = (argument ?? "").trim().toLowerCase();
  if (!text) return "toggle";
  if (["off", "false", "0", "no", "关", "关闭", "取消"].includes(text)) return false;
  if (["on", "true", "1", "yes", "开", "打开", "开启"].includes(text)) return true;
  return "toggle";
}

export function handleControlCommand(event: ControlCommand): void {
  const { action, argument } = event;

  switch (action) {
    case "play": {
      if (!argument?.trim()) {
        // "play" with nothing after it is resume, which MPRIS would
        // normally carry — but the assistant may still route it here.
        usePlaybackStore.getState().resume();
        return;
      }
      useAppStore.getState().navigate({ kind: "search" });
      playSearchResults(argument.trim());
      return;
    }

    case "search": {
      if (!argument?.trim()) return;
      useAppStore.getState().navigate({ kind: "search" });
      useSearchStore.getState().search(argument.trim());
      return;
    }

    case "volume": {
      const volume = parseVolume(argument);
      if (volume === null) return;
      usePlaybackStore.getState().setVolume(volume);
      return;
    }

    case "shuffle": {
      const want = parseSwitch(argument);
      const store = usePlaybackStore.getState();
      store.setShuffle(want === "toggle" ? !store.shuffle : want);
      return;
    }

    case "repeat": {
      // `cycleRepeat` walks off -> all -> one, matching the button. Reaching
      // a named mode means cycling until it lands there rather than setting
      // it directly, so there is still only one implementation of the order.
      const wanted = (argument ?? "").trim().toLowerCase();
      const target =
        wanted === "one" || wanted === "单曲" || wanted === "单曲循环"
          ? "one"
          : wanted === "all" || wanted === "全部" || wanted === "列表循环"
            ? "all"
            : wanted === "off" || wanted === "关" || wanted === "关闭"
              ? "off"
              : null;
      const store = usePlaybackStore.getState();
      if (target === null) {
        store.cycleRepeat();
        return;
      }
      for (let i = 0; i < 3 && usePlaybackStore.getState().repeat !== target; i++) {
        usePlaybackStore.getState().cycleRepeat();
      }
      return;
    }

    case "like": {
      const track = currentTrack();
      if (!track) return;
      const liked = useLikedSongsStore.getState();
      if (!liked.canLike()) {
        console.warn("[voice] cannot like — not signed in");
        return;
      }
      liked.toggle({
        videoId: track.videoId,
        title: track.title,
        subtitle: track.subtitle,
        thumbnail: track.thumbnail,
      });
      return;
    }

    case "lyrics": {
      const track = currentTrack();
      if (!track) return;
      useLyricsStore.getState().search({
        title: argument?.trim() || track.title,
        artist: track.subtitle,
      });
      // Lyrics are rendered by the karaoke view — there is no separate
      // lyrics route — so asking for lyrics has to open it, or the search
      // would finish with nothing on screen to show the result.
      useKaraokeStore.getState().setOpen(true);
      return;
    }

    case "lyrics_search": {
      const track = currentTrack();
      if (!track) return;
      const karaoke = useKaraokeStore.getState();
      // The stage first: the search screen is drawn over it, and the
      // screen closes itself if the track it opened for goes away.
      karaoke.setOpen(true);
      karaoke.setSearchOpen(true);
      // Tapping the magnifier only opens the form — it is the Search
      // button *inside* it that queries, against fields seeded from the
      // playing track. A spoken command has no second tap to give, so it
      // runs that same search with those same seeds; the screen then
      // opens on the results, which is where a tap would have landed too.
      useLyricsStore.getState().search({
        title: argument?.trim() || track.title,
        artist: track.subtitle,
      });
      return;
    }

    case "lyrics_save": {
      // `confirm` is what the green tick calls, and it is a no-op without
      // a videoId and a lyric — so "save lyric" with nothing on screen
      // saves nothing rather than caching an empty result for the track.
      const lyrics = useLyricsStore.getState();
      if (!lyrics.lyrics) {
        console.warn("[voice] nothing to save — no lyrics on screen");
        return;
      }
      lyrics.confirm();
      return;
    }

    case "karaoke": {
      const want = parseSwitch(argument);
      const karaoke = useKaraokeStore.getState();
      karaoke.setOpen(want === "toggle" ? !karaoke.open : want);
      return;
    }

    case "home": {
      // Navigation only. "Take me home" is about the screen; silencing the
      // music on the way would be a second, unasked-for command.
      useAppStore.getState().navigate({ kind: "home" });
      return;
    }

    case "play_local": {
      playLocalLibrary();
      return;
    }

    case "play_liked": {
      playLikedMusic();
      return;
    }

    case "quit": {
      // Goes through the existing command rather than closing a window
      // directly, so shutdown ordering (MPRIS teardown, cache flush) is
      // whatever the Quit button already does.
      dispatch({ type: "app:quit" });
      return;
    }

    default: {
      // Exhaustiveness: adding an action to the protocol without handling it
      // here is a compile error rather than a command that silently does
      // nothing.
      const unreachable: never = action;
      console.warn("[voice] unhandled control action %o", unreachable);
    }
  }
}

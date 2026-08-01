import type { AppEvent } from "@/protocol";
import { dispatch } from "@/bus/bus";
import { shelfItemToTrack } from "@/lib/track";
import type { SearchResults, ShelfItem } from "@/lib/innertube/types";
import { useAppStore } from "@/store/appStore";
import { useKaraokeStore } from "@/store/karaokeStore";
import { useLikedSongsStore } from "@/store/likedSongsStore";
import { useLyricsStore } from "@/store/lyricsStore";
import { usePlaybackStore } from "@/store/playbackStore";
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

    case "karaoke": {
      const want = parseSwitch(argument);
      const karaoke = useKaraokeStore.getState();
      karaoke.setOpen(want === "toggle" ? !karaoke.open : want);
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

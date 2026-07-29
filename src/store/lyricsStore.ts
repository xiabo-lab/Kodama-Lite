import { create } from "zustand";
import { dispatchContent, type ContentEvent } from "@/lib/network";
import {
  pickBest,
  SOURCE_ORDER,
  type LyricsSource,
  type ScoredCandidate,
} from "@/lib/lyrics/sources";
import type { Lyrics } from "@/lib/lyrics/types";
import type { FeedStatus } from "@/store/homeStore";

/** "auto" defers to `pickBest`; anything else pins that provider. */
export type SourceChoice = LyricsSource | "auto";

const CHOICE_STORAGE_KEY = "kl:lyrics-source";
const LYRICS_CACHE_KEY = "kl:lyrics-cache";
/** Lyrics are a few KB each; 300 tracks is comfortably inside the ~5MB
 *  localStorage budget and covers far more than a car's rotation. */
const LYRICS_CACHE_MAX = 300;

type SourceMap = Partial<Record<LyricsSource, Lyrics | null>>;

/**
 * A cached track's lyrics — and now, ONLY lyrics a human confirmed.
 *
 * This is Carlyrics' rule (`save_to_cache`: "we no longer auto-cache fetch
 * results, so a lyric only sticks once a human says it matched the song"),
 * and it exists because the old behaviour made a wrong answer permanent.
 * Every search result was written to the cache the moment it arrived, so a
 * mis-matched lyric was served instantly on every later play of that track
 * — and being a cache hit, it never re-searched, so it could not correct
 * itself. Confirmation is the difference between "this is what we found"
 * and "this is right".
 *
 * Everything not confirmed lives in memory for the session only.
 */
type CacheEntry = { confirmed: Lyrics };
type CachedLyrics = Record<string, CacheEntry>;

function isLyrics(v: unknown): v is Lyrics {
  if (!v || typeof v !== "object") return false;
  const k = (v as { kind?: unknown }).kind;
  return k === "timed" || k === "plain";
}

/**
 * Entries from before confirmation existed are DISCARDED, not migrated.
 *
 * They were written automatically, which is precisely the behaviour being
 * removed — carrying them forward would preserve the wrong lyrics this
 * change exists to stop serving. The cost is one refetch per track, which
 * is what a cache miss is for.
 */
function loadLyricsCache(): CachedLyrics {
  try {
    const raw = window.localStorage.getItem(LYRICS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: CachedLyrics = {};
      for (const [id, entry] of Object.entries(parsed)) {
        const confirmed = (entry as { confirmed?: unknown })?.confirmed;
        if (isLyrics(confirmed)) out[id] = { confirmed };
      }
      return out;
    }
  } catch {
    /* corrupt or unavailable — start empty */
  }
  return {};
}

let lyricsCache: CachedLyrics | null = null;

function cache(): CachedLyrics {
  lyricsCache ??= loadLyricsCache();
  return lyricsCache;
}

function readCached(videoId: string): Lyrics | undefined {
  return cache()[videoId]?.confirmed;
}

function persist(c: CachedLyrics): void {
  const keys = Object.keys(c);
  for (const stale of keys.slice(0, Math.max(0, keys.length - LYRICS_CACHE_MAX))) {
    delete c[stale];
  }
  try {
    window.localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* quota — the in-memory copy still serves this session */
  }
}

/** Persist a lyric the user has confirmed is correct. The only writer. */
function writeConfirmed(videoId: string, confirmed: Lyrics): void {
  const c = cache();
  // Insertion order is the eviction order (JS objects preserve it for
  // string keys), so re-inserting also marks this entry most recently used.
  delete c[videoId];
  c[videoId] = { confirmed };
  persist(c);
}

function dropConfirmed(videoId: string): void {
  const c = cache();
  if (!c[videoId]) return;
  delete c[videoId];
  persist(c);
}

/** Drop every cached lyric. Exposed for Settings → Storage. */
export function clearLyricsCache(): void {
  lyricsCache = {};
  try {
    window.localStorage.removeItem(LYRICS_CACHE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** How many tracks have confirmed lyrics, and roughly how many bytes. */
export function lyricsCacheStats(): { count: number; bytes: number } {
  const c = cache();
  const count = Object.keys(c).length;
  let bytes = 0;
  try {
    bytes = window.localStorage.getItem(LYRICS_CACHE_KEY)?.length ?? 0;
  } catch {
    /* leave 0 */
  }
  return { count, bytes };
}

/** No source searched yet — distinct from a searched-and-empty `null`. */
function emptySources(): SourceMap {
  return {};
}

/** The picked source is a standing preference, not a per-track one — you
 *  pick LRCLIB because you like its timings, and you mean it for the next
 *  song too. Persisted for the same reason. */
function loadChoice(): SourceChoice {
  try {
    const raw = window.localStorage.getItem(CHOICE_STORAGE_KEY);
    if (raw === "auto") return "auto";
    if (raw && (SOURCE_ORDER as string[]).includes(raw)) return raw as LyricsSource;
  } catch {
    /* private mode etc — fall through to auto */
  }
  return "auto";
}

function saveChoice(choice: SourceChoice): void {
  try {
    window.localStorage.setItem(CHOICE_STORAGE_KEY, choice);
  } catch {
    /* non-fatal — the choice still holds for this session */
  }
}

/**
 * Resolve what to actually display.
 *
 * A hand-picked result wins outright: the user looked at the alternatives
 * and said "that one", which is better evidence than any score.
 *
 * Below that, a pinned source that has nothing for *this* track silently
 * falls back to the auto-pick rather than showing "No lyrics found": the
 * preference is "prefer LRCLIB", not "show me nothing unless it's LRCLIB",
 * and the picker still marks which sources are unavailable so the fallback
 * isn't a mystery.
 */
function resolve(
  sources: SourceMap,
  choice: SourceChoice,
  manual?: Lyrics,
): Lyrics | null {
  if (manual) return manual;
  if (choice !== "auto") {
    const pinned = sources[choice];
    if (pinned) return pinned;
  }
  return pickBest(sources);
}

/** The manual Search Lyrics screen's own lifecycle. */
export type SearchStatus = "idle" | "searching" | "done" | "error";

type LoadParams = {
  videoId: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
};

interface LyricsState {
  videoId?: string;
  /** Kept so the picker can re-query a single source later. */
  params?: LoadParams;
  status: FeedStatus;
  /** Every provider's result for the current track — `null` where that
   *  provider had nothing or failed. Drives the picker's availability
   *  markers as well as the switch itself. Session-only: never persisted. */
  sources: SourceMap;
  choice: SourceChoice;
  /** What the views render: `resolve(sources, choice, manual)`. Derived,
   *  but kept in state so `LyricsBody` stays a one-line subscription. */
  lyrics: Lyrics | null;
  error?: string;
  /** The result the user hand-picked for the current track, if any. Wins
   *  over every source and over `choice`. Session-only until confirmed. */
  manual?: Lyrics;
  /**
   * Has the user confirmed what's on screen is the right lyric?
   *
   * True means it is in the persistent cache and will be served instantly
   * next time. False means it is this session's best guess and nothing has
   * been written to disk.
   */
  confirmed: boolean;
  /** Persist the displayed lyric — the green button. */
  confirm: () => void;
  /** Withdraw a confirmation and drop it from the cache. */
  unconfirm: () => void;

  // ── Manual search (the Search Lyrics screen) ────────────────────────
  searchStatus: SearchStatus;
  searchProgress: { done: number; total: number };
  /**
   * Results are kept in memory for as long as the track is playing, and
   * deliberately survive closing the search screen.
   *
   * Picking a wrong result and wanting the next one down is the common
   * case — that is what a results list is FOR — and re-running a six-source
   * sweep to get back to a list we already had made the second choice cost
   * as much as the first. Cleared when the track changes, because they were
   * searched for a different song.
   */
  searchResults: ScoredCandidate[];
  /** The query that produced `searchResults`, for the results header and
   *  to seed the editor when the user goes back to it. */
  searchQuery?: { title: string; artist?: string };
  searchError?: string;
  /** Sweep all six searchable sources for a hand-typed artist/song. */
  search: (query: { title: string; artist?: string }) => void;
  /** Adopt one of those results for the current track. NOT persisted —
   *  the green button does that. */
  pickManual: (lyrics: Lyrics) => void;
  /** Drop a hand-picked override and go back to the automatic answer. */
  clearManual: () => void;
  /** Throw away the cached results, so the screen offers the editor again. */
  resetSearch: () => void;

  /** Fetch lyrics for a track. Call whenever the current track changes;
   *  a no-op if it's already loading/loaded for this exact videoId. */
  load: (params: LoadParams) => void;
  /** Switch providers. Local and instant — every source was already
   *  fetched for this track, so nothing goes back over the network. */
  setChoice: (choice: SourceChoice) => void;
  /** Fetch one source the tiered search never reached, because the user
   *  asked for it by name in the picker. */
  fetchSource: (source: LyricsSource) => void;
  applyEvents: (events: ContentEvent[]) => void;
}

export const useLyricsStore = create<LyricsState>((set, get) => ({
  status: "idle",
  sources: emptySources(),
  choice: loadChoice(),
  lyrics: null,
  confirmed: false,
  searchStatus: "idle",
  searchProgress: { done: 0, total: 0 },
  searchResults: [],

  confirm: () => {
    const { videoId, lyrics } = get();
    if (!videoId || !lyrics) return;
    writeConfirmed(videoId, lyrics);
    set({ confirmed: true });
  },

  unconfirm: () => {
    const { videoId } = get();
    if (videoId) dropConfirmed(videoId);
    set({ confirmed: false });
  },

  search: (query) => {
    const { videoId } = get();
    if (!videoId || !query.title.trim()) return;
    set({
      searchStatus: "searching",
      searchProgress: { done: 0, total: 0 },
      searchResults: [],
      searchQuery: query,
      searchError: undefined,
    });
    dispatchContent({
      type: "lyrics:search",
      videoId,
      title: query.title,
      artist: query.artist,
    });
  },

  pickManual: (manual) => {
    if (!get().videoId) return;
    // Shown, not saved. The user has said "this one looks right"; the green
    // button is where they say "it IS right" after hearing it.
    set({ manual, lyrics: manual, status: "ready", confirmed: false, error: undefined });
  },

  clearManual: () => {
    const { sources, choice } = get();
    set({
      manual: undefined,
      lyrics: resolve(sources, choice),
      confirmed: false,
    });
  },

  resetSearch: () =>
    set({
      searchStatus: "idle",
      searchProgress: { done: 0, total: 0 },
      searchResults: [],
      searchQuery: undefined,
      searchError: undefined,
    }),

  load: (params) => {
    // Re-entrant guard, but "error" is deliberately NOT a terminal state:
    // otherwise a track whose lyrics fetch failed once could never be
    // retried, because `load()` is called with the same videoId every
    // time you come back to it.
    const s = get();
    if (s.videoId === params.videoId && s.status !== "idle" && s.status !== "error") {
      return;
    }

    // A different track invalidates the search results — they were found
    // for a song that is no longer playing.
    const trackChanged = s.videoId !== params.videoId;
    const searchReset = trackChanged
      ? {
          searchStatus: "idle" as const,
          searchResults: [],
          searchQuery: undefined,
          searchError: undefined,
          searchProgress: { done: 0, total: 0 },
        }
      : {};

    // Cache hit: a lyric this user confirmed. Serve it synchronously and
    // don't touch the network — this is what makes replaying a track, and
    // playing one offline, free.
    const confirmed = readCached(params.videoId);
    if (confirmed) {
      set({
        videoId: params.videoId,
        params,
        status: "ready",
        // The per-source map isn't cached any more, so the picker starts
        // empty here and fetches on demand if the user opens it. That is
        // the cost of only persisting what was confirmed, and it is paid
        // by a screen nobody opens on a track whose lyrics are right.
        sources: emptySources(),
        manual: undefined,
        lyrics: confirmed,
        confirmed: true,
        error: undefined,
        ...searchReset,
      });
      return;
    }

    set({
      videoId: params.videoId,
      params,
      status: "loading",
      sources: emptySources(),
      manual: undefined,
      lyrics: null,
      confirmed: false,
      error: undefined,
      ...searchReset,
    });
    dispatchContent({ type: "lyrics:load", ...params });
  },

  setChoice: (choice) => {
    saveChoice(choice);
    // Naming a source explicitly is a decision about THIS track too, so it
    // supersedes an earlier hand-picked override rather than being
    // silently ignored by it.
    const { sources, manual } = get();
    if (manual) set({ manual: undefined });
    set({
      choice,
      lyrics: resolve(sources, choice),
      // What's on screen is no longer what was confirmed.
      confirmed: false,
    });
    // Picking a source the tiered search skipped: go and get it. Nothing
    // to do when it's already in the map, including as a known `null`.
    if (choice !== "auto" && get().sources[choice] === undefined) {
      get().fetchSource(choice);
    }
  },

  fetchSource: (source) => {
    const { videoId, params } = get();
    if (!videoId || !params) return;
    set({ sources: { ...get().sources, [source]: null }, status: "loading" });
    dispatchContent({ type: "lyrics:source", source, ...params });
  },

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "lyrics:loading":
          if (get().videoId === e.videoId) set({ status: "loading" });
          break;
        case "lyrics:loaded": {
          // NOT written to the cache. Search results are this session's
          // best guess until the user confirms them.
          if (get().videoId === e.videoId) {
            const { choice, manual } = get();
            set({
              status: "ready",
              sources: e.sources,
              lyrics: resolve(e.sources, choice, manual),
              error: undefined,
            });
          }
          break;
        }
        case "lyrics:source-loaded": {
          if (get().videoId !== e.videoId) break;
          const sources = { ...get().sources, [e.source]: e.lyrics };
          set({
            status: "ready",
            sources,
            lyrics: resolve(sources, get().choice, get().manual),
            error: undefined,
          });
          break;
        }
        case "lyrics:error":
          if (get().videoId === e.videoId) {
            set({
              status: "error",
              sources: emptySources(),
              lyrics: null,
              confirmed: false,
              error: e.message,
            });
          }
          break;
        case "lyrics:search:progress":
          if (get().videoId === e.videoId) {
            set({ searchProgress: { done: e.done, total: e.total } });
          }
          break;
        case "lyrics:search:results":
          // Dropped outright if the track moved on while the sweep ran:
          // these results were searched for a song that is no longer
          // playing, and applying one to the current track would be wrong.
          if (get().videoId === e.videoId) {
            set({ searchStatus: "done", searchResults: e.results });
          }
          break;
        case "lyrics:search:error":
          if (get().videoId === e.videoId) {
            set({ searchStatus: "error", searchError: e.message });
          }
          break;
        default:
          break;
      }
    }
  },
}));

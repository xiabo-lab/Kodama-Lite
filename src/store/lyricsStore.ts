import { create } from "zustand";
import { dispatchContent, type ContentEvent } from "@/lib/network";
import { pickBest, SOURCE_ORDER, type LyricsSource } from "@/lib/lyrics/sources";
import type { Lyrics } from "@/lib/lyrics/types";
import type { FeedStatus } from "@/store/homeStore";

/** "auto" defers to `pickBest`; anything else pins that provider. */
export type SourceChoice = LyricsSource | "auto";

const CHOICE_STORAGE_KEY = "kl:lyrics-source";
const LYRICS_CACHE_KEY = "kl:lyrics-cache";
/** Lyrics are a few KB each; 300 tracks is comfortably inside the ~5MB
 *  localStorage budget and covers far more than a car's rotation. */
const LYRICS_CACHE_MAX = 300;

type CachedLyrics = Record<string, Record<LyricsSource, Lyrics | null>>;

/**
 * Persisted per-track lyrics, keyed by videoId. Replaying a track costs
 * no network at all: `load()` serves the cached map synchronously and
 * doesn't dispatch. Audio was already cached on disk by the stream
 * server; this is the other half of "playing a song again shouldn't use
 * data".
 *
 * The whole per-source map is stored, not just the winner, so switching
 * sources on a cached track stays instant and offline too.
 *
 * Insertion order is the eviction order (JS objects preserve it for
 * string keys), so the oldest entry drops out once the cap is hit — good
 * enough for a cache whose entries are individually cheap to refetch.
 */
function loadLyricsCache(): CachedLyrics {
  try {
    const raw = window.localStorage.getItem(LYRICS_CACHE_KEY);
    if (raw) return JSON.parse(raw) as CachedLyrics;
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

function readCached(
  videoId: string,
): Record<LyricsSource, Lyrics | null> | undefined {
  return cache()[videoId];
}

function writeCached(
  videoId: string,
  sources: Record<LyricsSource, Lyrics | null>,
): void {
  // Nothing found by any source isn't worth a cache slot — and caching it
  // would mean a track whose lyrics appear later never gets rechecked.
  if (!Object.values(sources).some(Boolean)) return;
  const c = cache();
  delete c[videoId];
  c[videoId] = sources;
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

/** Drop every cached lyric. Exposed for Settings → Storage. */
export function clearLyricsCache(): void {
  lyricsCache = {};
  try {
    window.localStorage.removeItem(LYRICS_CACHE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** How many tracks have cached lyrics, and roughly how many bytes. */
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

function emptySources(): Record<LyricsSource, Lyrics | null> {
  const out = {} as Record<LyricsSource, Lyrics | null>;
  for (const s of SOURCE_ORDER) out[s] = null;
  return out;
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
 * Resolve what to actually display. A pinned source that has nothing for
 * *this* track silently falls back to the auto-pick rather than showing
 * "No lyrics found": the preference is "prefer LRCLIB", not "show me
 * nothing unless it's LRCLIB", and the picker still marks which sources
 * are unavailable so the fallback isn't a mystery.
 */
function resolve(
  sources: Record<LyricsSource, Lyrics | null>,
  choice: SourceChoice,
): Lyrics | null {
  if (choice !== "auto") {
    const pinned = sources[choice];
    if (pinned) return pinned;
  }
  return pickBest(sources);
}

interface LyricsState {
  videoId?: string;
  status: FeedStatus;
  /** Every provider's result for the current track — `null` where that
   *  provider had nothing or failed. Drives the picker's availability
   *  markers as well as the switch itself. */
  sources: Record<LyricsSource, Lyrics | null>;
  choice: SourceChoice;
  /** What the views render: `resolve(sources, choice)`. Derived, but kept
   *  in state so `LyricsBody` stays a one-line subscription. */
  lyrics: Lyrics | null;
  error?: string;
  /** Fetch lyrics for a track. Call whenever the current track changes;
   *  a no-op if it's already loading/loaded for this exact videoId. */
  load: (params: {
    videoId: string;
    title: string;
    artist?: string;
    album?: string;
    duration?: number;
  }) => void;
  /** Switch providers. Local and instant — every source was already
   *  fetched for this track, so nothing goes back over the network. */
  setChoice: (choice: SourceChoice) => void;
  applyEvents: (events: ContentEvent[]) => void;
}

export const useLyricsStore = create<LyricsState>((set, get) => ({
  status: "idle",
  sources: emptySources(),
  choice: loadChoice(),
  lyrics: null,

  load: (params) => {
    if (get().videoId === params.videoId && get().status !== "idle") return;

    // Cache hit: serve it synchronously and don't touch the network. This
    // is what makes replaying a track — and playing one offline — free.
    const cached = readCached(params.videoId);
    if (cached) {
      set({
        videoId: params.videoId,
        status: "ready",
        sources: cached,
        lyrics: resolve(cached, get().choice),
        error: undefined,
      });
      return;
    }

    set({
      videoId: params.videoId,
      status: "loading",
      sources: emptySources(),
      lyrics: null,
      error: undefined,
    });
    dispatchContent({ type: "lyrics:load", ...params });
  },

  setChoice: (choice) => {
    saveChoice(choice);
    set({ choice, lyrics: resolve(get().sources, choice) });
  },

  applyEvents: (events) => {
    for (const e of events) {
      switch (e.type) {
        case "lyrics:loading":
          if (get().videoId === e.videoId) set({ status: "loading" });
          break;
        case "lyrics:loaded":
          // Cache regardless of whether this is still the current track:
          // the fetch already happened, and a user who skipped ahead and
          // back shouldn't pay for it twice.
          writeCached(e.videoId, e.sources);
          if (get().videoId === e.videoId) {
            set({
              status: "ready",
              sources: e.sources,
              lyrics: resolve(e.sources, get().choice),
              error: undefined,
            });
          }
          break;
        case "lyrics:error":
          if (get().videoId === e.videoId) {
            set({
              status: "error",
              sources: emptySources(),
              lyrics: null,
              error: e.message,
            });
          }
          break;
        default:
          break;
      }
    }
  },
}));

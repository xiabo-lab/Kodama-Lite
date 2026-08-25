import { createBatcher } from "@/bus/batcher";
import type { Shelf, ShelfItem, AlbumPage, ArtistPage, SearchResults } from "@/lib/innertube/types";
import type { PlaylistFirstPage } from "@/lib/innertube/playlist";
import type { SearchFilter } from "@/lib/innertube/search";
import type { Lyrics } from "@/lib/lyrics/types";
import { fetchHomeFeedPage } from "@/lib/innertube/home";
import {
  fetchExploreFeedPage,
  fetchChartsFeedPage,
  fetchNewReleasesFeedPage,
  fetchMoodsAndGenresFeedPage,
} from "@/lib/innertube/explore";
import { fetchSearch } from "@/lib/innertube/search";
import { fetchPlaylistFirstPage, fetchPlaylistContinuation } from "@/lib/innertube/playlist";
import { fetchAlbum } from "@/lib/innertube/album";
import { fetchArtist } from "@/lib/innertube/artist";
import {
  fetchLyricsTiered,
  fetchOneLyricsSource,
  searchAllSources,
  type LyricsSource,
  type ScoredCandidate,
} from "@/lib/lyrics/sources";
import {
  fetchLibraryAlbums,
  fetchLibraryArtists,
  fetchLibraryPlaylists,
  fetchLikedSongs,
  type LibrarySection,
} from "@/lib/innertube/library";
import { hasSession } from "@/lib/innertube/shared";
import { fetchRadio } from "@/lib/innertube/radio";
import { logLine } from "@/lib/log";

/** The Library screen's four tabs. */
export type LibraryTab = "playlists" | "songs" | "albums" | "artists";

/**
 * The "network subsystem" — everything that talks to YouTube Music
 * (library/search/playlist/album/artist) and to lyrics providers.
 *
 * This is a deliberate, disclosed departure from `src/protocol.ts`'s Rust
 * data plane. The original Phase 1 design put ALL network behind Rust
 * subsystems; porting InnerTube's ~3,000 lines of response-parsing logic
 * (see `src/lib/innertube/`) to Rust, uncompiled and unverified — there is
 * no Rust toolchain in this dev environment — was judged a worse trade
 * than reusing YTMLite's proven TypeScript parsers behind the identical
 * bus *pattern*: commands down, events up, batched to ≤1 flush/frame via
 * the same `createBatcher` the Rust-routed bus uses (see `bus/batcher.ts`).
 * The measurable property this whole architecture exists to protect — the
 * UI never awaits the network, never blocks a render — holds exactly the
 * same way here: every command handler below is async and every command
 * function returns before its fetch resolves.
 *
 * `dispatchContent`/`startContentBus` are this module's public surface;
 * everything else is an implementation detail of one command's handler.
 */

// ── Command / Event contract ───────────────────────────────────────────

export type ExploreFeed = "explore" | "charts" | "newReleases" | "moods";

export type ContentCommand =
  | { type: "home:load" }
  | { type: "explore:load"; feed: ExploreFeed; cursor?: string }
  | { type: "search:query"; query: string; filter?: SearchFilter }
  | { type: "playlist:load"; id: string }
  | { type: "playlist:more"; id: string; token: string }
  | { type: "album:load"; id: string }
  | { type: "artist:load"; id: string }
  | { type: "library:load"; tab: LibraryTab }
  /** Fetch tracks similar to `videoId` to extend the queue past its end. */
  | { type: "radio:load"; videoId: string }
  | {
      type: "lyrics:source";
      source: LyricsSource;
      videoId: string;
      title: string;
      artist?: string;
      album?: string;
      duration?: number;
    }
  | {
      type: "lyrics:load";
      videoId: string;
      title: string;
      artist?: string;
      album?: string;
      duration?: number;
    }
  /** A hand-typed (artist, song) query, from the karaoke stage's Search
   *  Lyrics screen. Sweeps all six searchable sources and returns every
   *  plausible hit for the user to choose from. `videoId` is the track the
   *  results will be applied to, echoed back so a result arriving after a
   *  track change can be dropped. */
  | {
      type: "lyrics:search";
      videoId: string;
      title: string;
      artist?: string;
    };

export type ContentEvent =
  | { type: "home:loading" }
  | { type: "home:loaded"; shelves: Shelf[] }
  | { type: "home:error"; message: string }
  | { type: "explore:loading"; feed: ExploreFeed }
  | {
      type: "explore:loaded";
      feed: ExploreFeed;
      shelves: Shelf[];
      nextCursor?: string;
      append: boolean;
    }
  | { type: "explore:error"; feed: ExploreFeed; message: string }
  | { type: "search:loading"; query: string; filter: SearchFilter }
  | { type: "search:loaded"; query: string; filter: SearchFilter; results: SearchResults }
  | { type: "search:error"; query: string; filter: SearchFilter; message: string }
  | { type: "playlist:loading"; id: string }
  | { type: "playlist:loaded"; id: string; page: PlaylistFirstPage }
  | { type: "playlist:more:loaded"; id: string; tracks: ShelfItem[]; nextCursor?: string }
  | { type: "playlist:error"; id: string; message: string }
  | { type: "album:loading"; id: string }
  | { type: "album:loaded"; id: string; page: AlbumPage }
  | { type: "album:error"; id: string; message: string }
  | { type: "library:loading"; tab: LibraryTab }
  /** `sections` for the shelf tabs, `tracks` for Liked Songs — one of the
   *  two is always empty, which is simpler than two event types for what
   *  is one screen with one loading state. */
  | {
      type: "library:loaded";
      tab: LibraryTab;
      sections: LibrarySection[];
      tracks: ShelfItem[];
    }
  | { type: "library:error"; tab: LibraryTab; message: string }
  /** `seed` is echoed back so a stale station — the user changed track
   *  while this was in flight — can be dropped rather than appended to a
   *  queue it has nothing to do with. */
  | { type: "radio:loaded"; seed: string; tracks: ShelfItem[] }
  | { type: "radio:error"; seed: string; message: string }
  | { type: "artist:loading"; id: string }
  | { type: "artist:loaded"; id: string; page: ArtistPage }
  | { type: "artist:error"; id: string; message: string }
  | { type: "lyrics:loading"; videoId: string }
  /** Every source's result, not just the winner. All seven fetches run in
   *  parallel regardless, so shipping the whole map is free and is what
   *  lets the source picker switch sources without a refetch. */
  | {
      type: "lyrics:loaded";
      videoId: string;
      /** PARTIAL: only the tiers that were actually searched. A missing
       *  key means "not asked"; a `null` value means "asked, nothing". */
      sources: Partial<Record<LyricsSource, Lyrics | null>>;
    }
  /** One source, fetched because the user picked it in the picker. */
  | {
      type: "lyrics:source-loaded";
      videoId: string;
      source: LyricsSource;
      lyrics: Lyrics | null;
    }
  | { type: "lyrics:error"; videoId: string; message: string }
  /** Manual-search progress, so the screen can say "3 of 6" rather than
   *  spin silently for as long as the slowest source takes. */
  | { type: "lyrics:search:progress"; videoId: string; done: number; total: number }
  /** Every plausible hit across the six searchable sources, best-scoring
   *  first. Empty means the sweep ran and found nothing. */
  | { type: "lyrics:search:results"; videoId: string; results: ScoredCandidate[] }
  | { type: "lyrics:search:error"; videoId: string; message: string };

// ── Pump: identical batching contract to the Rust-routed bus ──────────

let publish: (event: ContentEvent) => void = () => {};

/** Start the content event pump. Mirrors `startBus` in shape and in its
 *  ≤1-flush-per-frame / hidden-tab-fallback guarantees. */
export function startContentBus(
  applyEvents: (events: ContentEvent[]) => void,
): () => void {
  const batcher = createBatcher<ContentEvent>(applyEvents);
  publish = batcher.push;
  return () => {
    publish = () => {};
    batcher.stop();
  };
}

/** Dispatch a content intent. Fire-and-forget, exactly like `dispatch()` —
 *  the handler is async and this function returns before it resolves. */
export function dispatchContent(command: ContentCommand): void {
  void handle(command).catch((e) => {
    console.error("[network] unhandled error in", command.type, e);
  });
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Sequence number for `home:load`, so a slower earlier request can't
 *  land on top of a newer one. See the handler for why Home in
 *  particular needs it. */
let homeSeq = 0;

async function handle(command: ContentCommand): Promise<void> {
  switch (command.type) {
    case "home:load": {
      // Boot dispatches this twice: once anonymously from `App.tsx` (the
      // cookie-jar read is async, so it cannot have landed yet) and again
      // from `authStore` when `auth:state` comes back signed-in. Both
      // parse fine, but only the second carries the personalized shelves
      // — "Listen again", "Quick picks". Without this guard whichever
      // request happened to finish last won, so an anonymous response
      // that came back slowly would overwrite the personalized feed AND
      // be written to the localStorage cache, which is why "Listen again"
      // went missing on some launches and not others.
      const seq = ++homeSeq;
      publish({ type: "home:loading" });
      try {
        const page = await fetchHomeFeedPage();
        if (seq !== homeSeq) {
          // Silent by design — but not undiagnosable. A superseded load
          // publishes nothing at all, which means anything waiting on the
          // outcome of *its* request waits forever; that is precisely how
          // the startup refresher ended up timing out and retrying a feed
          // that had in fact just been fetched.
          logLine("Kodama Home", `Fetch #${seq} superseded by #${homeSeq}`);
          return;
        }
        publish({ type: "home:loaded", shelves: page.shelves });
      } catch (e) {
        if (seq !== homeSeq) {
          logLine("Kodama Home", `Fetch #${seq} superseded by #${homeSeq} (after failing)`);
          return;
        }
        // Logged, not just published. `homeStore` keeps this message in
        // state and the screen deliberately never shows it (a cached feed
        // must not be replaced by an error), so without this line a Home
        // feed that fails on every boot is completely silent — which is
        // exactly how the "Home shows stale content" report went
        // undiagnosed. One line per failed attempt, and attempts are
        // rare.
        logLine("Kodama Home", `Fetch failed: ${errMessage(e)}`);
        publish({ type: "home:error", message: errMessage(e) });
      }
      return;
    }

    case "explore:load": {
      publish({ type: "explore:loading", feed: command.feed });
      try {
        const fetcher = {
          explore: fetchExploreFeedPage,
          charts: fetchChartsFeedPage,
          newReleases: fetchNewReleasesFeedPage,
          moods: fetchMoodsAndGenresFeedPage,
        }[command.feed];
        const page = await fetcher(command.cursor);
        publish({
          type: "explore:loaded",
          feed: command.feed,
          shelves: page.shelves,
          nextCursor: page.nextCursor,
          append: !!command.cursor,
        });
      } catch (e) {
        publish({ type: "explore:error", feed: command.feed, message: errMessage(e) });
      }
      return;
    }

    case "search:query": {
      const filter = command.filter ?? "all";
      if (!command.query.trim()) {
        publish({
          type: "search:loaded",
          query: command.query,
          filter,
          results: { query: command.query, shelves: [] },
        });
        return;
      }
      publish({ type: "search:loading", query: command.query, filter });
      try {
        const results = await fetchSearch(command.query, filter);
        publish({ type: "search:loaded", query: command.query, filter, results });
      } catch (e) {
        publish({
          type: "search:error",
          query: command.query,
          filter,
          message: errMessage(e),
        });
      }
      return;
    }

    case "playlist:load": {
      publish({ type: "playlist:loading", id: command.id });
      try {
        const page = await fetchPlaylistFirstPage(command.id);
        publish({ type: "playlist:loaded", id: command.id, page });
      } catch (e) {
        publish({ type: "playlist:error", id: command.id, message: errMessage(e) });
      }
      return;
    }

    case "playlist:more": {
      try {
        const { tracks, continuationToken } = await fetchPlaylistContinuation(
          command.token,
        );
        publish({
          type: "playlist:more:loaded",
          id: command.id,
          tracks,
          nextCursor: continuationToken,
        });
      } catch (e) {
        publish({ type: "playlist:error", id: command.id, message: errMessage(e) });
      }
      return;
    }

    case "album:load": {
      publish({ type: "album:loading", id: command.id });
      try {
        const page = await fetchAlbum(command.id);
        publish({ type: "album:loaded", id: command.id, page });
      } catch (e) {
        publish({ type: "album:error", id: command.id, message: errMessage(e) });
      }
      return;
    }

    case "artist:load": {
      publish({ type: "artist:loading", id: command.id });
      try {
        const page = await fetchArtist(command.id);
        publish({ type: "artist:loaded", id: command.id, page });
      } catch (e) {
        publish({ type: "artist:error", id: command.id, message: errMessage(e) });
      }
      return;
    }

    case "library:load": {
      const { tab } = command;
      publish({ type: "library:loading", tab });
      // Signed out, YouTube answers a library browseId with a generic
      // explore page instead of an error — it parses cleanly into shelves
      // that have nothing to do with the user. Refusing here is what
      // stops "your playlists" quietly showing someone else's.
      if (!hasSession()) {
        publish({
          type: "library:error",
          tab,
          message: "Sign in to see your library.",
        });
        return;
      }
      try {
        if (tab === "songs") {
          const tracks = await fetchLikedSongs();
          publish({ type: "library:loaded", tab, sections: [], tracks });
        } else {
          const fetcher =
            tab === "playlists"
              ? fetchLibraryPlaylists
              : tab === "albums"
                ? fetchLibraryAlbums
                : fetchLibraryArtists;
          const sections = await fetcher();
          publish({ type: "library:loaded", tab, sections, tracks: [] });
        }
      } catch (e) {
        publish({ type: "library:error", tab, message: errMessage(e) });
      }
      return;
    }

    case "radio:load": {
      const { videoId } = command;
      try {
        const tracks = await fetchRadio(videoId);
        publish({ type: "radio:loaded", seed: videoId, tracks });
      } catch (e) {
        publish({ type: "radio:error", seed: videoId, message: errMessage(e) });
      }
      return;
    }

    case "lyrics:source": {
      const { source, ...params } = command;
      const lyrics = await fetchOneLyricsSource(source, params);
      publish({
        type: "lyrics:source-loaded",
        videoId: params.videoId,
        source,
        lyrics,
      });
      return;
    }

    case "lyrics:load": {
      publish({ type: "lyrics:loading", videoId: command.videoId });
      try {
        const { sources } = await fetchLyricsTiered(command);
        publish({ type: "lyrics:loaded", videoId: command.videoId, sources });
      } catch (e) {
        publish({ type: "lyrics:error", videoId: command.videoId, message: errMessage(e) });
      }
      return;
    }

    case "lyrics:search": {
      const { videoId, title, artist } = command;
      try {
        const results = await searchAllSources({ title, artist }, (done, total) =>
          publish({ type: "lyrics:search:progress", videoId, done, total }),
        );
        publish({ type: "lyrics:search:results", videoId, results });
      } catch (e) {
        publish({ type: "lyrics:search:error", videoId, message: errMessage(e) });
      }
      return;
    }
  }
}

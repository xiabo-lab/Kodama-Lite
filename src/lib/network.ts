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
import { fetchBestLyrics } from "@/lib/lyrics/sources";

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
  | {
      type: "lyrics:load";
      videoId: string;
      title: string;
      artist?: string;
      album?: string;
      duration?: number;
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
  | { type: "artist:loading"; id: string }
  | { type: "artist:loaded"; id: string; page: ArtistPage }
  | { type: "artist:error"; id: string; message: string }
  | { type: "lyrics:loading"; videoId: string }
  | { type: "lyrics:loaded"; videoId: string; lyrics: Lyrics | null }
  | { type: "lyrics:error"; videoId: string; message: string };

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

async function handle(command: ContentCommand): Promise<void> {
  switch (command.type) {
    case "home:load": {
      publish({ type: "home:loading" });
      try {
        const page = await fetchHomeFeedPage();
        publish({ type: "home:loaded", shelves: page.shelves });
      } catch (e) {
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

    case "lyrics:load": {
      publish({ type: "lyrics:loading", videoId: command.videoId });
      try {
        const lyrics = await fetchBestLyrics(command);
        publish({ type: "lyrics:loaded", videoId: command.videoId, lyrics });
      } catch (e) {
        publish({ type: "lyrics:error", videoId: command.videoId, message: errMessage(e) });
      }
      return;
    }
  }
}

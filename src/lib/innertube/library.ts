import type { ShelfItem } from "./types";
import {
  collectShelfNodes,
  mapShelfWrapper,
  rawBrowse,
  type YtNode,
} from "./shared";

/**
 * The user's library — playlists, albums, artists they follow, and Liked
 * Songs. Ported near-verbatim from YTMLite's `lib/innertube/library.ts`.
 *
 * Every one of these needs an authenticated session: signed out, YouTube
 * answers with a generic explore page rather than an error, so the
 * *caller* must check `hasSession()` first — a silent redirect that
 * parses cleanly into unrelated shelves is worse than a failure, because
 * it looks like it worked.
 */
export type LibrarySection = {
  id: string;
  title: string;
  items: ShelfItem[];
};

async function browseSections(browseId: string): Promise<LibrarySection[]> {
  const json = await rawBrowse(browseId);
  const tabs: YtNode[] =
    json?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];
  const sections: YtNode[] =
    tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];

  const shelfNodes = collectShelfNodes(sections);
  const out: LibrarySection[] = [];
  shelfNodes.forEach((wrapper, i) => {
    const { title, items } = mapShelfWrapper(wrapper, i);
    if (items.length === 0) return;
    out.push({ id: `${title}-${i}`, title, items });
  });
  return out;
}

export function fetchLibraryPlaylists(): Promise<LibrarySection[]> {
  return browseSections("FEmusic_liked_playlists");
}

export function fetchLibraryAlbums(): Promise<LibrarySection[]> {
  return browseSections("FEmusic_liked_albums");
}

export function fetchLibraryArtists(): Promise<LibrarySection[]> {
  return browseSections("FEmusic_library_corpus_artists");
}

/**
 * Liked Songs. YTM addresses it with the magic auto-generated id `LM`.
 * Returns the first page only — enough to fill the screen, and the Pi
 * never scrolls a 5,000-track list by hand. `fetchPlaylistContinuation`
 * is there if paging is ever wanted.
 */
export async function fetchLikedSongs(): Promise<ShelfItem[]> {
  const { fetchPlaylistFirstPage } = await import("./playlist");
  const page = await fetchPlaylistFirstPage("LM");
  return page.tracks;
}

/**
 * How many pages of Liked Music to walk when seeding the heart state.
 * A page is ~100 tracks, so this covers ~2,000 — deep enough that a song
 * liked a long time ago still shows as liked, bounded so a large library
 * doesn't turn sign-in into a minute of continuations. Tracks past the
 * cut-off render as un-liked until the user likes them again, which is
 * a display miss, not a data loss: `like/like` is idempotent.
 */
const LIKED_ID_PAGES = 20;

/**
 * Every liked videoId, as a Set, for deciding whether to draw the heart
 * filled. Deliberately ids only — the callers (the player bar and the
 * karaoke stage) need membership, not tracks, and dropping the rest keeps
 * a 2,000-entry set to a few tens of KB.
 *
 * Pages sequentially rather than in parallel because each continuation
 * token only exists once its own page has come back.
 */
export async function fetchLikedSongIds(): Promise<Set<string>> {
  const { fetchPlaylistFirstPage, fetchPlaylistContinuation } = await import(
    "./playlist"
  );
  const ids = new Set<string>();

  const first = await fetchPlaylistFirstPage("LM");
  for (const t of first.tracks) ids.add(t.id);

  let token = first.continuationToken;
  for (let page = 1; page < LIKED_ID_PAGES && token; page++) {
    const next = await fetchPlaylistContinuation(token);
    for (const t of next.tracks) ids.add(t.id);
    token = next.continuationToken;
  }

  return ids;
}

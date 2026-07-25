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

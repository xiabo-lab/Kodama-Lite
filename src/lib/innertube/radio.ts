import type { ShelfItem } from "./types";
import { mapPlaylistPanelVideo, rawNext, type YtNode } from "./shared";

/**
 * Radio: an endless station of tracks similar to a seed. This is what
 * YouTube Music does when a queue runs out — it doesn't stop, it keeps
 * finding songs in the same vein — and it's what makes "play one song from
 * Listen Again" turn into an evening of music rather than three minutes of
 * it.
 *
 * Ported from YTMLite's `lib/innertube/radio.ts`. `/next` with playlistId
 * `RDAMVM<videoId>` is the same call the real client makes for "Start
 * radio", and it answers with a `playlistPanelRenderer` of ~25 tracks
 * beginning with the seed itself.
 */

/** Pull the queue rows out of a `/next` `playlistPanelRenderer` response. */
function parsePanelTracks(json: YtNode): ShelfItem[] {
  const panelContents: YtNode[] =
    json?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
      ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents ?? [];

  const tracks: ShelfItem[] = [];
  for (const c of panelContents) {
    // YTM wraps rows that have both a song and a music-video version in a
    // playlistPanelVideoWrapperRenderer; the real row is under
    // primaryRenderer.
    const row =
      c.playlistPanelVideoRenderer ??
      c.playlistPanelVideoWrapperRenderer?.primaryRenderer
        ?.playlistPanelVideoRenderer;
    if (!row) continue;
    const mapped = mapPlaylistPanelVideo(row);
    if (mapped) tracks.push(mapped);
  }
  return tracks;
}

/** Tracks similar to `videoId`, seed first. */
export async function fetchRadio(videoId: string): Promise<ShelfItem[]> {
  return parsePanelTracks(
    await rawNext({
      videoId,
      playlistId: `RDAMVM${videoId}`,
      isAudioOnly: true,
    }),
  );
}

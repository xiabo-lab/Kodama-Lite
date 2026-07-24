// Ported verbatim from YTMLite's src/lib/lyrics/ytmusic.ts.

import { rawBrowse, rawNext, type YtNode } from "@/lib/innertube/shared";
import type { Lyrics } from "@/lib/lyrics/types";
import { parseLRC } from "@/lib/lyrics/parse-lrc";

/**
 * YouTube Music's own lyrics.
 *
 * Preferred over LRCLIB because it needs no matching step at all: the
 * lyrics are addressed by the exact `videoId` already playing, so there
 * is no fuzzy title/artist comparison and no possibility of returning a
 * different song.
 *
 * Two calls, both through the ported InnerTube client:
 *   1. `next` for the playing videoId returns a tab strip; one tab is
 *      Lyrics, carrying a `browseId` (or an empty one when the track
 *      has none).
 *   2. `browse` on that id returns the lyric text.
 *
 * The text is usually PLAIN, not timestamped — we still parse it as LRC
 * first since a minority of tracks come back with timestamps, and fall
 * back to plain when there are none.
 */

/** Locate the Lyrics tab's browseId in a `next` response. */
function findLyricsBrowseId(root: YtNode): string | null {
  const tabs =
    root?.contents?.singleColumnMusicWatchNextResultsRenderer
      ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs;
  if (!Array.isArray(tabs)) return null;

  for (const tab of tabs) {
    const r = tab?.tabRenderer;
    if (!r) continue;
    const title = String(r.title ?? "");
    const browseId = r.endpoint?.browseEndpoint?.browseId;
    // Match on the endpoint rather than the title: the tab label is
    // localised, but the browseId prefix is not.
    if (typeof browseId === "string" && browseId.startsWith("MPLY")) {
      return browseId;
    }
    if (title.toLowerCase() === "lyrics" && typeof browseId === "string") {
      return browseId || null;
    }
  }
  return null;
}

/** Pull the lyric text out of a lyrics `browse` response. */
function readLyricText(root: YtNode): string | null {
  const sections =
    root?.contents?.sectionListRenderer?.contents ??
    root?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
      ?.content?.sectionListRenderer?.contents;
  if (!Array.isArray(sections)) return null;

  for (const s of sections) {
    const desc = s?.musicDescriptionShelfRenderer?.description;
    if (!desc) continue;
    if (typeof desc.simpleText === "string" && desc.simpleText.trim()) {
      return desc.simpleText;
    }
    if (Array.isArray(desc.runs)) {
      const text = desc.runs.map((r: YtNode) => r?.text ?? "").join("");
      if (text.trim()) return text;
    }
  }
  return null;
}

export async function fetchYtMusicLyrics(
  videoId: string | undefined,
): Promise<Lyrics | null> {
  if (!videoId) return null;

  const next = await rawNext({ videoId, isAudioOnly: true });
  const browseId = findLyricsBrowseId(next);
  // No lyrics tab, or a tab with an empty id, means YouTube Music has
  // none for this track. That is a definitive answer, not an error, so
  // return null and let the next source take over.
  if (!browseId) return null;

  const text = readLyricText(await rawBrowse(browseId));
  if (!text || !text.trim()) return null;

  // A minority of records carry LRC timestamps; prefer them when present.
  const lines = parseLRC(text);
  if (lines.length > 0) {
    return { kind: "timed", lines, source: "YouTube Music" };
  }
  return { kind: "plain", text, source: "YouTube Music" };
}

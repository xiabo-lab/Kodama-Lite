import { fetchYtMusicLyrics } from "@/lib/lyrics/ytmusic";
import { fetchLrclibLyrics } from "@/lib/lyrics/lrclib";
import type { Lyrics } from "@/lib/lyrics/types";

/**
 * Simplified two-source aggregator: YouTube Music (exact-match, no
 * fuzzy matching, so it goes first) and LRCLIB (searched by title/artist).
 * YTMLite's full version races 7 sources including several with no
 * public English docs (QQ/Kugou/NetEase/Musixmatch/Genius) — deferred
 * here; this covers the two simplest, most broadly-licensed, no-auth
 * sources so lyrics genuinely work end to end for a real Phase 3, with
 * room to add more sources later by following the same pattern.
 *
 * Auto-pick rule (same as YTMLite): any timed source beats any plain
 * source; YTM wins ties since it can't be a mismatched song.
 */
export async function fetchBestLyrics(params: {
  videoId: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
}): Promise<Lyrics | null> {
  const [ytm, lrclib] = await Promise.allSettled([
    fetchYtMusicLyrics(params.videoId),
    fetchLrclibLyrics({
      title: params.title,
      artist: params.artist,
      album: params.album,
      duration: params.duration,
    }),
  ]);

  const ytmResult = ytm.status === "fulfilled" ? ytm.value : null;
  const lrclibResult = lrclib.status === "fulfilled" ? lrclib.value : null;

  if (ytmResult?.kind === "timed") return ytmResult;
  if (lrclibResult?.kind === "timed") return lrclibResult;
  return ytmResult ?? lrclibResult ?? null;
}

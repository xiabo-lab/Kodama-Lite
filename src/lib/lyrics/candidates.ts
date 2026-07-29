/**
 * Shared plumbing for "search a source, then fetch every hit's lyrics".
 *
 * Every provider works the same way — one search call returns N song
 * identifiers, then each identifier needs its own request to pull the
 * actual lyric. Carlyrics' `_candidates()` is the same helper, and its
 * rationale carries over unchanged: those per-hit downloads are
 * independent, so running them together makes a source cost ~2 round trips
 * instead of ~(1 + limit). It's the same number of requests either way,
 * just overlapped — and the song is already playing while we search.
 */

import type { LyricsCandidate } from "@/lib/lyrics/score";
import type { Lyrics } from "@/lib/lyrics/types";

/** One search hit, before its lyrics have been fetched. */
export type SearchHit<K> = {
  /** Whatever the lyric fetcher needs to identify this hit — a song id, a
   *  hash, a URL. Opaque here. */
  key: K;
  /** The provider's OWN reported title/artist. Carried through unchanged,
   *  because scoring compares it against what we asked for. */
  title: string;
  artist: string;
};

/**
 * Resolve every hit's lyrics concurrently and return the ones that
 * produced something, in the source's original ranking order.
 *
 * A single failed or empty lyric drops that one candidate rather than the
 * whole source — one 404 among five hits must not cost the other four.
 * Order is preserved (`allSettled` is positional), which matters because
 * `bestCandidate` resolves ties to the earlier entry, i.e. to the source's
 * own idea of which hit is best.
 */
export async function resolveCandidates<K>(
  source: string,
  hits: SearchHit<K>[],
  fetchLyrics: (key: K) => Promise<Lyrics | null>,
  limit: number,
): Promise<LyricsCandidate[]> {
  if (hits.length === 0) return [];
  const capped = hits.slice(0, limit);
  const settled = await Promise.allSettled(
    capped.map((h) => fetchLyrics(h.key)),
  );
  const out: LyricsCandidate[] = [];
  capped.forEach((hit, i) => {
    const r = settled[i];
    if (r.status !== "fulfilled" || !r.value) return;
    out.push({
      source,
      title: hit.title,
      artist: hit.artist,
      lyrics: r.value,
    });
  });
  return out;
}

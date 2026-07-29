// Ported verbatim from YTMLite (only the fetch import source changed).
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Lyrics } from "@/lib/lyrics/types";
import { parseLRC } from "@/lib/lyrics/parse-lrc";
import { hitMatches, normalizeForMatch } from "@/lib/lyrics/match";
import type { CnLyricsParams } from "@/lib/lyrics/netease";
import type { LyricsCandidate } from "@/lib/lyrics/score";
import { resolveCandidates, type SearchHit } from "@/lib/lyrics/candidates";

/**
 * QQ Music (QQ音乐) — the other major Chinese-language lyric source,
 * alongside NetEase and Kugou. See `netease.ts` for why these exist.
 *
 * Search uses the `client_search_cp` endpoint. The newer `musicu.fcg`
 * desktop service was tried first and rejected every query from here:
 * with no `comm` envelope it answers `req_1.code 2001`, and with one it
 * answers `code 0` and an empty song list, for Chinese and ASCII queries
 * alike. `client_search_cp` returns full results for the same terms, so
 * that is what we use.
 *
 * QQ also publishes word-by-word "QRC" lyrics, but that blob is hex
 * encoded and encrypted with a modified DES before zlib inflation.
 * Porting that is a lot of surface for no visible gain here: the player
 * highlights whole lines, so the per-word timings would be discarded by
 * the parser anyway. We take the plain LRC endpoint instead, which is
 * line-synced and needs no decryption.
 */

const SEARCH_URL = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const LYRIC_URL =
  "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";

/**
 * `Origin` is set deliberately, and the search endpoint does not work
 * without it. Tauri's HTTP plugin forwards the webview's own origin
 * (`http://tauri.localhost`), and `client_search_cp` answers 400 to any
 * request carrying an Origin it doesn't recognise — so QQ failed on
 * every lookup while the identical curl request succeeded. Sending
 * QQ's own origin is accepted; an empty one works too, a literal
 * "null" does not. Overriding it needs the http plugin's
 * `unsafe-headers` feature, which this app already enables.
 */
const HEADERS = {
  Referer: "https://y.qq.com/",
  Origin: "https://y.qq.com",
  "User-Agent": "Mozilla/5.0 (X11; Linux aarch64) Kodama-Lite/1.0",
};

/**
 * QQ is asked for its single top hit only, and never more than one
 * request at a time (see `qqSerialized`).
 *
 * Two independent reasons, both learned the hard way:
 *  - Relevance. QQ over-returns unrelated songs that merely share a
 *    title, so scanning deeper into its result list mostly finds noise.
 *    Taking the top hit and letting `hitMatches` veto it is stricter
 *    than accepting the best of five.
 *  - Rate limiting. QQ misbehaves when searched repeatedly in quick
 *    succession, which is exactly what track-skipping produces here.
 */
const SEARCH_LIMIT = 1;

/** Minimum spacing between consecutive QQ requests. */
const MIN_REQUEST_GAP_MS = 400;

let qqChain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/**
 * Run `fn` with every other QQ request, app-wide: one in flight at a
 * time, spaced by at least MIN_REQUEST_GAP_MS. Skipping through tracks
 * otherwise fires overlapping searches at a service that dislikes them.
 *
 * The chain is deliberately kept alive past a rejection, so one failed
 * lookup cannot wedge every later one.
 */
function qqSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = qqChain.then(async () => {
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  qqChain = run.catch(() => undefined);
  return run;
}

/**
 * GET a QQ endpoint and parse the body as JSON.
 *
 * Both endpoints answer with `Content-Type: application/x-javascript`
 * even when `format=json` is requested, so `Response.json()` rejects
 * them and the whole source silently errors out. Read the body as text
 * and parse it ourselves. Some QQ endpoints additionally wrap the object
 * in a JSONP callback, so strip that if present.
 */
async function fetchJson<T>(url: string): Promise<T> {
  return qqSerialized(async () => {
    const r = await tauriFetch(url, { headers: HEADERS });
    if (!r.ok) throw new Error(`QQ ${r.status}`);
    const raw = (await r.text()).trim();
    const jsonp = /^[^({]*\(([\s\S]*)\)\s*;?$/.exec(raw);
    return JSON.parse(jsonp ? jsonp[1] : raw) as T;
  });
}

type QqSong = {
  songmid?: string;
  songname?: string;
  singer?: { name?: string }[];
};

export async function fetchQqLyrics(
  p: CnLyricsParams,
): Promise<Lyrics | null> {
  if (!p.title) return null;

  const song = await searchSong(p);
  if (!song?.songmid) return null;

  const lrc = await fetchLyric(song.songmid);
  if (!lrc) return null;

  const lines = parseLRC(lrc);
  if (lines.length === 0) return null;
  return { kind: "timed", lines, source: "QQ Music" };
}

/**
 * QQ hits for a query, with lyrics, as scoreable candidates.
 *
 * Capped harder than the other sources, and Carlyrics caps it the same way
 * (`CANDIDATE_QUERY_LIMITS = {"QQ": 1}` for the automatic sweep) for the
 * two reasons in the SEARCH_LIMIT comment above: QQ's relevance is poor
 * past the top hit, and it rate-limits under rapid repeat queries. A
 * *manual* search can afford to ask for more — it happens once, on purpose,
 * and the user is looking at the results — so the limit is a parameter
 * rather than a constant here.
 */
export async function searchQqCandidates(
  p: CnLyricsParams,
  limit: number,
): Promise<LyricsCandidate[]> {
  const hits = await searchSongs(p, limit);
  return resolveCandidates("qq", hits, lyricsForMid, limit);
}

async function lyricsForMid(mid: string): Promise<Lyrics | null> {
  const lrc = await fetchLyric(mid);
  if (!lrc) return null;
  const lines = parseLRC(lrc);
  return lines.length > 0 ? { kind: "timed", lines, source: "QQ Music" } : null;
}

async function searchSongs(
  p: CnLyricsParams,
  limit: number,
): Promise<SearchHit<string>[]> {
  const query = [p.title, p.artist].filter(Boolean).join(" ").trim();
  if (!query) return [];

  const url = new URL(SEARCH_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("p", "1");
  url.searchParams.set("n", String(Math.max(limit, 1)));
  url.searchParams.set("w", query);

  const data = await fetchJson<{ data?: { song?: { list?: QqSong[] } } }>(
    url.toString(),
  );
  return (data.data?.song?.list ?? [])
    .filter((s): s is QqSong & { songmid: string } => !!s.songmid)
    .map((s) => ({
      key: s.songmid,
      title: s.songname ?? "",
      artist: (s.singer ?? [])
        .map((a) => a.name ?? "")
        .filter(Boolean)
        .join("/"),
    }));
}

async function searchSong(p: CnLyricsParams): Promise<QqSong | null> {
  const query = [p.title, p.artist].filter(Boolean).join(" ").trim();
  if (!query) return null;

  const url = new URL(SEARCH_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("p", "1"); // page
  url.searchParams.set("n", String(SEARCH_LIMIT)); // results per page
  url.searchParams.set("w", query); // keyword

  const data = await fetchJson<{ data?: { song?: { list?: QqSong[] } } }>(
    url.toString(),
  );
  const top = (data.data?.song?.list ?? [])[0];
  if (!top) return null;

  const hitTitle = normalizeForMatch(top.songname ?? "");
  const hitArtist = normalizeForMatch(
    (top.singer ?? []).map((a) => a.name ?? "").join(" "),
  );
  const ok = hitMatches(
    normalizeForMatch(p.title),
    normalizeForMatch(p.artist ?? ""),
    hitTitle,
    hitArtist,
  );
  return ok ? top : null;
}

async function fetchLyric(songMid: string): Promise<string | null> {
  const url = new URL(LYRIC_URL);
  url.searchParams.set("songmid", songMid);
  url.searchParams.set("format", "json");
  // Without this the payload comes back base64-encoded.
  url.searchParams.set("nobase64", "1");

  const data = await fetchJson<{ lyric?: string }>(url.toString());
  const lyric = data.lyric ?? "";
  if (!lyric.trim() || !lyric.includes("[")) return null;
  // QQ escapes HTML entities (&apos; &quot; &amp; …) inside the LRC text.
  return decodeHtmlEntities(lyric);
}

/**
 * Decode the handful of XML/HTML entities QQ escapes in its lyric text.
 * Deliberately not via `innerHTML` on a scratch element: this string is
 * untrusted remote content and parsing it as HTML would be an injection
 * vector for no benefit.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    // Ampersand last, so "&amp;lt;" decodes to "&lt;" and not "<".
    .replace(/&amp;/g, "&");
}

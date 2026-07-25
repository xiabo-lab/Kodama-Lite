// Ported verbatim from YTMLite (only the fetch import source changed).
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Lyrics } from "@/lib/lyrics/types";
import { parseLRC } from "@/lib/lyrics/parse-lrc";
import { hitMatches, normalizeForMatch } from "@/lib/lyrics/match";
import type { CnLyricsParams } from "@/lib/lyrics/netease";
import { krcToLines } from "@/lib/lyrics/krc";

/**
 * Kugou (酷狗音乐) — third of the Chinese-language sources; see
 * `netease.ts` for why they exist.
 *
 * Three unauthenticated steps: search for the song's `hash`, ask the
 * `krcs` service for a lyric candidate (`id` + `accesskey`), then
 * download that candidate. Kugou serves its own encrypted KRC format as
 * well as plain LRC; we try KRC first because its coverage is better,
 * and fall back to LRC when a track has none.
 *
 * These hosts are plain HTTP on purpose. `mobilecdn.kugou.com` presents
 * a TLS certificate that does not match its hostname, so HTTPS fails
 * verification outright. The endpoints are public, unauthenticated, and
 * carry nothing but song metadata and lyrics, so cleartext costs no
 * secrecy here — but it does mean these responses are attacker-mutable
 * on a hostile network, which is why nothing derived from them is ever
 * evaluated: it is parsed as text and rendered as text.
 */

const SEARCH_URL = "http://mobilecdn.kugou.com/api/v3/search/song";
const LYRIC_SEARCH_URL = "http://krcs.kugou.com/search";
const LYRIC_DOWNLOAD_URL = "http://lyrics.kugou.com/download";

const HEADERS = {
  Referer: "https://www.kugou.com/",
  "User-Agent": "Mozilla/5.0 (X11; Linux aarch64) Kodama-Lite/1.0",
};

const SEARCH_LIMIT = 5;

type KugouSong = {
  hash?: string;
  songname?: string;
  singername?: string;
};

type KugouCandidate = {
  id?: string;
  accesskey?: string;
};

export async function fetchKugouLyrics(
  p: CnLyricsParams,
): Promise<Lyrics | null> {
  if (!p.title) return null;

  const song = await searchSong(p);
  if (!song?.hash) return null;

  const candidate = await findLyricCandidate(song.hash);
  if (!candidate) return null;

  // KRC first: better coverage than Kugou's plain LRC, and the only
  // format among the seven sources that carries per-word timings — which
  // is what makes word-level karaoke possible at all.
  const krcLines = await downloadKrcLines(candidate);
  if (krcLines) return { kind: "timed", lines: krcLines, source: "Kugou" };

  const lrc = await downloadPlainLrc(candidate);
  if (!lrc) return null;

  const lines = parseLRC(lrc);
  if (lines.length === 0) return null;
  return { kind: "timed", lines, source: "Kugou" };
}

async function searchSong(p: CnLyricsParams): Promise<KugouSong | null> {
  const query = [p.title, p.artist].filter(Boolean).join(" ").trim();
  if (!query) return null;

  const url = new URL(SEARCH_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("keyword", query);
  url.searchParams.set("page", "1");
  url.searchParams.set("pagesize", String(SEARCH_LIMIT));
  url.searchParams.set("showtype", "1");

  const r = await tauriFetch(url.toString(), { headers: HEADERS });
  if (!r.ok) throw new Error(`Kugou search ${r.status}`);
  const data = (await r.json()) as { data?: { info?: KugouSong[] } };
  const songs = data.data?.info ?? [];
  if (songs.length === 0) return null;

  const reqTitle = normalizeForMatch(p.title);
  const reqArtist = normalizeForMatch(p.artist ?? "");
  for (const s of songs) {
    const hitTitle = normalizeForMatch(s.songname ?? "");
    const hitArtist = normalizeForMatch(s.singername ?? "");
    if (hitMatches(reqTitle, reqArtist, hitTitle, hitArtist)) return s;
  }
  return null;
}

async function findLyricCandidate(
  hash: string,
): Promise<KugouCandidate | null> {
  const url = new URL(LYRIC_SEARCH_URL);
  url.searchParams.set("ver", "1");
  url.searchParams.set("man", "yes");
  url.searchParams.set("client", "mobi");
  url.searchParams.set("hash", hash);

  const r = await tauriFetch(url.toString(), { headers: HEADERS });
  if (!r.ok) throw new Error(`Kugou lyric search ${r.status}`);
  const data = (await r.json()) as { candidates?: KugouCandidate[] };
  const first = data.candidates?.[0];
  if (!first?.id || !first?.accesskey) return null;
  return first;
}

/** Fetch one lyric format for a candidate. Returns the raw `content`. */
async function download(
  c: KugouCandidate,
  fmt: "krc" | "lrc",
): Promise<string> {
  const url = new URL(LYRIC_DOWNLOAD_URL);
  url.searchParams.set("ver", "1");
  url.searchParams.set("client", "pc");
  url.searchParams.set("id", c.id!);
  url.searchParams.set("accesskey", c.accesskey!);
  url.searchParams.set("fmt", fmt);
  url.searchParams.set("charset", "utf8");

  const r = await tauriFetch(url.toString(), { headers: HEADERS });
  if (!r.ok) throw new Error(`Kugou download ${fmt} ${r.status}`);
  const data = (await r.json()) as { content?: string };
  return data.content ?? "";
}

/** The word-timed leg. A track without a KRC answers with an empty or
 *  undecryptable blob, which `krcToLines` rejects — the caller then falls
 *  through to plain LRC, which is a complete substitute apart from the
 *  word timings. Network/parse trouble here alone must not lose the
 *  track, hence the swallow. */
async function downloadKrcLines(c: KugouCandidate) {
  try {
    const krc = await download(c, "krc");
    return krc ? await krcToLines(krc) : null;
  } catch {
    return null;
  }
}

async function downloadPlainLrc(c: KugouCandidate): Promise<string | null> {
  const content = await download(c, "lrc");
  if (!content) return null;
  const lrc = decodeBase64Utf8(content);
  if (!lrc || !lrc.trim() || !lrc.includes("[")) return null;
  return lrc;
}

/** base64 -> UTF-8 text, tolerating the BOM Kugou prepends to LRC blobs. */
function decodeBase64Utf8(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    // Strip the BOM Kugou prepends. Written as an escape because a
    // literal U+FEFF is invisible in source and trips eslint.
    const BOM = String.fromCharCode(0xfeff);
    return new TextDecoder("utf-8").decode(bytes).replace(new RegExp(`^${BOM}`), "");
  } catch {
    return null;
  }
}

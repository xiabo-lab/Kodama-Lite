// Ported from YTMLite, then extended to keep the per-word timings.
/**
 * Kugou KRC decoding.
 *
 * A KRC blob is base64 of: a 4-byte `krc1` magic, then the payload XOR'd
 * byte-wise with a fixed 16-byte key (cycled), then zlib-deflated text.
 * The key is a well-known constant published in every open-source Kugou
 * client; it obfuscates rather than protects, and there is no secret
 * here to leak.
 *
 * The decoded text is line-level `[start,duration]` tags followed by
 * per-word `<offset,duration,0>text` runs, where the word offset is
 * relative to the line start.
 *
 * This used to flatten straight to line-level LRC and throw the word runs
 * away, because the stage highlighted whole lines. It no longer does:
 * KRC is the only one of the seven sources that carries real word timings,
 * so those runs are the entire basis for word-level karaoke. They're kept
 * and normalised to absolute seconds here.
 *
 * Kept free of Tauri/network imports so it can be unit-tested.
 */

import type { TimedLine, TimedWord } from "@/lib/lyrics/types";

const KRC_KEY = new Uint8Array([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d,
  0xce, 0xd2, 0x6e, 0x69,
]);

const LINE_RE = /^\[(\d+),(\d+)\](.*)$/;
const WORD_RE = /<(\d+),(\d+),\d+>([^<]*)/g;

/**
 * Decrypt a base64 KRC blob into timed lines with per-word timings.
 * Returns null for anything that isn't a valid, timed KRC — an empty
 * blob, a bad magic, a failed inflate, or text with no timed lines.
 */
export async function krcToLines(b64: string): Promise<TimedLine[] | null> {
  const decrypted = await decryptKrc(b64);
  return decrypted ? krcTextToLines(decrypted) : null;
}

async function decryptKrc(b64: string): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    const bin = atob(b64.trim());
    bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length <= 4) return null;
  // "krc1"
  if (
    bytes[0] !== 0x6b ||
    bytes[1] !== 0x72 ||
    bytes[2] !== 0x63 ||
    bytes[3] !== 0x31
  ) {
    return null;
  }

  const body = bytes.slice(4);
  for (let i = 0; i < body.length; i++) {
    body[i] ^= KRC_KEY[i % KRC_KEY.length];
  }

  try {
    return await inflate(body);
  } catch {
    return null;
  }
}

/**
 * zlib-inflate via the platform's DecompressionStream. "deflate" is the
 * zlib-wrapped variant, which is what Kugou emits ("deflate-raw" would
 * choke on the 2-byte header). Older webviews lack the API entirely; the
 * caller treats a throw as "no KRC" and falls back to plain LRC.
 */
async function inflate(data: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream unavailable");
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder("utf-8").decode(buf);
}

/**
 * Parse decrypted KRC text into timed lines.
 *
 * Metadata lines (`[ti:…]`, `[language:…]`, …) carry no
 * `[start,duration]` tag and are skipped. A line whose word runs are all
 * empty contributes no text and is dropped, matching the old behaviour.
 */
export function krcTextToLines(krc: string): TimedLine[] | null {
  const out: TimedLine[] = [];
  for (const raw of krc.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const lineStartMs = Number(m[1]);
    const lineDurMs = Number(m[2]);
    if (!Number.isFinite(lineStartMs)) continue;

    const words: TimedWord[] = [];
    let text = "";
    for (const w of m[3].matchAll(WORD_RE)) {
      const offMs = Number(w[1]);
      const durMs = Number(w[2]);
      const chunk = w[3];
      text += chunk;
      // Whitespace-only runs are kept, not skipped: the renderer draws the
      // line *from* this list, so dropping them would delete the spaces
      // between Latin words. An invisible run simply lights up invisibly.
      if (!Number.isFinite(offMs) || !Number.isFinite(durMs)) continue;
      words.push({
        start: (lineStartMs + offMs) / 1000,
        end: (lineStartMs + offMs + durMs) / 1000,
        text: chunk,
      });
    }

    if (!text.trim()) continue;

    out.push({
      start: lineStartMs / 1000,
      end: Number.isFinite(lineDurMs)
        ? (lineStartMs + lineDurMs) / 1000
        : undefined,
      text,
      words: words.length > 0 ? words : undefined,
    });
  }
  if (out.length === 0) return null;
  out.sort((a, b) => a.start - b.start);
  return out;
}

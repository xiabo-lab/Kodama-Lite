// Ported verbatim from YTMLite.
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
 * relative to the line start. The player highlights whole lines, so we
 * flatten to ordinary line-level LRC and let `parseLRC` take it from
 * there rather than emitting per-word tags it would only strip again.
 *
 * Kept free of Tauri/network imports so it can be unit-tested.
 */

const KRC_KEY = new Uint8Array([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d,
  0xce, 0xd2, 0x6e, 0x69,
]);

const LINE_RE = /^\[(\d+),(\d+)\](.*)$/;
const WORD_RE = /<(\d+),(\d+),\d+>([^<]*)/g;

/** Format milliseconds as an LRC timestamp, `[mm:ss.cc]`. */
export function formatLrcTimestamp(ms: number): string {
  const mm = Math.floor(ms / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `[${pad(mm)}:${pad(ss)}.${pad(cs)}]`;
}

/**
 * Decrypt a base64 KRC blob and flatten it to line-level LRC.
 * Returns null for anything that isn't a valid, timed KRC — an empty
 * blob, a bad magic, a failed inflate, or text with no timed lines.
 */
export async function krcToLrc(b64: string): Promise<string | null> {
  const decrypted = await decryptKrc(b64);
  return decrypted ? krcTextToLrc(decrypted) : null;
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
 * Flatten decrypted KRC text to line-level LRC. Metadata lines
 * (`[ti:…]`, `[language:…]`, …) carry no `[start,duration]` tag and are
 * skipped.
 */
export function krcTextToLrc(krc: string): string | null {
  const out: string[] = [];
  for (const raw of krc.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const lineStart = Number(m[1]);
    if (!Number.isFinite(lineStart)) continue;
    let text = "";
    for (const w of m[3].matchAll(WORD_RE)) text += w[3];
    text = text.trim();
    if (!text) continue;
    out.push(formatLrcTimestamp(lineStart) + text);
  }
  return out.length > 0 ? out.join("\n") : null;
}

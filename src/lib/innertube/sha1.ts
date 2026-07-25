/**
 * A tiny SHA-1, used for exactly one thing: the `SAPISIDHASH` digest every
 * authenticated InnerTube request carries (see `authHeaders` in
 * `shared.ts`).
 *
 * Why not `crypto.subtle.digest("SHA-1", …)`: WebCrypto is only exposed in a
 * secure context, and the main window is served over Tauri's custom
 * protocol, whose secure-context status varies by platform and Tauri
 * version. A signed-in app silently losing its ability to authenticate
 * because `crypto.subtle` came back `undefined` on the Pi's WebKitGTK is a
 * bad failure to inherit for the sake of avoiding 40 lines — especially
 * when those 40 lines are exactly testable against the published vectors
 * (see sha1.test.ts) and this one is.
 *
 * SHA-1 is used here because Google's endpoint specifies it, not because
 * it's a sound choice of hash — it is not collision-resistant. It is not
 * used anywhere else in this codebase and must not be.
 */

/** SHA-1 of a string's UTF-8 bytes, as lowercase hex. */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;

  // Pad to a multiple of 64 bytes: 0x80, then zeroes, then a big-endian
  // 64-bit bit-count in the last 8 bytes.
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const block = new Uint8Array(paddedLength);
  block.set(bytes);
  block[bytes.length] = 0x80;
  const view = new DataView(block.buffer);
  // The high word is always 0 here — a string long enough to overflow 2^32
  // bits (512MB) can't reach this function.
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map(hex8).join("");
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

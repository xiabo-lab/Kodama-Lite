import { describe, expect, it } from "vitest";
import { sha1Hex } from "./sha1";

/**
 * The published FIPS 180-1 / RFC 3174 vectors, plus the cases that actually
 * exercise the padding branches: a message that lands exactly on a block
 * boundary, and one whose length forces a second padding block.
 */
describe("sha1Hex", () => {
  it("hashes the empty string", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("hashes 'abc'", () => {
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("hashes the two-block RFC 3174 vector", () => {
    expect(
      sha1Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ).toBe("84983e441c3bd26ebaae4aa1f95129e5e54670f1");
  });

  it("hashes a million 'a's", () => {
    expect(sha1Hex("a".repeat(1_000_000))).toBe(
      "34aa973cd4c4daa4f61eeb2bdbad27316534016f",
    );
  });

  // 55 bytes is the largest message that still fits its padding in one
  // 64-byte block; 56 is the smallest that needs a second one. Both are
  // off-by-one traps in the padding arithmetic.
  it("handles the one-block/two-block padding boundary", () => {
    expect(sha1Hex("a".repeat(55))).toBe(
      "c1c8bbdc22796e28c0e15163d20899b65621d65a",
    );
    expect(sha1Hex("a".repeat(56))).toBe(
      "c2db330f6083854c99d4b5bfb6e8f29f201be699",
    );
  });

  it("hashes multi-byte UTF-8 by its bytes, not its code units", () => {
    // "é" is two UTF-8 bytes; a naive charCodeAt() implementation gets a
    // different answer here.
    expect(sha1Hex("é")).toBe("bf15be717ac1b080b4f1c456692825891ff5073d");
  });
});

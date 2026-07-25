import { describe, expect, it } from "vitest";
import { krcTextToLines } from "@/lib/lyrics/krc";

/**
 * Decrypted-KRC parsing. The decrypt/inflate half needs
 * `DecompressionStream` and real Kugou bytes, so these cover the part
 * that actually decides what ends up on screen: the `[start,duration]`
 * line tags and the `<offset,duration,0>` word runs that word-level
 * karaoke is built on.
 */
describe("krcTextToLines", () => {
  const sample = [
    "[ti:打雀英雄傳]",
    "[ar:許冠傑]",
    "[1000,2000]<0,500,0>打<500,500,0>雀<1000,1000,0>英雄",
    "[3500,1500]<0,700,0>Hello <700,800,0>world",
  ].join("\n");

  it("skips metadata lines that carry no time tag", () => {
    expect(krcTextToLines(sample)).toHaveLength(2);
  });

  it("converts line tags to seconds", () => {
    const [first] = krcTextToLines(sample)!;
    expect(first.start).toBeCloseTo(1);
    expect(first.end).toBeCloseTo(3);
    expect(first.text).toBe("打雀英雄");
  });

  it("makes word offsets absolute, not line-relative", () => {
    const [first] = krcTextToLines(sample)!;
    expect(first.words).toEqual([
      { start: 1, end: 1.5, text: "打" },
      { start: 1.5, end: 2, text: "雀" },
      { start: 2, end: 3, text: "英雄" },
    ]);
  });

  it("keeps the spaces between Latin words", () => {
    const line = krcTextToLines(sample)![1];
    expect(line.words!.map((w) => w.text).join("")).toBe("Hello world");
  });

  it("returns null when nothing is timed", () => {
    expect(krcTextToLines("[ti:x]\n[ar:y]")).toBeNull();
    expect(krcTextToLines("")).toBeNull();
  });

  it("drops lines whose runs carry no text", () => {
    expect(krcTextToLines("[1000,500]<0,500,0>")).toBeNull();
  });

  it("sorts by start time", () => {
    const lines = krcTextToLines(
      "[5000,500]<0,500,0>b\n[1000,500]<0,500,0>a",
    )!;
    expect(lines.map((l) => l.text)).toEqual(["a", "b"]);
  });
});

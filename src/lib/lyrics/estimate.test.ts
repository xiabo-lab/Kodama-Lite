import { describe, expect, it } from "vitest";
import {
  canEstimate,
  estimateTimedLines,
  splitPlainLines,
  tokenizeWords,
} from "@/lib/lyrics/estimate";

describe("splitPlainLines", () => {
  it("drops blank lines and trims", () => {
    expect(splitPlainLines("a\n\n  b  \n\n\nc\n")).toEqual(["a", "b", "c"]);
  });
});

describe("tokenizeWords", () => {
  it("splits CJK per character", () => {
    expect(tokenizeWords("打雀英雄")).toEqual(["打", "雀", "英", "雄"]);
  });

  it("splits Latin per word", () => {
    expect(tokenizeWords("hello big world")).toEqual([
      "hello ",
      "big ",
      "world",
    ]);
  });

  // The renderer draws the active line from this list, so anything the
  // tokenizer drops is a character missing from the screen.
  it("reconstructs the original line exactly", () => {
    for (const line of [
      "hello big world",
      "打雀英雄傳",
      "Hello 世界 mixed 123",
      "a  b",
    ]) {
      expect(tokenizeWords(line).join("")).toBe(line);
    }
  });
});

describe("canEstimate", () => {
  it("rejects unknown or absurd durations", () => {
    expect(canEstimate("a\nb", 0)).toBe(false);
    expect(canEstimate("a\nb", NaN)).toBe(false);
    expect(canEstimate("a\nb", 3)).toBe(false);
  });

  it("rejects empty text", () => {
    expect(canEstimate("   \n\n ", 200)).toBe(false);
  });

  it("accepts a real transcript over a real duration", () => {
    expect(canEstimate("a\nb\nc", 200)).toBe(true);
  });
});

describe("estimateTimedLines", () => {
  const text = "打雀英雄傳\n六婶三太公\n大众开台啦面似莲蓉";
  const duration = 200;

  it("returns one line per non-blank input line", () => {
    expect(estimateTimedLines(text, duration)).toHaveLength(3);
  });

  it("leaves an intro and an outro rather than starting at zero", () => {
    const lines = estimateTimedLines(text, duration);
    expect(lines[0].start).toBeGreaterThan(0);
    expect(lines[lines.length - 1].end!).toBeLessThan(duration);
  });

  it("produces strictly increasing, contiguous spans", () => {
    const lines = estimateTimedLines(text, duration);
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i].end!).toBeGreaterThan(lines[i].start);
      if (i > 0) expect(lines[i].start).toBeCloseTo(lines[i - 1].end!, 6);
    }
  });

  it("gives a longer line more of the clock than a short one", () => {
    const [short, long] = estimateTimedLines("一二\n一二三四五六七八", 200);
    expect(long.end! - long.start).toBeGreaterThan(short.end! - short.start);
  });

  it("times every word inside its own line", () => {
    for (const line of estimateTimedLines(text, duration)) {
      expect(line.words).toBeDefined();
      const words = line.words!;
      expect(words[0].start).toBeCloseTo(line.start, 6);
      expect(words[words.length - 1].end).toBeCloseTo(line.end!, 6);
      for (let i = 1; i < words.length; i++) {
        expect(words[i].start).toBeCloseTo(words[i - 1].end, 6);
      }
    }
  });

  it("keeps words reconstructing their line, so nothing is dropped on screen", () => {
    for (const line of estimateTimedLines("Hello big world\n打雀英雄傳", 200)) {
      expect(line.words!.map((w) => w.text).join("").trim()).toBe(line.text);
    }
  });

  it("returns nothing when it cannot estimate", () => {
    expect(estimateTimedLines("a\nb", 0)).toEqual([]);
  });
});

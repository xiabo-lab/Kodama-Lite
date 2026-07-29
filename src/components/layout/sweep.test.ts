import { describe, expect, it } from "vitest";
import { sweepFraction } from "@/components/layout/lyrics-view";
import type { TimedWord } from "@/lib/lyrics/types";

/**
 * The karaoke fill's edge position — the port of Carlyrics'
 * `_karaoke_split_px`. Tested directly rather than through the DOM because
 * it is pure arithmetic over measured geometry, and the interesting cases
 * (before the first word, inside a word, at a boundary, past the end) are
 * exactly the ones that are awkward to hit by driving a real clock.
 */

/** Four evenly-spaced words, one second each, each a quarter of the line. */
const words: TimedWord[] = [
  { start: 10, end: 11, text: "a" },
  { start: 11, end: 12, text: "b" },
  { start: 12, end: 13, text: "c" },
  { start: 13, end: 14, text: "d" },
];
const bounds = [
  { left: 0, right: 0.25 },
  { left: 0.25, right: 0.5 },
  { left: 0.5, right: 0.75 },
  { left: 0.75, right: 1 },
];
const LINE_END = 14;

describe("sweepFraction", () => {
  it("sits at the line start before the first word", () => {
    expect(sweepFraction(words, bounds, 9.5, LINE_END)).toBe(0);
    expect(sweepFraction(words, bounds, 10, LINE_END)).toBe(0);
  });

  it("interpolates INSIDE the word being sung", () => {
    // The whole point: a glyph fills part-way rather than flipping. Half
    // through word 1 is half through its box.
    expect(sweepFraction(words, bounds, 10.5, LINE_END)).toBeCloseTo(0.125, 5);
    // A quarter through word 3.
    expect(sweepFraction(words, bounds, 12.25, LINE_END)).toBeCloseTo(0.5625, 5);
  });

  it("lands exactly on a boundary at a word boundary", () => {
    expect(sweepFraction(words, bounds, 11, LINE_END)).toBeCloseTo(0.25, 5);
    expect(sweepFraction(words, bounds, 13, LINE_END)).toBeCloseTo(0.75, 5);
  });

  it("is fully swept once the line is over", () => {
    expect(sweepFraction(words, bounds, 14, LINE_END)).toBe(1);
    expect(sweepFraction(words, bounds, 99, LINE_END)).toBe(1);
  });

  it("advances monotonically across the whole line", () => {
    // A fill that ever moves backwards reads as a glitch, and the
    // word-boundary arithmetic is where that would come from.
    let prev = -1;
    for (let t = 9.5; t <= 14.5; t += 0.05) {
      const f = sweepFraction(words, bounds, t, LINE_END);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
  });

  it("uses the NEXT word's start as the end of the current one", () => {
    // Sources routinely omit per-word `end`; the following word's start is
    // the real boundary, and falling back to the line end instead would
    // make the first word crawl across the entire line.
    const noEnds: TimedWord[] = words.map((w) => ({
      start: w.start,
      end: undefined as unknown as number,
      text: w.text,
    }));
    expect(sweepFraction(noEnds, bounds, 10.5, LINE_END)).toBeCloseTo(0.125, 5);
  });

  it("uses the line end for the last word, which has no successor", () => {
    expect(sweepFraction(words, bounds, 13.5, LINE_END)).toBeCloseTo(0.875, 5);
  });

  it("handles a zero-length word without dividing by zero", () => {
    const degenerate: TimedWord[] = [
      { start: 10, end: 10, text: "a" },
      { start: 10, end: 11, text: "b" },
    ];
    const b = [
      { left: 0, right: 0.5 },
      { left: 0.5, right: 1 },
    ];
    const f = sweepFraction(degenerate, b, 10, 11);
    expect(Number.isFinite(f)).toBe(true);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
  });
});

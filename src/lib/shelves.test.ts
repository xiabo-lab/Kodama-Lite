import { describe, expect, it } from "vitest";
import { isCategoryOnlyShelf, isPlaceholderTitle } from "./shelves";
import type { Shelf, ShelfItem } from "@/lib/innertube/types";

const item = (kind: ShelfItem["kind"], id: string): ShelfItem => ({
  kind,
  id,
  title: id,
  thumbnails: [],
});

const shelf = (items: ShelfItem[], title = "Section 1"): Shelf => ({
  id: "s",
  title,
  items,
});

describe("isPlaceholderTitle", () => {
  it("matches the parser's generated fallbacks", () => {
    expect(isPlaceholderTitle("Section 1")).toBe(true);
    expect(isPlaceholderTitle("Section 12")).toBe(true);
    expect(isPlaceholderTitle("  Section 3  ")).toBe(true);
  });

  it("leaves real titles alone", () => {
    // Including ones that merely start with the same word — a real shelf
    // called "Sections" or "Section highlights" must keep its heading.
    for (const t of [
      "New albums & singles",
      "Sections",
      "Section highlights",
      "Section",
      "Trending",
    ]) {
      expect(isPlaceholderTitle(t)).toBe(false);
    }
  });

  it("treats an empty title as a placeholder", () => {
    // Explore blanks its shelf titles on purpose; "no title" and "a title
    // we invented" should both render as no heading.
    expect(isPlaceholderTitle("")).toBe(true);
    expect(isPlaceholderTitle("   ")).toBe(true);
  });
});

describe("isCategoryOnlyShelf", () => {
  it("matches the Explore navigation shelf", () => {
    expect(
      isCategoryOnlyShelf(
        shelf([
          item("category", "new"),
          item("category", "charts"),
          item("category", "moods"),
        ]),
      ),
    ).toBe(true);
  });

  it("leaves content shelves alone", () => {
    expect(isCategoryOnlyShelf(shelf([item("album", "a"), item("song", "b")]))).toBe(false);
  });

  it("leaves a mixed shelf alone — dropping it would lose real content", () => {
    expect(
      isCategoryOnlyShelf(shelf([item("category", "c"), item("album", "a")])),
    ).toBe(false);
  });

  it("is false for an empty shelf, so nothing is filtered on a blank feed", () => {
    expect(isCategoryOnlyShelf(shelf([]))).toBe(false);
  });
});

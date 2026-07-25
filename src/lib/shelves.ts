import type { Shelf } from "@/lib/innertube/types";

/**
 * Shelf predicates shared by the screens and the shelf layouts. Plain
 * functions in their own module so they can be unit-tested without
 * dragging React components into a node test environment.
 */

/**
 * True for `mapShelfWrapper`'s fallback title — "Section 1", "Section 2" —
 * which it invents when YouTube ships a shelf with no title of its own.
 * It's an internal placeholder that reads as a bug on screen, so callers
 * render no heading at all, which also gives the row back the ~40px the
 * heading would have cost.
 */
export function isPlaceholderTitle(title: string): boolean {
  const t = title.trim();
  // Empty counts too: Explore blanks its shelf titles deliberately, and
  // "no title" and "a title we invented" should render identically —
  // as no heading at all.
  return t === "" || /^Section \d+$/.test(t);
}

/**
 * True for a shelf that is nothing but category tiles.
 *
 * On the Explore feed YouTube ships "New releases / Charts / Moods &
 * genres / Podcasts" as navigation buttons — the same four destinations
 * the tab row above already offers, costing ~100px of a 238px content area
 * and pushing the actual albums off the screen.
 *
 * Only meaningful for that one feed: the Moods & genres feed is category
 * tiles all the way down, and filtering them there would leave it blank.
 * The caller decides where to apply it.
 */
export function isCategoryOnlyShelf(shelf: Shelf): boolean {
  return (
    shelf.items.length > 0 && shelf.items.every((i) => i.kind === "category")
  );
}

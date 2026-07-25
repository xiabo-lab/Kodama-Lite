import { ShelfCarousel } from "@/components/shared/shelf-carousel";
import { ShelfGrid } from "@/components/shared/shelf-grid";
import { TrackList } from "@/components/shared/track-list";
import { isPlaceholderTitle } from "@/lib/shelves";
import type { Shelf } from "@/lib/innertube/types";

/** Picks the right layout for a `Shelf` by its `display` hint — the one
 *  switch every screen that renders shelves (Home, Explore, Search) shares. */
export function ShelfSection({ shelf }: { shelf: Shelf }) {
  if (shelf.display === "grid") return <ShelfGrid shelf={shelf} />;
  if (shelf.display === "list") {
    return (
      <section className="flex flex-col gap-3">
        {isPlaceholderTitle(shelf.title) ? null : (
          <div className="flex items-baseline justify-between gap-3 px-1">
            <h2 className="truncate text-xl font-semibold tracking-tight">{shelf.title}</h2>
          </div>
        )}
        <TrackList tracks={shelf.items} />
      </section>
    );
  }
  return <ShelfCarousel shelf={shelf} />;
}

import { useEffect, useState } from "react";
import { Loader2Icon, AlertCircleIcon } from "lucide-react";
import { dispatchContent, type ExploreFeed } from "@/lib/network";
import { useExploreStore } from "@/store/exploreStore";
import { isCategoryOnlyShelf } from "@/lib/shelves";
import { ShelfSection } from "@/components/shared/shelf-section";
import { VerticalTabs } from "@/components/shared/vertical-tabs";

const TABS: { feed: ExploreFeed; label: string }[] = [
  { feed: "explore", label: "Explore" },
  { feed: "charts", label: "Charts" },
  { feed: "newReleases", label: "New releases" },
  { feed: "moods", label: "Moods & genres" },
];

/**
 * Explore's four sub-feeds share one screen and one store slot each
 * (`exploreStore`), keyed by feed — same cache-first shape as Home, just
 * fanned out over four tabs. Switching tabs is instant (no unmount/loading
 * gate); each tab's own cached shelves paint immediately if it's been
 * visited this session, and a background load keeps it fresh.
 */
export function Explore() {
  const [tab, setTab] = useState<ExploreFeed>("explore");
  const feeds = useExploreStore((s) => s.feeds);
  const current = feeds[tab];

  useEffect(() => {
    if (current.status === "idle") {
      dispatchContent({ type: "explore:load", feed: tab });
    }
  }, [tab, current.status]);

  // Drop the shelf of category tiles from the Explore feed itself. YouTube
  // ships "New releases / Charts / Moods & genres / Podcasts" as navigation
  // buttons, which is exactly what the tab row above already is — the same
  // four destinations twice, costing ~100px of a 238px content area and
  // pushing the actual albums off the screen. Its heading was "Section 1"
  // too, the parser's fallback for a shelf YouTube gave no title.
  //
  // Only on this feed: the Moods & genres tab is category tiles all the way
  // down, and filtering them there would leave it blank.
  // Shelf titles are dropped here as well as the category tiles. With
  // ~238px of content area, a heading row is the difference between
  // seeing a row of artwork and seeing the top third of it; the tab
  // column on the left already says which feed you're looking at.
  const shelves = (
    tab === "explore"
      ? current.shelves.filter((s) => !isCategoryOnlyShelf(s))
      : current.shelves
  ).map((s) => ({ ...s, title: "" }));

  const showSkeleton = current.status === "loading" && current.shelves.length === 0;
  const showEmptyError = current.status === "error" && current.shelves.length === 0;

  return (
    <div className="flex gap-4 px-6 pb-6 pt-2">
      <VerticalTabs
        tabs={TABS.map((t) => ({ id: t.feed, label: t.label }))}
        active={tab}
        onSelect={setTab}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-6">

      {showSkeleton && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2Icon className="size-6 animate-spin" />
        </div>
      )}

      <div className="flex flex-col gap-8">
        {shelves.map((shelf) => (
          <ShelfSection key={shelf.id} shelf={shelf} />
        ))}
      </div>

      {showEmptyError && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <span className="font-medium">Couldn't load this feed</span>
            <span className="text-muted-foreground">{current.error}</span>
            <button
              type="button"
              onClick={() => dispatchContent({ type: "explore:load", feed: tab })}
              className="mt-1 w-fit text-brand hover:underline"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {current.nextCursor && current.shelves.length > 0 && (
        <button
          type="button"
          onClick={() => dispatchContent({ type: "explore:load", feed: tab, cursor: current.nextCursor })}
          className="mx-auto w-fit rounded-full border border-input px-4 py-2 text-sm font-medium hover:bg-white/10"
        >
          Load more
        </button>
      )}
      </div>
    </div>
  );
}

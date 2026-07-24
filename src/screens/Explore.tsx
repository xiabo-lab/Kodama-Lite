import { useEffect, useState } from "react";
import { Loader2Icon, AlertCircleIcon } from "lucide-react";
import { dispatchContent, type ExploreFeed } from "@/lib/network";
import { useExploreStore } from "@/store/exploreStore";
import { ShelfSection } from "@/components/shared/shelf-section";
import { cn } from "@/lib/utils";

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

  const showSkeleton = current.status === "loading" && current.shelves.length === 0;
  const showEmptyError = current.status === "error" && current.shelves.length === 0;

  return (
    <div className="flex flex-col gap-6 px-6 pb-6 pt-3">
      <h1 className="text-3xl font-bold tracking-tight">Explore</h1>

      <div className="flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.feed}
            type="button"
            onClick={() => setTab(t.feed)}
            className={cn(
              "rounded-full border px-3.5 py-1 text-sm font-medium transition-colors",
              tab === t.feed
                ? "border-transparent bg-foreground text-background"
                : "border-input bg-transparent text-foreground hover:bg-white/10",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {showSkeleton && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2Icon className="size-6 animate-spin" />
        </div>
      )}

      <div className="flex flex-col gap-8">
        {current.shelves.map((shelf) => (
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
  );
}

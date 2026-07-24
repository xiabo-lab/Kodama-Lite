import { WifiOffIcon } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useHomeStore } from "@/store/homeStore";
import { ShelfSection } from "@/components/shared/shelf-section";

/**
 * Home feed. Demonstrates the whole cache-first, event-driven loop:
 *
 *   - Reads from `homeStore` synchronously and paints immediately — from
 *     cached shelves (localStorage) on a cold boot, so there's never a
 *     blank frame.
 *   - NEVER awaits the network. `home:load` was dispatched at startup (see
 *     App.tsx); the result arrives as a `ContentEvent` and the store folds
 *     it in — see `src/lib/network.ts`.
 *   - Offline / stale is a first-class, non-blocking state: a small chip,
 *     not an error screen. A spinner shows ONLY when there's genuinely
 *     nothing cached to show.
 */
export function Home() {
  const status = useHomeStore((s) => s.status);
  const shelves = useHomeStore((s) => s.shelves);
  const stale = useHomeStore((s) => s.stale);
  const online = useAppStore((s) => s.online);

  const showSkeleton = status === "loading" && shelves.length === 0;
  const showEmptyError = status === "error" && shelves.length === 0;

  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">Home</h1>
        {(!online || stale) && (
          <span className="flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-xs text-muted-foreground">
            <WifiOffIcon className="size-3.5" />
            {online ? "showing saved" : "offline — showing saved"}
          </span>
        )}
      </div>

      {showSkeleton && <HomeSkeleton />}

      {shelves.map((shelf) => (
        <ShelfSection key={shelf.id} shelf={shelf} />
      ))}

      {showEmptyError && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-muted-foreground">
          Couldn't load home feed — it will retry automatically once you're
          back online.
        </div>
      )}
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      {Array.from({ length: 2 }).map((_, s) => (
        <section key={s} className="flex flex-col gap-3">
          <div className="h-6 w-56 animate-pulse rounded bg-white/10" />
          <div className="flex gap-2 overflow-hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="w-44 shrink-0 p-2">
                <div className="aspect-square w-full animate-pulse rounded-md bg-white/10" />
                <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-white/10" />
                <div className="mt-1 h-3 w-1/2 animate-pulse rounded bg-white/10" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

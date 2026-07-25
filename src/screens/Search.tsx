import { useEffect, useRef, useState } from "react";
import { AlertCircleIcon, ChevronRightIcon, Loader2Icon, PlayIcon, SearchIcon, ShuffleIcon, XIcon } from "lucide-react";
import { useSearchStore } from "@/store/searchStore";
import { useAppStore } from "@/store/appStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { shelfItemToTrack } from "@/lib/track";
import { ShelfCard } from "@/components/shared/shelf-card";
import { ShelfCarousel } from "@/components/shared/shelf-carousel";
import { TrackList } from "@/components/shared/track-list";
import { Thumbnail } from "@/components/shared/thumbnail";
import { OnScreenKeyboard } from "@/components/layout/on-screen-keyboard";
import type { SearchFilter } from "@/lib/innertube/search";
import type { Shelf, ShelfItem, TopResultAction } from "@/lib/innertube/types";
import { cn } from "@/lib/utils";

const FILTERS: SearchFilter[] = ["all", "songs", "albums", "artists", "playlists", "videos"];

function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/**
 * Simplified from YTMLite's search route: no "My library" scope (accounts-
 * gated, deferred), no search-history dropdown, no URL query params (this
 * app has no address bar to reflect them into — the Store route is the
 * source of truth). The workflow that matters — type, filter, get results,
 * click through — is intact.
 */
export function Search() {
  const query = useSearchStore((s) => s.query);
  const filter = useSearchStore((s) => s.filter);
  const status = useSearchStore((s) => s.status);
  const results = useSearchStore((s) => s.results);
  const error = useSearchStore((s) => s.error);
  const search = useSearchStore((s) => s.search);
  const setFilter = useSearchStore((s) => s.setFilter);

  const [value, setValue] = useState(query);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const debounced = useDebounced(value, 300);
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus only — deliberately NOT auto-opening the keyboard. Arriving
  // at Search with the panel already covering the screen would hide the
  // results you came back to look at.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (debounced.trim() !== query.trim()) search(debounced, filter);
    // Only re-run when the debounced typed value changes — `search`/`filter`
    // changing for other reasons (tab click) must not re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const isLoading = status === "loading" && !query;
  const trimmed = value.trim();

  return (
    <div className="flex flex-col gap-4 px-6 pb-6 pt-2">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            // Pointer only, NOT focus. Hooking `onFocus` meant the
            // autofocus effect below opened the keyboard on arrival, so
            // every trip to Search covered the results with a full-screen
            // panel. It also let Tab open it, which is the last thing
            // someone on a physical keyboard wants.
            onPointerDown={() => setKeyboardOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search(value, filter);
              if (e.key === "Escape" && value) setValue("");
            }}
            placeholder="Search songs, albums, artists…"
            className="h-12 w-full cursor-pointer rounded-md border border-input bg-transparent pl-9 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {value ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setValue("");
                inputRef.current?.focus();
              }}
              className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          ) : null}
        </div>

        <div className="flex gap-1.5 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "shrink-0 rounded-full border px-3.5 py-1 text-sm font-medium transition-colors",
                filter === f
                  ? "border-transparent bg-foreground text-background"
                  : "border-input bg-transparent text-foreground hover:bg-white/10",
              )}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {!trimmed ? null : error ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <span className="font-medium">Search failed</span>
            <span className="text-muted-foreground">{error}</span>
          </div>
        </div>
      ) : isLoading || (status === "loading" && !results.shelves.length && !results.topResult) ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2Icon className="size-6 animate-spin" />
        </div>
      ) : filter === "all" ? (
        <AllResults data={results} />
      ) : (
        <FilterResults items={results.shelves.flatMap((s) => s.items)} filter={filter} query={query} />
      )}

      {keyboardOpen && (
        <OnScreenKeyboard
          value={value}
          onChange={setValue}
          onSubmit={() => {
            search(value, filter);
            setKeyboardOpen(false);
          }}
          onClose={() => setKeyboardOpen(false)}
          placeholder="Search songs, albums, artists…"
        />
      )}
    </div>
  );
}

function AllResults({ data }: { data: { topResult?: ShelfItem; topResultAction?: TopResultAction; shelves: Shelf[]; query: string } }) {
  if (!data.topResult && data.shelves.length === 0) return <NoResults query={data.query} />;
  return (
    <div className="flex flex-col gap-8">
      {data.topResult ? <TopResultHero item={data.topResult} action={data.topResultAction} /> : null}
      {data.shelves.map((shelf) =>
        shelf.display === "list" ? (
          <section key={shelf.id} className="flex flex-col gap-3">
            <h2 className="truncate px-1 text-xl font-semibold tracking-tight">{shelf.title}</h2>
            <TrackList tracks={shelf.items} />
          </section>
        ) : (
          <ShelfCarousel key={shelf.id} shelf={shelf} />
        ),
      )}
    </div>
  );
}

function TopResultHero({ item, action }: { item: ShelfItem; action?: TopResultAction }) {
  const navigate = useAppStore((s) => s.navigate);
  const radius = item.round ? "rounded-full" : item.kind === "album" || item.kind === "playlist" ? "rounded-lg" : "rounded-md";

  const activate = () => {
    if (item.kind === "artist") navigate({ kind: "artist", id: item.id });
    else if (item.kind === "album") navigate({ kind: "album", id: item.id });
    else if (item.kind === "playlist") navigate({ kind: "playlist", id: item.id });
    else usePlaybackStore.getState().playNow(shelfItemToTrack(item));
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-xl font-semibold tracking-tight">Top result</h2>
      <button
        type="button"
        onClick={activate}
        className="relative flex items-center gap-5 rounded-xl border bg-card/40 p-4 pr-5 text-left transition-colors hover:bg-white/[0.06]"
      >
        <div className={cn("relative size-24 shrink-0 md:size-28", radius)}>
          <Thumbnail thumbnails={item.thumbnails} alt={item.title} round={item.round} className={cn("size-full", radius)} targetSize={320} kind={item.kind} id={item.id} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-3xl font-bold tracking-tight">{item.title}</span>
          {item.subtitle ? <span className="truncate text-sm text-muted-foreground">{item.subtitle}</span> : null}
        </div>
        {action ? (
          <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-input bg-white/5 px-5 py-2.5 text-sm font-semibold">
            {action.kind === "shuffle" ? <ShuffleIcon className="size-4" /> : <PlayIcon className="size-4 fill-current" />}
            {action.label}
          </span>
        ) : item.kind !== "song" && item.kind !== "video" ? (
          <ChevronRightIcon className="size-6 shrink-0 text-muted-foreground" />
        ) : null}
      </button>
    </section>
  );
}

function FilterResults({ items, filter, query }: { items: ShelfItem[]; filter: SearchFilter; query: string }) {
  if (items.length === 0) return <NoResults query={query} />;
  if (filter === "songs") return <TrackList tracks={items} />;

  const gridClass =
    filter === "videos"
      ? "grid w-full gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))]"
      : "grid w-full gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] [&>*]:max-w-[20rem]";

  return (
    <div className={gridClass}>
      {items.map((item) => (
        <ShelfCard key={`${item.kind}:${item.id}`} item={item} />
      ))}
    </div>
  );
}

function NoResults({ query }: { query: string }) {
  return <p className="text-sm text-muted-foreground">No results for "{query}".</p>;
}

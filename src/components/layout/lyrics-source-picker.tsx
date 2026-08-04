import { useEffect, useRef, useState } from "react";
import { CheckIcon, MicVocalIcon, SearchIcon } from "lucide-react";
import { SEARCH_TIERS, SOURCE_LABELS } from "@/lib/lyrics/sources";
import { LyricsSearchView } from "@/components/layout/lyrics-search-view";
import { useKaraokeStore } from "@/store/karaokeStore";
import { useLyricsStore, type SourceChoice } from "@/store/lyricsStore";
import { cn } from "@/lib/utils";

/**
 * Search Lyrics, as a control of its own.
 *
 * It used to be a button inside the source popup, which was wrong on two
 * counts: it made a top-level action cost two taps, and it put "go and ask
 * a new question" inside a menu whose every other row means "switch between
 * answers we already have". Those are different kinds of thing and the menu
 * read as a grab bag. Its own icon, beside the source mic, says so.
 */
export function LyricsSearchButton({
  className,
  boxClassName,
  disabled = false,
}: {
  /** The HIT AREA — sizing and positioning of the tappable region. */
  className?: string;
  /** The DRAWN box, centred inside the hit area. Omitted, the button draws
   *  itself at whatever `className` sizes it to; supplied, the target can
   *  be far larger than the thing you see. See `ConfirmLyricsButton`. */
  boxClassName?: string;
  disabled?: boolean;
}) {
  // Open state lives in `karaokeStore`, not here. The stage needs to read it
  // (it narrows its lyrics column while the screen is up) and so does
  // `voiceControl`, which may only reach the app through the same store
  // action a tap goes through. A local `useState` could serve neither.
  const open = useKaraokeStore((s) => s.searchOpen);
  const setOpen = useKaraokeStore((s) => s.setSearchOpen);
  // A cached result set is a state worth advertising: it means reopening
  // this costs nothing and goes straight back to the list.
  const hasResults = useLyricsStore((s) => s.searchResults.length > 0);

  return (
    <>
      <button
        type="button"
        aria-label="Search lyrics"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn("group", className, (open || hasResults) && "text-brand")}
      >
        {boxClassName ? (
          <span
            className={cn(
              "flex items-center justify-center rounded-md border-2 border-hairline transition-colors group-hover:bg-white/10",
              boxClassName,
            )}
          >
            <SearchIcon />
          </span>
        ) : (
          <SearchIcon />
        )}
      </button>
      {open && <LyricsSearchView onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The lyrics-source picker YTMLite has and this app was missing. The mic
 * button opens it in both bars — the player bar and the karaoke stage — and
 * switching is purely local: all seven providers are fetched in parallel
 * for every track anyway (see `fetchAllLyrics`), so the map is already in
 * the store and a switch is a `set()`, not a refetch.
 *
 * A source that HAS lyrics for this track is shown in the brand red;
 * everything else is plain. That replaced a "Synced"/"Unavailable" column
 * which doubled the width of every row and said, for most rows, only that
 * nothing had happened yet.
 *
 * Nothing is disabled any more either. Since the search runs in tiers
 * (see `SEARCH_TIERS`), most sources are never queried — "not asked" is
 * not "unavailable", and greying those out would be a lie. Tapping one
 * fetches it on demand.
 *
 * Anchored panel with the same Escape/click-outside handling as the queue
 * panel; still no `@radix-ui/*` in this project.
 */
export function LyricsSourceButton({
  className,
  align = "right",
  placement = "anchor",
  onOpenChange,
  disabled = false,
}: {
  className?: string;
  /** Which edge of the button the panel hangs from, when anchored. */
  align?: "left" | "right";
  /** `anchor` hangs the panel off the button (the player bar).
   *  `screen-right` pins it to the right edge of the screen instead —
   *  used on the karaoke stage, where a panel anchored to a button two
   *  thirds across lands squarely on top of the lyrics it is meant to
   *  be read alongside. */
  placement?: "anchor" | "screen-right";
  /** Told whenever the panel opens or closes, so a caller can make room
   *  for it. The karaoke stage uses this to narrow the lyrics column. */
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const choice = useLyricsStore((s) => s.choice);
  const manual = useLyricsStore((s) => s.manual);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Lyrics source"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          className,
          // A pinned source — or a hand-picked lyric — is a mode the user
          // should be able to see they are in without opening the menu.
          (open || choice !== "auto" || !!manual) && "text-brand",
        )}
      >
        <MicVocalIcon />
      </button>
      {open && (
        <SourceList
          align={align}
          placement={placement}
          onPick={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function SourceList({
  align,
  placement,
  onPick,
}: {
  align: "left" | "right";
  placement: "anchor" | "screen-right";
  onPick: () => void;
}) {
  const sources = useLyricsStore((s) => s.sources);
  const choice = useLyricsStore((s) => s.choice);
  const status = useLyricsStore((s) => s.status);
  const setChoice = useLyricsStore((s) => s.setChoice);

  const select = (next: SourceChoice) => {
    setChoice(next);
    onPick();
  };

  return (
    <div
      role="menu"
      // Two columns, 2.5x the old width. At 24px type a single 240px
      // column wrapped every label and pushed the list past the top of the
      // Pi's 440px panel, so picking a source meant scrolling a popup with
      // a fingertip. Eight entries in two columns fit without scrolling at
      // all — the `max-h` below is now a safety net rather than the plan.
      className={cn(
        "z-[55] flex w-[600px] max-w-[calc(100vw-2rem)] flex-col gap-0.5 overflow-y-auto rounded-xl border border-hairline bg-surface-active p-2 shadow-lg backdrop-blur",
        placement === "screen-right"
          ? // Pinned to the screen, clear of the karaoke control row.
            "fixed bottom-28 right-6 max-h-[calc(100vh-9rem)]"
          : cn(
              "absolute bottom-full mb-3 max-h-[calc(100vh-8rem)]",
              align === "right" ? "right-0" : "left-0",
            ),
      )}
    >
      {/* Padding and row height are tuned so all eight entries fit inside
          the 312px this panel gets above the bar on a 440px screen —
          measured at 333px before the trim, i.e. scrolling by a hair,
          which is the one thing two columns were meant to avoid. */}
      <h3 className="px-2 text-xs font-semibold uppercase tracking-wide leading-6 text-muted-foreground">
        Lyrics source
      </h3>
      {/* Auto spans both columns: it isn't one provider among eight, it's
          the rule that picks between them. */}
      <SourceRow
        label={status === "loading" ? "Auto — searching…" : "Auto"}
        available
        selected={choice === "auto"}
        onSelect={() => select("auto")}
      />
      <div className="my-0.5 h-px bg-hairline" aria-hidden="true" />
      {/* Laid out one row per SEARCH TIER, not simply flowed two-up.
          YouTube Music is a tier of its own so it spans the full width;
          Kugou and LRCLIB share the next row because they are searched
          together, and so on. The rows then say something true about the
          order things are tried in, instead of being an arbitrary wrap. */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
        {SEARCH_TIERS.flatMap((tier) =>
          tier.map((source) => (
            <SourceRow
              key={source}
              label={SOURCE_LABELS[source]}
              available={!!sources[source]}
              selected={choice === source}
              onSelect={() => select(source)}
              className={tier.length === 1 ? "col-span-2" : undefined}
            />
          )),
        )}
      </div>
    </div>
  );
}

function SourceRow({
  label,
  available,
  selected,
  onSelect,
  className,
}: {
  label: string;
  /** Has lyrics for the current track — shown in brand red. */
  available: boolean;
  selected: boolean;
  onSelect: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-white/10",
        className,
      )}
    >
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          available ? "font-medium text-brand" : "text-foreground",
        )}
      >
        {label}
      </span>
      {/* Reserve the tick's width on every row so selecting one doesn't
          reflow the column it's in. */}
      <CheckIcon
        className={cn("size-4 shrink-0 text-brand", !selected && "invisible")}
      />
    </button>
  );
}

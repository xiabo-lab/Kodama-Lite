import { useEffect, useRef, useState } from "react";
import { CheckIcon, MicVocalIcon } from "lucide-react";
import { SOURCE_LABELS, SOURCE_ORDER } from "@/lib/lyrics/sources";
import type { Lyrics } from "@/lib/lyrics/types";
import { useLyricsStore, type SourceChoice } from "@/store/lyricsStore";
import type { FeedStatus } from "@/store/homeStore";
import { cn } from "@/lib/utils";

/**
 * The lyrics-source picker YTMLite has and this app was missing. The mic
 * button opens it in both bars — the player bar and the karaoke stage — and
 * switching is purely local: all seven providers are fetched in parallel
 * for every track anyway (see `fetchAllLyrics`), so the map is already in
 * the store and a switch is a `set()`, not a refetch.
 *
 * Each row says what that provider actually has for *this* track — synced,
 * plain, or nothing — which is the information that makes the choice
 * meaningful. Rows with nothing are disabled rather than hidden, so the
 * list doesn't reshuffle underneath a finger between tracks.
 *
 * Anchored panel with the same Escape/click-outside handling as the queue
 * panel; still no `@radix-ui/*` in this project.
 */
export function LyricsSourceButton({
  className,
  align = "right",
  disabled = false,
}: {
  className?: string;
  /** Which edge of the button the panel hangs from. */
  align?: "left" | "right";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const choice = useLyricsStore((s) => s.choice);

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
          // A pinned source is a mode the user should be able to see they
          // are in without opening the menu.
          (open || choice !== "auto") && "text-brand",
        )}
      >
        <MicVocalIcon />
      </button>
      {open && (
        <SourceList align={align} onPick={() => setOpen(false)} />
      )}
    </div>
  );
}

function SourceList({
  align,
  onPick,
}: {
  align: "left" | "right";
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
        "absolute bottom-full z-50 mb-3 flex max-h-[calc(100vh-8rem)] w-[600px] max-w-[calc(100vw-2rem)] flex-col gap-0.5 overflow-y-auto rounded-xl border border-hairline bg-surface-active p-2 shadow-lg backdrop-blur",
        align === "right" ? "right-0" : "left-0",
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
        label="Auto"
        detail={status === "loading" ? "Searching…" : "Best available"}
        selected={choice === "auto"}
        onSelect={() => select("auto")}
      />
      <div className="my-0.5 h-px bg-hairline" aria-hidden="true" />
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
        {SOURCE_ORDER.map((source) => (
          <SourceRow
            key={source}
            label={SOURCE_LABELS[source]}
            detail={detailFor(sources[source], status)}
            selected={choice === source}
            disabled={!sources[source]}
            onSelect={() => select(source)}
          />
        ))}
      </div>
    </div>
  );
}

function detailFor(lyrics: Lyrics | null, status: FeedStatus): string {
  if (lyrics?.kind === "timed") return "Synced";
  if (lyrics?.kind === "plain") return "Plain text";
  return status === "loading" ? "Searching…" : "Unavailable";
}

function SourceRow({
  label,
  detail,
  selected,
  disabled = false,
  onSelect,
}: {
  label: string;
  detail: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className="flex min-h-11 items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-40"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
      {/* Reserve the tick's width on every row so selecting one doesn't
          reflow the column it's in. */}
      <CheckIcon
        className={cn("size-4 shrink-0 text-brand", !selected && "invisible")}
      />
    </button>
  );
}

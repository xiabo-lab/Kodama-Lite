import { useEffect, useRef } from "react";
import { ListMusicIcon, PauseIcon, PlayIcon, Trash2Icon, Volume2Icon, XIcon } from "lucide-react";
import { usePlaybackStore, type Track } from "@/store/playbackStore";
import { useQueuePanelStore } from "@/store/queuePanelStore";
import { cn } from "@/lib/utils";

function formatDuration(seconds?: number): string {
  if (!seconds || Number.isNaN(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Simplified from YTMLite's queue panel: no drag-to-reorder, no History
 * tab, no Autoplay/radio toggle (that needs `fetchWatchQueue`, which
 * hasn't been ported — see `src/lib/innertube/`). "Now playing" + "Up
 * next", click a row to jump to it, hover to remove — the part of the
 * workflow that matters day to day — is here.
 *
 * Built as a plain anchored panel rather than a Radix Popover: this phase
 * doesn't have `@radix-ui/*` as a dependency yet, and one more primitive
 * wasn't worth pulling in against tonight's deadline.
 */
export function QueuePanel({
  placement = "anchor",
}: {
  /** `anchor` centres the panel over its button (the player bar).
   *  `screen-right` pins it to the right edge — on the karaoke stage an
   *  anchored panel sits on top of the lyrics. */
  placement?: "anchor" | "screen-right";
} = {}) {
  const open = useQueuePanelStore((s) => s.open);
  const setOpen = useQueuePanelStore((s) => s.setOpen);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onClick);
    };
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className={cn(
        "z-[55] flex h-[min(28rem,70vh)] w-[28rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-hairline bg-surface-active shadow-lg backdrop-blur",
        placement === "screen-right"
          ? "fixed bottom-28 right-6"
          : "absolute bottom-full left-1/2 mb-3 -translate-x-1/2",
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <span className="text-sm font-semibold">Queue</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Clear queue"
            onClick={() => usePlaybackStore.getState().clearQueue()}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <Trash2Icon className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Close queue"
            onClick={() => setOpen(false)}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </header>
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-2">
        <QueueBody />
      </div>
    </div>
  );
}

function QueueBody() {
  const queue = usePlaybackStore((s) => s.queue);
  const index = usePlaybackStore((s) => s.index);
  const playing = usePlaybackStore((s) => s.playing);
  const toggle = usePlaybackStore((s) => s.toggle);
  const jumpTo = usePlaybackStore((s) => s.jumpTo);
  const removeAt = usePlaybackStore((s) => s.removeAt);

  const active = index >= 0 ? queue[index] : undefined;
  const upcoming = index >= 0 ? queue.slice(index + 1) : queue;

  if (!active && upcoming.length === 0) {
    return <p className="mt-4 px-2 text-sm text-muted-foreground">Queue is empty.</p>;
  }

  return (
    <>
      {active && (
        <QueueSection label="Now playing">
          <QueueRow track={active} active playing={playing} onActivate={toggle} />
        </QueueSection>
      )}
      {upcoming.length > 0 ? (
        <>
          {active && <div className="h-4" aria-hidden="true" />}
          <QueueSection label="Up next">
            {upcoming.map((t, i) => {
              const queueIdx = index + 1 + i;
              return (
                <QueueRow
                  key={`${t.videoId}-${queueIdx}`}
                  track={t}
                  onActivate={() => jumpTo(queueIdx)}
                  onRemove={() => removeAt(queueIdx)}
                />
              );
            })}
          </QueueSection>
        </>
      ) : active ? (
        <p className="mt-4 px-2 text-sm text-muted-foreground">Nothing queued next.</p>
      ) : null}
    </>
  );
}

function QueueSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function QueueRow({
  track,
  active = false,
  playing = false,
  onActivate,
  onRemove,
}: {
  track: Track;
  active?: boolean;
  playing?: boolean;
  onActivate: () => void;
  onRemove?: () => void;
}) {
  const overlayIcon = active && playing ? <PauseIcon className="size-4 fill-current" /> : <PlayIcon className="size-4 fill-current" />;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "group relative grid cursor-pointer select-none grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <div className="relative size-10 shrink-0 overflow-hidden rounded-md bg-muted">
        {track.thumbnail ? <img src={track.thumbnail} alt={track.title} className="size-full object-cover" referrerPolicy="no-referrer" /> : null}
        <span className={cn("absolute inset-0 flex items-center justify-center bg-black/50 text-white", active ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
          {active && playing ? (
            <>
              <Volume2Icon className="size-4 group-hover:hidden" />
              <PauseIcon className="hidden size-4 fill-current group-hover:block" />
            </>
          ) : (
            overlayIcon
          )}
        </span>
      </div>
      <div className="flex min-w-0 flex-col text-left">
        <span className={cn("truncate text-sm font-medium", active && "text-brand")}>{track.title}</span>
        <span className="truncate text-xs text-muted-foreground">{track.subtitle}</span>
      </div>
      <div className="flex items-center">
        <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(track.duration)}</span>
        {onRemove && (
          <button
            type="button"
            aria-label="Remove from queue"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="ml-1 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-white/10 hover:text-foreground group-hover:opacity-100"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Toggle button for the player bar. */
export function QueueButton({ className }: { className?: string }) {
  const open = useQueuePanelStore((s) => s.open);
  const toggle = useQueuePanelStore((s) => s.toggle);
  return (
    <button
      type="button"
      aria-label="Queue"
      aria-pressed={open}
      onClick={toggle}
      className={cn(className, open && "text-brand")}
    >
      <ListMusicIcon className="size-5" />
    </button>
  );
}

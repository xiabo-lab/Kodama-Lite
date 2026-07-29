import { useEffect } from "react";
import {
  AlertCircleIcon,
  HardDriveIcon,
  Loader2Icon,
  PlayIcon,
  RefreshCwIcon,
  RepeatIcon,
  ShuffleIcon,
} from "lucide-react";
import { useLocalStore, type PlayMode } from "@/store/localStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { cn } from "@/lib/utils";

/**
 * Library → Local: the music on a USB stick.
 *
 * A plain table rather than the card grid the other Library tabs use.
 * These are files, not entities — there is no artwork, nothing to navigate
 * into, and the three things worth knowing (song, artist, length) are
 * exactly what the user asked to see. A card grid would show three fields
 * of text in a square meant for a cover image.
 *
 * Playing a track hands the whole list to the queue, ordered by the
 * selected mode, so the tab behaves like a playlist rather than like a
 * folder of one-shot files.
 */
export function LocalTab() {
  const status = useLocalStore((s) => s.status);
  const tracks = useLocalStore((s) => s.tracks);
  const source = useLocalStore((s) => s.source);
  const error = useLocalStore((s) => s.error);
  const progress = useLocalStore((s) => s.progress);
  const playMode = useLocalStore((s) => s.playMode);
  const setPlayMode = useLocalStore((s) => s.setPlayMode);
  const scan = useLocalStore((s) => s.scan);
  const buildQueue = useLocalStore((s) => s.buildQueue);

  const playQueue = usePlaybackStore((s) => s.playQueue);
  const setShuffle = usePlaybackStore((s) => s.setShuffle);
  const currentId = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index]?.videoId : undefined,
  );

  // Scanned on first open rather than at boot: mounting a drive and
  // spawning an ffprobe per file is real work, and doing it on every
  // launch for a tab most sessions never visit would be paid by every
  // session. `idle` is only ever true before the first visit.
  useEffect(() => {
    if (status === "idle") scan();
  }, [status, scan]);

  const play = (index: number) => {
    const q = buildQueue(index);
    if (q.tracks.length === 0) return;
    playQueue(q.tracks, q.index);
    // The transport toggles follow the mode, so the player bar and the
    // karaoke stage show what is actually happening rather than
    // contradicting this tab.
    setShuffle(q.shuffle);
    usePlaybackStore.setState({ repeat: q.repeat });
  };

  // Grows with its content rather than filling a fixed height — `main` is
  // the app's only scroller and has to stay that way. See `Library`.
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <HardDriveIcon className="size-4 shrink-0" />
          <span className="truncate">
            {status === "ready" && source
              ? `${source} · ${tracks.length} track${tracks.length === 1 ? "" : "s"}`
              : "USB drive"}
          </span>
        </div>

        <ModeButton
          mode="normal"
          active={playMode === "normal"}
          onSelect={setPlayMode}
          icon={<PlayIcon className="size-4" />}
          label="In order"
        />
        <ModeButton
          mode="shuffle"
          active={playMode === "shuffle"}
          onSelect={setPlayMode}
          icon={<ShuffleIcon className="size-4" />}
          label="Shuffle"
        />
        <ModeButton
          mode="repeat"
          active={playMode === "repeat"}
          onSelect={setPlayMode}
          icon={<RepeatIcon className="size-4" />}
          label="Repeat"
        />

        <button
          type="button"
          onClick={scan}
          disabled={status === "scanning"}
          className="flex min-h-11 items-center gap-2 rounded-md border border-input px-3 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
        >
          <RefreshCwIcon
            className={cn("size-4", status === "scanning" && "animate-spin")}
          />
          Rescan
        </button>

        <button
          type="button"
          onClick={() => play(0)}
          disabled={tracks.length === 0}
          className="flex min-h-11 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
        >
          <PlayIcon className="size-4 fill-current" />
          Play all
        </button>
      </div>

      {status === "scanning" ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2Icon className="size-6 animate-spin" />
          <span className="text-sm">
            {progress.total > 0
              ? `Reading tags… ${progress.done}/${progress.total}`
              : "Looking for a drive…"}
          </span>
        </div>
      ) : status === "error" ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <span className="font-medium">No local music</span>
            <span className="text-muted-foreground">{error}</span>
            <button
              type="button"
              onClick={scan}
              className="mt-1 w-fit text-brand hover:underline"
            >
              Rescan
            </button>
          </div>
        </div>
      ) : tracks.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing on the drive yet.</p>
      ) : (
        <div>
          {/* A header row, because three unlabelled columns of text are
              ambiguous in a way a track list with artwork is not. */}
          <div className="flex items-center gap-3 border-b border-hairline px-3 pb-1 text-xs uppercase tracking-wide text-muted-foreground">
            <span className="w-8 shrink-0 text-right">#</span>
            <span className="min-w-0 flex-1">Song</span>
            <span className="min-w-0 w-1/3">Artist</span>
            <span className="w-16 shrink-0 text-right">Length</span>
          </div>
          {tracks.map((t, i) => {
            const playing = currentId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => play(i)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-accent",
                  playing && "bg-accent",
                )}
              >
                <span
                  className={cn(
                    "w-8 shrink-0 text-right tabular-nums",
                    playing ? "text-brand" : "text-muted-foreground",
                  )}
                >
                  {i + 1}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-medium",
                    playing && "text-brand",
                  )}
                >
                  {t.title}
                </span>
                <span className="w-1/3 min-w-0 truncate text-muted-foreground">
                  {t.artist || "Unknown artist"}
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                  {formatLength(t.duration)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModeButton({
  mode,
  active,
  onSelect,
  icon,
  label,
}: {
  mode: PlayMode;
  active: boolean;
  onSelect: (m: PlayMode) => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(mode)}
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors",
        active
          ? "border-brand bg-brand/15 text-brand"
          : "border-input text-foreground hover:bg-accent",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function formatLength(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

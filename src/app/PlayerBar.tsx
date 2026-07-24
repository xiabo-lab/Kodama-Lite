import { useRef } from "react";
import {
  Loader2Icon,
  Maximize2Icon,
  MicVocalIcon,
  PauseIcon,
  PlayIcon,
  Repeat1Icon,
  RepeatIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { usePlaybackStore } from "@/store/playbackStore";
import { useKaraokeStore } from "@/store/karaokeStore";
import { QueueButton, QueuePanel } from "@/components/layout/queue-panel";
import { cn } from "@/lib/utils";

/**
 * Bottom player bar — ported in look from YTMLite (cover + meta on the
 * left, finger-spaced transport in the center, secondary actions on the
 * right, a full-width progress row) and now wired to real state:
 * `playbackStore` for everything shown, dispatched actions for everything
 * clicked. Nothing here touches the bus directly or awaits anything —
 * every click is a synchronous store action; the one that needs the data
 * plane (advancing the current track) fires a `stream:resolve` and
 * returns immediately, exactly like the rest of the app.
 */
const ICON_BTN = "text-muted-foreground transition-colors hover:text-foreground";

export function PlayerBar() {
  const queue = usePlaybackStore((s) => s.queue);
  const index = usePlaybackStore((s) => s.index);
  const playing = usePlaybackStore((s) => s.playing);
  const status = usePlaybackStore((s) => s.status);
  const shuffle = usePlaybackStore((s) => s.shuffle);
  const repeat = usePlaybackStore((s) => s.repeat);
  const position = usePlaybackStore((s) => s.position);
  const duration = usePlaybackStore((s) => s.duration);
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);

  const toggle = usePlaybackStore((s) => s.toggle);
  const next = usePlaybackStore((s) => s.next);
  const prev = usePlaybackStore((s) => s.prev);
  const seek = usePlaybackStore((s) => s.seek);
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const toggleMute = usePlaybackStore((s) => s.toggleMute);
  const setShuffle = usePlaybackStore((s) => s.setShuffle);
  const cycleRepeat = usePlaybackStore((s) => s.cycleRepeat);
  const setKaraokeOpen = useKaraokeStore((s) => s.setOpen);

  const track = index >= 0 ? queue[index] : undefined;
  const hasTrack = !!track;
  const loading = status === "loading";

  const barRef = useRef<HTMLDivElement | null>(null);
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = barRef.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(fraction * duration);
  };

  const VolumeIcon = muted || volume === 0 ? VolumeXIcon : Volume2Icon;

  return (
    <aside className="relative z-10 mx-2 mb-2 flex shrink-0 flex-col gap-2 rounded-[10px] border border-sidebar-border bg-surface px-4 py-2.5 shadow-sm">
      <QueuePanel />
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="size-11 shrink-0 rounded-md border border-hairline bg-muted" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-base font-semibold leading-tight">
              {track?.title ?? "Nothing playing"}
            </span>
            <span className="truncate text-sm text-muted-foreground">
              {track?.subtitle ?? "Pick a track to start"}
            </span>
          </div>
        </div>

        {/* One flex group, one gap, for every button from Shuffle through
            the volume slider — previously this was two separate flex-1
            groups (transport centered, utility right-justified), which
            left a much wider gap between Repeat and the fullscreen-lyrics
            button than between any other pair. */}
        <div className="flex flex-1 items-center justify-end gap-6">
          <button
            className={cn(ICON_BTN, shuffle && "text-brand")}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            onClick={() => setShuffle(!shuffle)}
          >
            <ShuffleIcon className="size-5" />
          </button>
          <button
            className={ICON_BTN}
            aria-label="Previous"
            disabled={!hasTrack}
            onClick={prev}
          >
            <SkipBackIcon className="size-5 fill-current" />
          </button>
          <button
            className="flex size-12 items-center justify-center rounded-full bg-brand text-white transition-colors hover:bg-brand/90 disabled:pointer-events-none disabled:opacity-50"
            aria-label={playing ? "Pause" : "Play"}
            disabled={!hasTrack}
            onClick={toggle}
          >
            {loading ? (
              <Loader2Icon className="size-5 animate-spin" />
            ) : playing ? (
              <PauseIcon className="size-5 fill-current" />
            ) : (
              <PlayIcon className="size-5 fill-current" />
            )}
          </button>
          <button
            className={ICON_BTN}
            aria-label="Next"
            disabled={!hasTrack}
            onClick={next}
          >
            <SkipForwardIcon className="size-5 fill-current" />
          </button>
          <button
            className={cn(ICON_BTN, repeat !== "off" && "text-brand")}
            aria-label={`Repeat: ${repeat}`}
            aria-pressed={repeat !== "off"}
            onClick={cycleRepeat}
          >
            {repeat === "one" ? (
              <Repeat1Icon className="size-5" />
            ) : (
              <RepeatIcon className="size-5" />
            )}
          </button>
          <button
            className={ICON_BTN}
            aria-label="Full-screen lyrics"
            disabled={!hasTrack}
            onClick={() => setKaraokeOpen(true)}
          >
            <Maximize2Icon className="size-5" />
          </button>
          <button
            className={ICON_BTN}
            aria-label="Lyrics"
            disabled={!hasTrack}
            onClick={() => setKaraokeOpen(true)}
          >
            <MicVocalIcon className="size-5" />
          </button>
          <QueueButton className={cn(ICON_BTN, "flex items-center justify-center")} />
          <button className={ICON_BTN} aria-label={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
            <VolumeIcon className="size-5" />
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : Math.round(volume * 100)}
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
            aria-label="Volume"
            className="h-1.5 w-16 accent-brand"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatTime(position)}
        </span>
        <div
          ref={barRef}
          onClick={handleSeek}
          className={cn(
            "h-1.5 min-w-0 flex-1 rounded-full bg-white/20",
            hasTrack && duration > 0 && "cursor-pointer",
          )}
        >
          <div
            className="h-full rounded-full bg-brand"
            style={{ width: duration > 0 ? `${(position / duration) * 100}%` : "0%" }}
          />
        </div>
        <span className="w-10 shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatTime(duration)}
        </span>
      </div>
    </aside>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

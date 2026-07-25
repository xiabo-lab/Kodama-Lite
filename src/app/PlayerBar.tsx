import { useRef } from "react";
import {
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  Repeat1Icon,
  RepeatIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react";
import { usePlaybackStore } from "@/store/playbackStore";
import { useKaraokeStore } from "@/store/karaokeStore";
import { QueueButton, QueuePanel } from "@/components/layout/queue-panel";
import { LyricsSourceButton } from "@/components/layout/lyrics-source-picker";
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
  const playError = usePlaybackStore((s) => s.error);

  const toggle = usePlaybackStore((s) => s.toggle);
  const next = usePlaybackStore((s) => s.next);
  const prev = usePlaybackStore((s) => s.prev);
  const seek = usePlaybackStore((s) => s.seek);
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const setShuffle = usePlaybackStore((s) => s.setShuffle);
  const cycleRepeat = usePlaybackStore((s) => s.cycleRepeat);
  const karaokeOpen = useKaraokeStore((s) => s.open);

  const track = index >= 0 ? queue[index] : undefined;
  const hasTrack = !!track;
  const loading = status === "loading";
  const error = status === "error" ? playError : undefined;

  const barRef = useRef<HTMLDivElement | null>(null);
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = barRef.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(fraction * duration);
  };


  return (
    <aside className="relative z-10 mx-2 mb-2 flex shrink-0 flex-col gap-2 rounded-[10px] border border-sidebar-border bg-surface px-4 py-2.5 shadow-sm">
      {/* Only one QueuePanel may be mounted at a time: they share a store,
          so a second (invisible, behind the karaoke overlay) instance would
          see every click as an outside-click and slam the visible one shut.
          The karaoke stage renders its own. */}
      {!karaokeOpen && <QueuePanel />}
      <div className="flex items-center gap-4">
        {/* A quarter of the bar, not a flexible half and not a fixed 256px.
            Flexible claimed half the width and bunched the controls; 256px
            truncated most song titles after a few words. A quarter is
            enough for a real title and artist, and the controls give the
            width back by tightening their own spacing — `justify-between`
            redistributes whatever is left, so nothing needed re-tuning. */}
        <div className="flex w-1/4 shrink-0 items-center gap-3">
          {/* This was a bare `<div>` — a grey placeholder that never
              rendered anything, so the corner of the screen showing the
              current track's cover simply never worked. */}
          <div className="size-11 shrink-0 overflow-hidden rounded-md border border-hairline bg-muted">
            {track?.thumbnail ? (
              <img
                src={track.thumbnail}
                alt=""
                decoding="async"
                referrerPolicy="no-referrer"
                className="size-full object-cover"
              />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-base font-semibold leading-tight">
              {track?.title ?? "Nothing playing"}
            </span>
            {/* Resolving a track can take a few seconds on a cold cache
                (yt-dlp has to fetch it). Saying so beats a title sitting
                there doing nothing, which reads as a hung app. */}
            {loading ? (
              <span className="flex items-center gap-1.5 truncate text-sm text-brand">
                <Loader2Icon className="size-4 shrink-0 animate-spin" />
                Loading…
              </span>
            ) : error ? (
              <span className="truncate text-sm text-brand" title={error}>
                Couldn't play this track
              </span>
            ) : (
              <span className="truncate text-sm text-muted-foreground">
                {track?.subtitle ?? "Pick a track to start"}
              </span>
            )}
          </div>
        </div>

        {/* One flex group for every control from Shuffle through the volume
            slider, spread edge to edge across whatever width is left
            (`justify-between`) instead of packed against the right margin.
            `gap-4` is the floor, not the spacing: it only takes effect once
            the window is narrow enough that there's no slack left to
            distribute. */}
        <div className="flex flex-1 items-center justify-between gap-4">
          <button
            className={cn(ICON_BTN, shuffle && "text-brand")}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            onClick={() => setShuffle(!shuffle)}
          >
            <ShuffleIcon className="size-10" />
          </button>
          <button
            className={ICON_BTN}
            aria-label="Previous"
            disabled={!hasTrack}
            onClick={prev}
          >
            <SkipBackIcon className="size-10 fill-current" />
          </button>
          <button
            className="flex size-18 items-center justify-center rounded-full bg-brand text-white transition-colors hover:bg-brand/90 disabled:pointer-events-none disabled:opacity-50"
            aria-label={playing ? "Pause" : "Play"}
            disabled={!hasTrack}
            onClick={toggle}
          >
            {loading ? (
              <Loader2Icon className="size-10 animate-spin" />
            ) : playing ? (
              <PauseIcon className="size-10 fill-current" />
            ) : (
              <PlayIcon className="size-10 fill-current" />
            )}
          </button>
          <button
            className={ICON_BTN}
            aria-label="Next"
            disabled={!hasTrack}
            onClick={next}
          >
            <SkipForwardIcon className="size-10 fill-current" />
          </button>
          <button
            className={cn(ICON_BTN, repeat !== "off" && "text-brand")}
            aria-label={`Repeat: ${repeat}`}
            aria-pressed={repeat !== "off"}
            onClick={cycleRepeat}
          >
            {repeat === "one" ? (
              <Repeat1Icon className="size-10" />
            ) : (
              <RepeatIcon className="size-10" />
            )}
          </button>
          {/* The mic is the lyrics-*source* picker, not a way into the
              karaoke stage. That's the top-right corner button now (see
              `TopBar`) — a corner is a far better touch target than a
              40px icon wedged between Repeat and this one. */}
          <LyricsSourceButton
            className={cn(ICON_BTN, "[&_svg]:size-10")}
            disabled={!hasTrack}
          />
          <QueueButton
            className={cn(ICON_BTN, "flex items-center justify-center [&_svg]:size-10")}
          />
          {/* No mute button: at this length the slider is a faster way to
              silence it than a toggle, and `setVolume` clears `muted`, so
              dragging back up always restores sound even if something else
              (the karaoke bar's own mute) set it. */}
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : Math.round(volume * 100)}
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
            aria-label="Volume"
            className="h-3 w-[368px] accent-brand"
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

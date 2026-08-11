import { useState } from "react";
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
import { LikeButton } from "@/components/shared/like-button";
import { ConfirmLyricsButton } from "@/components/shared/confirm-lyrics-button";
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

/**
 * Extra hit box for the five small transport controls — Like, Shuffle,
 * Previous, Next, Repeat. Same technique and the same reason as
 * `TAP_EXPAND` on the karaoke stage: these buttons are sized by the glyph
 * inside them (40px, no padding, no background), so the box IS the
 * picture. Growing it would move every icon in the row; an overflowing
 * `::before` costs no layout at all, and only the area that answers a tap
 * changes.
 *
 * The horizontal figure has to track the row's gap, which is not a
 * constant here — `justify-between` spreads eight children across
 * whatever is left, so the gap measures 101px at 1920 (the panel), 67 at
 * 1600, 45 at 1400 and 32 at 1280, i.e. very close to
 * `(width - 983px) / 9.3`. Dividing by 28 instead of 9.3 keeps the pair of
 * expanded boxes inside about two-thirds of the gap at every width, so
 * neighbours never meet and the sliver between them stays dead — a tap
 * that lands there should do nothing rather than the wrong thing. The
 * 2rem cap stops the target growing absurdly wide on a desktop window.
 *
 * Vertically it is a flat 1rem, which takes the target to exactly the
 * height of the Play button beside it and still leaves 6px above the seek
 * slider on the row below. That slider is a real control — overlapping it
 * would steal drags from it.
 *
 * On the 1920px panel this is 40x40 → 104x72.
 */
const TAP_EXPAND =
  "relative before:absolute before:inset-x-[calc(clamp(0.375rem,calc((100vw-62rem)/28),2rem)*-1)] before:inset-y-[-1rem] before:content-['']";

export function PlayerBar() {
  const queue = usePlaybackStore((s) => s.queue);
  const index = usePlaybackStore((s) => s.index);
  const playing = usePlaybackStore((s) => s.playing);
  const status = usePlaybackStore((s) => s.status);
  const started = usePlaybackStore((s) => s.started);
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
  // `status` goes "ready" the instant the URL resolves, which is before a
  // single byte has been fetched — so on a slow link the bar showed a
  // Pause button and the artist's name over a silent car. Waiting for
  // `started` keeps the spinner up for the whole download, which is what
  // the 0:00 elapsed readout beside it has always been saying.
  const loading = status === "loading" || (playing && !started);
  const error = status === "error" ? playError : undefined;

  /**
   * Where the thumb is being dragged to, or `null` when it isn't.
   *
   * The element is a controlled input whose value normally follows
   * `position`, which the audio element pushes several times a second.
   * Without this, every one of those updates would yank the thumb back
   * out from under the finger holding it. While a drag is in progress the
   * scrub value wins and the store is left alone; the seek is committed
   * on release.
   */
  const [scrub, setScrub] = useState<number | null>(null);
  const shownPosition = scrub ?? position;
  const seekable = hasTrack && duration > 0;
  const pct = duration > 0 ? Math.min(100, (shownPosition / duration) * 100) : 0;

  const commitScrub = () => {
    if (scrub !== null) seek(scrub);
    setScrub(null);
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
              // The real reason, not "Couldn't play this track".
              //
              // The data plane now classifies yt-dlp's failure and sends a
              // sentence worth reading — "needs a Premium subscription",
              // "is DRM protected", "tap play to try again". Those are
              // three completely different situations that this row used
              // to render identically, leaving the only actionable
              // difference (is it worth trying again?) invisible. The raw
              // detail is still on the tooltip.
              <span className="truncate text-sm text-brand" title={error}>
                {error}
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
          {/* Like sits outside the transport group, to the left of
              Shuffle, because it acts on the track rather than on
              playback. Swapped in for the lyrics-source picker, which the
              karaoke stage still carries — that's where you are when a
              lyric sheet is wrong, and it's one control too many out here.
              One in, one out keeps the child count at eight, so
              `justify-between` distributes exactly the same spacing as
              before. */}
          <LikeButton
            track={track}
            className={cn(ICON_BTN, TAP_EXPAND, "disabled:opacity-40 [&_svg]:size-10")}
          />
          <button
            className={cn(ICON_BTN, TAP_EXPAND, shuffle && "text-brand")}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            onClick={() => setShuffle(!shuffle)}
          >
            <ShuffleIcon className="size-10" />
          </button>
          <button
            className={cn(ICON_BTN, TAP_EXPAND)}
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
            className={cn(ICON_BTN, TAP_EXPAND)}
            aria-label="Next"
            disabled={!hasTrack}
            onClick={next}
          >
            <SkipForwardIcon className="size-10 fill-current" />
          </button>
          <button
            className={cn(ICON_BTN, TAP_EXPAND, repeat !== "off" && "text-brand")}
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
        {/* Lower-left corner of the screen, on the progress row. It acts on
            the LYRICS rather than on playback, so it deliberately sits
            outside the transport cluster above — down here it is the only
            thing on its row that isn't a readout, and it can't be confused
            with a transport control mid-drive. */}
        <ConfirmLyricsButton className="size-7 shrink-0" />
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatTime(shownPosition)}
        </span>
        {/* `step={0.1}` rather than the default 1: at a whole second the
            thumb visibly snaps between stops on a long track, which reads
            as a laggy control rather than a precise one.

            Both `onMouseUp` and `onTouchEnd` commit, because WebKitGTK on
            the panel delivers one or the other depending on how the event
            was synthesised, and a drag that never commits leaves the thumb
            parked somewhere the audio never went. `onKeyUp` covers arrow
            stepping, which produces neither. */}
        <input
          type="range"
          min={0}
          max={duration > 0 ? duration : 100}
          step={0.1}
          value={shownPosition}
          disabled={!seekable}
          aria-label="Seek"
          aria-valuetext={`${formatTime(shownPosition)} of ${formatTime(duration)}`}
          onChange={(e) => setScrub(Number(e.target.value))}
          onMouseUp={commitScrub}
          onTouchEnd={commitScrub}
          onKeyUp={commitScrub}
          // `--pct` drives the filled portion of the track; see index.css.
          style={{ "--pct": `${pct}%` } as React.CSSProperties}
          className="seek-slider -my-3 min-w-0 flex-1"
        />
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

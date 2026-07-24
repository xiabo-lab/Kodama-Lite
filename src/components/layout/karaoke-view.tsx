import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  Repeat1Icon,
  RepeatIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  XIcon,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePlaybackStore } from "@/store/playbackStore";
import { useLyricsStore } from "@/store/lyricsStore";
import { useKaraokeStore } from "@/store/karaokeStore";
import { LyricsBody, STAGE_LEADING } from "@/components/layout/lyrics-view";
import { cn } from "@/lib/utils";

// Plain `vite dev` in a browser has no Tauri backend; `getCurrentWindow()`
// throws there. Same guard the title bar uses.
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const SECONDARY_BTN =
  "flex size-[clamp(3.5rem,15vh,4rem)] items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[clamp(1.75rem,7vh,2rem)]";
const PLAY_BTN = "size-[clamp(4.5rem,21vh,5.5rem)]";
const PLAY_GLYPH = "size-[clamp(2.25rem,9vh,2.75rem)]";
const BTN_GAP = "gap-[clamp(0.75rem,2.5vw,2rem)]";

const LYRIC_FONT = "clamp(1.75rem,15vh,3.75rem)";
const LYRIC_GAP = "clamp(0.3rem,1.8vh,0.9rem)";
const STAGE_LINES = 3;
const CHROME_MS = 5000;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function repeatLabel(repeat: "off" | "all" | "one"): string {
  return repeat === "one" ? "Repeat one" : repeat === "all" ? "Repeat all" : "Repeat off";
}

/**
 * Full-screen "karaoke" lyrics overlay. Simplified from YTMLite's version:
 * no lyrics-source picker (see lyrics-view.tsx) and no queue popover button
 * (see queue-panel.tsx for the standalone queue panel instead). The stage
 * layout itself — three big lyric lines, one row of finger-sized transport
 * controls, tap-to-reveal chrome — is kept faithfully; it's built for the
 * Pi's 1920x440 touch panel and is the part that actually defines the
 * feature.
 */
export function KaraokeView() {
  const open = useKaraokeStore((s) => s.open);
  const setOpen = useKaraokeStore((s) => s.setOpen);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open || !IS_TAURI) return;
    let cancelled = false;
    let prev = false;
    const win = getCurrentWindow();
    void win
      .isFullscreen()
      .then((was) => {
        prev = was;
        if (!cancelled) return win.setFullscreen(true);
      })
      .catch(() => {
        /* compositor refused fullscreen — the overlay still fills the window */
      });
    return () => {
      cancelled = true;
      if (!prev) void win.setFullscreen(false).catch(() => {});
    };
  }, [open]);

  if (!open) return null;
  return <KaraokeStage onClose={() => setOpen(false)} />;
}

function KaraokeStage({ onClose }: { onClose: () => void }) {
  const queue = usePlaybackStore((s) => s.queue);
  const index = usePlaybackStore((s) => s.index);
  const playing = usePlaybackStore((s) => s.playing);
  const status = usePlaybackStore((s) => s.status);
  const position = usePlaybackStore((s) => s.position);
  const duration = usePlaybackStore((s) => s.duration);
  const shuffle = usePlaybackStore((s) => s.shuffle);
  const repeat = usePlaybackStore((s) => s.repeat);
  const toggle = usePlaybackStore((s) => s.toggle);
  const next = usePlaybackStore((s) => s.next);
  const prev = usePlaybackStore((s) => s.prev);
  const seek = usePlaybackStore((s) => s.seek);
  const setShuffle = usePlaybackStore((s) => s.setShuffle);
  const cycleRepeat = usePlaybackStore((s) => s.cycleRepeat);
  const track = index >= 0 ? queue[index] : undefined;

  const loadLyrics = useLyricsStore((s) => s.load);
  useEffect(() => {
    if (track) loadLyrics({ videoId: track.videoId, title: track.title, artist: track.subtitle, duration: track.duration });
  }, [track?.videoId, loadLyrics]);

  const [scrub, setScrub] = useState<number | null>(null);
  const [chrome, setChrome] = useState(false);
  const hideRef = useRef<number | null>(null);
  const scrubRef = useRef(scrub);
  scrubRef.current = scrub;

  const revealChrome = useCallback(() => {
    setChrome(true);
    if (hideRef.current !== null) window.clearTimeout(hideRef.current);
    const tick = () => {
      if (scrubRef.current !== null) {
        hideRef.current = window.setTimeout(tick, CHROME_MS);
        return;
      }
      hideRef.current = null;
      setChrome(false);
    };
    hideRef.current = window.setTimeout(tick, CHROME_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (hideRef.current !== null) window.clearTimeout(hideRef.current);
    };
  }, []);

  const hasTrack = !!track;
  const loading = status === "loading" && playing;
  const shownPosition = scrub ?? position;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#0a0a0a] text-foreground"
      onPointerDown={(e) => {
        const el = e.target as HTMLElement | null;
        if (el?.closest("button,input[type=range]")) return;
        revealChrome();
      }}
    >
      <div
        aria-hidden={!chrome}
        className={cn(
          "absolute inset-x-0 top-0 z-10 flex items-center gap-[clamp(0.75rem,2vw,2rem)] bg-gradient-to-b from-black via-black/85 to-transparent pb-6 pl-[clamp(1rem,3vw,3rem)] pr-[clamp(4.5rem,7vw,7rem)] pt-[clamp(0.5rem,2.5vh,1rem)] transition-opacity duration-300",
          chrome ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div className="flex min-w-0 max-w-[38%] shrink items-baseline gap-2">
          <span className="min-w-0 truncate font-semibold text-[clamp(1rem,3.2vh,1.5rem)]">{track?.title ?? "Nothing playing"}</span>
          {track?.subtitle ? (
            <span className="min-w-0 truncate text-[clamp(0.85rem,2.4vh,1.125rem)] text-muted-foreground">— {track.subtitle}</span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="w-12 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{formatTime(shownPosition)}</span>
          <input
            type="range"
            min={0}
            max={duration > 0 ? duration : 100}
            value={shownPosition}
            disabled={!hasTrack || duration <= 0}
            onChange={(e) => setScrub(Number(e.target.value))}
            onMouseUp={() => {
              if (scrub !== null) seek(scrub);
              setScrub(null);
            }}
            className="h-2 min-w-0 flex-1 accent-brand"
          />
          <span className="w-12 shrink-0 text-sm tabular-nums text-muted-foreground">{formatTime(duration)}</span>
        </div>
      </div>

      <button
        type="button"
        aria-label="Exit full screen"
        onClick={onClose}
        className={cn(SECONDARY_BTN, "absolute right-3 top-3 z-20")}
      >
        <XIcon />
      </button>

      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={{ "--lyric-font": LYRIC_FONT, "--lyric-gap": LYRIC_GAP } as React.CSSProperties}
      >
        <div
          className="w-full overflow-hidden"
          style={{ height: `calc(${STAGE_LINES} * ${STAGE_LEADING} * var(--lyric-font) + ${STAGE_LINES - 1} * var(--lyric-gap))` }}
        >
          <LyricsBody display="stage" />
        </div>
      </div>

      <div className="shrink-0 px-6 pb-[clamp(0.5rem,2.5vh,1.25rem)]">
        <div className={cn("flex items-center justify-center", BTN_GAP)}>
          <button
            type="button"
            aria-label="Shuffle"
            aria-pressed={shuffle}
            onClick={() => setShuffle(!shuffle)}
            className={cn(SECONDARY_BTN, shuffle && "text-brand")}
          >
            <ShuffleIcon />
          </button>
          <button type="button" aria-label="Previous" onClick={prev} disabled={!hasTrack} className={SECONDARY_BTN}>
            <SkipBackIcon className="fill-current" />
          </button>
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            onClick={toggle}
            disabled={!hasTrack}
            className={cn(PLAY_BTN, "flex items-center justify-center rounded-full bg-brand text-white transition-colors hover:bg-brand/90 disabled:pointer-events-none disabled:opacity-50")}
          >
            {loading ? (
              <Loader2Icon className={cn(PLAY_GLYPH, "animate-spin")} />
            ) : playing ? (
              <PauseIcon className={cn(PLAY_GLYPH, "fill-current")} />
            ) : (
              <PlayIcon className={cn(PLAY_GLYPH, "fill-current")} />
            )}
          </button>
          <button type="button" aria-label="Next" onClick={next} disabled={!hasTrack} className={SECONDARY_BTN}>
            <SkipForwardIcon className="fill-current" />
          </button>
          <button
            type="button"
            aria-label={repeatLabel(repeat)}
            aria-pressed={repeat !== "off"}
            onClick={cycleRepeat}
            className={cn(SECONDARY_BTN, repeat !== "off" && "text-brand")}
          >
            {repeat === "one" ? <Repeat1Icon /> : <RepeatIcon />}
          </button>
        </div>
      </div>

      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-white/10 transition-opacity duration-300",
          chrome ? "opacity-0" : "opacity-100",
        )}
      >
        <div className="h-full bg-brand" style={{ width: `${duration > 0 ? Math.min(100, (shownPosition / duration) * 100) : 0}%` }} />
      </div>
    </div>
  );
}

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
import { useKaraokeStore } from "@/store/karaokeStore";
import { LikeButton } from "@/components/shared/like-button";
import { ConfirmLyricsButton } from "@/components/shared/confirm-lyrics-button";
import { LyricsBody, useDisplayLyrics } from "@/components/layout/lyrics-view";
import {
  LyricsSearchButton,
  LyricsSourceButton,
} from "@/components/layout/lyrics-source-picker";
import { QueueButton, QueuePanel } from "@/components/layout/queue-panel";
import { useQueuePanelStore } from "@/store/queuePanelStore";
import {
  lyricColorCss,
  useSettingsStore,
  type LyricStyle,
} from "@/store/settingsStore";
import { cn } from "@/lib/utils";

// Plain `vite dev` in a browser has no Tauri backend; `getCurrentWindow()`
// throws there. Same guard the title bar uses.
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// `shrink-0` on both button styles is load-bearing, not cosmetic: these are
// flex children, so without it a row that runs out of width squeezes the
// boxes narrower than the icons they contain — and the visible glyph stops
// marking where the hit target actually is.
const SECONDARY_BTN =
  "flex size-[clamp(3.5rem,15vh,4rem)] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[clamp(1.75rem,7vh,2rem)] [&_svg]:shrink-0";
const PLAY_BTN = "size-[clamp(4.5rem,21vh,5.5rem)] shrink-0";
const PLAY_GLYPH = "size-[clamp(2.25rem,9vh,2.75rem)]";
const BTN_GAP = "gap-[clamp(0.75rem,2.5vw,2rem)]";

/**
 * Extra hit box for the five small transport controls — Like, Shuffle,
 * Previous, Next, Repeat — the ones a moving car makes you stab at.
 *
 * Added as an overflowing pseudo-element rather than a bigger button,
 * because the box is also the visual: these controls have no background,
 * so growing `size-*` would move every glyph in the row and change the
 * spacing the user's hand has already learned. A `::before` costs no
 * layout at all — the icons stay exactly where they are, and only the
 * area that answers a tap grows.
 *
 * The horizontal figure is deliberately under half of `BTN_GAP` at every
 * clamp stop (1vw against 2.5vw, and both ends likewise), so two
 * neighbouring targets can never meet however the panel is sized. That
 * remaining sliver is worth keeping: between two expanded boxes, a tap
 * that lands in the middle should do nothing rather than the wrong thing.
 * On the 1920px panel this is 64px → 88x88, with 8px of dead space left.
 *
 * Only the transport row gets it. The utility cluster on the right sits
 * on a 4–12px gap with nothing to take.
 */
const TAP_EXPAND =
  "relative before:absolute before:inset-x-[calc(clamp(0.25rem,1vw,0.75rem)*-1)] before:inset-y-[calc(clamp(0.25rem,1.5vh,0.75rem)*-1)] before:content-['']";

const LYRIC_GAP = "clamp(0.3rem,1.8vh,0.9rem)";

/**
 * Settings → Appearance → Font settings, handed to the stage as custom
 * properties. Passing them down the DOM rather than through props keeps
 * `lyrics-view`'s slot components free of store reads — they already take
 * their geometry from `--lyric-*`, and this is the same channel.
 *
 * `--lyric-font` is kept, aliased to the current line's size: the stage's
 * *scrolling* branch (an unsynced transcript, which has no three-slot
 * layout to configure) still sizes itself from it.
 */
function lyricStyleVars(s: LyricStyle): React.CSSProperties {
  return {
    "--lyric-gap": LYRIC_GAP,
    "--lyric-font": `${s.current.size}px`,
    "--lyric-size-top": `${s.top.size}px`,
    "--lyric-size-current": `${s.current.size}px`,
    "--lyric-size-bottom": `${s.bottom.size}px`,
    "--lyric-color-top": lyricColorCss(s.top.color),
    "--lyric-color-current": lyricColorCss(s.current.color),
    "--lyric-color-bottom": lyricColorCss(s.bottom.color),
    "--lyric-color-karaoke": lyricColorCss(s.karaoke),
    // 650 / 500 are the weights the stage hardcoded before this setting
    // existed, so Bold-on and Bold-off reproduce the two looks it had.
    "--lyric-weight-top": s.top.bold ? 650 : 500,
    "--lyric-weight-current": s.current.bold ? 650 : 500,
    "--lyric-weight-bottom": s.bottom.bold ? 650 : 500,
  } as React.CSSProperties;
}
const CHROME_MS = 5000;

/**
 * The close button is sized and placed to mirror `KaraokeCornerButton` in
 * `TopBar.tsx` exactly — 160x60, flush to the top-right corner with no
 * margin or rounding on the outer two edges, icon inset for looks.
 *
 * That symmetry is the whole point: the same corner opens the stage and
 * closes it, so the gesture is one place your hand learns rather than two.
 * It also inherits what makes that button reliable — two screen edges stop
 * an over-shot finger, so the literal corner pixel is still inside the hit
 * box. The old button was a `SECONDARY_BTN` (~56-64px square) inset 12px
 * from both edges, which put the corner *outside* the target.
 */
const CLOSE_BTN =
  "absolute right-0 top-0 z-20 flex h-[60px] w-40 items-center justify-end rounded-bl-md pr-6 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/**
 * The two bottom-corner buttons: confirm-lyrics on the left, search-lyrics
 * on the right.
 *
 * The TARGET is 88px square — four times the area of the 44px box you
 * actually see, which is drawn centred inside it (`CORNER_BOX`). Splitting
 * the two is the point: these need to be hittable at a traffic light, but
 * a pair of 88px slabs is a lot of furniture to park in the corners of a
 * screen whose whole job is showing lyrics. The padding around each box is
 * all target — the same trick the seek slider uses.
 *
 * Both act on the LYRICS rather than on playback, which is why they live
 * in the corners rather than the transport row: a corner is the easiest
 * place to hit without looking (two edges stop an over-shot finger) and it
 * keeps them clear of controls where a mis-tap costs something.
 */
const CORNER_BTN = "absolute bottom-0 z-20 size-[88px]";
const CORNER_BOX = "size-11";

/**
 * Volume slider. Its own component so the volume subscription re-renders
 * this alone rather than the whole stage (the same reason `AudioEngine` is
 * split out of `AppShell`).
 *
 * No mute button, and the same 368px length as the player bar's: at this
 * width dragging to zero is quicker than finding a toggle, and `setVolume`
 * clears `muted`, so dragging back up always restores sound.
 */
function KaraokeVolume() {
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  const setVolume = usePlaybackStore((s) => s.setVolume);

  return (
    <input
      type="range"
      min={0}
      max={100}
      value={muted ? 0 : Math.round(volume * 100)}
      onChange={(e) => setVolume(Number(e.target.value) / 100)}
      aria-label="Volume"
      className="h-3 w-[368px] accent-brand"
    />
  );
}

function repeatLabel(repeat: "off" | "all" | "one"): string {
  return repeat === "one" ? "Repeat one" : repeat === "all" ? "Repeat all" : "Repeat off";
}

/**
 * Full-screen "karaoke" lyrics overlay: three big lyric lines, a centered
 * row of finger-sized transport controls, a right-hand cluster (lyrics
 * source, queue, volume) and tap-to-reveal chrome. Built for the Pi's
 * 1920x440 touch panel, which is why every hit target here is sized in
 * `vh` rather than pixels.
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
  const lyricStyle = useSettingsStore((s) => s.lyricStyle);
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
  const setShuffle = usePlaybackStore((s) => s.setShuffle);
  const cycleRepeat = usePlaybackStore((s) => s.cycleRepeat);
  const track = index >= 0 ? queue[index] : undefined;

  // Lyrics are loaded by `useAudioEngine` on every track change now, not
  // here — see its comment. Fetching from this component meant a track
  // only got lyrics if you happened to open the stage for it.

  // Either side panel makes the lyrics yield the right-hand third of the
  // stage. Pinning the panels to the screen edge stopped them landing in
  // the middle of the text, but the lines still ran under them — measured
  // 208px of overlap on the longest line. Narrowing the column re-centres
  // the text in what's left, so nothing is ever hidden behind a panel.
  const queueOpen = useQueuePanelStore((s) => s.open);
  const [sourceOpen, setSourceOpen] = useState(false);
  // The search screen is a full-screen overlay, but the stage still has to
  // treat it as "a panel is open" — otherwise the lyrics column widens
  // back out underneath it and snaps when it closes. Read from the store
  // rather than mirrored up from the button, so a spoken "search lyric"
  // narrows the column exactly as a tap does.
  const searchOpen = useKaraokeStore((s) => s.searchOpen);
  const panelOpen = queueOpen || sourceOpen || searchOpen;

  // Only needed for the "estimated timing" disclosure now — the stage
  // sizes itself (see `StageLyrics`).
  const displayLyrics = useDisplayLyrics();
  const estimatedTiming = displayLyrics?.kind === "timed" && displayLyrics.estimated;

  // Plain hide-after-a-delay now. It used to re-arm the timer for as long
  // as a scrub was in progress, so the band couldn't vanish from under a
  // finger mid-drag; with the slider gone from this band there is nothing
  // left in it to hold open for.
  const [chrome, setChrome] = useState(false);
  const hideRef = useRef<number | null>(null);

  const revealChrome = useCallback(() => {
    setChrome(true);
    if (hideRef.current !== null) window.clearTimeout(hideRef.current);
    hideRef.current = window.setTimeout(() => {
      hideRef.current = null;
      setChrome(false);
    }, CHROME_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (hideRef.current !== null) window.clearTimeout(hideRef.current);
    };
  }, []);

  const hasTrack = !!track;
  const loading = status === "loading" && playing;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#0a0a0a] text-foreground"
      onPointerDown={(e) => {
        const el = e.target as HTMLElement | null;
        if (el?.closest("button,input[type=range]")) return;
        revealChrome();
      }}
    >
      {/* Tap-to-reveal band: the track's name, centered, and nothing else.
          It used to also carry a seek slider with elapsed/total readouts,
          which is what pushed the title into a cramped 38%-wide column on
          the left. The slider is gone by request, and with the full width
          back the title can be centered and set 1.3x larger — which is the
          size it needs to be readable at a glance from the driver's seat,
          the only moment this band exists for. Seeking is still available
          in the always-on control row below, and the thin progress line at
          the bottom of the screen still shows position.

          Permanently `pointer-events-none`: nothing in here is interactive
          any more, and a full-width band that swallowed taps would make
          reachability depend on how tall a title happened to render. */}
      <div
        aria-hidden={!chrome}
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-1 bg-gradient-to-b from-black via-black/85 to-transparent px-[clamp(1rem,3vw,3rem)] pb-6 pt-[clamp(0.5rem,2.5vh,1rem)] transition-opacity duration-300",
          chrome ? "opacity-100" : "opacity-0",
        )}
      >
        {/* 1.3x the previous clamp at every stop: 1rem→1.3rem,
            3.2vh→4.16vh, 1.5rem→1.95rem. Scaling all three keeps the
            clamp behaving the same way across panel heights instead of
            only growing at one end. */}
        <div className="flex max-w-full items-baseline justify-center gap-2">
          <span className="min-w-0 truncate font-semibold text-[clamp(1.3rem,4.16vh,1.95rem)]">
            {track?.title ?? "Nothing playing"}
          </span>
          {track?.subtitle ? (
            <span className="min-w-0 truncate text-[clamp(1.105rem,3.12vh,1.4625rem)] text-muted-foreground">
              — {track.subtitle}
            </span>
          ) : null}
        </div>
        {/* Disclosed here rather than over the lyrics: this band is what
            you reveal when you tap to ask what's going on, and the stage
            has no spare vertical room on a 440px panel. On its own line
            now that the band is a centered column. */}
        {estimatedTiming ? (
          <span className="whitespace-nowrap text-[clamp(0.75rem,2.1vh,1rem)] text-brand">
            estimated timing
          </span>
        ) : null}
      </div>

      <button
        type="button"
        aria-label="Exit full screen"
        onClick={onClose}
        className={CLOSE_BTN}
      >
        <XIcon className="size-9" />
      </button>

      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center overflow-hidden",
          // Not animated: a CSS transition only advances while frames are
          // produced, and a stalled one would leave the column stuck at
          // the wrong width with the panel already closed.
          panelOpen && "pr-[640px]",
        )}
        style={lyricStyleVars(lyricStyle)}
      >
        {/* Full height, unconditionally. This used to be capped to exactly
            three lines' worth for a timed sheet, because the stage was a
            scrolling list and the cap was what limited how much of it
            showed. The stage now lays out its own three fixed slots and
            centres them (see `StageLyrics`), so the cap would only fight
            it — and an unsynced transcript still wants the whole height
            to scroll in. */}
        <div className="h-full w-full overflow-hidden">
          <LyricsBody display="stage" />
        </div>
      </div>

      {/* `relative` + an absolutely-positioned right cluster, so the
          transport row stays optically centered on the 1920px panel no
          matter how many utility controls sit beside it. */}
      <div className="relative shrink-0 px-6 pb-[clamp(0.5rem,2.5vh,1.25rem)]">
        <div className={cn("flex items-center justify-center", BTN_GAP)}>
          <LikeButton track={track} className={cn(SECONDARY_BTN, TAP_EXPAND)} />
          <button
            type="button"
            aria-label="Shuffle"
            aria-pressed={shuffle}
            onClick={() => setShuffle(!shuffle)}
            className={cn(SECONDARY_BTN, TAP_EXPAND, shuffle && "text-brand")}
          >
            <ShuffleIcon />
          </button>

          <button type="button" aria-label="Previous" onClick={prev} disabled={!hasTrack} className={cn(SECONDARY_BTN, TAP_EXPAND)}>
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
          <button type="button" aria-label="Next" onClick={next} disabled={!hasTrack} className={cn(SECONDARY_BTN, TAP_EXPAND)}>
            <SkipForwardIcon className="fill-current" />
          </button>
          <button
            type="button"
            aria-label={repeatLabel(repeat)}
            aria-pressed={repeat !== "off"}
            onClick={cycleRepeat}
            className={cn(SECONDARY_BTN, TAP_EXPAND, repeat !== "off" && "text-brand")}
          >
            {repeat === "one" ? <Repeat1Icon /> : <RepeatIcon />}
          </button>
        </div>

        {/* Pulled in from `right-6` to leave the bottom-right corner free
            for the search button below — otherwise the volume slider runs
            straight through it. */}
        <div className="absolute inset-y-0 right-[7rem] flex items-center gap-[clamp(0.25rem,1vw,0.75rem)]">
          <LyricsSourceButton
            className={SECONDARY_BTN}
            placement="screen-right"
            onOpenChange={setSourceOpen}
            disabled={!hasTrack}
          />
          <QueuePanel placement="screen-right" />
          <QueueButton className={SECONDARY_BTN} />
          <KaraokeVolume />
        </div>
      </div>

      {/* The two lyric controls, one in each bottom corner. The stage is
          where lyrics are actually READ, so this is where "are these
          right?" gets answered — and where "none of these are, go and ask
          again" gets asked. Putting either only on the player bar would
          mean leaving the screen to use it.

          Both are always visible rather than tied to the tap-to-reveal
          chrome: they are the controls you reach for *because* of what is
          on screen. */}
      <ConfirmLyricsButton
        className={cn(CORNER_BTN, "left-0")}
        boxClassName={CORNER_BOX}
        iconClassName="size-5"
      />
      <LyricsSearchButton
        className={cn(
          CORNER_BTN,
          "right-0 flex items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-25 [&_svg]:size-5",
        )}
        boxClassName={CORNER_BOX}
        disabled={!hasTrack}
      />

      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-white/10 transition-opacity duration-300",
          chrome ? "opacity-0" : "opacity-100",
        )}
      >
        <div className="h-full bg-brand" style={{ width: `${duration > 0 ? Math.min(100, (position / duration) * 100) : 0}%` }} />
      </div>
    </div>
  );
}

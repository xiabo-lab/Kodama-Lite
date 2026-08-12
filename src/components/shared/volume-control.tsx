import { useCallback, useEffect, useRef, useState } from "react";
import {
  Volume1Icon,
  Volume2Icon,
  VolumeIcon,
  VolumeXIcon,
} from "lucide-react";
import { usePlaybackStore } from "@/store/playbackStore";
import { cn } from "@/lib/utils";

/**
 * Volume: an icon button that pops a vertical slider above itself.
 *
 * One component for both places volume is set — the player bar and the
 * karaoke stage — for the same reason `LikeButton` is one component: the
 * two used to carry separate copies of the same 368px horizontal slider,
 * and any change to one silently left the other behind.
 *
 * It replaces those sliders. A 368px bar spent a quarter of the control
 * row on something that is set once a drive, and on the stage it ran
 * across the corner the search button needs. The glyph is also a readout
 * the bar never was: from the driver's seat "is this thing muted?" is now
 * answerable without focusing on a thumb position.
 *
 * Nothing about the audio path changed — this still only calls
 * `setVolume`, which clamps, clears `muted` and persists, exactly as the
 * sliders did.
 */

/** Auto-hide delay for the popped slider. Re-armed by every interaction. */
const HIDE_MS = 3000;

/**
 * Half the thumb, in px, and the only magic number in the drag maths.
 *
 * The thumb is a circle centred on the value, so the value's usable travel
 * is the track's height less one thumb — otherwise the top and bottom
 * halves of the track are dead space that reports 100% and 0%, and a
 * finger at the very end of the track sits visibly off the cap it is
 * dragging. `THUMB_R` keeps the pointer maths and the CSS that draws the
 * fill (`calc((100% - 2*THUMB_R) * p)`) in agreement.
 */
const THUMB_R = 12;

/**
 * Four states, four glyphs — muted, low, medium, high — so the icon says
 * roughly how loud it is and not merely whether sound exists.
 *
 * The thirds are of the SLIDER's scale, not of perceived loudness: this
 * has to agree with where the user just put the thumb, and the ear's
 * curve is applied downstream in `audioEngine` (see the volume notes
 * there). A muted stream reads 0 regardless of the remembered level,
 * which is what `muted ? 0 : volume` gives every consumer here.
 */
function VolumeGlyph({ level, className }: { level: number; className?: string }) {
  if (level <= 0) return <VolumeXIcon className={className} />;
  if (level < 1 / 3) return <VolumeIcon className={className} />;
  if (level < 2 / 3) return <Volume1Icon className={className} />;
  return <Volume2Icon className={className} />;
}

export function VolumeControl({
  className,
  iconClassName,
  wrapperClassName,
  trackClassName,
}: {
  /** Button styling — each caller supplies its own row's sizing. */
  className?: string;
  iconClassName?: string;
  /** The anchor the popup is positioned against. */
  wrapperClassName?: string;
  /**
   * Height of the popped track. The default is a 1920x440-friendly clamp;
   * both stops are the original figures plus 30% (7→9.1rem, 26→33.8vh,
   * 10→13rem), which is the length the panel was actually tested at.
   */
  trackClassName?: string;
}) {
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  const setVolume = usePlaybackStore((s) => s.setVolume);

  const level = muted ? 0 : volume;
  const pct = Math.round(level * 100);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const hideRef = useRef<number | null>(null);
  /**
   * Ref, not state: `arm` is called from pointer handlers that must not
   * re-render to take effect, and a stale `dragging` captured in a
   * `useCallback` would let the timer fire out from under a held finger.
   */
  const draggingRef = useRef(false);

  /**
   * (Re-)start the 3s countdown. Every interaction calls it, so the slider
   * only ever disappears after three quiet seconds.
   *
   * While a drag is in progress no timer is armed at all. A finger can
   * rest on the thumb without moving — no events, and a slider that faded
   * out from under it would leave the drag committing to an invisible
   * control. `commit` re-arms on release.
   */
  const arm = useCallback(() => {
    if (hideRef.current !== null) window.clearTimeout(hideRef.current);
    hideRef.current = null;
    if (draggingRef.current) return;
    hideRef.current = window.setTimeout(() => {
      hideRef.current = null;
      setOpen(false);
    }, HIDE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (hideRef.current !== null) window.clearTimeout(hideRef.current);
    };
  }, []);

  // Outside tap closes immediately rather than after the countdown: on a
  // panel this small the slider floats over the thing the user just
  // reached past it for, and three seconds of that is three too many.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * Value under the pointer, clamped.
   *
   * Measured against the visible track but driven from the padded box
   * around it, so the generous touch margin still drags rather than
   * needing a 12px-wide bullseye — a finger that slides off the side of
   * the track keeps its grip, which is how every slider on a phone
   * behaves.
   */
  const apply = useCallback(
    (clientY: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const usable = rect.height - 2 * THUMB_R;
      if (usable <= 0) return;
      const y = clientY - rect.top - THUMB_R;
      setVolume(Math.max(0, Math.min(1, 1 - y / usable)));
    },
    [setVolume],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Captured on the slider itself: WebKitGTK on the panel drops a drag
    // the moment the finger leaves the element otherwise, which on a
    // 12px-wide track is most of them.
    //
    // Guarded because capture is an optimisation, not the mechanism: a
    // pointer id the browser no longer considers active throws, and an
    // exception here would take the `apply` below with it — turning a
    // tap that should have set the volume into one that does nothing.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — the drag still tracks while over the box */
    }
    draggingRef.current = true;
    apply(e.clientY);
    arm();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    apply(e.clientY);
    arm();
  };

  const commit = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* already released with the pointer itself */
    }
    arm();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step =
      e.key === "ArrowUp" || e.key === "ArrowRight"
        ? 0.05
        : e.key === "ArrowDown" || e.key === "ArrowLeft"
          ? -0.05
          : 0;
    if (step !== 0) setVolume(level + step);
    else if (e.key === "Home") setVolume(0);
    else if (e.key === "End") setVolume(1);
    else return;
    e.preventDefault();
    arm();
  };

  const toggle = () => {
    if (open) {
      setOpen(false);
      if (hideRef.current !== null) window.clearTimeout(hideRef.current);
      hideRef.current = null;
      return;
    }
    setOpen(true);
    arm();
    // So arrow keys land on the slider the tap just revealed.
    window.setTimeout(() => sliderRef.current?.focus(), 0);
  };

  return (
    <div ref={wrapRef} className={cn("relative", wrapperClassName)}>
      {/* Kept mounted and faded with opacity rather than unmounted: the
          hide is specified as a fade, and a transition only runs on an
          element that is already in the DOM. `pointer-events-none` is what
          actually makes it inert while hidden — an invisible panel that
          still swallowed taps would eat the control row underneath it. */}
      <div
        aria-hidden={!open}
        // Pointer inside the panel at all — not only on the track — counts
        // as interaction and re-arms. Costs nothing on the panel (a finger
        // that is touching is already dragging) and stops the slider
        // vanishing from under a mouse that is on its way to it.
        onPointerMove={arm}
        className={cn(
          "absolute bottom-full left-1/2 z-[55] mb-2 -translate-x-1/2 rounded-xl border border-hairline bg-black px-2 py-3 shadow-lg transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div
          ref={sliderRef}
          role="slider"
          aria-label="Volume"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${pct}%`}
          tabIndex={open ? 0 : -1}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={commit}
          onPointerCancel={commit}
          onKeyDown={onKeyDown}
          // `touch-none`: without it the compositor claims the vertical
          // drag as a scroll gesture and the thumb never moves.
          className={cn(
            "flex w-11 cursor-pointer touch-none justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand",
            trackClassName ?? "h-[clamp(9.1rem,33.8vh,13rem)]",
          )}
        >
          <div
            ref={trackRef}
            className="relative h-full w-3 rounded-full bg-white/20"
            // The fill stops at the thumb's CENTRE, so the two agree at
            // every value instead of the cap drifting past the circle.
            style={
              {
                "--fill": `calc(${THUMB_R}px + (100% - ${2 * THUMB_R}px) * ${level})`,
              } as React.CSSProperties
            }
          >
            <div
              className="absolute inset-x-0 bottom-0 rounded-full bg-brand"
              style={{ height: "var(--fill)" }}
            />
            {/* `bottom` alone, no vertical transform: the box is one
                thumb tall, so sitting its bottom edge `THUMB_R` below the
                fill's cap puts its centre exactly on the value. */}
            <div
              className="absolute left-1/2 size-6 -translate-x-1/2 rounded-full border-[3px] border-brand bg-white shadow-[0_1px_3px_rgb(0_0_0/0.5)]"
              style={{ bottom: `calc(var(--fill) - ${THUMB_R}px)` }}
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        aria-label={`Volume ${pct}%`}
        aria-expanded={open}
        // No `title`. It was `Volume ${pct}%`, and on the panel WebKitGTK
        // pins the bubble under the last touch point and never re-renders
        // its text — caught on the device reading "Volume 0%" over a
        // two-arc glyph at 90%. The glyph is the readout; a tooltip that
        // can go stale is worse than none, and a touchscreen has no hover
        // to dismiss it.
        onClick={toggle}
        className={className}
      >
        <VolumeGlyph level={level} className={iconClassName} />
      </button>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { useLyricsStore } from "@/store/lyricsStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { cn } from "@/lib/utils";

/** How long the confirmation label stays up after a press. */
const HINT_MS = 3000;

/**
 * "These lyrics are right" — the green button.
 *
 * Ported in spirit from Carlyrics' GREEN feedback button (`_draw_feedback_
 * buttons` / `save_to_cache`). Nothing reaches the persistent lyrics cache
 * until this is pressed. Until then a lyric is this session's best guess:
 * shown, scrolled, sung along to, and forgotten when the track changes.
 *
 * Why that matters enough to need a button at all: the app used to cache
 * every search result the moment it arrived, so a mis-matched lyric became
 * permanent — and because a cache hit skips the search entirely, it could
 * never correct itself on a later play. Confirmation is what separates
 * "this is what we found" from "this is right", and only a human can tell
 * those apart.
 *
 * The pressed state is real state, not a flash: it stays lit for as long as
 * the confirmed lyric is on screen, so the answer to "did I already say yes
 * to this one?" is always visible. Pressing again withdraws it.
 */
export function ConfirmLyricsButton({
  className,
  boxClassName = "size-full",
  iconClassName = "size-5",
}: {
  /** The HIT AREA — sizing and positioning of the tappable region. */
  className?: string;
  /**
   * The DRAWN box, centred inside the hit area.
   *
   * Kept separate because the two want different answers. On the karaoke
   * stage the target is 88px so it can be hit while driving, but a green
   * square that large is a lot of colour to leave sitting in the corner of
   * a lyric screen. Defaults to filling the hit area, which is what the
   * player bar wants — there, the button is small and so is the target.
   */
  boxClassName?: string;
  iconClassName?: string;
}) {
  const lyrics = useLyricsStore((s) => s.lyrics);
  const confirmed = useLyricsStore((s) => s.confirmed);
  const confirm = useLyricsStore((s) => s.confirm);
  const unconfirm = useLyricsStore((s) => s.unconfirm);
  const hasTrack = usePlaybackStore((s) => s.index >= 0);

  /**
   * The label shown after a press, and nothing else.
   *
   * This used to be a native `title` tooltip. On the Pi's touch panel that
   * is the wrong mechanism twice over: WebKit raises it on a long press and
   * then leaves it up — there is no pointer to move away and dismiss it —
   * so "Save these lyrics for this track" sat on screen after the very tap
   * that made it untrue. A controlled label that times itself out can't do
   * that, and it can also say what actually happened rather than what the
   * button would do.
   */
  const [hint, setHint] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const flash = (text: string) => {
    setHint(text);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setHint(null);
    }, HINT_MS);
  };

  // Nothing to confirm without a lyric on screen. Rendered as an inert
  // placeholder rather than removed, so the controls beside it don't shift
  // sideways when a track's lyrics arrive a second after it starts.
  const enabled = hasTrack && !!lyrics;

  const onPress = () => {
    if (confirmed) {
      unconfirm();
      flash("Removed from saved lyrics");
    } else {
      confirm();
      flash("Lyrics saved for this track");
    }
  };

  return (
    <div className={cn("relative", className)}>
      {/* The button is the whole hit area and draws nothing itself; the
          span inside it is what you see. Padding is target, not
          decoration — the same trick the seek slider uses. */}
      <button
        type="button"
        aria-label={
          confirmed ? "Lyrics confirmed — tap to undo" : "Confirm these lyrics are correct"
        }
        aria-pressed={confirmed}
        disabled={!enabled}
        onClick={onPress}
        className={cn(
          "group flex size-full items-center justify-center",
          !enabled && "pointer-events-none opacity-25",
        )}
      >
        <span
          className={cn(
            "flex items-center justify-center rounded-md border-2 transition-colors",
            confirmed
              ? "border-emerald-500 bg-emerald-500 text-black"
              : "border-emerald-500/60 text-emerald-500 group-hover:bg-emerald-500/20",
            boxClassName,
          )}
        >
          <CheckIcon className={iconClassName} />
        </span>
      </button>
      {/* Above the button and out of the way of a thumb that is still on
          it. `pointer-events-none` so it can never eat the next tap. */}
      {hint ? (
        <span
          role="status"
          className="pointer-events-none absolute bottom-[calc(100%+0.5rem)] left-0 whitespace-nowrap rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-black shadow-lg"
        >
          {hint}
        </span>
      ) : null}
    </div>
  );
}

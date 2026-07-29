import { CheckIcon } from "lucide-react";
import { useLyricsStore } from "@/store/lyricsStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { cn } from "@/lib/utils";

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
export function ConfirmLyricsButton({ className }: { className?: string }) {
  const lyrics = useLyricsStore((s) => s.lyrics);
  const confirmed = useLyricsStore((s) => s.confirmed);
  const confirm = useLyricsStore((s) => s.confirm);
  const unconfirm = useLyricsStore((s) => s.unconfirm);
  const hasTrack = usePlaybackStore((s) => s.index >= 0);

  // Nothing to confirm without a lyric on screen. Rendered as an inert
  // placeholder rather than removed, so the controls beside it don't shift
  // sideways when a track's lyrics arrive a second after it starts.
  const enabled = hasTrack && !!lyrics;

  return (
    <button
      type="button"
      aria-label={confirmed ? "Lyrics confirmed — tap to undo" : "Confirm these lyrics are correct"}
      aria-pressed={confirmed}
      title={
        confirmed
          ? "Saved to the lyrics cache. Tap to remove."
          : "Save these lyrics for this track"
      }
      disabled={!enabled}
      onClick={() => (confirmed ? unconfirm() : confirm())}
      className={cn(
        "flex items-center justify-center rounded-md border-2 transition-colors",
        confirmed
          ? "border-emerald-500 bg-emerald-500 text-black"
          : "border-emerald-500/60 text-emerald-500 hover:bg-emerald-500/20",
        !enabled && "pointer-events-none opacity-25",
        className,
      )}
    >
      <CheckIcon className="size-5" />
    </button>
  );
}

import { HeartIcon } from "lucide-react";
import { useLikedSongsStore, type LikeTarget } from "@/store/likedSongsStore";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/lib/utils";

/**
 * The heart. One component for both places it appears — the player bar and
 * the karaoke stage — so the two can never disagree about whether a track
 * is liked, which is what happened while each read the store its own way.
 *
 * Everything it does is a store call: `likedSongsStore` owns the optimistic
 * update and the write-through to the account. This only renders.
 *
 * Disabled when signed out rather than quietly local: an anonymous
 * `like/like` returns HTTP 200 and persists nowhere, so a button that
 * still moved would be lying.
 */
export function LikeButton({
  track,
  className,
}: {
  /** The whole track, not just its id: liking has to insert a renderable
   *  row into the Liked Music lists, which needs the title and artwork. */
  track?: LikeTarget;
  className?: string;
}) {
  const videoId = track?.videoId;
  const liked = useLikedSongsStore((s) => (videoId ? s.ids.has(videoId) : false));
  const busy = useLikedSongsStore((s) => (videoId ? s.pending.has(videoId) : false));
  const toggle = useLikedSongsStore((s) => s.toggle);
  const signedIn = useAuthStore((s) => s.status === "signed-in");

  const disabled = !track || !signedIn || busy;

  return (
    <button
      type="button"
      aria-label={liked ? "Remove from liked" : "Add to liked"}
      aria-pressed={liked}
      disabled={disabled}
      title={signedIn ? undefined : "Sign in to like songs"}
      onClick={() => track && toggle(track)}
      className={cn(className, liked && "text-brand")}
    >
      <HeartIcon className={liked ? "fill-current" : undefined} />
    </button>
  );
}

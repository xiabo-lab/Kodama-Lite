import { HeartIcon } from "lucide-react";
import { useLikedSongsStore } from "@/store/likedSongsStore";
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
  videoId,
  className,
}: {
  videoId?: string;
  className?: string;
}) {
  const liked = useLikedSongsStore((s) => (videoId ? s.ids.has(videoId) : false));
  const busy = useLikedSongsStore((s) => (videoId ? s.pending.has(videoId) : false));
  const toggle = useLikedSongsStore((s) => s.toggle);
  const signedIn = useAuthStore((s) => s.status === "signed-in");

  const disabled = !videoId || !signedIn || busy;

  return (
    <button
      type="button"
      aria-label={liked ? "Remove from liked" : "Add to liked"}
      aria-pressed={liked}
      disabled={disabled}
      title={signedIn ? undefined : "Sign in to like songs"}
      onClick={() => videoId && toggle(videoId)}
      className={cn(className, liked && "text-brand")}
    >
      <HeartIcon className={liked ? "fill-current" : undefined} />
    </button>
  );
}

import { innertubePost } from "./shared";

/**
 * Mutating InnerTube actions. Ported from YTMLite's
 * `src/lib/innertube/mutations.ts`, trimmed to the ratings the app
 * actually offers (there is no dislike control on a car panel, and no
 * playlist editor).
 *
 * All of these need the authenticated cookie jar that `subsystems/auth.rs`
 * pushes into `shared.ts`. Anonymous calls are the trap here: YouTube
 * answers them HTTP 200 and they persist nowhere, which is exactly how a
 * like button ends up looking like it works while doing nothing. Callers
 * must check `hasSession()` first — `likedSongsStore` does.
 */

async function rate(
  endpoint: "like/like" | "like/removelike",
  videoId: string,
): Promise<void> {
  // `innertubePost` embeds the YouTube error body in the thrown message,
  // so a failure here says whether it was auth, throttling or a bad body
  // rather than just "request failed".
  await innertubePost(endpoint, { target: { videoId } });
}

/** Add a track to the account's Liked Music playlist. */
export function likeTrack(videoId: string): Promise<void> {
  return rate("like/like", videoId);
}

/** Clear the account's rating on a track — the undo half of `likeTrack`. */
export function removeRating(videoId: string): Promise<void> {
  return rate("like/removelike", videoId);
}

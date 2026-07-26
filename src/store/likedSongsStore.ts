import { create } from "zustand";
import { fetchLikedSongIds } from "@/lib/innertube/library";
import { likeTrack, removeRating } from "@/lib/innertube/mutations";
import { hasSession } from "@/lib/innertube/shared";

/**
 * Liked songs, synced with the signed-in YouTube Music account.
 *
 * This used to be a localStorage-only toggle, written when there was no
 * accounts subsystem: the heart moved, nothing reached the account, and a
 * song liked on a phone showed as un-liked here. Accounts landed
 * (`subsystems/auth.rs` → `setSession()`), so the account is now the
 * source of truth in both directions — `sync()` seeds the set from Liked
 * Music, and `toggle()` writes through with `like/like` / `like/removelike`.
 *
 * Nothing here is persisted. The previous localStorage copy was actively
 * harmful once the server became authoritative: it would paint hearts from
 * a different account, or from likes since undone elsewhere, before the
 * first sync could correct them. An empty set for the second or so a sync
 * takes is the honest state.
 *
 * Signed out, `toggle()` is a no-op — anonymous `like/like` calls answer
 * HTTP 200 and persist nowhere, which is precisely the silent failure this
 * store exists to avoid. The UI disables the control rather than relying
 * on that (`canLike` below).
 */

export type LikedStatus = "idle" | "loading" | "ready" | "error";

interface LikedSongsState {
  ids: Set<string>;
  status: LikedStatus;
  /** videoIds with a like/unlike request in flight — the button disables
   *  itself against these so a double-tap can't race two mutations. */
  pending: Set<string>;
  isLiked: (videoId: string) => boolean;
  /** True when a like would actually reach the account. */
  canLike: () => boolean;
  /** Fetch the account's liked set. Safe to call repeatedly. */
  sync: () => void;
  toggle: (videoId: string) => void;
  /** Sign-out: drop everything, the next account must not inherit it. */
  reset: () => void;
}

/** Guards a slow sync from an earlier session landing after a sign-out and
 *  repainting the previous account's hearts — same pattern as
 *  `authStore`'s `sessionEpoch`. */
let syncEpoch = 0;

export const useLikedSongsStore = create<LikedSongsState>((set, get) => ({
  ids: new Set(),
  status: "idle",
  pending: new Set(),

  isLiked: (videoId) => get().ids.has(videoId),

  canLike: () => hasSession(),

  sync: () => {
    if (!hasSession()) return;
    if (get().status === "loading") return;
    const epoch = ++syncEpoch;
    set({ status: "loading" });
    void fetchLikedSongIds()
      .then((ids) => {
        if (epoch !== syncEpoch) return;
        set({ ids, status: "ready" });
      })
      .catch(() => {
        if (epoch !== syncEpoch) return;
        // Keep whatever is already known — a failed refresh should not
        // blank hearts that were correct a moment ago.
        set({ status: "error" });
      });
  },

  toggle: (videoId) => {
    if (!videoId || !hasSession()) return;
    const { ids, pending } = get();
    if (pending.has(videoId)) return;

    const wasLiked = ids.has(videoId);

    // Optimistic: the heart fills on the tap, not on the round trip. On a
    // car panel over a phone hotspot that round trip is easily a second.
    const nextIds = new Set(ids);
    if (wasLiked) nextIds.delete(videoId);
    else nextIds.add(videoId);
    const nextPending = new Set(pending);
    nextPending.add(videoId);
    set({ ids: nextIds, pending: nextPending });

    const epoch = syncEpoch;
    const settle = (revert: boolean) => {
      const s = get();
      const p = new Set(s.pending);
      p.delete(videoId);
      // A sign-out (or a fresh sync) during the request wins — don't
      // resurrect an id into a set that no longer belongs to this session.
      if (revert && epoch === syncEpoch) {
        const back = new Set(s.ids);
        if (wasLiked) back.add(videoId);
        else back.delete(videoId);
        set({ ids: back, pending: p });
      } else {
        set({ pending: p });
      }
    };

    void (wasLiked ? removeRating(videoId) : likeTrack(videoId))
      .then(() => settle(false))
      .catch((e) => {
        console.error("[liked] rating failed for", videoId, e);
        settle(true);
      });
  },

  reset: () => {
    syncEpoch++;
    set({ ids: new Set(), status: "idle", pending: new Set() });
  },
}));

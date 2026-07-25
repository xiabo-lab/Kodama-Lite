import { LogInIcon } from "lucide-react";
import { useAuthStore } from "@/store/authStore";

/**
 * Still a stub, but now an accurate one. Sign-in itself works (see
 * `store/authStore.ts` / `src-tauri/src/subsystems/auth.rs`), so
 * `authHeaders()` sends a real session and the authenticated InnerTube
 * endpoints would answer — what hasn't been ported yet are the *fetchers
 * and parsers* for the library browse IDs (`FEmusic_liked_playlists`,
 * `FEmusic_liked_videos`, …) that turn those responses into shelves.
 *
 * The two states below are the honest ones: signed out, the fix is to sign
 * in; signed in, the fix is more code, and saying so beats an empty shelf
 * that reads like a failed load.
 */
export function Library() {
  const status = useAuthStore((s) => s.status);
  const signIn = useAuthStore((s) => s.signIn);
  const signedIn = status === "signed-in";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-12 text-center text-muted-foreground">
      <LogInIcon className="size-12" />
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-foreground">
          {signedIn ? "Library isn't ported yet" : "Sign in to see your library"}
        </h2>
        <p className="max-w-sm text-sm">
          {signedIn
            ? "You're signed in, but the parsers for liked songs and your own playlists haven't been ported to Kodama-Lite yet. Search, Explore, and public playlists/albums/artists all work."
            : "Your library, liked songs, and playlists need a signed-in YouTube Music session. Explore, Search, and public playlists/albums/artists all work without signing in."}
        </p>
      </div>
      {!signedIn && (
        <button
          onClick={signIn}
          disabled={status === "pending"}
          className="flex items-center gap-2 rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-60"
        >
          <LogInIcon className="size-4" />
          {status === "pending" ? "Signing in…" : "Sign in"}
        </button>
      )}
    </div>
  );
}

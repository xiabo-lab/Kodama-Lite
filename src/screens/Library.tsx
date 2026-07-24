import { LogInIcon } from "lucide-react";

/**
 * Honest stub. YTMLite's Library (liked songs, your playlists, pinned
 * sidebar entries) is entirely accounts-gated — it reads the signed-in
 * user's own YouTube Music cookie jar. Kodama-Lite has no accounts/
 * sign-in subsystem yet (deferred past tonight's deadline; see
 * README.md), so there's nothing real to show here. This screen exists
 * so the nav item goes somewhere truthful instead of a dead link.
 */
export function Library() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-12 text-center text-muted-foreground">
      <LogInIcon className="size-12" />
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-foreground">Sign-in isn't wired up yet</h2>
        <p className="max-w-sm text-sm">
          Your library, liked songs, and playlists need a signed-in YouTube
          Music session — that subsystem hasn't been ported to Kodama-Lite
          yet. Explore, Search, and public playlists/albums/artists all work
          without signing in.
        </p>
      </div>
    </div>
  );
}

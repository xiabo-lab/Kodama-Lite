import { useEffect, useState } from "react";
import { AlertCircleIcon, Loader2Icon, LogInIcon } from "lucide-react";
import { dispatchContent, type LibraryTab } from "@/lib/network";
import { LIBRARY_TABS, useLibraryStore } from "@/store/libraryStore";
import { useAuthStore } from "@/store/authStore";
import { useAppStore } from "@/store/appStore";
import { ShelfCard } from "@/components/shared/shelf-card";
import { TrackList } from "@/components/shared/track-list";
import { cn } from "@/lib/utils";

/**
 * Library, ported from YTMLite's `routes/library.tsx`: four tabs over the
 * authenticated browse IDs (`FEmusic_liked_playlists`,
 * `FEmusic_liked_albums`, `FEmusic_library_corpus_artists`) plus Liked
 * Songs (`LM`).
 *
 * Same cache-first, never-blocking contract as every other screen: the
 * tab paints from whatever the store already holds, `library:load` goes
 * out fire-and-forget, and a failure shows a retry card instead of a
 * frozen spinner. Signed out it doesn't fetch at all — see the guard in
 * `network.ts` for why a signed-out library request is worse than useless.
 *
 * Differences from YTMLite, both deliberate: Liked Songs loads its first
 * page only (no infinite-scroll sentinel — the Pi's panel is not where
 * anyone pages through 5,000 tracks by hand), and the shelf tabs flatten
 * their sections into one grid, which is what YTMLite does too because
 * library shelves come back with auto-generated "Section N" titles.
 */
export function Library() {
  const [tab, setTab] = useState<LibraryTab>("playlists");
  const status = useAuthStore((s) => s.status);
  const signIn = useAuthStore((s) => s.signIn);
  const signedIn = status === "signed-in";

  const state = useLibraryStore((s) => s.tabs[tab]);

  useEffect(() => {
    if (!signedIn) return;
    if (state.status === "idle") dispatchContent({ type: "library:load", tab });
  }, [tab, state.status, signedIn]);

  if (!signedIn) return <SignedOut pending={status === "pending"} onSignIn={signIn} />;

  return (
    <div className="flex flex-col gap-6 px-6 pb-6 pt-3">
      <h1 className="text-3xl font-bold tracking-tight">Library</h1>

      <div className="flex gap-1.5">
        {LIBRARY_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "min-h-11 rounded-full border px-4 text-sm font-medium transition-colors",
              tab === t.id
                ? "border-transparent bg-foreground text-background"
                : "border-input bg-transparent text-foreground hover:bg-accent",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <TabBody tab={tab} />
    </div>
  );
}

function TabBody({ tab }: { tab: LibraryTab }) {
  const state = useLibraryStore((s) => s.tabs[tab]);
  const items = state.sections.flatMap((s) => s.items);

  if (state.status === "loading") {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2Icon className="size-6 animate-spin" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
        <div className="flex flex-col gap-1">
          <span className="font-medium">Couldn't load your library</span>
          <span className="text-muted-foreground">{state.error}</span>
          <button
            type="button"
            onClick={() => dispatchContent({ type: "library:load", tab })}
            className="mt-1 w-fit text-brand hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (tab === "songs") {
    if (state.tracks.length === 0) {
      return <Empty label="No liked songs yet." />;
    }
    return <TrackList tracks={state.tracks} />;
  }

  if (items.length === 0) return <Empty label="Nothing here yet." />;

  return (
    <div className="grid w-full gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] [&>*]:max-w-[20rem]">
      {items.map((item) => (
        <ShelfCard key={`${item.kind}:${item.id}`} item={item} />
      ))}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="text-sm text-muted-foreground">{label}</p>;
}

function SignedOut({
  pending,
  onSignIn,
}: {
  pending: boolean;
  onSignIn: () => void;
}) {
  const navigate = useAppStore((s) => s.navigate);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-12 text-center text-muted-foreground">
      <LogInIcon className="size-12" />
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-foreground">
          Sign in to see your library
        </h2>
        <p className="max-w-sm text-sm">
          Your playlists, liked songs, saved albums and followed artists all
          need a signed-in YouTube Music session. Search, Explore and public
          playlists work without one.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onSignIn}
          disabled={pending}
          className="flex min-h-11 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-60"
        >
          <LogInIcon className="size-4" />
          {pending ? "Signing in…" : "Sign in"}
        </button>
        <button
          onClick={() => navigate({ kind: "settings" })}
          className="min-h-11 rounded-md border border-input px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          Settings
        </button>
      </div>
    </div>
  );
}

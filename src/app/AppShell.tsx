import { useEffect } from "react";
import { Sidebar } from "@/app/Sidebar";
import { TopBar } from "@/app/TopBar";
import { PlayerBar } from "@/app/PlayerBar";
import { AudioEngine } from "@/app/AudioEngine";
import { KaraokeView } from "@/components/layout/karaoke-view";
import { Home } from "@/screens/Home";
import { Explore } from "@/screens/Explore";
import { Search } from "@/screens/Search";
import { Library } from "@/screens/Library";
import { Playlist } from "@/screens/Playlist";
import { Album } from "@/screens/Album";
import { Artist } from "@/screens/Artist";
import { useAppStore, type Route } from "@/store/appStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { useKaraokeStore } from "@/store/karaokeStore";

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}

/**
 * The app frame — same anatomy as YTMLite: a full-window title bar with the
 * centered nav cluster, a left sidebar, a scrolling content column, and the
 * bottom player bar. The content column swaps screens by the Store's route
 * (a Store-driven router keeps navigation an event, not a side effect).
 *
 * `<AudioEngine>` renders nothing — it exists only to host the playback
 * store's high-frequency position updates (see its own docs) so that
 * subscription's ~60Hz churn never has to reconcile this larger tree.
 */
export function AppShell() {
  const route = useAppStore((s) => s.route);

  // `L` opens the full-screen karaoke lyrics view — same shortcut as
  // YTMLite. Ignored while typing (e.g. the Search box) so the letter
  // still types normally there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "l" && e.key !== "L") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (usePlaybackStore.getState().index < 0) return;
      useKaraokeStore.getState().setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <AudioEngine />
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="app-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Screen route={route} />
        </main>
      </div>
      <PlayerBar />
      <KaraokeView />
    </div>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.kind) {
    case "home":
      return <Home />;
    case "explore":
      return <Explore />;
    case "search":
      return <Search />;
    case "library":
      return <Library />;
    case "playlist":
      return <Playlist id={route.id} />;
    case "album":
      return <Album id={route.id} />;
    case "artist":
      return <Artist id={route.id} />;
  }
}

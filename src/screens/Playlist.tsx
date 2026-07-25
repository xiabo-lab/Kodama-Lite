import { useEffect } from "react";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { dispatchContent } from "@/lib/network";
import { usePlaylistStore } from "@/store/playlistStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { shelfItemToTrack } from "@/lib/track";
import { EntityHeader } from "@/components/shared/entity-header";
import { TrackList } from "@/components/shared/track-list";

/**
 * Simplified from YTMLite's playlist route: no search-in-playlist, no
 * sort menu, no pin-to-sidebar (accounts-gated), no auto-draining
 * infinite scroll — a plain "Load more" button instead. The core loop
 * (open a playlist, see its tracks, play/shuffle, page through more) is
 * intact.
 */
export function Playlist({ id }: { id: string }) {
  const entry = usePlaylistStore((s) => s.byId[id]);

  useEffect(() => {
    if (!entry) dispatchContent({ type: "playlist:load", id });
  }, [id, entry]);

  if (!entry || entry.status === "loading") {
    return (
      <div className="flex items-center justify-center px-6 py-24 text-muted-foreground">
        <Loader2Icon className="size-6 animate-spin" />
      </div>
    );
  }

  if (entry.status === "error" || !entry.page) {
    return (
      <div className="mx-6 mt-3 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
        <div className="flex flex-col gap-1">
          <span className="font-medium">Couldn't load playlist</span>
          <span className="text-muted-foreground">{entry.error}</span>
          <button
            type="button"
            onClick={() => dispatchContent({ type: "playlist:load", id })}
            className="mt-1 w-fit text-brand hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const header = entry.page;
  const tracks = entry.tracks;
  const metadataParts = [header.owner, header.trackCount ? `${header.trackCount} songs` : undefined].filter(Boolean).join(" • ");

  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <EntityHeader
        title={header.title}
        metadata={metadataParts}
        description={header.description}
        thumbnails={header.thumbnails}
        kind="playlist"
        id={id}
        onPlay={() => {
          if (tracks.length === 0) return;
          usePlaybackStore.getState().playQueue(tracks.map(shelfItemToTrack), 0);
          usePlaybackStore.getState().setShuffle(false);
        }}
        onShuffle={() => {
          if (tracks.length === 0) return;
          const start = Math.floor(Math.random() * tracks.length);
          usePlaybackStore.getState().playQueue(tracks.map(shelfItemToTrack), start);
          usePlaybackStore.getState().setShuffle(true);
        }}
      />

      <TrackList tracks={tracks} />

      {entry.nextCursor && (
        <button
          type="button"
          onClick={() => dispatchContent({ type: "playlist:more", id, token: entry.nextCursor! })}
          className="mx-auto w-fit rounded-full border border-input px-4 py-2 text-sm font-medium hover:bg-white/10"
        >
          Load more
        </button>
      )}
    </div>
  );
}

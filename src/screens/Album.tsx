import { useEffect } from "react";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { dispatchContent } from "@/lib/network";
import { useAlbumStore } from "@/store/albumStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { shelfItemToTrack } from "@/lib/track";
import { EntityHeader } from "@/components/shared/entity-header";
import { TrackList } from "@/components/shared/track-list";

export function Album({ id }: { id: string }) {
  const entry = useAlbumStore((s) => s.byId[id]);

  useEffect(() => {
    if (!entry) dispatchContent({ type: "album:load", id });
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
          <span className="font-medium">Couldn't load album</span>
          <span className="text-muted-foreground">{entry.error}</span>
          <button
            type="button"
            onClick={() => dispatchContent({ type: "album:load", id })}
            className="mt-1 w-fit text-brand hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const data = entry.page;
  // Album rows don't carry a per-track thumbnail (the cover is shared at
  // the album level) — backfill it so the player bar shows real art.
  const tracksWithCover = data.tracks.map((t) => (t.thumbnails.length > 0 ? t : { ...t, thumbnails: data.thumbnails }));
  const metadataParts = [data.year, data.trackCount ? `${data.trackCount} songs` : undefined, data.duration].filter(Boolean).join(" • ");

  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <EntityHeader
        title={data.title}
        subtitle={data.artists.map((a) => a.name).join(", ")}
        metadata={metadataParts}
        thumbnails={data.thumbnails}
        kind="album"
        onPlay={() => {
          if (tracksWithCover.length === 0) return;
          usePlaybackStore.getState().playQueue(tracksWithCover.map(shelfItemToTrack), 0);
          usePlaybackStore.getState().setShuffle(false);
        }}
        onShuffle={() => {
          if (tracksWithCover.length === 0) return;
          const start = Math.floor(Math.random() * tracksWithCover.length);
          usePlaybackStore.getState().playQueue(tracksWithCover.map(shelfItemToTrack), start);
          usePlaybackStore.getState().setShuffle(true);
        }}
      />
      <TrackList tracks={tracksWithCover} hideThumbnails />
    </div>
  );
}

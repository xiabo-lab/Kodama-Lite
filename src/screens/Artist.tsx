import { useEffect } from "react";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { dispatchContent } from "@/lib/network";
import { useArtistStore } from "@/store/artistStore";
import { EntityHeader } from "@/components/shared/entity-header";
import { ShelfCarousel } from "@/components/shared/shelf-carousel";
import { TrackList } from "@/components/shared/track-list";
import type { Shelf } from "@/lib/innertube/types";

export function Artist({ id }: { id: string }) {
  const entry = useArtistStore((s) => s.byId[id]);

  useEffect(() => {
    if (!entry) dispatchContent({ type: "artist:load", id });
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
          <span className="font-medium">Couldn't load artist</span>
          <span className="text-muted-foreground">{entry.error}</span>
          <button
            type="button"
            onClick={() => dispatchContent({ type: "artist:load", id })}
            className="mt-1 w-fit text-brand hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const data = entry.page;

  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <EntityHeader title={data.name} subtitle={data.subscribers} description={data.description} thumbnails={data.thumbnails} round />

      {data.shelves.map((shelf) => (shelf.display === "list" ? <ListShelf key={shelf.id} shelf={shelf} /> : <ShelfCarousel key={shelf.id} shelf={shelf} />))}
    </div>
  );
}

function ListShelf({ shelf }: { shelf: Shelf }) {
  const tracks = shelf.items.filter((i) => i.kind === "song");
  if (tracks.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="truncate px-1 text-xl font-semibold tracking-tight">{shelf.title}</h2>
      <TrackList tracks={tracks} showPlays />
    </section>
  );
}

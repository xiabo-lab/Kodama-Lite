import type { ShelfItem } from "@/lib/innertube/types";
import type { Track } from "@/store/playbackStore";
import { pickThumbnail } from "@/components/shared/thumbnail";

/** Adapts an InnerTube `ShelfItem` (song/video) into the `Track` shape
 *  `playbackStore` deals in. Only ever called on `kind === "song" | "video"`
 *  items (or a synthesized one — see `playableVideoId` in `shelf-card.tsx`). */
export function shelfItemToTrack(item: ShelfItem): Track {
  const subtitle = item.subtitle ?? item.artists?.map((a) => a.name).join(", ") ?? item.album;
  return {
    videoId: item.id,
    title: item.title,
    subtitle,
    thumbnail: pickThumbnail(item.thumbnails, 128) ?? undefined,
    duration: item.duration,
  };
}

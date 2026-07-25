import {
  DiscIcon,
  ListMusicIcon,
  MusicIcon,
  ThumbsUpIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ShelfItem, Thumbnail as YtThumbnail } from "@/lib/innertube/types";

/**
 * Simplified from YTMLite's `Thumbnail` — no disk-cache hi-res upgrade
 * (that lived behind a Rust cover-cache subsystem this phase doesn't have
 * time to port). Just picks the best-fit API-shipped variant and renders a
 * plain lazy `<img>`; still cache-first in the sense that it never blocks
 * paint on anything beyond the image's own load.
 */
export function pickThumbnail(thumbnails: YtThumbnail[], targetSize = 256): string | null {
  if (!thumbnails.length) return null;
  const sorted = [...thumbnails].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const match = sorted.find((t) => (t.width ?? 0) >= targetSize);
  return (match ?? sorted[sorted.length - 1]).url;
}

/**
 * YouTube Music's auto-generated playlists ship **no artwork at all** —
 * the real client draws its own glyph on a flat tile instead, which is why
 * "Liked Music" appears as a thumbs-up there and as an empty grey square
 * here. Match them by id and do the same.
 *
 * Ids rather than titles: these are stable across locales, whereas the
 * displayed titles are translated. `LM` is Liked Music (`VL`-prefixed when
 * it arrives as a browseId rather than a playlistId); `SE` is the Shorts
 * sounds shelf ("Sounds from Shorts").
 */
const AUTO_PLAYLIST_ICONS: Record<string, LucideIcon> = {
  LM: ThumbsUpIcon,
  VLLM: ThumbsUpIcon,
  SE: MusicIcon,
  VLSE: MusicIcon,
};

/** Last-resort glyph by entity kind, so nothing ever renders as a blank
 *  tile even when the id isn't one we recognise. */
function iconFor(kind?: ShelfItem["kind"], id?: string): LucideIcon {
  if (id && AUTO_PLAYLIST_ICONS[id]) return AUTO_PLAYLIST_ICONS[id];
  switch (kind) {
    case "artist":
      return UserRoundIcon;
    case "album":
      return DiscIcon;
    case "playlist":
      return ListMusicIcon;
    default:
      return MusicIcon;
  }
}

type Props = {
  thumbnails: YtThumbnail[];
  alt: string;
  round?: boolean;
  className?: string;
  targetSize?: number;
  /** Entity kind + id, used to pick the fallback glyph when the API
   *  shipped no artwork. Optional so existing callers keep working. */
  kind?: ShelfItem["kind"];
  id?: string;
};

export function Thumbnail({
  thumbnails,
  alt,
  round = false,
  className,
  targetSize = 256,
  kind,
  id,
}: Props) {
  const src = pickThumbnail(thumbnails, targetSize);
  const Icon = iconFor(kind, id);

  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden bg-muted",
        round ? "rounded-full" : "rounded-md",
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
        />
      ) : (
        <Icon className="size-2/5 text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  );
}

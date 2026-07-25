import { useState } from "react";
import {
  BookmarkIcon,
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
 * the real client draws its own tile instead: a white glyph centred on a
 * saturated colour field. That's why "Liked Music" is a blue thumbs-up
 * there and was an empty grey square here.
 *
 * Matched by id first, because ids are stable across locales while the
 * displayed titles are translated. Titles are a documented fallback: the
 * ids for the Shorts and podcast shelves aren't as well-known as `LM`, and
 * a locale-fragile match that works in English beats a blank tile.
 */
type AutoArt = { icon: LucideIcon; className: string };

/** Blue, as YouTube Music uses for Liked Music. */
const LIKED_ART: AutoArt = {
  icon: ThumbsUpIcon,
  className: "bg-gradient-to-br from-[#3b6fe0] to-[#1b3fa8]",
};
const SHORTS_ART: AutoArt = {
  icon: MusicIcon,
  className: "bg-gradient-to-br from-[#e04a5f] to-[#a11430]",
};
const EPISODES_ART: AutoArt = {
  icon: BookmarkIcon,
  className: "bg-gradient-to-br from-[#5b52d8] to-[#2e2793]",
};

const AUTO_ART_BY_ID: Record<string, AutoArt> = {
  LM: LIKED_ART,
  VLLM: LIKED_ART,
  SE: EPISODES_ART,
  VLSE: EPISODES_ART,
};

function autoArtFor(id?: string, title?: string): AutoArt | null {
  if (id && AUTO_ART_BY_ID[id]) return AUTO_ART_BY_ID[id];
  const t = title?.toLowerCase() ?? "";
  if (!t) return null;
  if (t.includes("liked music") || t.includes("liked songs")) return LIKED_ART;
  if (t.includes("sounds from shorts")) return SHORTS_ART;
  if (t.includes("episodes for later")) return EPISODES_ART;
  return null;
}

/** Last-resort glyph by entity kind, so nothing ever renders as a blank
 *  tile even when neither the id nor the title is one we recognise. */
function iconFor(kind?: ShelfItem["kind"]): LucideIcon {
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
  /** Title, used only to recognise an auto-playlist when its id isn't a
   *  known one. Defaults to `alt`, which is the title at every call site. */
  title?: string;
};

export function Thumbnail({
  thumbnails,
  alt,
  round = false,
  className,
  targetSize = 256,
  kind,
  id,
  title,
}: Props) {
  const picked = pickThumbnail(thumbnails, targetSize);

  // Fall back when the image FAILS TO LOAD, not merely when the API
  // shipped no URL. That distinction was the bug: YouTube Music does ship
  // artwork URLs for its auto-playlists (from www.gstatic.com), so `src`
  // was non-null, the `<img>` rendered, the request was refused, and the
  // tile stayed empty — the icon fallback never got a chance. Seeded test
  // data with an empty array hid it completely.
  //
  // Keyed by URL so a new track's image gets a fresh attempt rather than
  // inheriting the previous one's failure.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = picked && picked !== failedSrc ? picked : null;

  const auto = src ? null : autoArtFor(id, title ?? alt);
  const Icon = auto?.icon ?? iconFor(kind);

  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden",
        // A real auto-playlist tile is a full-bleed colour field with a
        // white glyph, like the YouTube Music app — not a grey box with a
        // small muted icon, which reads as "image failed to load".
        auto ? auto.className : "bg-muted",
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
          onError={() => setFailedSrc(picked)}
          className="size-full object-cover"
        />
      ) : (
        <Icon
          className={cn(
            auto ? "size-1/2 text-white" : "size-2/5 text-muted-foreground",
          )}
          // The glyph IS the artwork here, so give it the alt text rather
          // than hiding it — a screen reader otherwise reaches a tile with
          // no accessible content at all.
          aria-label={auto ? alt : undefined}
          aria-hidden={auto ? undefined : true}
          strokeWidth={auto ? 2.25 : 2}
        />
      )}
    </div>
  );
}

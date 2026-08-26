import { useState } from "react";
import { useAppStore } from "@/store/appStore";
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
 * Picks the best-fit API-shipped variant. The URL this returns is the
 * *upstream* one; `Thumbnail` rewrites it through the local disk cache
 * before it reaches an `<img>` — see `coverSrc` below.
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

/**
 * Rewrite an upstream artwork URL through the local cover cache.
 *
 * This is what makes a cold boot look right. The Pi's network takes about
 * forty seconds to arrive, `homeStore` restores the last feed from
 * localStorage and paints it on the first frame, and pointing those
 * `<img>`s straight at `i.ytimg.com` meant every tile failed and fell back
 * to a grey glyph for the first minute of every drive. The local server
 * answers the same request from disk, with no network involved at all —
 * see `subsystems/covers.rs`.
 *
 * `base` is undefined until `cover:base` answers, which is a few
 * milliseconds into the launch. Falling back to the upstream URL for that
 * window means a data plane that never answers costs the *cache*, never
 * the artwork.
 */
export function coverSrc(url: string, base: string | undefined): string {
  if (!base) return url;
  return `${base}?u=${encodeURIComponent(url)}`;
}

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
  const coverBase = useAppStore((s) => s.coverBase);
  const netEpoch = useAppStore((s) => s.netEpoch);
  const picked = pickThumbnail(thumbnails, targetSize);
  const resolved = picked ? coverSrc(picked, coverBase) : null;

  // Fall back when the image FAILS TO LOAD, not merely when the API
  // shipped no URL. That distinction was the bug: YouTube Music does ship
  // artwork URLs for its auto-playlists (from www.gstatic.com), so `src`
  // was non-null, the `<img>` rendered, the request was refused, and the
  // tile stayed empty — the icon fallback never got a chance. Seeded test
  // data with an empty array hid it completely.
  //
  // Remembered against the RESOLVED url and the connectivity epoch, not
  // the upstream url alone. Two things depend on that pair:
  //
  //   * `cover:base` arriving changes the resolved url, so the one attempt
  //     made before the cache was known does not condemn the tile.
  //   * The epoch expires a failure when the network returns. Without it a
  //     tile that failed during the boot window stayed grey for the whole
  //     session — the carousel keys items by `kind:id`, so the component
  //     instance and its memory survive every feed refresh.
  const [failed, setFailed] = useState<{ src: string; epoch: number } | null>(null);
  const stillFailed = failed?.src === resolved && failed.epoch === netEpoch;
  const src = resolved && !stillFailed ? resolved : null;

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
          onError={() => setFailed({ src, epoch: netEpoch })}
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

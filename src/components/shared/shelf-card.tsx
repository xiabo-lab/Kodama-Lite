import {
  ChevronRightIcon,
  ZapIcon,
  DumbbellIcon,
  CarIcon,
  HeartIcon,
  CloudRainIcon,
  SmileIcon,
  MoonIcon,
  TargetIcon,
  PartyPopperIcon,
  CoffeeIcon,
  UsersIcon,
  MusicIcon,
  Music2Icon,
  Music3Icon,
  Music4Icon,
  MicIcon,
  GuitarIcon,
  PianoIcon,
  SkullIcon,
  FilmIcon,
  BabyIcon,
  ChurchIcon,
  SnowflakeIcon,
  GlobeIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Thumbnail } from "@/components/shared/thumbnail";
import { useAppStore } from "@/store/appStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { shelfItemToTrack } from "@/lib/track";
import type { ShelfItem } from "@/lib/innertube/types";

type Props = {
  item: ShelfItem;
  className?: string;
};

/**
 * Ported from YTMLite's `ShelfCard`, trimmed for Phase 3's time budget:
 * no pin/hide (no pinned-playlists subsystem here) and no right-click
 * context menu. Routing and the moods/genres icon heuristic are kept
 * verbatim — cheap, pure, and needed for feature parity.
 */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  energize: ZapIcon,
  workout: DumbbellIcon,
  commute: CarIcon,
  romance: HeartIcon,
  sad: CloudRainIcon,
  "feel good": SmileIcon,
  sleep: MoonIcon,
  focus: TargetIcon,
  party: PartyPopperIcon,
  chill: CoffeeIcon,
  family: UsersIcon,
  pop: MusicIcon,
  "hip-hop": MicIcon,
  country: GuitarIcon,
  "r&b": MicIcon,
  rock: GuitarIcon,
  soul: Music3Icon,
  latin: GuitarIcon,
  "indie & alternative": Music3Icon,
  classical: PianoIcon,
  "dance & electronic": Music4Icon,
  blues: Music3Icon,
  jazz: Music3Icon,
  metal: SkullIcon,
  reggae: Music4Icon,
  "folk & acoustic": GuitarIcon,
  "soundtracks & musicals": FilmIcon,
  "children's music": BabyIcon,
  "christian & gospel": ChurchIcon,
  holiday: SnowflakeIcon,
};

const GEO_KEYWORDS = [
  "iraqi", "russian", "turkish", "arabic", "indian", "spanish", "french",
  "german", "japanese", "korean", "k-pop", "chinese", "pakistani", "afghan",
  "egyptian", "lebanese", "tamil", "punjabi", "hindi", "thai", "vietnamese",
  "world",
];

function pickCategoryIcon(title: string): LucideIcon {
  const key = title.toLowerCase();
  if (CATEGORY_ICONS[key]) return CATEGORY_ICONS[key];
  if (GEO_KEYWORDS.some((g) => key.includes(g))) return GlobeIcon;
  return Music2Icon;
}

const CARD_CLASS =
  "group flex w-full flex-col gap-2 rounded-lg p-2 text-left transition-colors short:gap-1 short:p-1.5 hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none";

export function ShelfCard({ item, className }: Props) {
  const subtitle = item.subtitle ?? item.artists?.map((a) => a.name).join(", ") ?? item.album ?? "";

  const isVideo = item.kind === "video";
  const isAlbumOrPlaylist = item.kind === "album" || item.kind === "playlist";
  const radiusClass = item.round ? "rounded-full" : isAlbumOrPlaylist ? "rounded-lg" : "rounded-md";

  const body = (
    <>
      <div className={cn("relative w-full", isVideo ? "aspect-video" : "aspect-square")}>
        <Thumbnail
          thumbnails={item.thumbnails}
          alt={item.title}
          round={item.round}
          className={cn("size-full", radiusClass)}
          targetSize={isVideo ? 480 : 256}
          kind={item.kind}
          id={item.id}
        />
        <div
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-0 border border-hairline", radiusClass)}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 short:gap-0">
        <div className={cn("flex min-w-0 items-center gap-1.5", item.round && "justify-center")}>
          <span className="truncate text-sm font-medium">{item.title}</span>
          {item.explicit ? (
            <span
              title="Explicit"
              aria-label="Explicit"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-muted text-[15px] font-bold leading-none text-muted-foreground"
            >
              E
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <span className={cn("truncate text-xs text-muted-foreground", item.round && "text-center")}>
            {subtitle}
          </span>
        ) : null}
      </div>
    </>
  );

  if (item.kind === "category") {
    const tint = item.tint ?? "#666";
    const Icon = pickCategoryIcon(item.title);
    // Category drill-down (a dedicated moods/genre page keyed by
    // `item.categoryParams`) is deferred — there's no Route for it yet.
    // The tile still renders correctly; it's just inert until that lands.
    return (
      <div
        className={cn(
          "group relative flex h-14 w-full items-center gap-3 overflow-hidden rounded-lg border-l-4 bg-white/5 px-3 text-left transition-transform hover:scale-[1.01] active:scale-[0.99]",
          className,
        )}
        style={{ borderLeftColor: tint }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ background: `radial-gradient(ellipse 70% 130% at 0% 50%, ${tint}26, transparent 70%)` }}
        />
        <Icon className="relative z-10 size-5 shrink-0" style={{ color: tint }} />
        <span className="relative z-10 min-w-0 flex-1 truncate text-sm font-medium text-white">
          {item.title}
        </span>
        <ChevronRightIcon className="relative z-10 size-4 shrink-0 text-white/40" />
      </div>
    );
  }

  return (
    <ShelfItemActivator item={item} className={cn(CARD_CLASS, className)}>
      {body}
    </ShelfItemActivator>
  );
}

/**
 * Wraps arbitrary content in whatever "opening this item" means for its
 * kind: a Store `navigate()` for artists/albums/playlists, or starting
 * playback for songs/videos. Split out so other presentations of a shelf
 * item (e.g. a track-list row) can reuse the same routing.
 */
export function ShelfItemActivator({
  item,
  className,
  children,
}: {
  item: ShelfItem;
  className?: string;
  children: React.ReactNode;
}) {
  const navigate = useAppStore((s) => s.navigate);

  if (item.kind === "artist") {
    return (
      <button type="button" onClick={() => navigate({ kind: "artist", id: item.id })} className={className}>
        {children}
      </button>
    );
  }

  if (item.kind === "album") {
    return (
      <button type="button" onClick={() => navigate({ kind: "album", id: item.id })} className={className}>
        {children}
      </button>
    );
  }

  if (item.kind === "playlist") {
    if (item.playableVideoId) {
      const asSong: ShelfItem = { ...item, kind: "song", id: item.playableVideoId };
      return (
        <button
          type="button"
          className={className}
          onClick={() => usePlaybackStore.getState().playNow(shelfItemToTrack(asSong))}
        >
          {children}
        </button>
      );
    }
    return (
      <button type="button" onClick={() => navigate({ kind: "playlist", id: item.id })} className={className}>
        {children}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => usePlaybackStore.getState().playNow(shelfItemToTrack(item))}
    >
      {children}
    </button>
  );
}

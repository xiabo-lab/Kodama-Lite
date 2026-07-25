import { PlayIcon, PauseIcon, Volume2Icon } from "lucide-react";
import { Thumbnail } from "@/components/shared/thumbnail";
import { cn } from "@/lib/utils";

import { usePlaybackStore } from "@/store/playbackStore";
import { useAppStore } from "@/store/appStore";
import { shelfItemToTrack } from "@/lib/track";
import type { ShelfItem } from "@/lib/innertube/types";

/**
 * Simplified from YTMLite's `TrackList` — no virtualization (`@tanstack/
 * react-virtual` isn't a Phase 3 dependency; playlists/albums here are the
 * few-hundred-row range a Pi 5 renders fine unvirtualized, especially with
 * lazy thumbnails), no context menu / like buttons (accounts-gated,
 * deferred), no per-track source picker. Click-to-play and the artist/
 * album cross-links are kept — those are the parts that actually change
 * the workflow.
 */
type Props = {
  tracks: ShelfItem[];
  hideThumbnails?: boolean;
  hideAlbum?: boolean;
  showPlays?: boolean;
  className?: string;
};

function formatDuration(seconds?: number): string {
  if (!seconds || Number.isNaN(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatPlays(text?: string): string {
  if (!text) return "—";
  const trimmed = text.trim();
  if (!/^[\d.,\s]+$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  const n = Number(digits);
  if (!Number.isFinite(n) || n === 0) return trimmed;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function TrackList({ tracks, hideThumbnails = false, hideAlbum = false, showPlays = false, className }: Props) {
  const activeId = usePlaybackStore((s) => (s.index >= 0 ? s.queue[s.index]?.videoId : undefined));
  const playing = usePlaybackStore((s) => s.playing);
  const showAlbum = !hideAlbum && tracks.some((t) => t.album);

  const gridTemplate = [
    "minmax(0,2fr)",
    "minmax(0,1fr)",
    showAlbum ? "minmax(0,1fr)" : null,
    showPlays ? "5rem" : "3.5rem",
  ]
    .filter(Boolean)
    .join(" ");

  if (tracks.length === 0) {
    return <p className="text-sm text-muted-foreground">No tracks to display.</p>;
  }

  return (
    <ul className={cn("flex flex-col", className)}>
      {tracks.map((t, idx) => (
        <TrackRow
          key={`${t.id}:${idx}`}
          track={t}
          idx={idx}
          tracks={tracks}
          gridTemplate={gridTemplate}
          hideThumbnails={hideThumbnails}
          showAlbum={showAlbum}
          showPlays={showPlays}
          isActive={activeId === t.id}
          playing={playing}
        />
      ))}
    </ul>
  );
}

type RowProps = {
  track: ShelfItem;
  idx: number;
  tracks: ShelfItem[];
  gridTemplate: string;
  hideThumbnails: boolean;
  showAlbum: boolean;
  showPlays: boolean;
  isActive: boolean;
  playing: boolean;
};

function TrackRow({ track: t, idx, tracks, gridTemplate, hideThumbnails, showAlbum, showPlays, isActive, playing }: RowProps) {
  const navigate = useAppStore((s) => s.navigate);

  const activate = () => {
    const store = usePlaybackStore.getState();
    if (isActive) {
      store.toggle();
      return;
    }
    store.playQueue(tracks.map(shelfItemToTrack), idx);
  };

  return (
    <li
      data-videoid={t.id}
      style={{ gridTemplateColumns: gridTemplate }}
      className={cn(
        "group grid cursor-pointer items-center gap-3 rounded-lg p-2",
        isActive ? "bg-black/25" : "hover:bg-surface",
      )}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-nav-link]")) return;
        activate();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
      tabIndex={0}
      role="button"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center">
          {hideThumbnails ? (
            <>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  isActive ? "hidden text-brand" : "text-muted-foreground group-hover:hidden",
                )}
              >
                {idx + 1}
              </span>
              {isActive ? (
                playing ? (
                  <Volume2Icon className="size-4 text-brand" />
                ) : (
                  <PauseIcon className="size-4 text-brand" />
                )
              ) : (
                <PlayIcon className="hidden size-4 fill-current group-hover:block" aria-hidden />
              )}
            </>
          ) : (
            <div className="relative size-10">
              <Thumbnail thumbnails={t.thumbnails} alt={t.title} className="size-full rounded-sm" targetSize={80} />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-sm bg-black/55 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              >
                {isActive && playing ? (
                  <PauseIcon className="size-5 fill-current text-white" />
                ) : (
                  <PlayIcon className="size-5 fill-current text-white" />
                )}
              </div>
            </div>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-sm font-medium", isActive && "font-bold text-brand")}>{t.title}</span>
          {t.explicit ? (
            <span
              title="Explicit"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-muted text-[15px] font-bold leading-none text-muted-foreground"
            >
              E
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-1 truncate text-sm text-muted-foreground">
        {t.artists?.length ? (
          t.artists.map((a, i) => (
            <span key={`${a.id ?? a.name}-${i}`} className="truncate">
              {a.id ? (
                <button
                  type="button"
                  data-nav-link
                  onClick={() => navigate({ kind: "artist", id: a.id! })}
                  className="hover:text-foreground hover:underline"
                >
                  {a.name}
                </button>
              ) : (
                a.name
              )}
              {i < (t.artists?.length ?? 0) - 1 ? ", " : ""}
            </span>
          ))
        ) : (
          <span className="truncate">{t.subtitle ?? ""}</span>
        )}
      </div>

      {showAlbum ? (
        <div className="min-w-0 truncate text-sm text-muted-foreground">
          {t.album ? (
            t.albumId ? (
              <button
                type="button"
                data-nav-link
                onClick={() => navigate({ kind: "album", id: t.albumId! })}
                className="truncate hover:text-foreground hover:underline"
              >
                {t.album}
              </button>
            ) : (
              <span className="truncate">{t.album}</span>
            )
          ) : null}
        </div>
      ) : null}

      <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {showPlays ? formatPlays(t.playCount) : formatDuration(t.duration)}
      </span>
    </li>
  );
}

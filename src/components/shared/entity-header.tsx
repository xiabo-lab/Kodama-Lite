import type { ReactNode } from "react";
import { PlayIcon, ShuffleIcon } from "lucide-react";
import { Thumbnail } from "@/components/shared/thumbnail";
import type { Thumbnail as YtThumbnail } from "@/lib/innertube/types";

type Props = {
  title: string;
  subtitle?: string;
  metadata?: string;
  description?: string;
  thumbnails: YtThumbnail[];
  round?: boolean;
  onPlay?: () => void;
  onShuffle?: () => void;
  actions?: ReactNode;
};

/**
 * Simplified from YTMLite's `EntityHeader` — that version publishes to a
 * store so the title bar itself renders a compact/hero header (with a
 * "short" 440px-tall-Pi-panel layout variant). Reproducing that chrome
 * wasn't worth the time against tonight's deadline; this renders the same
 * information (cover, title, subtitle, Play/Shuffle) as a plain block at
 * the top of the content column instead — same data, simpler placement.
 */
export function EntityHeader({ title, subtitle, metadata, description, thumbnails, round = false, onPlay, onShuffle, actions }: Props) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-end">
      <div className={round ? "size-40 shrink-0 md:size-48" : "aspect-square w-40 shrink-0 md:w-56"}>
        <Thumbnail thumbnails={thumbnails} alt={title} round={round} className="size-full" targetSize={512} />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{title}</h1>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        {metadata ? <p className="text-sm text-muted-foreground">{metadata}</p> : null}
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
        {(onPlay || onShuffle || actions) && (
          <div className="mt-2 flex items-center gap-2">
            {onPlay ? (
              <button
                type="button"
                onClick={onPlay}
                className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand/90"
              >
                <PlayIcon className="size-4 fill-current" />
                Play
              </button>
            ) : null}
            {onShuffle ? (
              <button
                type="button"
                onClick={onShuffle}
                className="inline-flex items-center gap-2 rounded-full border border-input bg-white/5 px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-white/10"
              >
                <ShuffleIcon className="size-4" />
                Shuffle
              </button>
            ) : null}
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

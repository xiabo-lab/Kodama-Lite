import { cn } from "@/lib/utils";
import type { Thumbnail as YtThumbnail } from "@/lib/innertube/types";

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

type Props = {
  thumbnails: YtThumbnail[];
  alt: string;
  round?: boolean;
  className?: string;
  targetSize?: number;
};

export function Thumbnail({ thumbnails, alt, round = false, className, targetSize = 256 }: Props) {
  const src = pickThumbnail(thumbnails, targetSize);

  return (
    <div
      className={cn("relative overflow-hidden bg-muted", round ? "rounded-full" : "rounded-md", className)}
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
      ) : null}
    </div>
  );
}

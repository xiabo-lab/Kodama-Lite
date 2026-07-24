import { useEffect, useRef } from "react";
import { useLyricsStore } from "@/store/lyricsStore";
import { usePlaybackStore } from "@/store/playbackStore";
import type { TimedLine } from "@/lib/lyrics/types";
import { cn } from "@/lib/utils";

/**
 * Simplified from YTMLite's `lyrics-view.tsx`: one aggregated best-source
 * lookup (`lyricsStore` / `fetchBestLyrics`, YTM + LRCLIB) instead of a
 * 7-source picker with a dropdown and a per-track preference — that whole
 * source-selection UI is a nice-to-have this phase doesn't have time for.
 * No lyrics-timing offset either (that's a Settings-screen feature; Settings
 * itself isn't ported yet). The scroll + active-line-highlight engine below,
 * which is the part that actually matters for "does this feel like karaoke",
 * is kept faithfully.
 */
export type LyricsDisplay = "panel" | "stage";

/** Line-height multiplier for stage text — the stage sizes its viewport to
 *  an exact line count, and both halves of that math must agree. */
export const STAGE_LEADING = 1.3;

export function LyricsBody({ display = "panel" }: { display?: LyricsDisplay }) {
  const status = useLyricsStore((s) => s.status);
  const lyrics = useLyricsStore((s) => s.lyrics);
  const hasTrack = usePlaybackStore((s) => s.index >= 0);

  if (!hasTrack) return null;
  const notice = display === "stage" ? "text-center text-2xl text-muted-foreground" : "px-4 py-2 text-sm text-muted-foreground";

  if (status === "loading" && !lyrics) {
    return <p className={notice}>Loading lyrics…</p>;
  }
  if (!lyrics) {
    return <p className={notice}>No lyrics found.</p>;
  }
  if (lyrics.kind === "timed") {
    return <TimedLyrics lines={lyrics.lines} display={display} />;
  }
  return <PlainLyrics text={lyrics.text} display={display} />;
}

const ACTIVE_LOOKAHEAD_S = 0.72;

function findActiveIdx(lines: TimedLine[], position: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].start - ACTIVE_LOOKAHEAD_S;
    if (start > position) break;
    const nextStart = lines[i + 1]?.start;
    const end = nextStart !== undefined ? nextStart - ACTIVE_LOOKAHEAD_S : (lines[i].end ?? Infinity);
    if (position < end) {
      active = i;
      break;
    }
    active = i;
  }
  return active;
}

const ACTIVE_LINE_VIEWPORT_RATIO = 0.36;

function scrollTargetTop(container: HTMLElement, el: HTMLElement, idx: number, stage: boolean): number {
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const elTopWithinContent = eRect.top - cRect.top + container.scrollTop;
  const offset = stage || idx === 0 ? 0 : container.clientHeight * ACTIVE_LINE_VIEWPORT_RATIO - el.clientHeight / 2;
  return Math.max(0, elTopWithinContent - offset);
}

const SCROLL_DURATION_MS = 720;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function TimedLyrics({ lines, display = "panel" }: { lines: TimedLine[]; display?: LyricsDisplay }) {
  const stage = display === "stage";
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const position = usePlaybackStore((s) => s.position);
  const seek = usePlaybackStore((s) => s.seek);

  const activeIdx = findActiveIdx(lines, position);
  const prevActiveRef = useRef(activeIdx);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const idx = findActiveIdx(lines, usePlaybackStore.getState().position);
    prevActiveRef.current = idx;
    if (idx < 0) {
      container.scrollTop = 0;
      return;
    }
    const el = container.querySelector<HTMLElement>(`[data-line-idx="${idx}"]`);
    if (!el) {
      container.scrollTop = 0;
      return;
    }
    container.scrollTop = scrollTargetTop(container, el, idx, stage);
  }, [lines, stage]);

  useEffect(() => {
    if (activeIdx === prevActiveRef.current) return;
    prevActiveRef.current = activeIdx;
    if (activeIdx < 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`[data-line-idx="${activeIdx}"]`);
    if (!el) return;
    const targetTop = scrollTargetTop(container, el, activeIdx, stage);

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const startTop = container.scrollTop;
    const delta = targetTop - startTop;
    if (Math.abs(delta) < 1) return;

    const startTs = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startTs) / SCROLL_DURATION_MS);
      container.scrollTop = startTop + delta * easeInOutCubic(t);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else rafRef.current = null;
    };
    rafRef.current = requestAnimationFrame(step);
  }, [activeIdx, stage]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className={cn(
          "lyrics-no-scrollbar flex h-full flex-col overflow-y-auto pt-0",
          stage ? "gap-[var(--lyric-gap,0.5rem)] px-8 pb-[60vh]" : "gap-1 px-1 pb-16",
          !stage && activeIdx >= 1 && "lyrics-mask",
        )}
      >
        {lines.map((line, i) => {
          const isActive = i === activeIdx;
          const isPast = i < activeIdx;
          return (
            <button
              key={i}
              type="button"
              data-line-idx={i}
              onClick={() => seek(line.start)}
              style={stage ? { fontSize: "var(--lyric-font)", lineHeight: STAGE_LEADING } : undefined}
              className={cn(
                "lyrics-line cursor-pointer rounded-md font-[650] leading-snug transition-[scale,color] duration-[1260ms] ease-in-out hover:bg-black/30",
                stage ? "origin-center px-4 py-0 text-center" : "origin-left px-2 py-1 text-left text-lg",
                isActive
                  ? stage
                    ? "scale-[1.04] text-foreground"
                    : "scale-[1.06] text-foreground"
                  : isPast
                    ? "scale-100 text-muted-foreground/40"
                    : "scale-100 text-muted-foreground/70",
              )}
            >
              {line.text || "♪"}
            </button>
          );
        })}
      </div>
      {!stage ? (
        <div
          aria-hidden
          className="lyrics-blur-overlay pointer-events-none absolute inset-x-0 top-0 h-[26%] transition-opacity duration-500 ease-in-out"
          style={{ opacity: activeIdx <= 0 ? 0 : 1 }}
        />
      ) : null}
    </div>
  );
}

function PlainLyrics({ text, display = "panel" }: { text: string; display?: LyricsDisplay }) {
  const stage = display === "stage";
  return (
    <div
      style={stage ? { fontSize: "var(--lyric-font)", lineHeight: STAGE_LEADING } : undefined}
      className={cn(
        "app-scroll h-full overflow-y-auto whitespace-pre-wrap pt-0 font-medium text-foreground/90",
        stage ? "lyrics-no-scrollbar px-8 pb-[30vh] text-center" : "lyrics-mask px-2 pb-12 text-lg leading-relaxed",
      )}
    >
      {text}
    </div>
  );
}

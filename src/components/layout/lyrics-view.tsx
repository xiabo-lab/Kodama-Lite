import { useEffect, useMemo, useRef, useState } from "react";
import { useLyricsStore } from "@/store/lyricsStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { Lyrics, TimedLine, TimedWord } from "@/lib/lyrics/types";
import { canEstimate, estimateTimedLines } from "@/lib/lyrics/estimate";
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

/**
 * What the views should actually render for a given lyric result.
 *
 * `plain` lyrics become `timed` when the track's duration is known, by
 * interpolation — see `estimate.ts` for why a rough moving sheet beats an
 * exact frozen one, and `estimated` for how that's disclosed. Exported
 * because the karaoke stage sizes its viewport differently for a
 * line-highlighted sheet than for a static block of text, and the two
 * must agree on which one is being shown.
 */
export function resolveDisplayLyrics(
  lyrics: Lyrics | null,
  duration: number,
): Lyrics | null {
  if (!lyrics || lyrics.kind === "timed") return lyrics;
  if (!canEstimate(lyrics.text, duration)) return lyrics;
  const lines = estimateTimedLines(lyrics.text, duration);
  if (lines.length === 0) return lyrics;
  return { kind: "timed", lines, source: lyrics.source, estimated: true };
}

/** The stage's own hook version, so both it and `LyricsBody` derive the
 *  same answer from the same two subscriptions. */
export function useDisplayLyrics(): Lyrics | null {
  const lyrics = useLyricsStore((s) => s.lyrics);
  const duration = usePlaybackStore((s) => s.duration);
  return useMemo(() => resolveDisplayLyrics(lyrics, duration), [lyrics, duration]);
}

export function LyricsBody({ display = "panel" }: { display?: LyricsDisplay }) {
  const status = useLyricsStore((s) => s.status);
  const rawLyrics = useLyricsStore((s) => s.lyrics);
  const lyrics = useDisplayLyrics();
  const hasTrack = usePlaybackStore((s) => s.index >= 0);

  if (!hasTrack) return null;
  const notice = display === "stage" ? "text-center text-2xl text-muted-foreground" : "px-4 py-2 text-sm text-muted-foreground";

  if (status === "loading" && !rawLyrics) {
    return <p className={notice}>Loading lyrics…</p>;
  }
  if (!lyrics) {
    return <p className={notice}>No lyrics found.</p>;
  }
  if (lyrics.kind === "timed") {
    return (
      <TimedLyrics
        lines={lyrics.lines}
        display={display}
        estimated={lyrics.estimated}
      />
    );
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

/** How many of `words` have started by `t`. */
function countSung(words: TimedWord[], t: number): number {
  let n = 0;
  while (n < words.length && words[n].start <= t) n++;
  return n;
}

/**
 * Do this line's words actually reconstruct its text?
 *
 * The three parsers that produce `words` (Kugou KRC, Enhanced LRC, and
 * the estimator) each have edge cases where a run could be dropped —
 * text before the first tag, a malformed timestamp. Drawing the line from
 * a word list that doesn't add up would silently mangle the lyric, so the
 * renderer checks first and falls back to whole-line highlighting. A
 * missing highlight is a far smaller failure than missing words.
 */
function wordsUsable(line: TimedLine): boolean {
  if (!line.words || line.words.length === 0) return false;
  return line.words.map((w) => w.text).join("").trim() === line.text.trim();
}

/**
 * How many words of the active line have been sung.
 *
 * `position` in the store is driven by the audio element's `timeupdate`,
 * which fires roughly four times a second — far too coarse for word-level
 * highlighting, where CJK characters can be 200ms apart. This interpolates
 * between those ticks against a wall clock and resyncs on every real one,
 * so the highlight advances smoothly without the playback store having to
 * run at frame rate.
 *
 * `setCount` is called with the same value on most frames, which React
 * bails out of, so this re-renders about once per word rather than once
 * per frame — and only ever the single active line, never the sheet.
 */
function useSungWordCount(words: TimedWord[], offsetSec: number): number {
  const storePosition = usePlaybackStore((s) => s.position);
  const playing = usePlaybackStore((s) => s.playing);
  const [count, setCount] = useState(() =>
    countSung(words, storePosition - offsetSec),
  );

  useEffect(() => {
    const startedAt = performance.now();
    const apply = (elapsed: number) =>
      setCount(countSung(words, storePosition + elapsed - offsetSec));
    apply(0);
    // Paused: the clock isn't moving, so one computation is the whole job.
    if (!playing) return;
    let raf = requestAnimationFrame(function tick() {
      apply((performance.now() - startedAt) / 1000);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [words, storePosition, playing, offsetSec]);

  return count;
}

/** The active line, drawn word by word. */
function WordLine({ words, offsetSec }: { words: TimedWord[]; offsetSec: number }) {
  const sung = useSungWordCount(words, offsetSec);
  return (
    <>
      {words.map((w, i) => (
        <span
          key={i}
          className={cn(
            "transition-colors duration-200 ease-out",
            i < sung ? "text-foreground" : "text-foreground/30",
          )}
        >
          {w.text}
        </span>
      ))}
    </>
  );
}

function TimedLyrics({
  lines,
  display = "panel",
  estimated,
}: {
  lines: TimedLine[];
  display?: LyricsDisplay;
  estimated?: boolean;
}) {
  const stage = display === "stage";
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const rawPosition = usePlaybackStore((s) => s.position);
  const seek = usePlaybackStore((s) => s.seek);
  // Bluetooth to the car speakers arrives a fraction of a second after
  // this app's playback clock, so the highlight lands ahead of what's
  // being sung. Settings → Lyrics timing shifts line selection to
  // compensate; positive holds the lyrics back. Applied only to line
  // *selection* — `seek` still targets the true timestamp, so tapping a
  // line jumps to where that line really is in the audio.
  const offset = useSettingsStore((s) => s.lyricsOffsetSec);
  const position = rawPosition - offset;

  const activeIdx = findActiveIdx(lines, position);
  const prevActiveRef = useRef(activeIdx);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    // Same offset the render path applies — otherwise the jump-to-current
    // scroll on mount would target a different line than the one about to
    // be highlighted.
    const idx = findActiveIdx(
      lines,
      usePlaybackStore.getState().position - offset,
    );
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
  }, [lines, stage, offset]);

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
      {/* Panel only. The stage has no vertical room to spare on a 440px
          panel, so it discloses this in its chrome band instead — see
          `karaoke-view.tsx`. */}
      {estimated && !stage ? (
        <p className="shrink-0 px-2 pb-1 text-xs text-muted-foreground">
          Estimated timing — no synced lyrics were found, so these are
          spread across the track's length.
        </p>
      ) : null}
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
          // Only the active line is drawn word by word — the others have
          // nothing to reveal, and giving each its own rAF clock would put
          // the whole sheet on a frame-rate render loop.
          const byWord = isActive && wordsUsable(line);
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
              {byWord ? (
                <WordLine words={line.words!} offsetSec={offset} />
              ) : (
                line.text || "♪"
              )}
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

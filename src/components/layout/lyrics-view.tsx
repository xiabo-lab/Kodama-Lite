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
    // The stage and the side panel are different instruments, and used to
    // share one renderer at the cost of both. See `StageLyrics`.
    return display === "stage" ? (
      <StageLyrics lines={lyrics.lines} />
    ) : (
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

// ── The karaoke stage ─────────────────────────────────────────────────
//
// Rebuilt on Carlyrics' display model after the scrolling version tested
// badly. What Carlyrics does (`_line_positions` + `draw_karaoke_line` in
// `Lyrics_Display.py`) and why each part of it is the right call for a
// 1920x440 panel in a moving car:
//
//  1. THREE FIXED SLOTS, NOT A SCROLLING LIST. Previous line above,
//     current line centred, next line below — at fixed positions, redrawn
//     in place. The old stage scrolled a full-length list with a 720ms
//     eased animation on every line change, which meant the line you were
//     trying to read was physically in motion for a large fraction of its
//     own airtime. At this text size the movement is the most salient
//     thing on the screen. Fixed slots make the current line the only
//     thing that never moves.
//
//  2. THE CURRENT LINE IS CENTRED, not pinned to the top of the viewport.
//     The old stage put the active line at the top with its two
//     SUCCESSORS below, so there was no context for what had just been
//     sung and your eye had to hunt for the highlight. One line back and
//     one forward is what a singer actually needs.
//
//  3. A CONTINUOUS SWEEP, NOT PER-WORD SWITCHING. The sung portion is
//     divided from the unsung one by a vertical edge that slides left to
//     right, interpolating INSIDE the word being sung. The old renderer
//     flipped each word between two opacities as it started — for CJK,
//     where a "word" is one character maybe 200ms wide, that reads as a
//     stutter rather than a sweep. A partially-filled glyph is what makes
//     it look like singing.
//
//  4. THE SWEEP WORKS WITHOUT WORD TIMINGS TOO, by interpolating across
//     the whole line between its start and the next line's start. So a
//     line-synced source still gets a moving fill instead of a static
//     highlight — which is most of the perceived quality, and it applies
//     to the majority of sources.
//
//  5. AN INTRO COUNTDOWN before the first line, one dot per remaining
//     second, so the intro isn't a blank screen and you know when to come
//     in.

// Context lines used to be a fixed 0.61x the current line (Carlyrics' 34px
// against 56). They are now sized independently in Settings → Appearance →
// Font settings; that ratio survives as the shipped default (35px against
// 60) in `settingsStore`'s DEFAULT_LYRIC_STYLE.
/** Carlyrics shows at most 3 countdown dots (1 dot = 1 second). */
const INTRO_DOTS_MAX = 3;

/**
 * Where the sung/unsung edge sits on the current line, as a fraction of
 * its width. Direct port of Carlyrics' `_karaoke_split_px`, in fractions
 * rather than pixels because the DOM gives us measured element geometry
 * instead of a font metrics call.
 *
 * `widths` are cumulative left offsets per word, normalised to 0..1.
 */
export function sweepFraction(
  words: TimedWord[],
  bounds: { left: number; right: number }[],
  t: number,
  lineEnd: number,
): number {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const wEnd = words[i + 1]?.start ?? w.end ?? lineEnd;
    if (t < w.start) return bounds[i]?.left ?? 0; // not reached yet
    if (t < wEnd) {
      // Mid-word: interpolate across this word's own box. This is the
      // part that makes a glyph fill partially rather than flip.
      const span = wEnd - w.start;
      const f = span > 0 ? (t - w.start) / span : 1;
      const b = bounds[i];
      if (!b) return 0;
      return b.left + f * (b.right - b.left);
    }
  }
  return 1; // every word sung
}

/**
 * The current line, drawn as two stacked copies clipped against each
 * other. The sweep is animated by mutating `clipPath` on the top copy from
 * a rAF loop — deliberately NOT through React state, because this updates
 * every frame and re-rendering the sheet at 60fps to move one edge would
 * be exactly the kind of thing this app's architecture exists to avoid.
 */
function KaraokeLine({
  line,
  nextStart,
  offsetSec,
}: {
  line: TimedLine;
  nextStart?: number;
  offsetSec: number;
}) {
  const fillRef = useRef<HTMLSpanElement>(null);
  const baseRef = useRef<HTMLSpanElement>(null);
  const playing = usePlaybackStore((s) => s.playing);
  const storePosition = usePlaybackStore((s) => s.position);

  const words = wordsUsable(line) ? line.words! : undefined;
  const lineEnd = line.end ?? nextStart ?? line.start + 4;

  useEffect(() => {
    const fill = fillRef.current;
    const base = baseRef.current;
    if (!fill || !base) return;

    // Measure each word's box once per line. `offsetLeft` is relative to
    // the positioned ancestor, so both copies — identical markup, same
    // font — agree on it.
    let bounds: { left: number; right: number }[] = [];
    if (words) {
      const spans = Array.from(base.children) as HTMLElement[];
      const total = base.offsetWidth || 1;
      bounds = spans.map((el) => ({
        left: el.offsetLeft / total,
        right: (el.offsetLeft + el.offsetWidth) / total,
      }));
    }

    const startedAt = performance.now();
    const apply = (elapsed: number) => {
      const t = storePosition + elapsed - offsetSec;
      let f: number;
      if (words && bounds.length === words.length) {
        f = sweepFraction(words, bounds, t, lineEnd);
      } else {
        // No usable word timings: interpolate across the whole line, so a
        // line-synced source still sweeps rather than sitting static.
        const span = lineEnd - line.start;
        f = span > 0 ? (t - line.start) / span : 1;
      }
      f = Math.max(0, Math.min(1, f));
      fill.style.clipPath = `inset(0 ${(1 - f) * 100}% 0 0)`;
    };

    apply(0);
    // Paused: the clock isn't moving, so one computation is the whole job.
    if (!playing) return;
    let raf = requestAnimationFrame(function tick() {
      apply((performance.now() - startedAt) / 1000);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [words, line.start, lineEnd, storePosition, playing, offsetSec]);

  const content = words
    ? words.map((w, i) => <span key={i}>{w.text}</span>)
    : line.text;

  return (
    <span className="relative inline-block">
      {/* Unsung, then sung. Carlyrics has this the other way round (unsung
          yellow, sung white), which works on its display but puts a whole
          line of fully-saturated colour on screen as the RESTING state — at
          60px of CJK on a dark panel that is a lot to read past. Dim
          resting, brand red sweeping, means the colour marks exactly where
          you are rather than where you aren't, which is the question the
          line is being read to answer. Both colours are now Settings →
          Appearance → Font settings (defaults preserve that reasoning);
          swapping them back is two taps for anyone who prefers it. */}
      <span
        ref={baseRef}
        className="whitespace-pre"
        style={{ color: "var(--lyric-color-current)" }}
      >
        {content}
      </span>
      {/* Sung — same markup, same box, clipped from the right. `inset-0`
          plus identical content guarantees the two copies are registered
          pixel for pixel, which is what makes a half-filled glyph line up
          with itself. */}
      <span
        ref={fillRef}
        aria-hidden
        className="absolute inset-0 whitespace-pre"
        style={{
          clipPath: "inset(0 100% 0 0)",
          color: "var(--lyric-color-karaoke)",
        }}
      >
        {content}
      </span>
    </span>
  );
}

/**
 * The three-slot stage. Every slot is a fixed-height row so nothing
 * reflows as the text changes: a line that wraps or a missing context line
 * must not be able to shift the current line off centre.
 */
function StageLyrics({ lines }: { lines: TimedLine[] }) {
  const rawPosition = usePlaybackStore((s) => s.position);
  const offset = useSettingsStore((s) => s.lyricsOffsetSec);
  const position = rawPosition - offset;
  const activeIdx = findActiveIdx(lines, position);

  // Before the first line: count the intro down instead of showing a blank
  // stage, and put the upcoming first line where it will stay, so it
  // doesn't jump when it becomes active.
  if (activeIdx < 0) {
    const first = lines[0];
    const remaining = (first?.start ?? 0) - position;
    const dots = Math.max(0, Math.min(INTRO_DOTS_MAX, Math.ceil(remaining)));
    return (
      <StageFrame
        above={
          dots > 0 ? (
            <span
              className="tracking-[0.4em]"
              style={{ color: "var(--lyric-color-karaoke)" }}
            >
              {"•".repeat(dots)}
            </span>
          ) : null
        }
        // The line about to become active, shown in the sweep colour —
        // it's the one thing on the stage that is "current" during the
        // intro, and it must not move when it actually becomes so.
        current={
          <span style={{ color: "var(--lyric-color-karaoke)" }}>
            {first?.text || "♪"}
          </span>
        }
        below={
          <span style={{ color: "var(--lyric-color-bottom)" }}>
            {lines[1]?.text ?? ""}
          </span>
        }
      />
    );
  }

  const prev = lines[activeIdx - 1];
  const cur = lines[activeIdx];
  const next = lines[activeIdx + 1];

  return (
    <StageFrame
      above={
        prev ? (
          <span style={{ color: "var(--lyric-color-top)" }}>{prev.text}</span>
        ) : null
      }
      current={
        <KaraokeLine
          // Keyed by index so each line gets a fresh measurement pass and
          // its own rAF loop — without this the sweep would carry the
          // previous line's word boxes into the next one.
          key={activeIdx}
          line={cur}
          nextStart={next?.start}
          offsetSec={offset}
        />
      }
      below={
        next ? (
          <span style={{ color: "var(--lyric-color-bottom)" }}>{next.text}</span>
        ) : null
      }
    />
  );
}

/**
 * Fixed three-row frame. The context rows are sized in `em` off the
 * current line's font, so one `--lyric-font` still drives the whole stage
 * and the proportions hold at any panel height.
 *
 * `overflow-hidden` + `whitespace-nowrap` on each row rather than wrapping:
 * a wrapped line would grow its row and push the current line off centre,
 * which is the one thing this layout exists to prevent. Long lines are
 * scaled down to fit instead — Carlyrics' `MAX_LINE_WIDTH_FRAC` shrink.
 */
function StageFrame({
  above,
  current,
  below,
}: {
  above: React.ReactNode;
  current: React.ReactNode;
  below: React.ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-[var(--lyric-gap,0.5rem)] px-8">
      <Row slot="top">{above}</Row>
      <Row slot="current">{current}</Row>
      <Row slot="bottom">{below}</Row>
    </div>
  );
}

function Row({
  children,
  slot,
}: {
  children: React.ReactNode;
  slot: "top" | "current" | "bottom";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  // Shrink-to-fit, measured rather than guessed: a CJK line can be three
  // times the width of its romanised equivalent, and truncating a lyric
  // mid-phrase is worse than making it smaller.
  useEffect(() => {
    const box = ref.current;
    const text = inner.current;
    if (!box || !text) return;
    text.style.transform = "scale(1)";
    const avail = box.clientWidth;
    const want = text.scrollWidth;
    if (want > avail && avail > 0) {
      text.style.transform = `scale(${Math.max(0.35, avail / want)})`;
    }
  });

  return (
    <div
      ref={ref}
      className="flex w-full shrink-0 items-center justify-center overflow-hidden"
      style={{
        fontSize: `var(--lyric-size-${slot})`,
        lineHeight: STAGE_LEADING,
        // Reserved from the slot's own size, not the current line's: each
        // row has to hold its height whether or not it has text in it, or
        // a missing context line would let the current line drift off
        // centre — the one thing this layout exists to prevent.
        height: `calc(var(--lyric-size-${slot}) * ${STAGE_LEADING})`,
        fontWeight: `var(--lyric-weight-${slot})`,
      }}
    >
      <div ref={inner} className="whitespace-nowrap">
        {children}
      </div>
    </div>
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

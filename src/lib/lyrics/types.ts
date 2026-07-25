// Ported from YTMLite, then extended with per-word timing.

/**
 * One timed word (or, for CJK, usually one character) inside a line.
 *
 * Seconds, absolute — not relative to the line — so the renderer never has
 * to know which line a word came from. Kugou's KRC stores them relative to
 * the line start and Enhanced LRC stores them absolutely; both are
 * normalised to this shape at parse time.
 */
export type TimedWord = {
  start: number;
  end: number;
  text: string;
};

/**
 * A single line of synchronized lyrics.
 *
 * `start` is the second at which the line becomes active; `end` is when it
 * stops being active. Some lines have no text ("interlude" markers) — we
 * still render them so the highlight glides naturally.
 *
 * `words` is present only when the source actually carried per-word
 * timings (Kugou KRC, Enhanced LRC) or when they were estimated from the
 * track duration — see `estimate.ts`, and `Lyrics.estimated` for how the
 * difference is surfaced. Absent means line-level only, which is the
 * common case; the renderer falls back to highlighting the whole line.
 */
export type TimedLine = {
  start: number;
  end?: number;
  text: string;
  words?: TimedWord[];
};

export type Lyrics =
  | {
      kind: "timed";
      lines: TimedLine[];
      source?: string;
      /** True when the timings are a guess derived from the track length
       *  rather than data from the provider. Shown in the UI, because a
       *  fabricated timing presented as fact is worse than an honest
       *  approximation. */
      estimated?: boolean;
    }
  | { kind: "plain"; text: string; source?: string };

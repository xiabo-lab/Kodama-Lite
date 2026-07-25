import type { TimedLine, TimedWord } from "@/lib/lyrics/types";

/**
 * Synthesised timings for songs where every provider has only an unsynced
 * transcript.
 *
 * **This is a guess, and it is labelled as one everywhere it surfaces**
 * (`Lyrics.estimated`). There is no timing information in a plain lyric
 * sheet, so nothing here can be better than an interpolation: it spreads
 * the lines across the track's duration in proportion to how much text
 * each one carries, then spreads each line's own span across its words.
 *
 * Why do it at all, when it will drift: without it the karaoke stage
 * shows a plain transcript frozen at line 1 for the whole song, because
 * the stage's viewport is only a few lines tall and nothing scrolls it.
 * Roughly-right lines that move are far more useful in a car than
 * exactly-right lines that never do — and the label stops it claiming to
 * be something it isn't.
 *
 * Deliberately NOT clever: no per-section modelling, no attempt to detect
 * choruses or instrumental breaks. Those need signal this input doesn't
 * contain, and a more elaborate guess would only be wrong more
 * convincingly.
 *
 * Pure and dependency-free so it can be unit-tested.
 */

/**
 * Fractions of the track assumed to be instrumental intro and outro.
 * Almost every song has both; leaving them out would push the whole sheet
 * early by an intro's worth. Capped in seconds so a long track doesn't
 * get an implausible one-minute intro.
 */
const LEAD_IN_RATIO = 0.06;
const LEAD_IN_MAX_S = 12;
const TAIL_RATIO = 0.04;
const TAIL_MAX_S = 8;

/** Below this there isn't enough track to spread anything across. */
const MIN_DURATION_S = 5;

/**
 * One token per CJK character, one per run of anything else. CJK is sung
 * roughly a character at a time, which is exactly the granularity that
 * makes word-level highlighting look right for a Cantonese or Mandarin
 * track; Latin text stays word-by-word.
 *
 * Trailing whitespace rides along with its token so that concatenating
 * every token reproduces the line exactly — the renderer draws the line
 * from this list, so a dropped space would be a missing space on screen.
 */
const CJK = "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF\\uAC00-\\uD7AF";
const TOKEN_RE = new RegExp(`[${CJK}]\\s*|[^\\s${CJK}]+\\s*`, "gu");

export function tokenizeWords(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/**
 * Split a transcript into displayable lines. Blank lines are structural
 * (verse breaks) and carry no text to sing, so they're dropped rather
 * than given a share of the clock.
 */
export function splitPlainLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Is there enough here to be worth estimating? */
export function canEstimate(text: string, duration: number): boolean {
  return (
    Number.isFinite(duration) &&
    duration >= MIN_DURATION_S &&
    splitPlainLines(text).length > 0
  );
}

/**
 * Spread `text` across `duration` seconds, weighting each line by how
 * many tokens it carries so a long line gets more of the clock than a
 * short one. Returns [] when there's nothing sensible to do.
 */
export function estimateTimedLines(text: string, duration: number): TimedLine[] {
  if (!canEstimate(text, duration)) return [];

  const rawLines = splitPlainLines(text);
  const tokenized = rawLines.map(tokenizeWords);
  // A line that tokenizes to nothing (punctuation only) still occupies a
  // slot, so give it a floor rather than a zero-length span.
  const weights = tokenized.map((t) => Math.max(1, t.length));
  const total = weights.reduce((a, b) => a + b, 0);

  const leadIn = Math.min(duration * LEAD_IN_RATIO, LEAD_IN_MAX_S);
  const tail = Math.min(duration * TAIL_RATIO, TAIL_MAX_S);
  const span = Math.max(0, duration - leadIn - tail);
  if (span <= 0) return [];

  const out: TimedLine[] = [];
  let consumed = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const start = leadIn + (span * consumed) / total;
    consumed += weights[i];
    const end = leadIn + (span * consumed) / total;
    out.push({
      start,
      end,
      text: rawLines[i],
      words: spreadWords(tokenized[i], start, end),
    });
  }
  return out;
}

/** Divide one line's span among its tokens, weighted by token length so a
 *  long Latin word isn't given the same beat as "a". */
function spreadWords(
  tokens: string[],
  start: number,
  end: number,
): TimedWord[] | undefined {
  if (tokens.length === 0) return undefined;
  const weights = tokens.map((t) => Math.max(1, t.trim().length));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = end - start;
  const out: TimedWord[] = [];
  let consumed = 0;
  for (let i = 0; i < tokens.length; i++) {
    const wStart = start + (span * consumed) / total;
    consumed += weights[i];
    out.push({
      start: wStart,
      end: start + (span * consumed) / total,
      text: tokens[i],
    });
  }
  return out;
}

// Ported verbatim from YTMLite.

import type { TimedLine, TimedWord } from "@/lib/lyrics/types";

/**
 * Parse LRC text into timed lines.
 *
 * Format examples:
 *   [00:12.34]First line
 *   [00:15.67]Second line
 *   [00:15.67][00:20.00]Repeated line (chorus)
 *   [00:12]Line without centiseconds
 *
 * Lines without timestamps (metadata like `[ar:Artist]`) are skipped.
 * Each line's `end` is filled from the next line's `start` so the
 * highlight glides naturally between lines.
 *
 * Enhanced ("karaoke") LRC additionally carries a per-word timestamp
 * inside the text, e.g. `[00:12.34]<00:12.34>Hel<00:12.80>lo`. These used
 * to be stripped, because the stage highlighted whole lines. They're now
 * parsed into `words` — the same shape Kugou's KRC produces — so any
 * source that ships Enhanced LRC gets word-level karaoke for free. The
 * tags are still removed from `text` either way; without that they would
 * render literally.
 *
 * A word's `end` is the next word's start, and the last word's is the
 * line's own end. Enhanced LRC carries no explicit word durations, so
 * this is the only reading available — and it matches how the format is
 * used in practice, where a word is "current" until the next one begins.
 */
export function parseLRC(lrc: string): TimedLine[] {
  const tsRe = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
  const wordTsRe = /<\d+:\d+(?:[.:]\d+)?>/g;
  const out: TimedLine[] = [];
  // Optional global shift tag. Per the LRC spec a positive [offset:+ms]
  // shifts the lyrics earlier, so we subtract it from every timestamp.
  const offsetMatch = lrc.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
  const offsetSec = offsetMatch ? parseInt(offsetMatch[1], 10) / 1000 : 0;
  for (const rawLine of lrc.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(tsRe)];
    if (matches.length === 0) continue;
    const last = matches[matches.length - 1];
    const body = rawLine.slice((last.index ?? 0) + last[0].length);
    const text = body.replace(wordTsRe, "").trim();
    const words = parseWordTags(body, offsetSec);
    for (const m of matches) {
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      const frac = m[3]
        ? parseInt(m[3].padEnd(3, "0").slice(0, 3), 10)
        : 0;
      if (Number.isNaN(mm) || Number.isNaN(ss)) continue;
      const start = Math.max(0, mm * 60 + ss + frac / 1000 - offsetSec);
      // A chorus line repeats under several timestamps; each repeat needs
      // its own word array or they'd share one object and the second
      // rendering would fight the first.
      out.push({ start, text, words: words ? words.map((w) => ({ ...w })) : undefined });
    }
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length - 1; i++) {
    out[i].end = out[i + 1].start;
  }
  for (const line of out) closeWordEnds(line.words, line.end);
  return out;
}

/**
 * Pull `<mm:ss.xx>word` runs out of one Enhanced-LRC line body. Returns
 * undefined for ordinary LRC, which is the overwhelmingly common case —
 * `words` stays absent and the renderer highlights whole lines.
 *
 * `end` is left at 0 here and filled by `closeWordEnds` once the line's
 * own end is known.
 */
function parseWordTags(body: string, offsetSec: number): TimedWord[] | undefined {
  const runRe = /<(\d+):(\d+)(?:[.:](\d+))?>([^<]*)/g;
  const words: TimedWord[] = [];
  for (const m of body.matchAll(runRe)) {
    const mm = parseInt(m[1], 10);
    const ss = parseInt(m[2], 10);
    const frac = m[3] ? parseInt(m[3].padEnd(3, "0").slice(0, 3), 10) : 0;
    if (Number.isNaN(mm) || Number.isNaN(ss)) continue;
    // Whitespace-only runs are kept for the same reason as in `krc.ts`:
    // the renderer draws the line from this list, so dropping them would
    // delete the spaces between words.
    const chunk = m[4];
    words.push({
      start: Math.max(0, mm * 60 + ss + frac / 1000 - offsetSec),
      end: 0,
      text: chunk,
    });
  }
  return words.length > 0 ? words : undefined;
}

/** Each word runs until the next one starts; the last runs to the line's
 *  end (or a second, when the line has no end because it's the last). */
function closeWordEnds(words: TimedWord[] | undefined, lineEnd?: number): void {
  if (!words) return;
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1]?.start;
    words[i].end = next ?? Math.max(lineEnd ?? 0, words[i].start + 1);
  }
}

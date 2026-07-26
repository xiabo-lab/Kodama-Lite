/**
 * Pinyin input method.
 *
 * The dictionary is RIME's `pinyin_simp` (Apache 2.0, derived from the
 * Android Open Source Project's PinyinIME), rebuilt into
 * `public/pinyin-dict.json` as `pinyin-without-spaces -> concatenated
 * candidates, most frequent first`. See scripts/build-pinyin-dict.mjs.
 *
 * It is FETCHED, not imported. At ~880KB it would otherwise be inlined
 * into the main bundle and paid for on every launch by every user, when
 * only someone tapping 中 ever needs it. Loaded once, memoised for the
 * process lifetime.
 */

export type Candidate = {
  /** The Chinese text to insert. */
  text: string;
  /** How many letters of the composing buffer this consumes. */
  consumed: number;
};

type Dict = Record<string, string>;

let dictPromise: Promise<Dict> | null = null;

export function loadPinyinDict(): Promise<Dict> {
  dictPromise ??= fetch("pinyin-dict.json")
    .then((r) => {
      if (!r.ok) throw new Error(`pinyin dict: HTTP ${r.status}`);
      return r.json() as Promise<Dict>;
    })
    .catch((e) => {
      // Let a later attempt retry rather than caching the failure — a
      // transient read shouldn't disable Chinese input for the session.
      dictPromise = null;
      throw e;
    });
  return dictPromise;
}

/**
 * Ceiling on how many candidates one buffer can produce. This is a sanity
 * bound, not a display limit — the keyboard pages through the list, so it
 * needs the whole thing. It was 9, which combined with the generator's old
 * cap of 8 per key meant a syllable like "shi" (131 characters in the
 * dictionary) offered eight and no way to reach the rest.
 *
 * Still bounded because a short buffer matches every shorter prefix too:
 * without a stop, "z" would walk a good fraction of the dictionary to
 * build a list nobody scrolls to the end of.
 */
const MAX_CANDIDATES = 200;

/**
 * Candidates for a composing buffer.
 *
 * Tries the whole buffer first, then progressively shorter prefixes, so
 * typing "beijingdaxue" still offers 北京 after the full string misses —
 * partial commits are how anyone actually types a phrase the dictionary
 * doesn't hold whole. Longer matches rank above shorter ones because
 * consuming more of what was typed is almost always what was meant.
 */
export function candidatesFor(buffer: string, dict: Dict): Candidate[] {
  const key = buffer.toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return [];

  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (let len = key.length; len > 0 && out.length < MAX_CANDIDATES; len--) {
    const entry = dict[key.slice(0, len)];
    if (!entry) continue;
    // Space-separated words, not a run of characters — see the generator.
    for (const word of entry.split(" ")) {
      if (!word || seen.has(word)) continue;
      seen.add(word);
      out.push({ text: word, consumed: len });
      if (out.length >= MAX_CANDIDATES) break;
    }
  }

  return out;
}

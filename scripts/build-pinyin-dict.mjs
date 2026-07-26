// Builds the bundled Pinyin IME dictionary from RIME's pinyin_simp
// (Apache 2.0, derived from AOSP PinyinIME).
//
//   node build-pinyin-dict.mjs <pinyin_simp.yaml> <out.json>
//
// Input lines are `word \t pinyin \t weight`, pinyin space-separated by
// syllable. The key is the pinyin with spaces removed, which is what
// someone actually types: "nihao", "beijing".
//
// Candidates are ordered by descending weight and NOT capped per key.
//
// They used to be capped at 8, on the theory that a candidate bar shows a
// handful and the tail is never chosen. That was wrong for Chinese: "shi"
// alone has 131 entries here (是时事使市式试石十室师诗食史世实施视…), so a
// cap of 8 made most homophones physically untypeable — you could not
// enter 诗 or 世 at all. The keyboard pages through candidates now.
//
// The bundle argument didn't survive measurement either. Nearly every key
// is a multi-syllable word with one or two candidates; only common single
// syllables have long tails. Uncapping moves the file 890KB → 939KB, +5%,
// for 12,000 more characters — and it is fetched on demand, not bundled
// (see src/lib/pinyin.ts).
import { readFileSync, writeFileSync } from "node:fs";

const [, , SRC, OUT] = process.argv;
/** Below this weight an entry is a curiosity, not something a user of a
 *  car stereo is searching for. Keeps the dictionary to a size worth
 *  shipping. */
const MIN_WEIGHT = 1;

const lines = readFileSync(SRC, "utf8").split("\n");
const byKey = new Map();

for (const line of lines) {
  if (!line || line.startsWith("#")) continue;
  const parts = line.split("\t");
  if (parts.length < 3) continue;
  const [word, pinyin, weightRaw] = parts;
  const weight = Number(weightRaw);
  if (!Number.isFinite(weight) || weight < MIN_WEIGHT) continue;
  if (!/^[a-z ]+$/.test(pinyin)) continue;
  const key = pinyin.replace(/ /g, "");
  if (!key) continue;
  let list = byKey.get(key);
  if (!list) byKey.set(key, (list = []));
  list.push([word, weight]);
}

const out = {};
let entries = 0;
for (const [key, list] of byKey) {
  list.sort((a, b) => b[1] - a[1]);
  const words = list.map(([w]) => w);
  // Space-separated, NOT concatenated. Concatenating loses word
  // boundaries: "北京背景" is indistinguishable from four one-character
  // candidates, so typing "beijing" offered 北 instead of 北京. Chinese
  // words contain no spaces, so this separator is unambiguous, and it
  // costs one byte per candidate.
  out[key] = words.join(" ");
  entries += words.length;
}

writeFileSync(OUT, JSON.stringify(out));
const bytes = readFileSync(OUT).length;
console.log(
  `keys=${byKey.size} candidates=${entries} bytes=${bytes} (${(bytes / 1024).toFixed(0)} KB)`,
);

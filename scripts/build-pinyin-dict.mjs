// Builds the bundled Pinyin IME dictionary from RIME's pinyin_simp
// (Apache 2.0, derived from AOSP PinyinIME).
//
//   node build-pinyin-dict.mjs <pinyin_simp.yaml> <out.json>
//
// Input lines are `word \t pinyin \t weight`, pinyin space-separated by
// syllable. The key is the pinyin with spaces removed, which is what
// someone actually types: "nihao", "beijing".
//
// Candidates are capped per key and ordered by descending weight, because
// a candidate bar shows a handful and the tail is never chosen — keeping
// all of them would multiply the bundle for entries nobody reaches.
import { readFileSync, writeFileSync } from "node:fs";

const [, , SRC, OUT] = process.argv;
const MAX_PER_KEY = 8;
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
  const words = list.slice(0, MAX_PER_KEY).map(([w]) => w);
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

// Set the release version in the three files that must agree.
//
//   node scripts/bump-version.mjs 0.1.16
//   node scripts/bump-version.mjs patch
//
// They have to match or the build lies about itself: package.json feeds
// the About screen via Vite's define, tauri.conf.json names the .deb, and
// Cargo.toml is what `cargo` compiles in. Missing one is silent — nothing
// fails, you just ship a package whose name and self-reported version
// disagree, and `update-pi.sh` compares the .deb version against dpkg.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  { rel: "package.json", re: /("version":\s*")([^"]+)(")/ },
  { rel: "src-tauri/tauri.conf.json", re: /("version":\s*")([^"]+)(")/ },
  { rel: "src-tauri/Cargo.toml", re: /(^version\s*=\s*")([^"]+)(")/m },
];

const current = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;

const arg = process.argv[2];
if (!arg) {
  console.error(`current: ${current}\nusage: bump-version.mjs <version|patch|minor>`);
  process.exit(1);
}

let next = arg;
if (arg === "patch" || arg === "minor") {
  const [maj, min, pat] = current.split(".").map(Number);
  next = arg === "patch" ? `${maj}.${min}.${pat + 1}` : `${maj}.${min + 1}.0`;
}
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`not a version: ${next}`);
  process.exit(1);
}

for (const { rel, re } of FILES) {
  const file = path.join(ROOT, rel);
  const src = readFileSync(file, "utf8");
  if (!re.test(src)) {
    console.error(`no version field found in ${rel} — aborting, nothing written`);
    process.exit(1);
  }
  writeFileSync(file, src.replace(re, `$1${next}$3`));
  console.log(`  ${rel}: ${current} -> ${next}`);
}

console.log(`\nNext:\n  git commit -am "..."\n  git tag -a v${next} -m "..." && git push origin main v${next}`);

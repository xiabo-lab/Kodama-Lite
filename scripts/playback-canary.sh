#!/usr/bin/env bash
#
# Playback canary — does extraction still work at all?
#
#   bash scripts/playback-canary.sh          # check; exit 0 healthy, 1 broken
#   bash scripts/playback-canary.sh --quiet  # only speak up when it's broken
#
# ## Why this exists
#
# On 2026-08-18 every player client in the app's ladder started returning
# 403 at once, and nothing played for an entire day. The journal had the
# answer the whole time. Nobody read it, because the only thing that
# noticed was a person in a car tapping play — which is the worst possible
# place to discover it and the last possible moment to do anything.
#
# So this asks the same question the app asks, on a timer, somewhere you
# can see the answer: fetch a few real bytes of a known-good track. It
# deliberately does NOT go through the app — the app caches, and a cache
# hit would report health long after extraction died.
#
# Run it from the `kodama-canary` systemd timer (see README). It writes a
# one-line verdict to the journal, which is where `journalctl -t
# kodama-canary` and any future alerting can find it.

set -uo pipefail

# A track chosen to be boring on purpose: old, popular, not region-locked,
# not age-gated, not Premium-only. If this one stops resolving, the problem
# is extraction and not the video.
#
# `me` is Rick Astley — Never Gonna Give You Up. It has outlived every
# other candidate anyone has ever picked for this job.
CANARY_ID="${CANARY_ID:-dQw4w9WgXcQ}"

# The whole track is fetched, not a slice.
#
# A partial fetch would not reproduce the failure this canary exists for.
# During the 2026-08-18 outage the FIRST chunk downloaded fine and the
# second 403'd, because the media URL carried no PO token — so a canary
# that stopped after 256KB would have reported everything healthy for the
# entire day. `--get-url` is even weaker: extraction succeeded throughout,
# and only the download failed.
#
# It costs about 5MB per run. On a metered 5G link that is worth it once a
# day; lower the timer's frequency before trimming the download.
TIMEOUT="${TIMEOUT:-180}"
TAG="kodama-canary"

quiet=0
[ "${1:-}" = "--quiet" ] && quiet=1

# The same locations `playback::server` puts on the yt-dlp child's PATH. A
# systemd timer inherits an even barer environment than the app does, and
# without Deno on PATH the JS-challenge tiers fail — which would make the
# canary cry wolf about a perfectly healthy app.
export PATH="$HOME/.deno/bin:$HOME/.bun/bin:/usr/local/bin:$PATH"

# say <message> [priority]
#
# `$1` only — an earlier version printed `"$*"`, which appended the
# priority argument to every error line ("…403: Forbidden err").
say() {
  local msg="$1" prio="${2:-info}"
  # Journal when it's there (the timer's normal home), stdout when a person
  # is running it by hand.
  if command -v systemd-cat >/dev/null 2>&1 && [ ! -t 1 ]; then
    printf '%s\n' "$msg" | systemd-cat -t "$TAG" -p "$prio"
  fi
  [ "$quiet" -eq 1 ] && [ "${IS_FAILURE:-0}" -eq 0 ] && return 0
  printf '%s\n' "$msg"
}

# The app's managed copy, not whatever is on PATH — testing a different
# binary than the app runs would make this canary a liar. `YTDLP=` in the
# environment overrides it, which is how you ask "would the version I am
# about to ship have fixed this?" without installing it first.
YTDLP="${YTDLP:-}"
[ -n "$YTDLP" ] && [ ! -x "$YTDLP" ] && { echo "YTDLP=$YTDLP is not executable" >&2; exit 2; }
for candidate in \
  "$YTDLP" \
  "$HOME/.local/share/com.xiabolab.kodamalite/bin/yt-dlp" \
  "$(command -v yt-dlp 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then YTDLP="$candidate"; break; fi
done

if [ -z "$YTDLP" ]; then
  IS_FAILURE=1 say "BROKEN: no yt-dlp binary found (app has not downloaded it yet?)" err
  exit 1
fi

version=$("$YTDLP" --version 2>/dev/null || echo unknown)

# Is the network even up? Without this the canary blames extraction every
# time the car is in a tunnel, and an alert that fires for the wrong reason
# is one people learn to ignore.
if ! curl -fsS --max-time 10 -o /dev/null https://www.youtube.com 2>/dev/null; then
  say "SKIP: no internet — not a playback verdict (yt-dlp $version)"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# `--downloader` is deliberately not set, and the format selector is the
# app's: this must exercise the same built-in HTTP downloader with the same
# format, because that downloader's request shape is exactly what
# googlevideo started rejecting.
#
# No `--extractor-args` either — matching the app's unpinned lead tier, so
# a green canary means the tier the app actually reaches for is working.
if timeout "$TIMEOUT" "$YTDLP" \
     --no-warnings --no-playlist \
     -f 'bestaudio[ext=webm]/bestaudio' \
     -o "$tmp/canary.%(ext)s" \
     "https://www.youtube.com/watch?v=$CANARY_ID" >"$tmp/log" 2>&1
then
  got=$(find "$tmp" -type f ! -name log -printf '%s\n' 2>/dev/null | sort -rn | head -1)
  got=${got:-0}
  if [ "$got" -gt 0 ]; then
    say "OK: playback healthy — fetched $got bytes (yt-dlp $version)"
    exit 0
  fi
  IS_FAILURE=1 say "BROKEN: yt-dlp exited 0 but produced no audio (yt-dlp $version)" err
  IS_FAILURE=1 say "$(tail -3 "$tmp/log")" err
  exit 1
fi

IS_FAILURE=1 say "BROKEN: could not fetch a known-good track (yt-dlp $version)" err
IS_FAILURE=1 say "$(grep -m3 -i 'error' "$tmp/log" || tail -3 "$tmp/log")" err
exit 1

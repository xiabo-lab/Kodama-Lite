#!/usr/bin/env bash
#
# Update Kodama-Lite on a Raspberry Pi from the latest GitHub release.
#
#   bash scripts/update-pi.sh          # check, then install if newer
#   bash scripts/update-pi.sh --check  # report only, change nothing
#
# Ported from YTMLite's scripts/update-pi.sh — same rationale: Tauri's
# updater can only install AppImage bundles on Linux, and this app ships a
# .deb so it stays integrated with apt and the desktop menu. This script is
# the supported update path: it downloads the prebuilt arm64 .deb built by
# .github/workflows/release.yml, so updating costs seconds rather than a
# source rebuild.

set -euo pipefail

# TODO: fill in once the GitHub repo exists, e.g. "xiabo-lab/kodama-lite".
REPO="REPLACE_ME/kodama-lite"
# The .deb package name Tauri derives from productName by kebab-casing it.
# "Kodama-Lite" -> "kodama-lite". If productName ever changes, this must
# change with it or the script will think the app is not installed and
# reinstall every time.
PKG="kodama-lite"
API="https://api.github.com/repos/${REPO}/releases/latest"

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

check_only=0
[ "${1:-}" = "--check" ] && check_only=1

command -v curl >/dev/null || die "curl is required."

# ── What's installed now ──────────────────────────────────────────────

if installed=$(dpkg-query -W -f='${Version}' "$PKG" 2>/dev/null); then
  log "Installed: $PKG $installed"
else
  installed=""
  warn "$PKG is not installed yet — this will install it fresh."
fi

# ── What's published ──────────────────────────────────────────────────

log "Checking $REPO for the latest release"
release=$(curl -fsSL "$API" 2>/dev/null) || die \
  "Could not reach the GitHub API. Check the network, or that $REPO has a
     *published* release — draft releases are not returned by /releases/latest."

tag=$(printf '%s' "$release" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
[ -n "$tag" ] || die "No published release found for $REPO yet."

# arm64 .deb asset. Tauri names it Kodama-Lite_<version>_arm64.deb.
url=$(printf '%s' "$release" \
      | grep -oE '"browser_download_url": *"[^"]+_arm64\.deb"' \
      | sed -E 's/.*"(https[^"]+)"/\1/' | head -1)
[ -n "$url" ] || die "Release $tag has no arm64 .deb asset attached."

remote_ver="${tag#v}"
log "Latest release: $tag"

if [ -n "$installed" ] && [ "$installed" = "$remote_ver" ]; then
  log "Already up to date ($installed). Nothing to do."
  exit 0
fi

if [ -n "$installed" ]; then
  # dpkg decides what "newer" means; don't guess with string compares.
  if dpkg --compare-versions "$remote_ver" le "$installed"; then
    log "Installed version ($installed) is not older than $remote_ver. Nothing to do."
    exit 0
  fi
  log "Update available: $installed -> $remote_ver"
else
  log "Will install: $remote_ver"
fi

if [ "$check_only" -eq 1 ]; then
  log "--check given; stopping before download."
  exit 0
fi

# ── Download + install ────────────────────────────────────────────────

# Staged in /tmp on purpose: apt drops privileges to the `_apt` user to
# fetch, and it cannot traverse a 0700 home directory — installing from
# ~/ works but prints a confusing "Download is performed unsandboxed"
# notice. /tmp is world-readable, so the sandbox is happy.
deb="/tmp/$(basename "$url")"
log "Downloading $(basename "$url")"
curl -fL --progress-bar -o "$deb" "$url" || die "Download failed."
chmod 644 "$deb"

log "Installing (sudo)"
sudo apt-get install -y "$deb"
rm -f "$deb"

log "Now installed: $(dpkg-query -W -f='${Version}' "$PKG" 2>/dev/null)"
echo
echo "Restart Kodama-Lite to pick up the new version."

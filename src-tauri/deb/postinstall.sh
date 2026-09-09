#!/bin/sh
# Keep the system-level Tesla Bluetooth helper in step with OTA app updates.
# The source is package-owned under /usr/lib; the setup-created systemd unit
# deliberately continues to run the compatibility path under /usr/local/bin.

set -eu

PACKAGED_HELPER=/usr/lib/kodama-lite/tesla-bt-connect.sh
LIVE_HELPER=/usr/local/bin/tesla-bt-connect.sh
SERVICE=tesla-bt-connect.service

install -D -m 0755 "$PACKAGED_HELPER" "$LIVE_HELPER"

# Existing Pis have this unit from tesla-bt-setup.sh. Do not make installing
# the desktop app fail on another Debian machine where the service is absent
# or systemd is not currently running.
if command -v systemctl >/dev/null 2>&1 && \
   systemctl cat "$SERVICE" >/dev/null 2>&1; then
  systemctl --no-block restart "$SERVICE" || true
fi

exit 0

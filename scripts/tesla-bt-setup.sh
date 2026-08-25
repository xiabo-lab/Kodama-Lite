#!/usr/bin/env bash
#
# Install (or re-install) everything the Tesla auto-connect needs on the Pi.
# Idempotent: safe to run on every deploy, and safe to run twice.
#
#   scp scripts/tesla-bt-*.sh raspberrypi5:/tmp/
#   ssh raspberrypi5 'sudo bash /tmp/tesla-bt-setup.sh'
#
# It does NOT pair and it does NOT re-pair. The bond and its link key are
# left exactly as they are — the only device-level change is setting
# `Trusted`, which is one flag in the bond's info file.
#
# What it changes, and why each one is here:
#
#   /etc/bluetooth/main.conf
#     FastConnectable = true
#       Default is false, which leaves the adapter on the slow page-scan
#       interval (R1, ~1.28s). The Tesla pages the Pi when it wakes and
#       gives up quickly; a Pi that only listens for a page every 1.28s
#       misses a meaningful share of those. `true` switches to the fast
#       interval so the Pi answers promptly. The documented tradeoff is
#       power, which is irrelevant on a car-powered appliance.
#
#     [Policy] ReconnectAttempts / ReconnectIntervals
#       BlueZ's own policy plugin already reconnects A2DP after a link
#       loss (ReconnectUUIDs defaults include 110a/110b), but the attempt
#       count and schedule are only defaults until they are written down.
#       Making them explicit means a mid-drive drop is chased by BlueZ on
#       a sane ramp as well as by tesla-bt-connect.
#
#   /usr/local/bin/tesla-bt-connect.sh + its unit
#     The connect loop itself. See the long comment at the top of that
#     script for the boot race it exists to close.
#
# Everything here is reversible:
#   sudo cp /etc/bluetooth/main.conf.kodama-bak /etc/bluetooth/main.conf
#   sudo systemctl restart bluetooth

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (sudo bash $0)" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF=/etc/bluetooth/main.conf
BAK=/etc/bluetooth/main.conf.kodama-bak

say() { printf '[tesla-bt-setup] %s\n' "$*"; }

# ── 1. main.conf ──────────────────────────────────────────────────────

[ -f "$BAK" ] || { cp -a "$CONF" "$BAK"; say "backed up $CONF -> $BAK"; }

# Set KEY=VALUE inside [SECTION], whether the key is absent, commented out,
# or already set to something else. Deliberately does not use `crudini`
# (not installed) or rewrite the file wholesale — a BlueZ main.conf is
# mostly documentation and losing it would make the next person's job
# harder.
set_ini() {
  local section="$1" key="$2" value="$3" file="$4"
  python3 - "$section" "$key" "$value" "$file" <<'PY'
import re, sys
section, key, value, path = sys.argv[1:5]
lines = open(path, encoding="utf-8").read().split("\n")

# Find the section, adding it if it isn't there.
sec_at = None
for i, line in enumerate(lines):
    if line.strip().lower() == f"[{section}]".lower():
        sec_at = i
        break
if sec_at is None:
    lines += [f"[{section}]"]
    sec_at = len(lines) - 1

# The section runs until the next [Header].
end = len(lines)
for i in range(sec_at + 1, len(lines)):
    if re.match(r"^\s*\[", lines[i]):
        end = i
        break

want = f"{key} = {value}"
pattern = re.compile(rf"^\s*#?\s*{re.escape(key)}\s*=", re.IGNORECASE)
for i in range(sec_at + 1, end):
    if pattern.match(lines[i]):
        lines[i] = want
        break
else:
    lines.insert(end, want)

open(path, "w", encoding="utf-8").write("\n".join(lines))
PY
  say "$file: [$section] $key = $value"
}

set_ini General FastConnectable true "$CONF"
set_ini Policy  AutoEnable true "$CONF"
set_ini Policy  ReconnectAttempts 7 "$CONF"
set_ini Policy  ReconnectIntervals "1,2,4,8,16,32,64" "$CONF"

# ── 2. the connect loop ───────────────────────────────────────────────

install -m 0755 "$SRC_DIR/tesla-bt-connect.sh" /usr/local/bin/tesla-bt-connect.sh
say "installed /usr/local/bin/tesla-bt-connect.sh"

cat > /etc/systemd/system/tesla-bt-connect.service <<'UNIT'
# Auto-connect the already-paired Tesla, and diagnose it when that fails.
#
# `After=bluetooth.service` is necessary but NOT sufficient: the A2DP
# endpoints come from PipeWire in the *user* session, which starts later
# and cannot be ordered against from a system unit. The script waits for
# them itself by watching the adapter's UUIDs — see its header.
[Unit]
Description=Auto-connect Bluetooth A2DP to the Tesla
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=simple
ExecStart=/usr/local/bin/tesla-bt-connect.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
say "installed /etc/systemd/system/tesla-bt-connect.service"

# ── 3. apply ──────────────────────────────────────────────────────────

systemctl daemon-reload
systemctl restart bluetooth
say "restarted bluetooth (FastConnectable needs a daemon restart to take)"
sleep 2
systemctl enable --now tesla-bt-connect.service >/dev/null
systemctl restart tesla-bt-connect.service
say "restarted tesla-bt-connect"

say "done. Watch it with: journalctl -u tesla-bt-connect -f"

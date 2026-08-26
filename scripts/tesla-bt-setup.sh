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
#     [Policy] ReconnectAttempts = 0
#       BlueZ's policy plugin pages a device after a link loss. On this
#       Tesla that is pure harm and it was measured doing harm: every page
#       the Pi sends is rejected `Connection Rejected due to Unacceptable
#       BD_ADDR (0x0f)` — the car never accepts an inbound link — and
#       while the controller is paging it is not page-SCANNING, so it is
#       deaf to the car's own attempts for the duration. A capture during
#       a 2-minute reconnect test showed 4 outgoing pages from this plugin
#       alone, with the script already silent. Zero means the radio spends
#       its whole time listening, which is the only thing that works here.
#
#       Set it back to 7 (with ReconnectIntervals) for a head unit that
#       actually accepts inbound connections.
#
#   /usr/local/bin/tesla-bt-connect.sh + its unit
#     The connect loop itself. See the long comment at the top of that
#     script for the boot race it exists to close.
#
#   ~<user>/.config/wireplumber/wireplumber.conf.d/52-no-bt-autoconnect.conf
#     bluez5.auto-connect = [ ]
#       WirePlumber pages the car on every start, behind both silencers
#       above, and it has to be a *rule* rather than a monitor property to
#       take effect. See section 1c for the capture that found it.
#
# Everything here is reversible:
#   sudo cp /etc/bluetooth/main.conf.kodama-bak /etc/bluetooth/main.conf
#   rm ~/.config/wireplumber/wireplumber.conf.d/52-no-bt-autoconnect.conf
#   sudo systemctl restart bluetooth
#   sudo rm /etc/cloud/cloud-init.disabled
#   sudo loginctl disable-linger fuwenxu

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (sudo bash $0)" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF=/etc/bluetooth/main.conf
BAK=/etc/bluetooth/main.conf.kodama-bak
# The desktop user whose session runs PipeWire/WirePlumber.
BT_USER="${TESLA_PW_USER:-fuwenxu}"

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
# AutoEnable=FALSE, deliberately. With it true, bluetoothd powers the
# adapter on the moment it starts (5.45s) — but the A2DP endpoints do not
# exist until ~8s, so anything that pages in between completes an ACL and
# then fails AVDTP with `Protocol not available`, burning one of Tesla's
# ~5 attempts. tesla-bt-connect powers the radio on itself, once A2DP
# Source and AVRCP Target are actually registered.
#
# The service is Restart=always and powers the radio on regardless after
# TESLA_GATE_MAX_WAIT_SEC, so a broken audio stack degrades to "Bluetooth
# with no sound" rather than "no Bluetooth". If you ever remove that
# service, set this back to true or the adapter will stay dark.
set_ini Policy  AutoEnable false "$CONF"
set_ini Policy  ReconnectAttempts 0 "$CONF"
# Class of Device. The adapter was advertising 0x4c0000, whose major device
# class field is 0 — "Miscellaneous". Tesla is a car kit that connects to
# phones and media devices; announcing ourselves as an unclassified nothing
# is at best unhelpful.
#
# 0x00041C is Audio/Video (major 0x04) : Portable Audio (minor 0x07), which
# is what this device honestly is — an A2DP Source with AVRCP. Not an
# iPhone impersonation; the standards-compliant class for what it does.
# BlueZ takes only the major/minor bits from here, deriving the service
# class bits from the profiles actually registered.
set_ini General Class 0x00041C "$CONF"

# ── 1b. get Bluetooth up EARLY ────────────────────────────────────────
#
# The whole problem is a race: Tesla pages its priority device when the car
# wakes, gives up after ~5 tries, and never retries. The Pi only gets power
# when the ignition does, so every second before the radio is listening is
# a second of that window thrown away. Two things were holding it back.

# cloud-init sits on bluetooth.service's critical path:
#   cloud-init-main +758ms -> cloud-init-local +159ms -> cloud-init-network
#   -> sysinit.target @2.879s -> basic.target -> bluetooth.service
# This is a fixed-image car appliance; cloud-init has nothing to do here.
# The documented disable switch, not a purge, so it is trivially undone.
if [ -d /etc/cloud ] && [ ! -f /etc/cloud/cloud-init.disabled ]; then
  touch /etc/cloud/cloud-init.disabled
  say "disabled cloud-init (was ~1.5s on bluetooth.service critical path)"
fi

# The A2DP endpoints come from WirePlumber, which lives in the user session
# - and without linger, user@1000 does not start until lightdm has logged
# in: measured at 6.92s, with the endpoints landing at 8.14s. Lingering
# starts the user manager at boot instead, so PipeWire/WirePlumber no
# longer wait for the graphical stack. Bluetooth must not depend on the UI.
if [ "$(loginctl show-user "$BT_USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$BT_USER"
  say "enabled linger for $BT_USER (audio stack no longer waits for the desktop)"
fi

# Linger alone bought nothing, because the user manager has a second gate:
#
#   user@1000.service <- systemd-user-sessions.service <- network.target
#                     <- NetworkManager.service (+1.118s)
#
# So the A2DP endpoints were waiting on NetworkManager, which audio does not
# need in any way. `systemd-user-sessions` exists to remove /run/nologin and
# gate interactive logins; a lingering user manager has no business waiting
# for it. Drop that one edge and keep every other ordering intact.
#
# Written as a full re-declaration because `After=` is additive — the empty
# assignment first is what clears the inherited list.
DROPIN=/etc/systemd/system/user@$(id -u "$BT_USER").service.d
mkdir -p "$DROPIN"
cat > "$DROPIN/10-kodama-early-audio.conf" <<'UNIT'
# Start the user manager (and with it PipeWire/WirePlumber, and with them
# the Bluetooth A2DP endpoints) without waiting for the network.
#
# Measured on this Pi: user@1000 at 7.23s -> the A2DP endpoints at 8.16s,
# with the radio itself usable at 5.45s. Every one of those seconds is a
# second of Tesla's connect window spent unable to complete a link.
#
# Revert: rm this file, systemctl daemon-reload.
[Unit]
After=
After=systemd-logind.service dbus.service user-runtime-dir@%i.service
After=systemd-journald.socket sysinit.target basic.target user-%i.slice
UNIT
say "user@$(id -u "$BT_USER") no longer waits for network.target"

# That alone changes nothing, because the edge is owned by the OTHER unit:
# systemd-user-sessions.service declares Before=user@1000.service, and a
# drop-in on user@1000 cannot remove a dependency someone else declares.
#
# systemd-user-sessions itself waits for network.target purely so that
# network-backed name lookups (NIS/LDAP) resolve before logins are allowed.
# This Pi has one local account and no directory service, so that ordering
# costs 1.1s of NetworkManager startup and buys nothing.
#
# Revert: rm this file, systemctl daemon-reload.
SUS=/etc/systemd/system/systemd-user-sessions.service.d
mkdir -p "$SUS"
cat > "$SUS/10-kodama-no-network-wait.conf" <<'UNIT'
# Permit user sessions without waiting for the network.
#
# The only account on this machine is local, so nothing here needs a
# network name lookup. Dropping the edge lets the user manager — and with
# it PipeWire, WirePlumber and the Bluetooth A2DP endpoints — start about
# 1.1s earlier, which is 1.1s less of Tesla's connect window spent with a
# radio that answers pages it cannot yet service.
[Unit]
After=
After=remote-fs.target nss-user-lookup.target home.mount
UNIT
say "systemd-user-sessions no longer waits for network.target"

# ── 1c. stop WirePlumber paging the car ───────────────────────────────
#
# Two silencers were already in place — this script's listen mode and
# [Policy] ReconnectAttempts=0 above — and the Pi was STILL paging the
# Tesla on every single boot. Caught 2026-08-25 with `dbus-monitor
# --system` on interface=org.bluez.Device1: about two seconds after every
# WirePlumber start it calls
#
#   org.bluez.Device1.ConnectProfile("0000110b-...")   <- A2DP AudioSink
#
# on the car. In the journal that surfaces as
#
#   avdtp_connect_cb() connect to 4C:FC:AA:55:B0:60: Connection refused (111)
#
# with the car present, and "Host is down (112)" with the car absent. The
# 112 is the tell: a page timeout can only happen if we paged, so an absent
# car proves the Pi initiated rather than merely answered.
#
# It matters for the same reason as everything else here: a controller that
# is PAGING is not page-SCANNING, so each attempt is a window in which the
# car's own attempt goes unheard — and the car tries about five times, then
# gives up until it next wakes.
#
# The knob is `bluez5.auto-connect`, and the trap is that it is a property
# of the DEVICE (api.bluez5.device, read in bluez5-device.c), NOT of the
# monitor. Setting it under `monitor.bluez.properties` does nothing, and
# does nothing SILENTLY. That the section is read at all was confirmed by
# setting `bluez5.codecs` there, which really did cut the codec list from
# 19 to 1 — so an ineffective key there looks exactly like a working one.
# It has to be a rule, because scripts/monitors/bluez.lua runs
# `match_rules_update_properties(config.rules)` over the properties it
# hands to SpaDevice(). Note that same script creates the device for a
# DISCONNECTED car too (it creates it, then deactivates it), which is
# exactly why a car thirty miles away still got paged.
#
# Revert: rm this file, then, as the user,
#   systemctl --user restart wireplumber
PW_DIR="$(getent passwd "$BT_USER" | cut -d: -f6)/.config/wireplumber/wireplumber.conf.d"
install -d -o "$BT_USER" -g "$BT_USER" "$PW_DIR"
cat > "$PW_DIR/52-no-bt-autoconnect.conf" <<'PWCONF'
# Never let WirePlumber initiate a Bluetooth connection.
#
# This car refuses every Pi-initiated link at HCI level (Connect Complete ->
# "Connection Rejected due to Unacceptable BD_ADDR (0x0f)"), and paging it
# deafens our own radio to the car's own attempts. The Pi's job is to sit
# still and answer.
#
# Installed by scripts/tesla-bt-setup.sh — the long comment is there.
monitor.bluez.rules = [
  {
    matches = [
      { device.name = "~bluez_card.*" }
    ]
    actions = {
      update-props = {
        bluez5.auto-connect = [ ]
      }
    }
  }
]
PWCONF
chown "$BT_USER:$BT_USER" "$PW_DIR/52-no-bt-autoconnect.conf"
say "installed $PW_DIR/52-no-bt-autoconnect.conf (WirePlumber no longer pages the car)"

# The adapter must not sit in inquiry scan either. An earlier debugging
# session set Discoverable=true with DiscoverableTimeout=0 while testing
# whether the car would ever come looking for an absent device (it does
# not, at all), and that persisted in the adapter's BlueZ settings across
# every reboot since. Inquiry scan interleaves with the page scan we
# actually depend on, and buys nothing for a device that is already bonded.
for s in /var/lib/bluetooth/*/settings; do
  [ -f "$s" ] || continue
  if grep -q '^Discoverable=true$' "$s"; then
    sed -i 's/^Discoverable=true$/Discoverable=false/' "$s"
    say "cleared leftover Discoverable=true in $s"
  fi
done

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

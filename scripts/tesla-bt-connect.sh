#!/usr/bin/env bash
#
# Keep the A2DP link to the Tesla up — and record WHY it failed when it does.
#
# Installed on the Pi at /usr/local/bin/tesla-bt-connect.sh and run by
# /etc/systemd/system/tesla-bt-connect.service (root, Restart=always).
# Kept here so a reimage doesn't lose it.
#
#   journalctl -u tesla-bt-connect -f              # watch it live
#   journalctl -u tesla-bt-connect -p warning -S today   # just the failures
#
# WHY THIS EXISTS. The version this replaced ran `bluetoothctl connect` with
# both stdout and stderr sent to /dev/null, so after a drive where the car
# never connected there was nothing at all to read — you could not tell a
# sleeping car from a refusing car from a broken adapter. Everything below is
# in service of answering that one question from the journal alone.
#
# HOW TO READ A FAILURE LINE. Each one carries the BlueZ error, a verdict, and
# a probe result. The verdict comes from the error string:
#
#   br-connection-page-timeout   the car never answered            → CAR
#   br-connection-refused        the car answered and said no      → CAR
#   InProgress / NotReady        our own adapter                   → PI
#   UnknownObject                no bond on this adapter           → PI
#
# `br-connection-refused` alone is too vague — it covers "busy", "asleep" and
# "refuses this address" — so on the first failure of a streak (and whenever
# the error changes) we also ask the car its name over the air. A name coming
# back means the car is AWAKE AND REFUSING; silence means it isn't reachable.
# That pair is what separates "the car is asleep" from "something is already
# using the car's Bluetooth", which is the likeliest cause of an intermittent
# no-connect: a phone that won the race to the head unit.
#
# For the cases even that can't split, capture HCI status codes directly:
#   sudo timeout 20 btmon | grep Status:
# `Connection Rejected due to Unacceptable BD_ADDR (0x0f)` is the car's policy
# on who may initiate, and no amount of retrying changes it.
#
# DESIGN NOTES
#   * Everything is addressed by BD_ADDR, never by hci index. Plugging a USB
#     adapter in makes it hci0 and the built-in hci1, and `bluetoothctl` with
#     no `select` would then talk to the adapter that holds no bond. bluetoothctl
#     5.82 has no --adapter flag and `select` does not survive between one-shot
#     invocations, so connects go through busctl on an explicit object path.
#     That also yields precise D-Bus error names, which bluetoothctl swallows.
#   * No discovery scan, ever. Scanning has never helped here — in every
#     observed failure the car was answering and refusing — and it floods the
#     2.4GHz radio the Pi 5 shares with WiFi, which is the known cause of the
#     A2DP stuttering. It would trade a connect problem for an audio one.
#   * Disconnects are noticed from a BlueZ D-Bus signal rather than by polling,
#     so a mid-drive drop is seen at once instead of up to 20s later.
#   * The profile is checked, not just the connection. The documented failure
#     mode is a link that connects fine and lands on headset-head-unit (HFP)
#     instead of a2dp-sink: silence, no track info, dead transport buttons,
#     while every connection-level check says healthy.
#   * This script REPORTS a bad profile, it does not fix one. `pactl` is not
#     installed and `wpctl` cannot switch card profiles, so the only lever
#     available is a disconnect/reconnect cycle — too blunt to fire
#     automatically off a heuristic that has not yet been seen to trigger.

set -uo pipefail

MAC="${TESLA_MAC:-4C:FC:AA:55:B0:60}"
ADAPTER="${TESLA_ADAPTER:-2C:CF:67:58:CF:FE}"   # built-in Broadcom; the car lives here
PW_USER="${TESLA_PW_USER:-fuwenxu}"             # PipeWire runs in the user session,
PW_UID="${TESLA_PW_UID:-1000}"                  # this script runs as root

FAST_RETRY_SEC="${TESLA_FAST_RETRY_SEC:-5}"
FAST_RETRY_COUNT="${TESLA_FAST_RETRY_COUNT:-12}"
SLOW_RETRY_SEC="${TESLA_SLOW_RETRY_SEC:-15}"
SUMMARY_EVERY_SEC="${TESLA_SUMMARY_EVERY_SEC:-300}"
CONNECT_TIMEOUT="${TESLA_CONNECT_TIMEOUT:-35}"

MAC_PATH="${MAC//:/_}"
REASON=""

# systemd reads these prefixes as syslog levels, so `journalctl -p warning`
# filters to the interesting lines.
log()  { printf '<6>[bt] %s\n' "$*"; }
warn() { printf '<4>[bt] %s\n' "$*"; }
err()  { printf '<3>[bt] %s\n' "$*"; }

# ── adapter / device plumbing ─────────────────────────────────────────

# The hci index for our adapter's address. Re-derived every iteration:
# indexes move when USB adapters come and go, addresses don't.
adapter_hci() {
  hciconfig 2>/dev/null | awk -v want="$ADAPTER" '
    /^hci[0-9]/   { d = $1; sub(":", "", d) }
    /BD Address/  { if ($3 == want) { print d; exit } }
  '
}

# busctl prints "b true" / "s \"Some Name\"" — strip the type letter and quotes.
bluez_prop() {
  busctl get-property org.bluez "$1" "$2" "$3" 2>/dev/null \
    | awk '{ $1 = ""; sub(/^ /, ""); gsub(/^"|"$/, ""); print }'
}

is_connected() { [ "$(bluez_prop "$1" org.bluez.Device1 Connected)" = "true" ]; }

ensure_powered() {
  local hci="$1" tries=0
  while [ "$tries" -lt 30 ]; do
    hciconfig "$hci" 2>/dev/null | grep -q 'UP RUNNING' && return 0
    busctl set-property org.bluez "/org/bluez/$hci" org.bluez.Adapter1 \
      Powered b true >/dev/null 2>&1
    sleep 1
    tries=$((tries + 1))
  done
  return 1
}

# Every fresh pairing has landed Trusted=false twice now. Untrusted means BlueZ
# won't auto-authorise the car's incoming connection, and nothing else reports it.
check_bond() {
  local dev="$1" paired trusted
  paired=$(bluez_prop "$dev" org.bluez.Device1 Paired)
  trusted=$(bluez_prop "$dev" org.bluez.Device1 Trusted)
  [ "$paired" = "true" ]  || warn "device is NOT paired (Paired=${paired:-?}) on $ADAPTER — auto-connect cannot work"
  [ "$trusted" = "true" ] || warn "device is NOT trusted (Trusted=${trusted:-?}) — fix with: bluetoothctl trust $MAC"
}

# ── connecting ────────────────────────────────────────────────────────

attempt_connect() {
  local dev="$1" out rc
  out=$(timeout $((CONNECT_TIMEOUT + 5)) busctl call org.bluez "$dev" \
        org.bluez.Device1 Connect --timeout="$CONNECT_TIMEOUT" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then REASON=""; return 0; fi
  REASON=$(printf '%s' "$out" | head -1 | sed 's/^Call failed: //')
  [ "$rc" -eq 124 ] && REASON="local-timeout-after-${CONNECT_TIMEOUT}s"
  [ -z "$REASON" ] && REASON="unknown (rc=$rc)"
  return 1
}

classify() {
  case "$1" in
    *page-timeout*)       echo "CAR — never answered the page (asleep, or out of range)" ;;
    *refused*)            echo "CAR — answered, then refused the link" ;;
    *profile-unavailable*) echo "CAR — link came up but no A2DP profile was offered" ;;
    *canceled*|*aborted*) echo "EITHER — attempt cancelled mid-flight" ;;
    *InProgress*)         echo "PI — an attempt was already running" ;;
    *NotReady*)           echo "PI — adapter not ready" ;;
    *UnknownObject*|*"Unknown object"*) echo "PI — no bond for this device on $ADAPTER" ;;
    *AlreadyConnected*)   echo "PI — BlueZ already considers it connected" ;;
    *local-timeout*)      echo "EITHER — BlueZ never returned" ;;
    *)                    echo "unclassified" ;;
  esac
}

# The discriminator bluetoothctl's error string cannot give you: a name coming
# back means the car is awake and refusing us specifically; silence means it is
# not reachable at all. Deliberately rare — it costs airtime on the same radio.
name_probe() {
  local n
  n=$(timeout 12 hcitool -i "$1" name "$MAC" 2>/dev/null | head -1)
  if [ -n "$n" ]; then
    echo "car ANSWERED a name request as \"$n\" — it is awake and refusing us"
  else
    echo "car did NOT answer a name request — asleep or out of range"
  fi
}

# ── profile ───────────────────────────────────────────────────────────

profile_report() {
  local dump names profs
  dump=$(sudo -u "$PW_USER" env XDG_RUNTIME_DIR="/run/user/$PW_UID" \
         timeout 10 pw-dump 2>/dev/null)
  if [ -z "$dump" ]; then
    warn "profile check: pw-dump returned nothing — PipeWire session not reachable"
    return
  fi
  # Scoped to this car's address. A bare "bluez" prefix also matches
  # bluez_midi.server, which is always present and would mask the
  # "connected but no audio path" case entirely.
  names=$(printf '%s' "$dump" | grep -o "\"node\.name\": *\"bluez[^\"]*${MAC_PATH}[^\"]*\"" \
          | sed 's/.*"bluez/bluez/; s/"$//' | sort -u | tr '\n' ' ')
  profs=$(printf '%s' "$dump" | grep -o '"api\.bluez5\.profile": *"[^"]*"' \
          | sed 's/.*: *"//; s/"$//' | sort -u | tr '\n' ' ')

  if [ -z "$names" ]; then
    warn "profile check: BlueZ reports connected but PipeWire has no bluez node — there is no audio path to the car"
    return
  fi
  log "profile check: nodes [ ${names}] profiles [ ${profs:-none reported} ]"
  case "$names $profs" in
    *headset*|*handsfree*|*hfp*|*hsp*)
      warn "profile check: an HFP/headset profile is active — this is the 'connected but silent, no track info, dead buttons' state. Recovery is a disconnect + reconnect." ;;
    *a2dp*)
      : ;;
    *)
      log "profile check: could not positively confirm a2dp-sink from the names above (not necessarily wrong — check them against a known-good drive)" ;;
  esac
}

# ── waiting ───────────────────────────────────────────────────────────

HAVE_DBUS_MONITOR=0
command -v dbus-monitor >/dev/null 2>&1 && HAVE_DBUS_MONITOR=1

# Block until BlueZ reports any property change, or $1 seconds pass. Not
# filtered to our device's object path on purpose: that path embeds the hci
# index, which is exactly the thing that is not stable here. Any BlueZ event
# just means "re-check state", which is cheap.
wait_for_bluez_event() {
  if [ "$HAVE_DBUS_MONITOR" -eq 1 ]; then
    timeout "$1" dbus-monitor --system \
      "type='signal',sender='org.bluez',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'" \
      2>/dev/null | grep -q -m1 'PropertiesChanged' || true
    sleep 1   # floor, so a burst of signals can't spin this loop
  else
    sleep "$1"
  fi
}

# ── preflight ─────────────────────────────────────────────────────────

log "starting — target $MAC via adapter $ADAPTER"
if [ "$HAVE_DBUS_MONITOR" -eq 1 ]; then
  log "bluez $(bluetoothctl --version 2>/dev/null | awk '{print $NF}'), event-driven disconnect detection"
else
  warn "bluez $(bluetoothctl --version 2>/dev/null | awk '{print $NF}'), dbus-monitor MISSING — falling back to polling"
fi

hci=$(adapter_hci)
if [ -n "$hci" ]; then
  log "adapter $ADAPTER is $hci"
  ensure_powered "$hci" || err "adapter $hci would not power on"
  check_bond "/org/bluez/$hci/dev_$MAC_PATH"
else
  err "adapter $ADAPTER is not present — waiting for it to appear"
fi

# ── main loop ─────────────────────────────────────────────────────────

fail_streak=0
last_reason=""
last_summary=0
was_connected=-1

while true; do
  hci=$(adapter_hci)
  if [ -z "$hci" ]; then
    err "adapter $ADAPTER not present"
    sleep 10
    continue
  fi
  dev="/org/bluez/$hci/dev_$MAC_PATH"

  if ! ensure_powered "$hci"; then
    err "adapter $hci is down and will not power on"
    sleep 10
    continue
  fi

  if is_connected "$dev"; then
    if [ "$was_connected" != "1" ]; then
      if [ "$fail_streak" -gt 0 ]; then
        log "CONNECTED to $MAC via $hci after $fail_streak failed attempt(s)"
      else
        log "CONNECTED to $MAC via $hci"
      fi
      check_bond "$dev"
      sleep 3          # give WirePlumber time to build the nodes
      profile_report
      was_connected=1
      fail_streak=0
      last_reason=""
    fi
    wait_for_bluez_event 60
    if ! is_connected "$dev"; then
      warn "DISCONNECTED from $MAC — reconnecting"
      was_connected=0
    fi
    continue
  fi

  was_connected=0
  fail_streak=$((fail_streak + 1))
  attempt_connect "$dev" && continue

  now=$(date +%s)
  probe_now=0
  [ "$fail_streak" -eq 1 ]                            && probe_now=1
  [ "$REASON" != "$last_reason" ]                     && probe_now=1
  [ $((now - last_summary)) -ge "$SUMMARY_EVERY_SEC" ] && probe_now=1

  if [ "$probe_now" -eq 1 ]; then
    warn "attempt #$fail_streak failed: $REASON | $(classify "$REASON") | $(name_probe "$hci")"
    last_summary=$now
  elif [ "$fail_streak" -le "$FAST_RETRY_COUNT" ]; then
    warn "attempt #$fail_streak failed: $REASON | $(classify "$REASON")"
  fi
  last_reason="$REASON"

  if [ "$fail_streak" -le "$FAST_RETRY_COUNT" ]; then
    sleep "$FAST_RETRY_SEC"
  else
    sleep "$SLOW_RETRY_SEC"
  fi
done

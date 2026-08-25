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
# ─────────────────────────────────────────────────────────────────────
# THE BOOT RACE THIS EXISTS TO CLOSE (measured 2026-08-24)
# ─────────────────────────────────────────────────────────────────────
#
# On 5 consecutive boots, the FIRST connect attempt failed the same way:
#
#   17:21:06  bluetoothd 5.82 starts; this script starts
#   17:21:07  bluetoothd: a2dp-sink profile connect failed for <car>:
#                         Protocol not available
#   17:21:08  wireplumber starts
#   17:21:09  bluetoothd: Endpoint registered: /MediaEndpoint/A2DPSource/sbc
#
# The script was connecting one to two seconds before **PipeWire had
# registered any A2DP endpoint with bluetoothd**. With no local endpoint
# there is no A2DP to offer, so BlueZ refuses its own connect with
# `br-connection-profile-unavailable`. The old classifier called that
# "CAR — link came up but no A2DP profile was offered", which pointed the
# blame at exactly the wrong end for weeks.
#
# The connect-level cost of that is small — the retry a few seconds later
# succeeds. The REAL cost is what it does to the car's own reconnect: the
# Pi pages the car, takes an ACL link up, fails the profile and drops it,
# all inside the window where the Tesla is trying to reconnect on its own.
# A head unit that gets a failed profile connect stops trying and waits for
# a human to press Connect, which is the reported "auto-connect works less
# than half the time".
#
# So: nothing is attempted until the adapter actually advertises A2DP
# Source (0000110a) and AVRCP Target (0000110c). Those UUIDs appear on
# /org/bluez/hciN exactly when PipeWire's endpoints land, which makes them
# the authoritative "the audio stack is ready" signal — far better than
# sleeping and hoping.
#
# ─────────────────────────────────────────────────────────────────────
# THE SECOND HALF: Trusted=false
# ─────────────────────────────────────────────────────────────────────
#
# The bond has read `Trusted=false` on every boot since it was made. An
# untrusted device's *incoming* profile connections need an agent to
# authorise them, and this Pi runs none (no bt-agent, no interactive
# bluetoothctl). So when the car initiates — the direction that actually
# works reliably on this car — BlueZ has nobody to ask and the connection
# is refused. Trusting the device removes the authorisation step entirely.
#
# This does NOT re-pair and does NOT touch the link key: it flips one flag
# in /var/lib/bluetooth/<adapter>/<device>/info, which bluetoothd persists.
#
# ─────────────────────────────────────────────────────────────────────
# HOW TO READ A FAILURE LINE
# ─────────────────────────────────────────────────────────────────────
#
# Each one carries the BlueZ error, a verdict, and sometimes a probe result:
#
#   br-connection-page-timeout   the car never answered            → CAR
#   br-connection-refused        the car answered and said no      → CAR
#   br-connection-profile-unavailable  usually OUR endpoints       → PI
#   InProgress / NotReady        our own adapter                   → PI
#   UnknownObject                no bond on this adapter           → PI
#
# `br-connection-refused` alone is too vague — it covers "busy", "asleep"
# and "refuses this address" — so on the first failure of a streak (and
# whenever the error changes) we also ask the car its name over the air. A
# name coming back means the car is AWAKE AND REFUSING; silence means it
# isn't reachable. That pair is what separates "the car is asleep" from
# "something is already using the car's Bluetooth", which is the likeliest
# remaining cause of an intermittent no-connect: a phone that won the race
# to the head unit.
#
# For the cases even that can't split, capture HCI status codes directly:
#   sudo timeout 20 btmon | grep Status:
# `Connection Rejected due to Unacceptable BD_ADDR (0x0f)` is the car's
# policy on who may initiate, and no amount of retrying changes it.
#
# DESIGN NOTES
#   * Everything is addressed by BD_ADDR, never by hci index. Plugging a USB
#     adapter in makes it hci0 and the built-in hci1, and `bluetoothctl` with
#     no `select` would then talk to the adapter that holds no bond. bluetoothctl
#     5.82 has no --adapter flag and `select` does not survive between one-shot
#     invocations, so connects go through busctl on an explicit object path.
#     That also yields precise D-Bus error names, which bluetoothctl swallows.
#   * No discovery scan, ever. Scanning has never helped here — in every
#     observed failure the car was answering and refusing, or plainly asleep —
#     and it floods the 2.4GHz radio the Pi 5 shares with WiFi, which is the
#     known cause of the A2DP stuttering. It would trade a connect problem
#     for an audio one.
#   * Disconnects are noticed from a BlueZ D-Bus signal rather than by polling,
#     so a mid-drive drop is seen at once instead of up to 60s later.
#   * The profile is checked, not just the connection. The documented failure
#     mode is a link that connects fine and lands on headset-head-unit (HFP)
#     instead of a2dp-sink: silence, no track info, dead transport buttons,
#     while every connection-level check says healthy.
#   * This script REPORTS a bad profile, it does not fix one. `pactl` is not
#     installed and `wpctl` cannot switch card profiles, so the only lever
#     available is a disconnect/reconnect cycle — too blunt to fire
#     automatically off a heuristic that has not yet been seen to trigger.
#   * ONE device, by address. Nothing here enumerates or touches any other
#     paired device, so a phone or a speaker can be used normally.
#   * A disconnect is given a grace period before we chase it. Pressing
#     Disconnect on the car's screen must not start a tug-of-war, and
#     `touch /run/tesla-bt-hold` suspends reconnection entirely for as long
#     as the file exists.

set -uo pipefail

MAC="${TESLA_MAC:-4C:FC:AA:55:B0:60}"
ADAPTER="${TESLA_ADAPTER:-2C:CF:67:58:CF:FE}"   # built-in Broadcom; the car lives here
PW_USER="${TESLA_PW_USER:-fuwenxu}"             # PipeWire runs in the user session,
PW_UID="${TESLA_PW_UID:-1000}"                  # this script runs as root

# Backoff. Fast while the car is plausibly still waking with the ignition,
# then geometric so a car that is simply not there costs one page a minute
# instead of six — pages are airtime on the radio WiFi shares.
FAST_RETRY_SEC="${TESLA_FAST_RETRY_SEC:-5}"
FAST_RETRY_COUNT="${TESLA_FAST_RETRY_COUNT:-12}"
MAX_RETRY_SEC="${TESLA_MAX_RETRY_SEC:-60}"
SUMMARY_EVERY_SEC="${TESLA_SUMMARY_EVERY_SEC:-300}"
CONNECT_TIMEOUT="${TESLA_CONNECT_TIMEOUT:-35}"
# How long to leave a fresh disconnect alone before reconnecting, so a
# deliberate Disconnect on the car's screen is not immediately undone.
DISCONNECT_GRACE_SEC="${TESLA_DISCONNECT_GRACE_SEC:-20}"
# Cap on how long to wait for PipeWire to register its A2DP endpoints.
# Generous: on a cold boot the user session starts well after bluetoothd.
AUDIO_READY_TIMEOUT_SEC="${TESLA_AUDIO_READY_TIMEOUT_SEC:-120}"
HOLD_FILE="${TESLA_HOLD_FILE:-/run/tesla-bt-hold}"

# A2DP Source and AVRCP Target. Their presence on the adapter is what says
# PipeWire has registered its media endpoints with bluetoothd.
UUID_A2DP_SOURCE="0000110a-0000-1000-8000-00805f9b34fb"
UUID_AVRCP_TARGET="0000110c-0000-1000-8000-00805f9b34fb"

MAC_PATH="${MAC//:/_}"
REASON=""

# systemd reads these prefixes as syslog levels, so `journalctl -p warning`
# filters to the interesting lines.
log()  { printf '<6>[Kodama Bluetooth] %s\n' "$*"; }
warn() { printf '<4>[Kodama Bluetooth] %s\n' "$*"; }
err()  { printf '<3>[Kodama Bluetooth] %s\n' "$*"; }

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

# Does this adapter offer A2DP Source and AVRCP Target yet?
#
# bluetoothd adds these UUIDs to the adapter when a media endpoint is
# registered — i.e. exactly when PipeWire's bluez5 monitor has finished
# starting. Reading them is therefore a direct answer to "can an A2DP
# connect succeed right now", rather than a guess based on elapsed time.
audio_stack_ready() {
  local uuids
  uuids=$(busctl get-property org.bluez "/org/bluez/$1" org.bluez.Adapter1 UUIDs 2>/dev/null)
  [ -n "$uuids" ] || return 1
  case "$uuids" in *"$UUID_A2DP_SOURCE"*) ;; *) return 1 ;; esac
  case "$uuids" in *"$UUID_AVRCP_TARGET"*) ;; *) return 1 ;; esac
  return 0
}

# Block until the audio stack is ready, or the cap expires.
wait_for_audio_stack() {
  local hci="$1" waited=0
  if audio_stack_ready "$hci"; then
    log "A2DP connected profile available on $hci (A2DP Source + AVRCP Target registered)"
    log "AVRCP ready"
    return 0
  fi
  log "Waiting for the audio stack — no A2DP endpoint registered on $hci yet"
  while [ "$waited" -lt "$AUDIO_READY_TIMEOUT_SEC" ]; do
    sleep 1
    waited=$((waited + 1))
    if audio_stack_ready "$hci"; then
      log "A2DP profile registered after ${waited}s — adapter ready"
      log "AVRCP ready"
      return 0
    fi
  done
  err "no A2DP endpoint after ${AUDIO_READY_TIMEOUT_SEC}s — is PipeWire/WirePlumber running? Connecting anyway"
  return 1
}

# Every fresh pairing has landed Trusted=false. Untrusted means BlueZ won't
# auto-authorise the car's INCOMING connection, and with no agent running
# there is nobody to ask — so the car's own reconnect is refused. Fix it
# rather than only reporting it: this writes one flag, it does not re-pair
# and does not touch the link key.
check_bond() {
  local dev="$1" paired trusted
  paired=$(bluez_prop "$dev" org.bluez.Device1 Paired)
  trusted=$(bluez_prop "$dev" org.bluez.Device1 Trusted)

  if [ "$paired" != "true" ]; then
    warn "device is NOT paired (Paired=${paired:-?}) on $ADAPTER — auto-connect cannot work"
    return
  fi

  if [ "$trusted" = "true" ]; then
    return
  fi

  warn "device is NOT trusted (Trusted=${trusted:-?}) — the car's own reconnect needs an agent we do not run; trusting it now"
  if busctl set-property org.bluez "$dev" org.bluez.Device1 Trusted b true >/dev/null 2>&1; then
    if [ "$(bluez_prop "$dev" org.bluez.Device1 Trusted)" = "true" ]; then
      log "device is now trusted — incoming connections from the car are auto-authorised"
    else
      err "setting Trusted did not stick — check /var/lib/bluetooth/$ADAPTER/$MAC/info"
    fi
  else
    err "could not set Trusted (is this running as root?)"
  fi
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

# `hci` is passed so profile-unavailable can be attributed correctly: if
# OUR adapter has no A2DP Source UUID, the missing profile is ours, not
# the car's. Getting that backwards is what sent this investigation to the
# wrong end of the link for weeks.
classify() {
  local reason="$1" hci="$2"
  case "$reason" in
    *page-timeout*)       echo "CAR — never answered the page (asleep, or out of range)" ;;
    *refused*)            echo "CAR — answered, then refused the link" ;;
    *profile-unavailable*)
      if audio_stack_ready "$hci"; then
        echo "CAR — link came up but the car offered no A2DP profile"
      else
        echo "PI — our own adapter has no A2DP endpoint yet (PipeWire not ready)"
      fi ;;
    *canceled*|*aborted*) echo "EITHER — attempt cancelled mid-flight" ;;
    # Seen immediately after a `systemctl restart bluetooth`, and while an
    # attempt from BlueZ's own policy plugin is still in flight. Ours, and
    # transient — the next retry is the whole fix.
    *connection-busy*)    echo "PI — adapter busy (another attempt in flight); transient" ;;
    # BlueZ's catch-all when the controller gave it nothing better. In
    # practice this has always been a car that is not answering, but it is
    # not worth asserting that: the name probe on the same line decides.
    *connection-unknown*) echo "EITHER — BlueZ reported no specific cause; read the name probe" ;;
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

# Geometric backoff after the fast window, capped.
retry_delay() {
  local streak="$1" delay
  if [ "$streak" -le "$FAST_RETRY_COUNT" ]; then
    echo "$FAST_RETRY_SEC"
    return
  fi
  delay=$(( FAST_RETRY_SEC * (1 << ((streak - FAST_RETRY_COUNT) > 5 ? 5 : (streak - FAST_RETRY_COUNT))) ))
  [ "$delay" -gt "$MAX_RETRY_SEC" ] && delay="$MAX_RETRY_SEC"
  echo "$delay"
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
  log "Adapter ready — $ADAPTER is $hci"
  ensure_powered "$hci" || err "adapter $hci would not power on"
  # Before the first connect, not after it: this is the whole point of the
  # rewrite. See the boot-race note at the top.
  wait_for_audio_stack "$hci"
  if [ -n "$(bluez_prop "/org/bluez/$hci/dev_$MAC_PATH" org.bluez.Device1 Paired)" ]; then
    log "Known Tesla device found — $MAC on $hci"
  else
    err "no bond for $MAC on $ADAPTER — pair from the car's screen first"
  fi
  check_bond "/org/bluez/$hci/dev_$MAC_PATH"
else
  err "adapter $ADAPTER is not present — waiting for it to appear"
fi

# ── main loop ─────────────────────────────────────────────────────────

fail_streak=0
last_reason=""
last_summary=0
was_connected=-1
disconnected_at=0

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
        log "Tesla connected via $hci after $fail_streak failed attempt(s)"
      else
        log "Tesla already connected via $hci"
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
      warn "Tesla disconnected — will reconnect after ${DISCONNECT_GRACE_SEC}s"
      was_connected=0
      disconnected_at=$(date +%s)
    fi
    continue
  fi

  # Someone asked us to stay out of the way (another device in use, or a
  # deliberate disconnect they want to stick).
  if [ -e "$HOLD_FILE" ]; then
    log "hold file $HOLD_FILE present — not reconnecting"
    sleep 10
    continue
  fi

  # Don't fight a disconnect that has only just happened: pressing
  # Disconnect on the car's screen should stay disconnected long enough to
  # be meaningful.
  now=$(date +%s)
  if [ "$disconnected_at" -gt 0 ] && [ $((now - disconnected_at)) -lt "$DISCONNECT_GRACE_SEC" ]; then
    sleep 2
    continue
  fi

  # The audio stack can go away mid-run (a WirePlumber restart), and
  # connecting without it produces the same false "CAR" verdict as at boot.
  if ! audio_stack_ready "$hci"; then
    warn "A2DP endpoint has gone from $hci — waiting for the audio stack before retrying"
    wait_for_audio_stack "$hci"
    continue
  fi

  was_connected=0
  fail_streak=$((fail_streak + 1))
  log "Reconnect attempt $fail_streak"
  if attempt_connect "$dev"; then
    continue
  fi

  now=$(date +%s)
  probe_now=0
  [ "$fail_streak" -eq 1 ]                            && probe_now=1
  [ "$REASON" != "$last_reason" ]                     && probe_now=1
  [ $((now - last_summary)) -ge "$SUMMARY_EVERY_SEC" ] && probe_now=1

  if [ "$probe_now" -eq 1 ]; then
    warn "Reconnect failed: $REASON | $(classify "$REASON" "$hci") | $(name_probe "$hci")"
    last_summary=$now
  elif [ "$fail_streak" -le "$FAST_RETRY_COUNT" ]; then
    warn "Reconnect failed: $REASON | $(classify "$REASON" "$hci")"
  fi
  last_reason="$REASON"

  sleep "$(retry_delay "$fail_streak")"
done

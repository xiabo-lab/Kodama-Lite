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
# WHY THIS DOES NOT CONNECT — AND WHY THAT IS THE FIX
# ─────────────────────────────────────────────────────────────────────
#
# This script used to page the car every few seconds until it answered.
# That is exactly backwards for this car, and it was the reason
# auto-connect "worked less than half the time".
#
# Two facts, both measured across four consecutive boots on a real drive
# (2026-08-25, journal boots -3..0), with the car awake and in use:
#
#   1. THE TESLA REFUSES EVERY PI-INITIATED LINK. About fifty attempts,
#      all `br-connection-refused` / `avdtp_connect_cb: Connection refused
#      (111)`, while `hcitool name` was answering "Tesla Model Y 阿快" on
#      the same radio in the same second. Not one has ever succeeded. This
#      is the car's policy about who may initiate, and no amount of
#      retrying changes it. (First seen 2026-07-30 with the car parked and
#      written off as "it is asleep"; this drive proves it is not that.)
#
#   2. OUR RETRYING WAS WHAT KEPT THE CAR OUT. A controller that is paging
#      is not page-SCANNING, so every attempt we made was a window in
#      which the Tesla's own attempt could not be heard. The car gives up
#      after about five tries.
#
#      boot -3   paged every 5-8s, never stopped   -> never connected
#      boot -2   paged, then backed off to 44s     -> connected 60s after
#                                                     our last page
#      boot -1   paged, then backed off to 40s     -> connected 61s after
#                                                     our last page
#      boot  0   never paged at all (it happened   -> connected 3 SECONDS
#                to be waiting for the audio          after the radio came
#                stack)                               up
#
#      The car connects the moment it gets a quiet radio, and not before.
#
# So the default mode is LISTEN: power the adapter, make sure the bond is
# trusted and the A2DP endpoints exist, then say nothing and let the car
# do what it is going to do anyway. Outbound connecting is still available
# behind TESLA_CONNECT_MODE=initiate for a different head unit that needs
# it — this refusal is one car's policy, not a universal one.
#
# ─────────────────────────────────────────────────────────────────────
# THE OTHER BOOT RACE (still closed, still relevant)
# ─────────────────────────────────────────────────────────────────────
#
# PipeWire registers the A2DP endpoints with bluetoothd one to three
# seconds AFTER bluetoothd starts, because WirePlumber lives in the user
# session and a system unit cannot be ordered against it:
#
#   17:21:06  bluetoothd 5.82 starts
#   17:21:09  bluetoothd: Endpoint registered: /MediaEndpoint/A2DPSource/sbc
#
# Until those exist there is no A2DP to offer, so a connection attempt in
# that window fails with `Protocol not available` — in EITHER direction.
# An inbound attempt from the car that lands there is a wasted one of its
# five. Nothing is reported as ready until the adapter actually advertises
# A2DP Source (0000110a) and AVRCP Target (0000110c), which appear exactly
# when those endpoints land.
#
# ─────────────────────────────────────────────────────────────────────
# THE THIRD ONE: Trusted=false
# ─────────────────────────────────────────────────────────────────────
#
# The bond read `Trusted=false` on every boot since it was made. An
# untrusted device's INCOMING profile connections need an agent to
# authorise them, and this Pi runs none (no bt-agent, no interactive
# bluetoothctl) — so the car's own connection, the only kind that works
# here, had nobody to answer for it. Set to true below if it is ever
# found false. That writes one flag in
# /var/lib/bluetooth/<adapter>/<device>/info; it does NOT re-pair and does
# NOT touch the link key.
#
# ─────────────────────────────────────────────────────────────────────
# HOW FAST CAN THIS POSSIBLY BE? (measured 2026-08-25)
# ─────────────────────────────────────────────────────────────────────
#
# Tesla pages its priority device when the car wakes and gives up after
# about five tries, so the only thing that matters is whether the Pi is
# listening in time. An iPhone always is, because it never turned off. The
# Pi is powered by the car and starts from nothing, so this is a race.
#
# Where the time actually goes, from `journalctl -b -o short-monotonic`:
#
#   2.44s  kernel done
#   4.42s  Bluetooth core + HCI UART driver loaded
#   4.77s  hci0: BCM4345C0 detected
#   4.78s  loading firmware patch BCM4345C0...hcd
#   5.45s  firmware patch DONE          <- the radio does not exist before this
#   5.45s  bluetoothd starts
#   7.04s  user@1000 (PipeWire/WirePlumber live here)
#   7.97s  A2DP endpoints registered with bluetoothd
#   8.92s  TESLA-BT READY
#
# Two things follow, and they are worth knowing before optimising again:
#
#   * **bluetoothd is already starting as soon as the controller exists.**
#     There is nothing to win by starting it earlier — the gate is a 675ms
#     Broadcom firmware patch load that finishes at 5.45s. A target of
#     "connectable in under 3 seconds" is not reachable on this hardware
#     without kernel-level work.
#
#   * The remaining ~2.5s is the audio stack, which lives in the user
#     session. `cloud-init` was removed from bluetoothd's critical path,
#     linger was enabled, and the user manager's wait on `network.target`
#     was cut — together worth only ~0.2s, because the ordering edge is
#     declared by `systemd-user-sessions.service` (`Before=user@1000`) and
#     a drop-in on the far side cannot remove it.
#
# The gap between "connectable" (5.45s) and "A2DP ready" (7.97s) WAS a
# danger zone: the car could complete an ACL there and then fail on profile
# with `Protocol not available`, burning one of its five attempts. Since
# shrinking it proved to be worth only ~0.2s, the gap is closed from the
# other end instead — the radio is held dark until the audio stack is
# ready:
#
#   controller -> bluetoothd -> PipeWire/WirePlumber -> A2DP + AVRCP
#   -> ONLY NOW connectable -> Tesla connects -> audio works immediately
#
# The Pi becomes reachable slightly later, but every page it answers is one
# it can finish. A page timeout reads as "not here yet" and gets retried; a
# failed profile connect reads as "here and broken". See `gate_until_ready`,
# and note it needs `AutoEnable=false` in main.conf to have a say.
#
# ─────────────────────────────────────────────────────────────────────
# HOW TO READ A FAILURE LINE (initiate mode only)
# ─────────────────────────────────────────────────────────────────────
#
#   br-connection-page-timeout   the car never answered            -> CAR
#   br-connection-refused        the car answered and said no      -> CAR
#   br-connection-profile-unavailable  usually OUR endpoints       -> PI
#   InProgress / NotReady        our own adapter                   -> PI
#   UnknownObject                no bond on this adapter           -> PI
#
# For the cases those cannot split, capture HCI status codes directly:
#   sudo timeout 20 btmon | grep Status:
# `Connection Rejected due to Unacceptable BD_ADDR (0x0f)` is the car's
# policy on who may initiate.
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
#     so a mid-drive drop is seen at once instead of up to 60s later. In
#     listen mode noticing is ALL that happens — see the top of this file
#     for why chasing a disconnect is what caused the bug.
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
#   * Listen mode cannot fight a deliberate Disconnect on the car's screen,
#     because it never initiates anything. `touch /run/tesla-bt-hold` still
#     suspends initiate mode for as long as the file exists.

set -uo pipefail

MAC="${TESLA_MAC:-4C:FC:AA:55:B0:60}"
ADAPTER="${TESLA_ADAPTER:-2C:CF:67:58:CF:FE}"   # built-in Broadcom; the car lives here
PW_USER="${TESLA_PW_USER:-fuwenxu}"             # PipeWire runs in the user session,
PW_UID="${TESLA_PW_UID:-1000}"                  # this script runs as root

# listen   — never page the car; just be ready and let it connect. The
#            default, and the only mode that works on this Tesla.
# initiate — the old behaviour: page the car on a backoff. Kept for a
#            different head unit that actually accepts inbound links.
MODE="${TESLA_CONNECT_MODE:-listen}"

# How often to say "still waiting" in listen mode. Rare on purpose: this
# runs for the length of every drive, and a heartbeat that scrolls is a
# heartbeat nobody reads.
IDLE_REPORT_SEC="${TESLA_IDLE_REPORT_SEC:-600}"

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

# Hold the radio dark until the audio stack can actually service a link.
#
# `AutoEnable=false` in main.conf keeps the adapter powered off at boot, and
# this script powers it on only once A2DP Source and AVRCP Target are
# registered. See the header for why. Set to 0 to go back to "connectable
# the moment bluetoothd starts".
GATE_CONNECTABLE="${TESLA_GATE_CONNECTABLE:-1}"

# Failsafe. If the audio stack never arrives, power the radio on anyway
# after this long: a Pi whose Bluetooth is merely degraded is worth far
# more than a Pi whose Bluetooth does not exist, and a car that connects
# and gets no audio is at least diagnosable from the driver's seat.
GATE_MAX_WAIT_SEC="${TESLA_GATE_MAX_WAIT_SEC:-45}"

# How many 200ms ticks to wait for the adapter to appear before giving up
# and letting the main loop cope. 150 = 30s, far longer than the ~0.5s the
# firmware patch actually needs.
ADAPTER_WAIT_SEC="${TESLA_ADAPTER_WAIT_TICKS:-150}"

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

# BlueZ's own `Connectable` bookkeeping was found reading false while the
# controller was in fact page-scanning. The controller is the truth, so
# nothing was actually broken — but a property BlueZ believes is false is
# one it may act on later and drop PSCAN, which would leave the car unable
# to reach us at all. Assert it. This restores LOCAL state only and never
# reaches for the car.
ensure_connectable() {
  local a="/org/bluez/$1"
  [ "$(bluez_prop "$a" org.bluez.Adapter1 Connectable)" = "true" ] && return 0
  busctl set-property org.bluez "$a" org.bluez.Adapter1 Connectable b true >/dev/null 2>&1
  if [ "$(bluez_prop "$a" org.bluez.Adapter1 Connectable)" = "true" ]; then
    log "adapter marked Connectable (BlueZ had it false while the radio was page-scanning)"
  else
    warn "could not set Connectable — the car may be unable to reach us"
  fi
}

# Power the adapter DOWN. Used only at startup, and only while gating: a
# powered-off controller does not page-scan, so the car's early attempts
# time out instead of completing an ACL we cannot finish.
power_off() {
  busctl set-property org.bluez "/org/bluez/$1" org.bluez.Adapter1     Powered b false >/dev/null 2>&1
}

# Poll at 100ms, not 1s.
#
# The old shape was check / set / `sleep 1` / repeat, so a controller that
# came up in ~150ms was still reported as down for a whole second.
# Harmless when this only ran at boot beside an already-powered radio - but
# the gate now calls it at the exact moment the Pi becomes reachable to the
# car, so that second was a second of Tesla's connect window spent on a
# `sleep`. Measured: 1.16s between "powering on" and "connectable", almost
# all of it here.
#
# The set is re-issued periodically rather than once, because a
# set-property landing while bluetoothd is still settling can be dropped,
# and being stubborn about that is this function's whole job.
ensure_powered() {
  local hci="$1" tries=0
  hciconfig "$hci" 2>/dev/null | grep -q 'UP RUNNING' && return 0
  while [ "$tries" -lt 300 ]; do
    if [ $((tries % 20)) -eq 0 ]; then
      busctl set-property org.bluez "/org/bluez/$hci" org.bluez.Adapter1 Powered b true >/dev/null 2>&1
    fi
    hciconfig "$hci" 2>/dev/null | grep -q 'UP RUNNING' && return 0
    sleep 0.1
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

# Has WirePlumber's bluez5 monitor loaded? That is the moment the A2DP
# endpoints get registered with bluetoothd, and unlike the adapter's UUID
# list it is observable with the controller powered off.
#
# Scoped to a `bluez` node rather than the string "bluez5" anywhere in the
# dump: `bluez_midi.server` is created by the same plugin load and is
# present whether or not any device is connected, which makes it exactly
# the "the monitor is up" signal wanted here.
bluez5_monitor_loaded() {
  sudo -u "$PW_USER" env XDG_RUNTIME_DIR="/run/user/$PW_UID"     timeout 5 pw-dump 2>/dev/null | grep -q '"node\.name": *"bluez'
}

# Block until our adapter exists.
#
# `bluetoothd` can start BEFORE the kernel has finished loading the
# Broadcom firmware patch — measured on one boot at bluetoothd 4.72s
# against hci0 ready at 5.23s. The preflight then found no adapter, logged
# it, and fell through to the main loop, which powers the radio on with no
# gate at all. That is the very race this script exists to close, so it
# must not be left to luck: 9 of 10 boots happened to go the other way,
# which is exactly the kind of "usually fine" that produced the original
# bug report.
wait_for_adapter() {
  local waited=0 hci
  while [ "$waited" -lt "$ADAPTER_WAIT_SEC" ]; do
    hci=$(adapter_hci)
    if [ -n "$hci" ]; then
      [ "$waited" -gt 0 ] && log "adapter $ADAPTER appeared after ${waited}s (kernel firmware load)"
      echo "$hci"
      return 0
    fi
    sleep 0.2
    waited=$((waited + 1))
  done
  return 1
}

# Bring the Pi up in the right ORDER:
#
#   controller -> bluetoothd -> PipeWire/WirePlumber -> A2DP + AVRCP
#   -> only now connectable -> Tesla connects -> audio works immediately
#
# The alternative, which is what shipped before, is to be connectable from
# the moment bluetoothd starts (5.45s) while the endpoints do not exist
# until 7.97s. A car that pages in that window completes an ACL and then
# fails AVDTP with `Protocol not available` — and Tesla only tries about
# five times before giving up for good. Answering a page we cannot service
# is strictly worse than not answering it: a page timeout looks like "not
# here yet" and gets retried, a failed profile connect looks like "here and
# broken".
#
# Requires `AutoEnable=false`, or bluetoothd powers the adapter on before
# we get a say.
gate_until_ready() {
  local hci="$1" waited=0
  if [ "$GATE_CONNECTABLE" != "1" ]; then
    ensure_powered "$hci"
    wait_for_audio_stack "$hci"
    return
  fi

  # NEVER power-cycle a radio that is already working. This service is
  # Restart=always, so it re-runs mid-drive after any hiccup — and taking
  # the adapter down there would drop a live A2DP link to the car, which
  # the car would then have to re-establish on a policy that only lets it
  # try about five times. Gating is a COLD-START behaviour: if the audio
  # stack is already up, there is nothing to gate and nothing to fix.
  if audio_stack_ready "$hci" || is_connected "/org/bluez/$hci/dev_$MAC_PATH"; then
    log "audio stack already up (service restart, not a cold boot) — leaving the radio alone"
    ensure_powered "$hci"
    ensure_connectable "$hci"
    return 0
  fi

  power_off "$hci"
  log "radio held dark until the audio stack is ready (no half-working link for the car to waste an attempt on)"

  # TWO readiness signals, because it is not established that the first one
  # works from a dark radio.
  #
  # `audio_stack_ready` reads the A2DP Source / AVRCP Target UUIDs off the
  # ADAPTER, and BlueZ may only publish those once the controller is
  # powered — in which case, while gating, it would never become true and
  # every boot would burn the full failsafe with the radio dark. That would
  # be worse than the problem being fixed.
  #
  # So the PipeWire side is accepted as well: once WirePlumber's bluez5
  # monitor has loaded, the endpoints have been registered with bluetoothd,
  # and that is visible in `pw-dump` regardless of adapter power. Whichever
  # answers first opens the gate; the report afterwards says which.
  while [ "$waited" -lt "$GATE_MAX_WAIT_SEC" ]; do
    if audio_stack_ready "$hci" || bluez5_monitor_loaded; then
      log "audio stack ready after ${waited}s — powering the radio on"
      ensure_powered "$hci"
      ensure_connectable "$hci"
      # Now that the controller is up the adapter must really be
      # advertising both profiles. If it is not, say so loudly rather than
      # reporting a readiness that is not there.
      if audio_stack_ready "$hci"; then
        log "A2DP Source + AVRCP Target confirmed on $hci"
        log "AVRCP ready"
      else
        warn "powered on but $hci still does not advertise A2DP Source + AVRCP Target — the car will connect and get no audio"
      fi
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  err "no A2DP endpoint after ${GATE_MAX_WAIT_SEC}s — powering on anyway; the car may connect with no audio"
  ensure_powered "$hci"
  ensure_connectable "$hci"
  return 1
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

# ── readiness report ──────────────────────────────────────────────────

# Seconds since boot, to 3dp. /proc/uptime is monotonic and immune to the
# NTP step this Pi takes early in every boot (it has no RTC battery), which
# makes wall-clock timestamps useless for measuring the boot race.
mono() { awk '{ printf "%.3f", $1 }' /proc/uptime; }

# One line that answers "was the Pi ready before the car gave up?" without
# needing any other log. Everything Tesla needs is on it, so a failed drive
# can be diagnosed from a single grep:
#
#   journalctl -b -u tesla-bt-connect | grep TESLA-BT
#
# Deliberately emitted once, at the moment readiness is reached, rather
# than sampled — the value being reported IS the time it happened.
ready_report() {
  local hci="$1" dev="/org/bluez/$hci/dev_$MAC_PATH" uuids act psi psw pst yes_a2dp yes_avrcp
  uuids=$(busctl get-property org.bluez "/org/bluez/$hci" org.bluez.Adapter1 UUIDs 2>/dev/null)
  # Read straight from the controller: the config file says what we asked
  # for, this says what we got. Bytes are
  #   <ncmd> <op-lo> <op-hi> <status> <int-lo> <int-hi> <win-lo> <win-hi>
  # and the hex is converted in bash, because Debian's awk is mawk and has
  # no `strtonum` — which silently reported both values as 0.
  act=$(sudo hcitool -i "$hci" cmd 0x03 0x001b 2>/dev/null | sed -n '3p')
  psi=$(( 16#$(printf '%s' "$act" | awk '{print $6 $5}' 2>/dev/null || echo 0) ))
  psw=$(( 16#$(printf '%s' "$act" | awk '{print $8 $7}' 2>/dev/null || echo 0) ))
  pst=$(sudo hcitool -i "$hci" cmd 0x03 0x0046 2>/dev/null | sed -n '3p' | awk '{print $5}')
  case "$uuids" in *$UUID_A2DP_SOURCE*) yes_a2dp=yes ;; *) yes_a2dp=no ;; esac
  case "$uuids" in *$UUID_AVRCP_TARGET*) yes_avrcp=yes ;; *) yes_avrcp=no ;; esac
  log "TESLA-BT READY t=$(mono)s adapter=$hci bdaddr=$ADAPTER powered=$(bluez_prop "/org/bluez/$hci" org.bluez.Adapter1 Powered) connectable=$(bluez_prop "/org/bluez/$hci" org.bluez.Adapter1 Connectable) discoverable=$(bluez_prop "/org/bluez/$hci" org.bluez.Adapter1 Discoverable) class=$(printf '0x%06x' "$(bluez_prop "/org/bluez/$hci" org.bluez.Adapter1 Class)" 2>/dev/null) tesla_paired=$(bluez_prop "$dev" org.bluez.Device1 Paired) tesla_trusted=$(bluez_prop "$dev" org.bluez.Device1 Trusted) link_key=$(sudo test -s "/var/lib/bluetooth/$ADAPTER/$MAC/info" && echo yes || echo no) a2dp_source=$yes_a2dp avrcp=$yes_avrcp page_scan_interval=${psi}slots/$((psi * 625 / 1000))ms page_scan_window=${psw}slots/$((psw * 625 / 1000))ms page_scan_type=${pst:-?} mode=$MODE"
}

# ── preflight ─────────────────────────────────────────────────────────

log "starting — target $MAC via adapter $ADAPTER"
if [ "$HAVE_DBUS_MONITOR" -eq 1 ]; then
  log "bluez $(bluetoothctl --version 2>/dev/null | awk '{print $NF}'), event-driven disconnect detection"
else
  warn "bluez $(bluetoothctl --version 2>/dev/null | awk '{print $NF}'), dbus-monitor MISSING — falling back to polling"
fi

hci=$(wait_for_adapter)
if [ -n "$hci" ]; then
  log "Adapter ready — $ADAPTER is $hci"
  # Order matters, and this is the order. Nothing becomes reachable until
  # everything the car will ask for exists.
  gate_until_ready "$hci"
  if [ -n "$(bluez_prop "/org/bluez/$hci/dev_$MAC_PATH" org.bluez.Device1 Paired)" ]; then
    log "Known Tesla device found — $MAC on $hci"
  else
    err "no bond for $MAC on $ADAPTER — pair from the car's screen first"
  fi
  ensure_connectable "$hci"
  check_bond "/org/bluez/$hci/dev_$MAC_PATH"
  ready_report "$hci"
else
  err "adapter $ADAPTER is not present — waiting for it to appear"
fi

if [ "$MODE" = "listen" ]; then
  log "mode: LISTEN — the Pi will not page the car. This car refuses every"
  log "mode: LISTEN — inbound link we open, and paging it deafens our own"
  log "mode: LISTEN — radio to its attempts. Measured: connects in ~3s of quiet."
else
  warn "mode: INITIATE — paging the car on a backoff. On the Tesla this is the"
  warn "mode: INITIATE — behaviour that BROKE auto-connect; see the file header."
fi

# ── main loop ─────────────────────────────────────────────────────────

fail_streak=0
last_reason=""
last_summary=0
was_connected=-1
disconnected_at=0
last_idle_report=0

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
  ensure_connectable "$hci"

  if is_connected "$dev"; then
    if [ "$was_connected" != "1" ]; then
      if [ "$fail_streak" -gt 0 ]; then
        log "Tesla connected via $hci after $fail_streak failed attempt(s)"
      else
        log "Tesla connected via $hci"
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
      was_connected=0
      disconnected_at=$(date +%s)
      if [ "$MODE" = "listen" ]; then
        # Deliberately not chased. See the file header: reaching for the
        # car here is what stopped it reaching for us.
        warn "Tesla disconnected — waiting for it to reconnect (not paging it)"
      else
        warn "Tesla disconnected — will reconnect after ${DISCONNECT_GRACE_SEC}s"
      fi
    fi
    continue
  fi

  # ── not connected ───────────────────────────────────────────────────

  was_connected=0

  # The audio stack can go away mid-run (a WirePlumber restart), and an
  # inbound connection that lands while it is missing fails on profile
  # and costs the car one of its few attempts. Worth noticing in both
  # modes, and worth waiting for before doing anything else.
  if ! audio_stack_ready "$hci"; then
    warn "A2DP endpoint has gone from $hci — the car cannot complete a link until it returns"
    wait_for_audio_stack "$hci"
    continue
  fi

  if [ "$MODE" = "listen" ]; then
    # Nothing to do but be reachable. Everything that matters — powered,
    # page-scanning, trusted, A2DP registered — has been checked above.
    now=$(date +%s)
    if [ $((now - last_idle_report)) -ge "$IDLE_REPORT_SEC" ]; then
      log "Ready and connectable on $hci — waiting for the Tesla to connect"
      last_idle_report=$now
    fi
    wait_for_bluez_event 60
    continue
  fi

  # ── initiate mode only, from here down ──────────────────────────────

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

#!/usr/bin/env bash
#
# Diagnose (and optionally fix) sluggish / glitchy Bluetooth audio on the Pi.
#
#   bash scripts/bt-audio-doctor.sh         # report only, change nothing
#   bash scripts/bt-audio-doctor.sh --fix   # apply the safe, reversible fixes
#
# Written for the in-car setup: Pi 5 on Raspberry Pi OS Bookworm (PipeWire +
# WirePlumber) driving a Bluetooth amplifier such as the Fosi Audio BT20A.
#
# The four things that actually cause "sluggish with glitches" here, in the
# order they're worth checking:
#
#   1. WiFi/Bluetooth coexistence. The Pi 5 shares ONE antenna between its
#      2.4GHz radio and Bluetooth. On a 2.4GHz network they contend and A2DP
#      stutters continuously. Moving the Pi to the 5GHz SSID is usually the
#      single biggest win, and it costs nothing to try.
#   2. WiFi power saving. The driver parks the radio between beacons, which
#      lands right on top of the A2DP stream. Turning it off is a one-liner.
#   3. The audio profile. A device in HSP/HFP ("headset") mode is 8-16kHz
#      mono and sounds terrible. NOTE this is unlikely on a BT20A — it has no
#      microphone, so it should only ever advertise A2DP — but it's one
#      command to rule out, and it IS the usual culprit on headsets.
#   4. Codec quality. Plain SBC at default bitpool is the fallback everyone
#      gets; SBC-XQ roughly doubles the bitrate and is a large audible step up
#      when the link itself is healthy.
#
# Nothing here touches Kodama-Lite. This is the operating system's audio
# stack — the app just plays into whatever sink PipeWire gives it.

set -uo pipefail

FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
hint() { printf '\033[1;36m  ->\033[0m %s\n' "$*"; }

# ── 1. WiFi band ──────────────────────────────────────────────────────

log "WiFi band (Bluetooth shares this antenna)"
if command -v iw >/dev/null && iw dev wlan0 link >/dev/null 2>&1; then
  link=$(iw dev wlan0 link 2>/dev/null)
  if printf '%s' "$link" | grep -q 'Not connected'; then
    ok "wlan0 not connected — no 2.4GHz contention from WiFi."
  else
    freq=$(printf '%s' "$link" | grep -oE 'freq: *[0-9]+' | grep -oE '[0-9]+' | head -1)
    ssid=$(printf '%s' "$link" | grep -oE 'SSID: .*' | cut -d' ' -f2-)
    if [ -n "$freq" ] && [ "$freq" -lt 3000 ] 2>/dev/null; then
      warn "On 2.4GHz (${freq} MHz, SSID ${ssid:-?}) — THIS IS THE MOST LIKELY CAUSE."
      hint "The Pi 5 shares one antenna between 2.4GHz WiFi and Bluetooth."
      hint "Join the 5GHz SSID instead, or move the Pi to Ethernet, and retest."
      hint "Not something this script can change for you — it needs the network's"
      hint "credentials, and the 5GHz SSID is often named differently."
    else
      ok "On 5GHz (${freq:-?} MHz, SSID ${ssid:-?}) — no antenna contention."
    fi
  fi
else
  warn "Couldn't read wlan0 (no iw, or a different interface name)."
fi

# ── 2. WiFi power saving ──────────────────────────────────────────────

log "WiFi power saving (parks the radio mid-stream)"
if command -v iw >/dev/null && iw dev wlan0 get power_save >/dev/null 2>&1; then
  ps=$(iw dev wlan0 get power_save 2>/dev/null | grep -oE '(on|off)' | head -1)
  if [ "$ps" = "on" ]; then
    warn "Power save is ON."
    if [ "$FIX" -eq 1 ]; then
      if sudo iw dev wlan0 set power_save off; then
        ok "Turned off for this boot."
        hint "To make it permanent, add to /etc/rc.local before 'exit 0':"
        hint "  iw dev wlan0 set power_save off"
      fi
    else
      hint "Fix: sudo iw dev wlan0 set power_save off   (or rerun with --fix)"
    fi
  else
    ok "Power save already off."
  fi
else
  warn "Couldn't read power_save state."
fi

# ── 3. Bluetooth card profile ─────────────────────────────────────────

log "Bluetooth audio profile"
if ! command -v pactl >/dev/null; then
  warn "pactl not found — is pipewire-pulse (or pulseaudio) installed?"
else
  card=$(pactl list cards short 2>/dev/null | awk '/bluez/ {print $2; exit}')
  if [ -z "$card" ]; then
    warn "No Bluetooth audio card found. Is the BT20A connected?"
    hint "Check with: bluetoothctl devices Connected"
  else
    ok "Card: $card"
    active=$(pactl list cards 2>/dev/null \
             | awk -v c="$card" '$0 ~ "Name: "c {f=1} f && /Active Profile:/ {print $3; exit}')
    ok "Active profile: ${active:-unknown}"
    case "$active" in
      a2dp-sink*)
        ok "A2DP — correct. This is the high-quality stereo profile."
        ;;
      headset*|handsfree*)
        warn "HEADSET profile — 8-16kHz mono. This would sound bad."
        if [ "$FIX" -eq 1 ]; then
          if pactl set-card-profile "$card" a2dp-sink; then
            ok "Switched to a2dp-sink."
          fi
        else
          hint "Fix: pactl set-card-profile $card a2dp-sink   (or rerun with --fix)"
        fi
        ;;
      off)
        warn "Profile is 'off' — no audio will play at all."
        [ "$FIX" -eq 1 ] && pactl set-card-profile "$card" a2dp-sink && ok "Set to a2dp-sink."
        ;;
      *)
        hint "Unrecognised profile. Available ones:"
        pactl list cards 2>/dev/null \
          | awk -v c="$card" '$0 ~ "Name: "c {f=1} f && /^\t\t[a-z].*: / {print "       "$0} f && /Active Profile:/ {exit}' \
          | head -12
        ;;
    esac
  fi
fi

# ── 4. Codec ──────────────────────────────────────────────────────────

log "Codec"
if command -v pactl >/dev/null; then
  codec=$(pactl list cards 2>/dev/null | grep -iE 'bluetooth.codec' | head -1 | sed 's/.*= *//' | tr -d '"')
  ok "In use: ${codec:-unknown}"
fi

WP_DIR="$HOME/.config/wireplumber/wireplumber.conf.d"
WP_CONF="$WP_DIR/51-bluez-quality.conf"
if [ -f "$WP_CONF" ]; then
  ok "SBC-XQ config already present at $WP_CONF"
else
  warn "SBC-XQ not enabled (roughly doubles SBC bitrate)."
  if [ "$FIX" -eq 1 ]; then
    mkdir -p "$WP_DIR"
    cat > "$WP_CONF" <<'CONF'
# Higher-quality SBC, and A2DP only.
#
# enable-sbc-xq raises the SBC bitpool well above the default, which is a
# clear audible improvement on a healthy link.
#
# Restricting `roles` to the A2DP ones stops anything from ever negotiating
# the HSP/HFP headset profile, which is 8-16kHz mono. A speaker with no
# microphone has no reason to offer it.
monitor.bluez.properties = {
  bluez5.enable-sbc-xq = true
  bluez5.roles = [ a2dp_sink a2dp_source ]
}
CONF
    ok "Wrote $WP_CONF"
    systemctl --user restart wireplumber 2>/dev/null \
      && ok "Restarted wireplumber." \
      || hint "Restart it yourself: systemctl --user restart wireplumber"
    hint "Then re-pair or reconnect the BT20A so it renegotiates the codec."
  else
    hint "Fix: rerun with --fix to write $WP_CONF"
  fi
fi

# ── 5. Load ───────────────────────────────────────────────────────────

log "System load (audio dropouts can just be a busy CPU)"
uptime | sed 's/^/  /'
if command -v vcgencmd >/dev/null; then
  thr=$(vcgencmd get_throttled 2>/dev/null)
  if [ "$thr" = "throttled=0x0" ]; then
    ok "No throttling."
  else
    warn "$thr — under-voltage or thermal throttling can cause dropouts."
    hint "0x50000/0x50005 means it HAS throttled since boot; check the PSU."
  fi
fi

log "Done"
if [ "$FIX" -eq 0 ]; then
  hint "This run changed nothing. Rerun with --fix to apply the safe fixes."
fi
hint "If the WiFi band came back 2.4GHz, fix that FIRST — the rest is noise"
hint "next to antenna contention."

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
        # Bookworm manages wifi with NetworkManager and has no /etc/rc.local,
        # so persist it on the connection profile instead. `2` is
        # "powersave disabled" in NM's 802-11-wireless.powersave enum.
        conn=$(nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null \
               | awk -F: '$2=="wlan0"{print $1; exit}')
        if [ -n "$conn" ]; then
          if sudo nmcli connection modify "$conn" 802-11-wireless.powersave 2 2>/dev/null; then
            ok "Persisted on NetworkManager connection \"$conn\"."
          else
            hint "Persist it yourself:"
            hint "  sudo nmcli connection modify \"$conn\" 802-11-wireless.powersave 2"
          fi
        else
          hint "Couldn't find the NetworkManager connection to persist it on;"
          hint "this setting will revert on reboot."
        fi
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

# ── 3. Audio stack ────────────────────────────────────────────────────
#
# Checked before the profile because it decides *how* to check the profile
# — and because a missing pipewire-pulse is itself a strong candidate for
# glitchy audio. The app's audio comes out of WebKitGTK via GStreamer,
# which prefers the PulseAudio API; without pipewire-pulse bridging that to
# PipeWire, GStreamer falls back to writing ALSA directly, and a direct
# ALSA path to a Bluetooth device is exactly where underruns come from.

log "Audio stack"
have_pw=0; have_pactl=0; have_wpctl=0
pgrep -x pipewire >/dev/null 2>&1 && have_pw=1
command -v pactl >/dev/null && have_pactl=1
command -v wpctl >/dev/null && have_wpctl=1

if [ "$have_pw" -eq 1 ]; then ok "pipewire is running."; else warn "pipewire is NOT running."; fi
if pgrep -x wireplumber >/dev/null 2>&1; then ok "wireplumber is running."; else warn "wireplumber is NOT running."; fi

if pgrep -f 'pipewire-pulse' >/dev/null 2>&1; then
  ok "pipewire-pulse is running (GStreamer can use the PulseAudio API)."
else
  warn "pipewire-pulse is NOT running — LIKELY RELEVANT."
  hint "WebKitGTK plays through GStreamer, which prefers the PulseAudio API."
  hint "Without the bridge it falls back to raw ALSA, which underruns on a"
  hint "Bluetooth sink — glitchy, stuttery audio, exactly the symptom."
  hint "Fix: sudo apt install -y pipewire-pulse gstreamer1.0-pipewire"
  hint "     systemctl --user restart pipewire pipewire-pulse wireplumber"
fi

if [ "$have_pactl" -eq 0 ]; then
  warn "pactl not installed (it lives in pulseaudio-utils)."
  if [ "$have_wpctl" -eq 1 ]; then
    hint "Using wpctl instead — it ships with pipewire and is equivalent here."
  else
    hint "Install one for diagnosis: sudo apt install -y pulseaudio-utils"
  fi
fi

log "Default sink (where audio actually goes)"
if [ "$have_wpctl" -eq 1 ]; then
  wpctl status 2>/dev/null | sed -n '/Audio/,/Video/p' | grep -E '^\s+[│├└]|Sinks' | head -14 | sed 's/^/  /'
  if wpctl status 2>/dev/null | grep -qiE '\*.*(bluez|BT20A|Fosi)'; then
    ok "The default sink is the Bluetooth device."
  else
    warn "The default sink does NOT look like the Bluetooth device."
    hint "Audio may be going to HDMI or the headphone jack instead."
    hint "Set it with: wpctl set-default <id-from-the-list-above>"
  fi
elif [ "$have_pactl" -eq 1 ]; then
  pactl info 2>/dev/null | grep -i 'default sink' | sed 's/^/  /'
fi

# ── 4. Bluetooth card profile ─────────────────────────────────────────

log "Bluetooth audio profile"
if [ "$have_pactl" -eq 0 ]; then
  # No pactl: report what wpctl can see. wpctl can't switch card profiles
  # (that's still a pactl-only operation), so say so rather than pretend.
  if [ "$have_wpctl" -eq 1 ]; then
    if wpctl status 2>/dev/null | grep -qiE 'bluez|BT20A|Fosi'; then
      ok "A Bluetooth sink is present:"
      wpctl status 2>/dev/null | grep -iE 'bluez|BT20A|Fosi' | head -4 | sed 's/^/  /'
      hint "A sink appearing at all means A2DP negotiated — the headset"
      hint "profile exposes no sink of this kind. So the profile is fine."
    else
      warn "No Bluetooth sink visible. Is the BT20A connected?"
      hint "Check: bluetoothctl devices Connected"
    fi
  else
    warn "Neither pactl nor wpctl available — cannot inspect the profile."
  fi
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

# ── 5. Codec ──────────────────────────────────────────────────────────
#
# WirePlumber changed its ENTIRE config system between 0.4 and 0.5: 0.4
# reads Lua from bluetooth.lua.d/, 0.5 reads SPA-JSON from
# wireplumber.conf.d/. Each silently ignores the other's files — so writing
# the wrong one looks like it worked and does nothing at all. Detect the
# version and write the matching format.

log "Codec"
if [ "$have_pactl" -eq 1 ]; then
  codec=$(pactl list cards 2>/dev/null | grep -iE 'bluetooth.codec' | head -1 | sed 's/.*= *//' | tr -d '"')
  ok "In use: ${codec:-unknown}"
else
  hint "Codec readout needs pactl; skipping."
fi

wp_ver=$(wireplumber --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)
wp_major=${wp_ver%%.*}
wp_minor=${wp_ver##*.}
ok "WirePlumber ${wp_ver:-unknown}"

if [ -z "$wp_ver" ]; then
  warn "Couldn't determine the WirePlumber version — skipping codec config."
  warn "Writing the wrong format would silently do nothing."
else
  if [ "$wp_major" -eq 0 ] && [ "$wp_minor" -lt 5 ] 2>/dev/null; then
    WP_STYLE="lua"
    WP_DIR="$HOME/.config/wireplumber/bluetooth.lua.d"
    WP_CONF="$WP_DIR/51-bluez-quality.lua"
    STALE="$HOME/.config/wireplumber/wireplumber.conf.d/51-bluez-quality.conf"
  else
    WP_STYLE="conf"
    WP_DIR="$HOME/.config/wireplumber/wireplumber.conf.d"
    WP_CONF="$WP_DIR/51-bluez-quality.conf"
    STALE="$HOME/.config/wireplumber/bluetooth.lua.d/51-bluez-quality.lua"
  fi

  # An earlier run of this script (before it knew about the split) may have
  # left a file in the format this version ignores. Say so — a stale file
  # that does nothing is worse than none, because it reads as configured.
  if [ -f "$STALE" ]; then
    warn "Found a config in the OTHER format, which this version ignores:"
    warn "  $STALE"
    if [ "$FIX" -eq 1 ]; then
      rm -f "$STALE" && ok "Removed it."
    else
      hint "Rerun with --fix to remove it."
    fi
  fi

  if [ -f "$WP_CONF" ]; then
    ok "Codec config present, correct format: $WP_CONF"
  else
    warn "SBC-XQ not enabled (roughly doubles SBC bitrate)."
    if [ "$FIX" -eq 1 ]; then
      mkdir -p "$WP_DIR"
      if [ "$WP_STYLE" = "lua" ]; then
        cat > "$WP_CONF" <<'CONF'
-- Higher-quality SBC, and A2DP only. WirePlumber 0.4 (Lua) format.
--
-- enable-sbc-xq raises the SBC bitpool well above the default, a clear
-- audible improvement on a healthy link.
--
-- Restricting roles to the A2DP ones stops anything ever negotiating the
-- HSP/HFP headset profile (8-16kHz mono). A speaker with no microphone has
-- no reason to offer it.
bluez_monitor.properties = {
  ["bluez5.enable-sbc-xq"] = true,
  ["bluez5.roles"] = "[ a2dp_sink a2dp_source ]",
}
CONF
      else
        cat > "$WP_CONF" <<'CONF'
# Higher-quality SBC, and A2DP only. WirePlumber 0.5+ (SPA-JSON) format.
#
# enable-sbc-xq raises the SBC bitpool well above the default, a clear
# audible improvement on a healthy link.
#
# Restricting roles to the A2DP ones stops anything ever negotiating the
# HSP/HFP headset profile (8-16kHz mono). A speaker with no microphone has
# no reason to offer it.
monitor.bluez.properties = {
  bluez5.enable-sbc-xq = true
  bluez5.roles = [ a2dp_sink a2dp_source ]
}
CONF
      fi
      ok "Wrote $WP_CONF ($WP_STYLE format, matching WirePlumber $wp_ver)"
      systemctl --user restart wireplumber 2>/dev/null \
        && ok "Restarted wireplumber." \
        || hint "Restart it yourself: systemctl --user restart wireplumber"
      hint "Now DISCONNECT and RECONNECT the BT20A — the codec is negotiated"
      hint "when the link is established, so an existing connection keeps the"
      hint "old one."
    else
      hint "Fix: rerun with --fix to write $WP_CONF"
    fi
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

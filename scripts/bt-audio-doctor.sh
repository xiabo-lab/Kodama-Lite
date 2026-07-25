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
NO_XQ=0
case "${1:-}" in
  --fix)       FIX=1 ;;
  --no-sbc-xq) NO_XQ=1 ;;
esac

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

# ── 6. Codec actually in use ──────────────────────────────────────────
#
# Readable without pactl: wpctl can dump a node's properties, and the
# bluez5 sink carries the negotiated codec among them.

log "Negotiated codec"
if [ "$have_wpctl" -eq 1 ]; then
  bt_id=$(wpctl status 2>/dev/null \
          | sed -n '/Sinks:/,/Sources:/p' \
          | grep -iE 'bluez|BT20A|Fosi' \
          | grep -oE '[0-9]+\.' | head -1 | tr -d '.')
  if [ -n "$bt_id" ]; then
    codec=$(wpctl inspect "$bt_id" 2>/dev/null \
            | grep -iE 'bluez5.codec|api.bluez5.codec' | head -1 | sed 's/.*= *//' | tr -d '"')
    lat=$(wpctl inspect "$bt_id" 2>/dev/null \
          | grep -iE 'node.latency' | head -1 | sed 's/.*= *//' | tr -d '"')
    ok "Codec: ${codec:-not reported}"
    ok "Node latency: ${lat:-default}"
    if [ "${codec:-}" = "sbc" ]; then
      hint "Plain 'sbc' rather than 'sbc_xq' means the XQ config has not taken"
      hint "effect — the codec is negotiated at connect time, so DISCONNECT"
      hint "and RECONNECT the speaker after any config change."
    fi
  else
    warn "Couldn't identify the Bluetooth sink id."
  fi
fi

# ── 7. CPU governor ───────────────────────────────────────────────────

log "CPU governor"
gov_file=/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
if [ -r "$gov_file" ]; then
  gov=$(cat "$gov_file")
  if [ "$gov" = "performance" ]; then
    ok "performance"
  else
    warn "Governor is '$gov'. Ramp-up lag can cause audio dropouts."
    if [ "$FIX" -eq 1 ]; then
      if echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor >/dev/null 2>&1; then
        ok "Set to performance for this boot."
        hint "Persist with: sudo apt install -y cpufrequtils"
        hint "  then set GOVERNOR=\"performance\" in /etc/default/cpufrequtils"
      fi
    else
      hint "Try: echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor"
    fi
  fi
else
  hint "No cpufreq governor exposed; skipping."
fi

log "System load (audio dropouts can just be a busy CPU)"
hint "NOTE: this is meaningful only while a track is PLAYING. Idle load"
hint "says nothing about whether decode + Bluetooth is keeping up."
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

# ── 8. Buffering ──────────────────────────────────────────────────────
#
# The fix when everything above is clean and audio *still* breaks up only
# over Bluetooth. A2DP is a lossy radio link with variable delivery; if
# PipeWire's buffer is sized for a wired sink, every retransmit becomes an
# underrun. A bigger buffer rides over them.
#
# The cost is latency — roughly quantum/48000 seconds per buffer, so 2048
# is ~43ms. For a car stereo that is irrelevant (nothing is lip-syncing to
# it); for anything interactive it would not be.
#
# This is set globally rather than per-device on purpose: a per-node
# WirePlumber rule needs property names that differ between versions, and
# silently writing config that does nothing is a mistake this script has
# already made once.

PW_DIR="$HOME/.config/pipewire/pipewire.conf.d"
PW_CONF="$PW_DIR/10-bluetooth-latency.conf"

log "Audio buffer size"
if [ -f "$PW_CONF" ]; then
  ok "Larger-buffer config present: $PW_CONF"
  hint "If audio is now smooth but noticeably DELAYED, lower the quantum"
  hint "values in that file, or delete it to go back to the default."
else
  warn "Default buffer size — small for a Bluetooth link."
  if [ "$FIX" -eq 1 ]; then
    mkdir -p "$PW_DIR"
    cat > "$PW_CONF" <<'CONF'
# Larger audio buffers, to ride over Bluetooth retransmits.
#
# A2DP delivery is variable; a buffer sized for a wired sink underruns on
# every hiccup, which is heard as stuttering. ~43ms per buffer at 48kHz.
# Delete this file to return to PipeWire's defaults.
context.properties = {
  default.clock.quantum     = 2048
  default.clock.min-quantum = 1024
  default.clock.max-quantum = 8192
}
CONF
    ok "Wrote $PW_CONF"
    systemctl --user restart pipewire pipewire-pulse wireplumber 2>/dev/null \
      && ok "Restarted the audio stack." \
      || hint "Restart it: systemctl --user restart pipewire pipewire-pulse wireplumber"
  else
    hint "Fix: rerun with --fix to write $PW_CONF"
  fi
fi

# ── 9. Link quality ───────────────────────────────────────────────────

log "Bluetooth link"
mac=$(bluetoothctl devices Connected 2>/dev/null | awk '/Fosi|BT20A/ {print $2; exit}')
[ -z "$mac" ] && mac=$(bluetoothctl devices Connected 2>/dev/null | awk '{print $2; exit}')
if [ -n "$mac" ]; then
  ok "Connected device: $mac"
  rssi=$(bluetoothctl info "$mac" 2>/dev/null | grep -iE 'RSSI|TxPower' | sed 's/^\s*/  /')
  [ -n "$rssi" ] && printf '%s\n' "$rssi"
  hint "Bluetooth is 2.4GHz regardless of which band your WiFi uses, so it"
  hint "still shares air with every neighbouring 2.4GHz network. Distance and"
  hint "obstructions matter: test with the Pi and the BT20A close together and"
  hint "line-of-sight. If that alone fixes it, the link is marginal and the"
  hint "durable fix is a USB Bluetooth adapter with a real antenna — the Pi 5's"
  hint "onboard radio shares one small trace antenna with WiFi."
else
  warn "No connected Bluetooth device found."
fi

# ── Revert path ───────────────────────────────────────────────────────

if [ "$NO_XQ" -eq 1 ]; then
  log "Reverting SBC-XQ"
  removed=0
  for f in "$HOME/.config/wireplumber/wireplumber.conf.d/51-bluez-quality.conf" \
           "$HOME/.config/wireplumber/bluetooth.lua.d/51-bluez-quality.lua"; do
    [ -f "$f" ] && rm -f "$f" && ok "Removed $f" && removed=1
  done
  [ "$removed" -eq 0 ] && ok "Nothing to remove."
  systemctl --user restart wireplumber 2>/dev/null && ok "Restarted wireplumber."
  hint "Now disconnect and reconnect the speaker, then listen again."
  hint "XQ roughly doubles SBC's bitrate: better on a healthy link, worse on"
  hint "a marginal one. This tells you which yours is."
fi

log "Done"
if [ "$FIX" -eq 0 ] && [ "$NO_XQ" -eq 0 ]; then
  hint "This run changed nothing. Rerun with --fix to apply the safe fixes."
fi
hint "Remember: any codec change needs a DISCONNECT + RECONNECT of the"
hint "speaker to take effect — it is negotiated at link setup."

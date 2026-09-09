#!/usr/bin/env bash
# Deterministic tests for the Tesla A2DP handoff state. No Bluetooth hardware,
# system D-Bus, PipeWire, root access, or pairing is required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONNECT_SCRIPT="$SCRIPT_DIR/tesla-bt-connect.sh"
CALL_LOG="$(mktemp)"
trap 'rm -f "$CALL_LOG"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }

# Globals consumed by the extracted production functions.
PW_USER=test
PW_UID=1000
MAC_PATH=4C_FC_AA_55_B0_60
UUID_A2DP_SOURCE=source
UUID_A2DP_SINK=sink
PROFILE_CONNECT_TIMEOUT_SEC=1
PROFILE_CONNECT_RETRY_SEC=2
PROFILE_DUMP_TIMEOUT_SEC=1
PROFILE_HANDOFF_GRACE_SEC=2
last_sink_request=0
profile_transition_started=0
source_drop_attempted=0
MOCK_NOW=100
MOCK_DUMP=""
MOCK_BUSCTL_RC=0
MOCK_BUSCTL_OUTPUT=""

log() { :; }
warn() { :; }
err() { :; }
sleep() { :; }
date() { printf '%s\n' "$MOCK_NOW"; }
sudo() { printf '%s' "$MOCK_DUMP"; }
timeout() { shift; "$@"; }
busctl() {
  printf '%s\n' "$*" >> "$CALL_LOG"
  printf '%s' "$MOCK_BUSCTL_OUTPUT"
  return "$MOCK_BUSCTL_RC"
}

# Load only the profile functions; sourcing the whole service would enter its
# main loop and touch the real machine.
eval "$(awk '/^request_tesla_sink\(\)/ { emit=1 } /^# ── waiting/ { emit=0 } emit' "$CONNECT_SCRIPT")"

MOCK_DUMP=""
if profile_report /device 1; then fail "missing node was marked healthy"; fi
pass "missing PipeWire node stays on fast retry"

MOCK_DUMP='"node.name": "bluez_output.4C_FC_AA_55_B0_60.1", "api.bluez5.profile": "a2dp-sink"'
profile_report /device 1 || fail "Tesla output was not marked healthy"
pass "Tesla output is healthy"

MOCK_DUMP='"node.name": "bluez_input.4C_FC_AA_55_B0_60.2", "api.bluez5.profile": "a2dp-source"'
if profile_report /device 1; then fail "reverse Tesla input was marked healthy"; fi
pass "reverse Tesla input stays on fast retry"

: > "$CALL_LOG"
MOCK_DUMP='"node.name": "bluez_input.4C_FC_AA_55_B0_60.2" "node.name": "bluez_output.4C_FC_AA_55_B0_60.1", "api.bluez5.profile": "a2dp-sink"'
profile_report /device 1 || fail "coexisting output/input was not usable"
grep -q 'DisconnectProfile.*source' "$CALL_LOG" || fail "reverse source was not removed after output confirmation"
pass "make-before-break cleans up source after output exists"

: > "$CALL_LOG"
last_sink_request=0
request_tesla_sink /device 1 || fail "initial sink request failed"
grep -q 'ConnectProfile.*sink' "$CALL_LOG" || fail "remote Audio Sink was not requested"
[ "$last_sink_request" -eq "$MOCK_NOW" ] || fail "sink request timestamp was not saved"
pass "remote sink is requested immediately"

: > "$CALL_LOG"
profile_transition_started=97
source_drop_attempted=0
last_sink_request=100
drive_sink_handoff /device 1
grep -q 'DisconnectProfile.*source' "$CALL_LOG" || fail "fallback did not remove reverse source"
grep -q 'ConnectProfile.*sink' "$CALL_LOG" || fail "fallback did not retry remote sink"
[ "$source_drop_attempted" -eq 1 ] || fail "fallback was not marked complete"
pass "two-second fallback performs break-before-make once"

bash -n "$CONNECT_SCRIPT"
pass "service script syntax"

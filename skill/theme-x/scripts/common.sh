#!/bin/bash
# codex-theme-x shared helpers (macOS).
set -euo pipefail

CTX_HOME="${CTX_HOME:-$HOME/.codex/codex-theme-x}"
CTX_PORT="${CTX_PORT:-9341}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "error: $*" >&2; exit 1; }

find_codex_bundle() {
  local candidate
  for candidate in "/Applications/ChatGPT.app" "/Applications/Codex.app"; do
    if [ -f "$candidate/Contents/Info.plist" ] \
      && [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$candidate/Contents/Info.plist" 2>/dev/null)" = "com.openai.codex" ]; then
      echo "$candidate"; return 0
    fi
  done
  candidate="$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "com.openai.codex"' 2>/dev/null | /usr/bin/grep '^/Applications/' | /usr/bin/head -n1)"
  [ -n "$candidate" ] && { echo "$candidate"; return 0; }
  fail "Codex app (com.openai.codex) not found in /Applications"
}

# System node >= 22, else the signed node bundled inside the Codex app.
find_node() {
  local sys_node major bundle
  sys_node="$(command -v node || true)"
  if [ -n "$sys_node" ]; then
    major="$("$sys_node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "$major" -ge 22 ] && { echo "$sys_node"; return 0; }
  fi
  bundle="$(find_codex_bundle)"
  if [ -x "$bundle/Contents/Resources/cua_node/bin/node" ]; then
    echo "$bundle/Contents/Resources/cua_node/bin/node"; return 0
  fi
  fail "no Node.js >= 22 found (system or bundled)"
}

codex_main_pids() {
  # Match the exact executable field so helper/render processes and shell
  # commands that merely mention the bundle are never treated as the app.
  /bin/ps -axww -o pid=,command= | /usr/bin/awk '
    $2 == "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" ||
    $2 == "/Applications/Codex.app/Contents/MacOS/Codex" { print $1 }
  '
}

# Match only the actual app executable. Searching for the bundle id also
# matches helper/diagnostic command lines and can make a successful quit look
# like a permanently running Codex process.
codex_is_running() { [ -n "$(codex_main_pids)" ]; }

cdp_reachable() { /usr/bin/curl -s -m 2 "http://127.0.0.1:$CTX_PORT/json/version" >/dev/null 2>&1; }

quit_codex() {
  /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null 2>&1 || true
  local deadline=$((SECONDS + 10))
  while codex_is_running && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.5; done
  if codex_is_running; then
    # Codex can defer AppleScript termination while an agent turn is active.
    # A normal TERM is the same graceful signal used by app launchers and lets
    # the detached apply stage continue without touching helpers or other apps.
    local pids; pids="$(codex_main_pids)"
    [ -n "$pids" ] && /bin/kill $pids 2>/dev/null || true
    deadline=$((SECONDS + 15))
    while codex_is_running && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.5; done
  fi
  if codex_is_running; then
    # Last resort: the app deferred both AppleScript quit and TERM (it does
    # this while an agent turn is active). Conversations are server-side, so
    # KILL loses nothing important — and without it the restart never happens.
    local pids; pids="$(codex_main_pids)"
    [ -n "$pids" ] && /bin/kill -9 $pids 2>/dev/null || true
    deadline=$((SECONDS + 5))
    while codex_is_running && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.5; done
  fi
  codex_is_running && fail "Codex did not quit within 40s"
  return 0
}

launch_codex_debug() {
  local bundle; bundle="$(find_codex_bundle)"
  /usr/bin/open -na "$bundle" --args --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CTX_PORT"
}

launch_codex_normal() {
  local bundle; bundle="$(find_codex_bundle)"
  /usr/bin/open -na "$bundle"
}

wait_for_cdp() {
  local deadline=$((SECONDS + ${1:-40}))
  while ! cdp_reachable; do
    [ "$SECONDS" -ge "$deadline" ] && return 1
    /bin/sleep 0.5
  done
  return 0
}

# Spawn a command in a NEW SESSION (node's detached=setsid), appending its
# output to $1. The caller's shell usually lives inside the Codex app's exec
# harness, which kills the whole process group when the command returns —
# nohup only ignores SIGHUP, so a nohup'd child dies with the group. A new
# session gets its own process group and survives.
detach_survivor() {
  local log="$1"; shift
  local node; node="${NODE:-$(find_node)}"
  "$node" -e '
    const { spawn } = require("child_process");
    const fs = require("fs");
    const log = fs.openSync(process.argv[1], "a");
    spawn(process.argv[2], process.argv.slice(3), {
      detached: true,
      stdio: ["ignore", log, log],
    }).unref();
  ' "$log" "$@"
}

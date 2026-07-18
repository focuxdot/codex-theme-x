#!/bin/bash
# codex-theme-x apply — the one atomic operation:
#   quit Codex → write colors into config.toml → relaunch with the debug flag
#   → wait for CDP → inject the background layer.
#
# The whole sequence runs DETACHED: this script is usually spawned from a shell
# that lives inside the Codex app itself, and quitting the app would kill a
# non-detached child half way through.
#
# Usage:
#   apply.sh --theme <dir> [--live-only]
#     --live-only   inject background + write colors, but skip the restart
#                   (colors appear on next launch; background appears now if
#                   the app is already running with CDP)
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

THEME_DIR="" LIVE_ONLY=false STAGE2=false SET_MODE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --theme) THEME_DIR="$(cd "$2" && pwd)"; shift 2 ;;
    --live-only) LIVE_ONLY=true; shift ;;
    --set-mode) SET_MODE=(--set-mode); shift ;;  # flip light/dark mode to the theme's variant (explicit user request only)
    --stage2) STAGE2=true; shift ;;   # internal: we ARE the detached process
    *) fail "unknown option: $1" ;;
  esac
done
[ -n "$THEME_DIR" ] || fail "--theme <dir> is required"
[ -f "$THEME_DIR/theme.json" ] || fail "no theme.json in $THEME_DIR"

NODE="$(find_node)"
mkdir -p "$CTX_HOME"
LOG="$CTX_HOME/apply.log"

# Remember the active theme so keeper/doctor/switch know what to re-apply.
save_pointer() { printf '%s\n' "$THEME_DIR" > "$CTX_HOME/current-theme"; }

if [ "$LIVE_ONLY" = true ]; then
  "$NODE" "$SCRIPT_DIR/write-colors.mjs" apply --theme "$THEME_DIR" ${SET_MODE[@]+"${SET_MODE[@]}"}
  if cdp_reachable; then
    "$NODE" "$SCRIPT_DIR/inject.mjs" apply --theme "$THEME_DIR" --port "$CTX_PORT"
    echo "background applied live; colors will follow on the next app restart"
  else
    echo "colors written; Codex is not running with CDP, background will appear after: apply.sh --theme $THEME_DIR"
  fi
  save_pointer
  exit 0
fi

if [ "$STAGE2" = false ]; then
  # Detach stage 2 and return immediately so the caller can tell the user
  # the app is about to restart before the ground disappears under us.
  detach_survivor "$LOG" /bin/bash "$0" --theme "$THEME_DIR" --stage2 ${SET_MODE[@]+"${SET_MODE[@]}"}
  echo "restart sequence started (log: $LOG)."
  echo "Codex will quit and come back themed in ~15 seconds."
  exit 0
fi

# ------------------------------------------------------------------- stage 2
echo "[$(date '+%F %T')] applying $(basename "$THEME_DIR")"
# The caller is usually an agent whose shell lives INSIDE Codex. Give it a
# moment to flush its final message to the user before we pull the app down.
/bin/sleep 5
quit_codex
"$NODE" "$SCRIPT_DIR/write-colors.mjs" apply --theme "$THEME_DIR" ${SET_MODE[@]+"${SET_MODE[@]}"}
save_pointer
launch_codex_debug
wait_for_cdp 60 || fail "Codex did not expose CDP within 60s"
# The renderer needs a beat after the port opens before the page exists.
for _ in $(seq 1 30); do
  if "$NODE" "$SCRIPT_DIR/inject.mjs" apply --theme "$THEME_DIR" --port "$CTX_PORT" 2>>"$LOG"; then
    echo "[$(date '+%F %T')] theme applied"
    exit 0
  fi
  /bin/sleep 1
done
fail "injection did not succeed after app restart (see $LOG)"

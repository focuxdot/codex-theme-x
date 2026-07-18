#!/bin/bash
# codex-theme-x restore — return Codex to its pristine official appearance:
#   remove the injected background, restore original colors in config.toml,
#   uninstall the keeper, and (detached) relaunch WITHOUT the debug flag so
#   the CDP port closes.
#
# Usage: restore.sh [--no-restart]
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

NO_RESTART=false STAGE2=false
while [ $# -gt 0 ]; do
  case "$1" in
    --no-restart) NO_RESTART=true; shift ;;
    --stage2) STAGE2=true; shift ;;
    *) fail "unknown option: $1" ;;
  esac
done

NODE="$(find_node)"
LOG="$CTX_HOME/apply.log"

if [ "$STAGE2" = false ]; then
  # Stop re-injection first, then strip the current payload.
  "$SCRIPT_DIR/keeper-uninstall.sh" >/dev/null 2>&1 || true
  if cdp_reachable; then
    "$NODE" "$SCRIPT_DIR/inject.mjs" remove --port "$CTX_PORT" || true
  fi
  "$NODE" "$SCRIPT_DIR/write-colors.mjs" restore || true
  rm -f "$CTX_HOME/current-theme"

  if [ "$NO_RESTART" = true ]; then
    echo "restored (colors take effect on next launch; CDP port stays open until the app restarts)"
    exit 0
  fi

  detach_survivor "$LOG" /bin/bash "$0" --stage2
  echo "restore started; Codex will relaunch clean (no debug port) in ~10 seconds."
  exit 0
fi

echo "[$(date '+%F %T')] restore: relaunching without debug flag"
# The caller is usually an agent whose turn is still finishing inside Codex —
# the app defers quit while a turn is active. Give it a moment first.
/bin/sleep 5
quit_codex
launch_codex_normal
echo "[$(date '+%F %T')] restore complete"

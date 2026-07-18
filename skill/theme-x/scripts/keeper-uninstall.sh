#!/bin/bash
# Remove the keeper LaunchAgent.
set -euo pipefail
LABEL="com.codex-theme-x.keeper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "keeper uninstalled"
else
  echo "keeper was not installed"
fi

#!/bin/bash
# Install the keeper LaunchAgent (auto re-apply the background after app
# restarts and page reloads). Opt-in: when an applied theme has a background,
# opening Codex normally causes one controlled relaunch with a loopback-only
# debug port, followed by background injection.
#
# A lightweight resident bridge checks only for the renderer's one-shot flush
# flag. It never uploads on a timer: without a buffer-full / normal-exit flag,
# the check is a no-op. Keeping the bridge resident is required because
# launchd filesystem watches do not observe localStorage writes.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

LABEL="com.codex-theme-x.keeper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(find_node)"
mkdir -p "$CTX_HOME" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$SCRIPT_DIR/keeper.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CTX_HOME</key><string>$CTX_HOME</string>
    <key>CTX_PORT</key><string>$CTX_PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$CTX_HOME/keeper.log</string>
  <key>StandardErrorPath</key><string>$CTX_HOME/keeper.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "keeper installed, resident event bridge ($PLIST); applied image themes will auto-restore and flush explicit ad signals"

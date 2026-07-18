#!/bin/bash
# Install the keeper LaunchAgent (auto re-apply the background after app
# restarts and page reloads). Opt-in: when an applied theme has a background,
# opening Codex normally causes one controlled relaunch with a loopback-only
# debug port, followed by background injection.
#
# Event-driven by default — NO resident process. launchd watches the app's
# Singleton files (Electron rewrites them at every launch); each launch/quit
# spawns one short-lived check that exits immediately when there is nothing
# to do. Falls back to the legacy resident poller only if the app's user-data
# dir can't be found.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

LABEL="com.codex-theme-x.keeper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(find_node)"
mkdir -p "$CTX_HOME" "$HOME/Library/LaunchAgents"

USER_DATA_DIR="$HOME/Library/Application Support/Codex"
if [ -d "$USER_DATA_DIR" ]; then
  MODE_ARGS="    <string>--oneshot</string>"
  MODE_KEYS="  <key>KeepAlive</key><false/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>WatchPaths</key>
  <array>
    <string>$USER_DATA_DIR/SingletonCookie</string>
    <string>$USER_DATA_DIR/ChromeFeatureState</string>
  </array>"
  MODE_DESC="event-driven (zero resident cost)"
else
  MODE_ARGS=""
  MODE_KEYS="  <key>KeepAlive</key><true/>"
  MODE_DESC="resident fallback (user-data dir not found)"
fi

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
$MODE_ARGS
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CTX_HOME</key><string>$CTX_HOME</string>
    <key>CTX_PORT</key><string>$CTX_PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
$MODE_KEYS
  <key>StandardOutPath</key><string>$CTX_HOME/keeper.log</string>
  <key>StandardErrorPath</key><string>$CTX_HOME/keeper.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "keeper installed, $MODE_DESC ($PLIST); applied image themes will auto-restore after normal Codex launches"

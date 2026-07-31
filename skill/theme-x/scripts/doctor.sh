#!/bin/bash
# codex-theme-x doctor — self-check with a human-readable report.
# Exit 0 when healthy or simply not applied; non-zero when something that
# should be working is broken.
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PROBLEMS=0
ok()   { echo "  ok   $*"; }
warn() { echo "  warn $*"; }
bad()  { echo "  BAD  $*"; PROBLEMS=$((PROBLEMS + 1)); }

echo "codex-theme-x doctor"

# 1. runtime
if NODE="$(find_node 2>/dev/null)"; then ok "node: $NODE ($("$NODE" --version))"; else bad "no Node.js >= 22 (system or Codex-bundled)"; echo; exit 1; fi

# 2. app bundle
if BUNDLE="$(find_codex_bundle 2>/dev/null)"; then ok "codex app: $BUNDLE"; else bad "Codex app not found"; fi

# 3. app / CDP state
if codex_is_running; then
  if cdp_reachable; then
    ok "codex running with CDP on 127.0.0.1:$CTX_PORT"
  else
    warn "codex is running WITHOUT the debug port — an enabled keeper will relaunch it only when the applied theme has a background"
  fi
else
  warn "codex is not running"
fi

# 4. theme state
POINTER="$CTX_HOME/current-theme"
if [ -f "$POINTER" ]; then
  THEME_DIR="$(cat "$POINTER")"
  if [ -f "$THEME_DIR/theme.json" ]; then
    ok "current theme: $(basename "$THEME_DIR") ($THEME_DIR)"
  else
    bad "current-theme points to a missing theme: $THEME_DIR"
  fi
  if cdp_reachable; then
    STATUS="$("$NODE" "$SCRIPT_DIR/inject.mjs" status --port "$CTX_PORT" --json 2>/dev/null || echo '{}')"
    case "$(printf '%s' "$STATUS" | "$NODE" -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).injected))' 2>/dev/null)" in
      true)
        ok "background payload injected"
        SURFACE_STATE="$(printf '%s' "$STATUS" | "$NODE" -e '
          process.stdin.on("data", d => {
            const h = JSON.parse(d).health;
            if (!h) return console.log("unknown");
            if (!h.mainFound) return console.log("missing");
            console.log(h.mainSurfaceApplied ? "ok" : "bad");
          })' 2>/dev/null || echo unknown)"
        case "$SURFACE_STATE" in
          ok)
            SURFACE_DETAIL="$(printf '%s' "$STATUS" | "$NODE" -e '
              process.stdin.on("data", d => {
                const h = JSON.parse(d).health;
                console.log(`actual ${h.actualPanelOpacity}, configured ${h.expectedPanelOpacity}`);
              })' 2>/dev/null || true)"
            ok "main surface follows theme opacity ($SURFACE_DETAIL)"
            ;;
          bad) bad "main surface does NOT follow theme opacity (Codex likely changed its DOM/CSS)" ;;
          missing) bad "Codex main surface was not found (app internals changed)" ;;
          *) warn "payload is older than the live surface check; re-apply the theme" ;;
        esac
        ;;
      false) bad "theme is set but the background is NOT injected (run apply, or install the keeper)" ;;
      *)     warn "could not query injection state" ;;
    esac
  fi
else
  ok "no theme applied (pristine)"
fi

# 5. colors in config
if grep -q '^\[desktop\.appearance\(Dark\|Light\)ChromeTheme\]' "$HOME/.codex/config.toml" 2>/dev/null; then
  ok "official color tables present in config.toml"
else
  warn "no custom color tables in config.toml"
fi

# 6. keeper
if [ -f "$HOME/Library/LaunchAgents/com.codex-theme-x.keeper.plist" ]; then
  if launchctl list "com.codex-theme-x.keeper" >/dev/null 2>&1; then
    ok "keeper installed and loaded (applied image themes auto-restore after a normal launch)"
  else
    bad "keeper plist exists but the agent is not loaded (try keeper-install.sh again)"
  fi
else
  ok "keeper not installed (background lives until the next app restart)"
fi

echo
if [ "$PROBLEMS" -eq 0 ]; then echo "all good"; else echo "$PROBLEMS problem(s) found"; exit 1; fi

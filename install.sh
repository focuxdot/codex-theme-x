#!/bin/bash
# codex-theme-x installer — assemble the `theme` skill into ~/.codex/skills/.
# Run from a repo checkout: bash install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="${CODEX_SKILLS_DIR:-$HOME/.codex/skills}"
DEST="$SKILLS_DIR/theme-x"

[ -f "$REPO_DIR/skill/theme-x/SKILL.md" ] || { echo "error: run this from a codex-theme-x checkout" >&2; exit 1; }

# Clean install so files removed from the repo don't linger across upgrades.
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$REPO_DIR/skill/theme-x/." "$DEST/"
mkdir -p "$DEST/themes" "$DEST/references"
cp -R "$REPO_DIR/themes/." "$DEST/themes/"
cp "$REPO_DIR/spec/codextheme-format.md" "$DEST/references/codextheme-format.md"
chmod +x "$DEST/scripts/"*.sh "$DEST/scripts/"*.mjs

echo "installed: $DEST"
echo
bash "$DEST/scripts/doctor.sh" || true
echo
echo "Open a NEW Codex conversation (skills are scanned at conversation start),"
echo "then try:  \$theme-x <一张图的路径>   或   \$theme-x list"

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

# Localize the skill-picker description at install time. The source SKILL.md
# keeps the English description as canonical; here we swap in the localized
# string on the INSTALLED copy only (that frontmatter line is what Codex's
# `/`-picker renders). Language: THEME_X_LANG override → macOS system language →
# $LANG; anything Chinese picks zh, otherwise the English source stays.
DESC_ZH="换张背景，顺手换个心情：Codex 桌面端的整套主题，从一张图里自动生成、彼此呼应。"
lang="${THEME_X_LANG:-}"
if [ -z "$lang" ]; then
  sys="$(defaults read -g AppleLanguages 2>/dev/null | tr -d '\n ' || true)"
  [ -n "$sys" ] || sys="${LANG:-}"
  case "$sys" in *zh*|*Hans*|*Hant*) lang=zh ;; *) lang=en ;; esac
fi
if [ "$lang" = zh ]; then
  DESC="$DESC_ZH" node -e 'const fs=require("fs"),p=process.argv[1];let s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace(/^description:.*$/m,"description: "+process.env.DESC));' "$DEST/SKILL.md"
  echo "description language: zh"
else
  echo "description language: en"
fi

echo "installed: $DEST"
echo
bash "$DEST/scripts/doctor.sh" || true
echo
echo "Open a NEW Codex conversation (skills are scanned at conversation start),"
echo "then try:  \$theme-x <一张图的路径>   或   \$theme-x list"

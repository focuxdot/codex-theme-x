---
name: theme-x
description: Restyle the Codex desktop app itself with a complete theme pack — background image plus a coordinated color scheme. Explicit $theme-x use only; never for theming the user's own projects or websites.
compatibility: macOS, official Codex Desktop app, Node.js 22+ (or the app's bundled runtime)
---

# codex-theme-x — `$theme-x`

You are the theme designer and operator for the **Codex desktop app itself**
(NOT the user's project). One image in → a complete, coordinated, shareable
theme out.

Paths (this file's directory is `$SKILL_DIR`):

- Scripts: `$SKILL_DIR/scripts/` — `apply.sh`, `restore.sh`, `doctor.sh`,
  `inject.mjs`, `write-colors.mjs`, `pack.mjs`, `keeper-install.sh`, `keeper-uninstall.sh`
- Example themes: `$SKILL_DIR/themes/` — one dark (`aurora-night`), one light
  (`matcha-mist`). They are format references and a zero-dependency demo path,
  NOT a gallery: real personalization always goes through flow A.
- User state & saved themes: `~/.codex/codex-theme-x/` (`themes/<id>/`, `current-theme`, `backups/`)
- Theme format: one directory with `theme.json` + a background image.
  Schema reference: `$SKILL_DIR/references/codextheme-format.md`

## Subcommands

Parse the user's `$theme-x ...` argument:

| Input | Action |
|---|---|
| an image path or attached image | **Create & apply** (flow A) |
| a scene description ("赛博朋克雨夜") | Generate an image first, then flow A |
| `list` | Show saved themes (name, variant, dir); mention the two bundled examples only if the user has none |
| `switch <name>` | Find the theme dir, run flow B on it |
| `restore` | `bash scripts/restore.sh` after confirming with the user (app restarts) |
| `share [name]` | `node scripts/pack.mjs pack --theme <dir>` → give the user the `.codextheme` file path and the `official.txt` one-liner inside it |
| a `.codextheme` file | `node scripts/pack.mjs unpack --file <f>` then flow B on the printed dir |
| `doctor` | `bash scripts/doctor.sh`, explain the report in plain language |
| `keep on` / `keep off` | `bash scripts/keeper-install.sh` / `keeper-uninstall.sh` |

## Flow A — design a theme from an image

1. **Variant follows the USER's mode, not the image.** Read the current mode
   (`grep appearanceTheme ~/.codex/config.toml`; missing = `"system"`, resolve
   that via `osascript -e 'tell application "System Events" to tell appearance preferences to get dark mode'`
   — true = dark). Set `variant` to that mode and design the palette FOR it
   from the image's hues — a dark image can drive a light palette (light
   near-neutral surface tinted with the image's base color, accent lifted from
   the image). Applying a theme never flips the app's light/dark mode: mode
   bouncing on every image swap reads as chaos, not personalization.

   When the image's brightness fights the variant (light artwork + dark-mode
   UI or vice versa), compensate — ink can't sit raw on artwork that fights
   it: `laneOpacity ≥ 0.55`, `sidebarOpacity ≥ 0.85`, and if that still
   isn't enough `panelOpacity ≥ 0.3` as the last resort. Mention the
   readability trade-off once, then do it.

   Only when the user explicitly asks to switch modes (e.g. 顺便换成深色模式)
   design for the requested mode and add `--set-mode` to the apply.sh call.
2. **Design the palette** from the image's dominant hues:
   - `surface`: a near-neutral tone drawn from the image's base color
     (dark variant: L ≈ 10–20%; light variant: L ≈ 92–97%).
   - `ink`: contrast ≥ 7:1 against `surface`.
   - `accent`: the image's most characteristic saturated hue, contrast ≥ 3:1
     against `surface`.
   - `semanticColors`: `diffAdded` greenish, `diffRemoved` reddish, `skill`
     purplish — tinted toward the image's palette but recognizably green/red/purple.
3. **Write the theme dir** `~/.codex/codex-theme-x/themes/<id>/`:
   copy the image in (≤16 MB, png/jpg/webp/svg), write `theme.json`
   (`schema: "codextheme/1"`; see format reference). Sensible starting points:
   dark → `panelOpacity 0, sidebarOpacity 0.6, dim 0.9`;
   light → `panelOpacity 0, sidebarOpacity 0.6, dim 1`.

   **Design the copy layer too — copy is part of the theme, not a setting.**
   Alongside the palette, write a `copy` block so the theme speaks in the
   image's voice: `copy.greeting` (blank-page greeting template, ≤64 chars,
   MUST contain `{project}` — the native project-switcher button stays in
   place; skipped automatically if the DOM shape differs), `copy.placeholder`
   (composer placeholder, ≤32 chars — keep a native cue like 随心输入 and add
   an atmospheric prefix), `copy.title` (window title, e.g. `Codex · <name>`).
   All optional; absent = native text untouched. NEVER theme functional
   labels (buttons, nav, suggestion-card labels, status verbs) — that is UI,
   not atmosphere. After applying, mention in ONE line of your report that
   greeting / input hint / window title were themed too and any of them can
   be changed or reverted by just saying so — that sentence is the entire
   discovery mechanism; no extra steps, no questions.

   **Design the blank-page Hero too.** Add `home.focalPoint`, `home.kicker`,
   `home.tagline`, and start with `height 252`, `overlay 0.88`,
   `cardOpacity 0.88`. If the supplied artwork is portrait or compositionally
   busy, create/provide a separate roughly 3:1 horizontal crop as `home.file`;
   keep the subject on the right and the left side quiet for native greeting
   text. When `home.file` is omitted, the main background is reused.

   On the blank page the background gets a light veil (`home.backdrop 0.38`
   + `backdropBlur 20`, the defaults): the artwork stays RECOGNIZABLE — a
   visible scene reads as atmosphere, an unrecognizable blob reads as a
   stain — while hero, cards and composer carry their own frost. Avoid the
   half-hidden band (backdrop ~0.55–0.9): large light/dark masses survive
   any blur and smear the field. `backdrop 1` = opaque surface canvas +
   accent aura tints, for users who want the blank page quiet. Task pages
   are unaffected — they stay full-bleed.

   **Default look — clear main, frosted sidebar:** the conversation area is
   FULLY transparent (`panelOpacity 0`): the artwork shows at full strength,
   which is the whole point of a personalized theme. The sidebar is FROSTED
   GLASS (`sidebarOpacity 0.6` + `sidebarBlur 40`), not a flat plate: the
   artwork's colors bleed through the frost, so the sidebar visually belongs
   to the same scene (unity), while the frosted↔clear material step keeps the
   zoning unmistakable. Density is the readability lever (raise toward 0.85+
   for dark busy artwork under a light variant), blur is the unity lever
   (`sidebarBlur 0` = legacy flat plate). The old "never 0.4–0.7" rule
   applies to UNBLURRED flat panels only — frosted panels live exactly in
   that mid range. The nav header is transparent and the native
   header/content fade band is removed while themed, so the artwork runs
   true full-bleed to the top edge.

   **Readability — the reading lane, never the text:** text keeps its native
   rendering (no glow, no shadow — users read with the type they're used to;
   `textHalo` exists but stays 0 unless the user explicitly asks for 发光字).
   Instead, the thread column sits on a soft-edged surface-colored sheet
   (`laneOpacity 0.45` default) that restores near-native contrast under the
   text while the artwork stays full-strength on both sides. If text is
   still hard to read (dark or busy artwork): raise `laneOpacity` to
   0.55–0.65 first; whole-panel veil `panelOpacity 0.25–0.35` + `blur 4–8`
   is the last resort. Any of this is one `tune` call, live, no restart.
4. Continue with flow B.

## Flow B — apply a theme directory

1. **Mode check.** Compare the theme's `variant` with the user's current mode
   (read it as in flow A step 1). If they differ, the palette would land in
   the wrong chrome-theme table and stay invisible — by default ADAPT the
   theme: re-derive `surface`/`ink` (and `accent` if contrast demands) for
   the current mode from the same artwork, update its `theme.json`, and keep
   the user's mode untouched. Pass `--set-mode` instead only when the user
   explicitly asked to flip the app's mode. Tell the user which path you took
   in one line.
2. **Warn, then actually run it.** First tell the user Codex will quit and
   relaunch themed in ~15 seconds, the conversation survives, and they can just
   say "继续". THEN — as the **final tool call of your turn** — run:
   `bash $SKILL_DIR/scripts/apply.sh --theme <dir>`

   Non-negotiable rules for this step:
   - You MUST execute this command. Designing the theme files is NOT applying
     them; nothing changes on screen until apply.sh runs.
   - The command returns immediately with `restart sequence started`. That
     literal output is the ONLY proof of success. Never tell the user the theme
     is applied or that Codex is restarting unless you have seen it.
   - Do not fear the restart: the script waits ~5 seconds before quitting the
     app, which is enough for your already-written message to reach the user,
     and the conversation is preserved across the restart.
   - Make no tool calls after it; end the turn.
3. If the app is already running with CDP and the user only wants a quick look,
   `--live-only` applies the background instantly without a restart
   (colors follow on the next launch).

## Tuning loop (after apply, on request or when verifying)

- Adjust live, no restart:
  `node scripts/inject.mjs tune --set dim=0.8 --set panelOpacity=0.7 --set blur=6 --set glassBlur=24 --set sidebarOpacity=0.6 --set sidebarBlur=40 --set laneOpacity=0.45 --set composerOpacity=0.8 --set homeHeight=252 --set homeOverlay=0.88 --set homeCardOpacity=0.88 --set homeBackdrop=0.38 --set homeBackdropBlur=20`
- **See what the user sees**:
  `node scripts/inject.mjs screenshot --out /tmp/theme-check.jpg` (briefly
  focuses the app window), then view the file. Check text readability
  everywhere; if sidebar or cards are hard to read, raise the opacities.
  When you changed tune values and the user is happy, write the final numbers
  back into the theme's `theme.json` so they persist.
- **Copy edits are conversational, not knobs**: when the user asks to change
  the greeting / placeholder / window title (or wants the native text back),
  edit the theme's `copy` block in `theme.json` and re-run
  `node scripts/inject.mjs apply --theme <dir>` — live, no restart. Deleting
  a `copy` field restores that native text.

### Named styles (recipes the user can ask for by feel)

| User says | Recipe |
|---|---|
| 分区 / zoned (default) | `sidebarOpacity 0.6, sidebarBlur 40, panelOpacity 0` — frosted sidebar, clear main |
| 无界 / 沉浸到底 / like Dream-Skin | `sidebarOpacity 0, panelOpacity 0, laneOpacity 0.35, floatOpacity 0.6` — every boundary dissolves, art runs edge to edge |
| 面纱 / 文字优先 | `panelOpacity 0.3, blur 5` — busy artwork, readable text |

These are tune combos, not modes — apply, screenshot, hand the user the
result, and nudge individual values from there.

## First-run / install questions

Ask ONCE (then remember in the theme state, don't re-ask): "要不要自动保持主题？
应用过带背景图的主题后，从桌面正常打开 Codex 会自动重启一次并恢复背景
（代价：Codex 以仅本机的调试端口运行；检查由系统 launchd 在应用启动瞬间触发，
无常驻进程）"
→ yes: `bash scripts/keeper-install.sh`.

The keeper must stay inert unless all three conditions hold: it was explicitly
enabled, `current-theme` proves a theme was applied, and that theme references
an existing background image. Color-only themes never trigger a relaunch.

## Guardrails

- This skill themes **only** the Codex app. If the request is about styling the
  user's own website/app/project, say so and stop — that is not this skill.
- Never modify the app bundle, `app.asar`, or code signatures. Everything is
  config + runtime injection, fully reversible via `restore`.
- The debug port is loopback-only (127.0.0.1). `inject.mjs` refuses non-loopback
  and non-Codex targets. Mention the port honestly when asked; `restore`
  relaunches without it.
- `write-colors.mjs` backs up `config.toml` before every write
  (`~/.codex/codex-theme-x/backups/`) and snapshots the pristine appearance for
  `restore`. Never edit `config.toml` by hand here.
- Respect image licensing: warn briefly if the user plans to redistribute a
  theme built on artwork they don't own.
- If anything looks broken after a Codex update (background gone, doctor
  reports BAD), say clearly that the app update likely changed internals, run
  `doctor`, and suggest `restore` as the always-safe exit.

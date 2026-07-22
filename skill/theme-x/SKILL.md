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
| an image path or attached image | **Create & apply** a standard theme (flow A) |
| a scene description ("赛博朋克雨夜") | Generate an image first, then flow A |
| the above **+ a sponsored trigger** (广告 / 赞助 / sponsored / `$theme-x sponsor …`) | **Create & apply a sponsored (ad) theme** (flow A-sponsor) |
| `list` | Show saved themes (name, variant, **type**, dir); mention the two bundled examples only if the user has none |
| `switch <name>` | Find the theme dir, run flow B on it |
| `restore` | `bash scripts/restore.sh` after confirming with the user (app restarts) |
| `share` / `export` / `导出` / `分享` `[name]` | `node scripts/pack.mjs pack --theme <dir>` → return the exported file using the exact clickable-link contract below; keep `official.txt` inside the pack but do not print its `codex-theme-v1:` one-liner in the conversation. |
| a `.codextheme` file | `node scripts/pack.mjs unpack --file <f>` then flow B — the pack's `type` (standard/sponsored) is auto-detected on load; **both import identically** |
| `doctor` | `bash scripts/doctor.sh`, explain the report in plain language |
| `keep on` / `keep off` | `bash scripts/keeper-install.sh` / `keeper-uninstall.sh` |

### Export response contract

After a successful pack, the final response MUST contain exactly one clickable
Markdown local-file link and nothing else:

```markdown
[⬇ 下载 <filename>.codextheme](/absolute/path/to/<filename>.codextheme)
```

Use the exported file's absolute path as the link target. If the path contains
spaces, wrap the target in angle brackets. Never return a bare path, an inline
code path, or a code block instead of the link.

**Two theme types (`type` field).** `standard` (default) = a normal
personalization theme. `sponsored` = an ad theme that also renders clickable
Hero links. **Default is ALWAYS standard**: only enter the sponsored flow when
the user explicitly signals it (the word 广告 / 赞助 / sponsored, or a
`$theme-x sponsor …` prefix). Never infer "ad theme" from an ordinary image or
description — that protects the majority of normal users. Creating and sharing
sponsored themes is open to every user; the trigger is the only gate.

## Flow A — design a theme from an image

1. **Default is DUAL-MODE (`variant: "auto"`) — design BOTH a light and a dark
   palette from the one image.** The theme then follows the user's light/dark
   mode automatically, with no re-apply: switching the app mode in Settings
   swaps the whole palette AND the veil densities live. This is the default for
   every theme; you do not need a trigger. (Applying still never flips the
   user's current mode — `auto` simply has the right look ready for both.)

   Design **two coordinated palettes** from the same hues — a light one (light
   near-neutral surface, dark ink) and a dark one (dark surface, light ink),
   accent lifted from the image for each. They should read as the same theme in
   two lightings, not two different themes.

   **Per-mode readability compensation** (the density lever differs by mode):
   when the artwork is bright, the DARK mode needs a denser sidebar so dark ink
   stays legible (`sidebarOpacity ≥ 0.85`, `laneOpacity ≥ 0.55`); the LIGHT mode
   over the same bright art can stay light (`sidebarOpacity ≈ 0.6`). Put each
   mode's densities in its own `modes.<mode>.background`. Mention the trade-off
   once, then do it.

   **Explicit single-mode** (`$theme-x dark …` / `light …`, or "只做深色/浅色"):
   set `variant` to `"dark"` or `"light"` with a single top-level `official` +
   `background` (no `modes` block) — the legacy single-table path. Use
   `--set-mode` on apply.sh only when the user explicitly wants the app mode
   flipped to match.
2. **Design each palette** from the image's dominant hues (do this for BOTH the
   light and dark palette under `auto`):
   - `surface`: a near-neutral tone drawn from the image's base color
     (dark: L ≈ 10–20%; light: L ≈ 92–97%).
   - `ink`: contrast ≥ 7:1 against that mode's `surface`.
   - `accent`: the image's most characteristic saturated hue, contrast ≥ 3:1
     against that mode's `surface` (the two modes can carry different accents).
   - `semanticColors`: `diffAdded` greenish, `diffRemoved` reddish, `skill`
     purplish — tinted toward the image's palette but recognizably green/red/purple.
3. **Write the theme dir** `~/.codex/codex-theme-x/themes/<id>/`:
   copy the image in (≤16 MB, png/jpg/webp/svg), write `theme.json`
   (`schema: "codextheme/1"`; see format reference). For `auto`, carry both
   palettes + per-mode densities in a `modes` block; the shared image and blurs
   stay at the top level:
   ```jsonc
   "variant": "auto",
   "modes": {
     "light": { "official": { "surface": "#…", "ink": "#…", "accent": "#…", "contrast": … , "semanticColors": {…} },
                "background": { "panelOpacity": 0, "sidebarOpacity": 0.6,  "dim": 1,    "laneOpacity": 0.45 } },
     "dark":  { "official": { "surface": "#…", "ink": "#…", "accent": "#…", "contrast": … , "semanticColors": {…} },
                "background": { "panelOpacity": 0, "sidebarOpacity": 0.85, "dim": 0.72, "laneOpacity": 0.62 } }
   },
   "background": { "file": "background.jpg", "sidebarBlur": 40, "glassBlur": 20, "blur": 0 }
   ```
   Effective vars for a mode = top-level `background` merged with that mode's
   `modes.<mode>.background`. (A single-mode theme keeps the flat `official` +
   `background` with no `modes`.)

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

## Flow A-sponsor — design a sponsored (ad) theme

Enter this ONLY on an explicit sponsored trigger (see the two-types note above).
It is flow A plus an advertising layer; the difference is creative material
(copy + jump links), not a different pipeline. Any user can build one.

1. **Design the theme exactly as in flow A** (variant follows the user's mode,
   palette + copy + Hero from the image). The artwork IS the ad creative, so the
   Hero image matters even more — keep the left side quiet for the three copy
   lines.
2. **Source the advertiser creative — infer first, ask only as fallback.** The
   three Hero copy slots — `kicker` (top label), `greeting` (headline),
   `tagline` (subtitle) — can each become a clickable link. Each needs **copy
   text** and, if it should jump, a **landing URL** (http/https only — other
   schemes are dropped and the slot stays non-clickable). At least one slot is
   required.

   Where the creative comes from, in priority order:
   - **The user's own context is the primary source, and using it is the point.**
     Most users make an ad theme for *their own* product, so when their repos,
     open files, or memory carry a clear advertiser signal (a branded project,
     a product domain, a PRD/README with positioning), **infer the brand name,
     copy, and landing URL from it** rather than making them retype what you can
     already see. This "it already knows" auto-fill is a feature, not an
     overstep — a wrong guess costs nothing because every field is editable in
     one conversational turn (step 4).
   - **When you inferred it, SAY SO and make it correctable.** In your report,
     name the source in one line ("文案与链接读自你的 `<project>` 项目") and
     invite edits. The user can only fix what they can see, so provenance is what
     makes "填错也没关系" actually true. Match your running narration to what you
     wrote — don't say "no jump for now" and then wire live URLs.
   - **Only when there is NO signal at all** — no project, no brand, nothing in
     context — do NOT invent a brand or a domain. Ask the user one line ("这条广告
     是给谁做的？把文案和落地链接发我，或我先做无跳转的占位"), or write text-only
     slots with the URL omitted (valid, non-clickable). Fabricating a plausible
     real-looking domain from thin air is the one thing to avoid.

   The **disclosure** badge (a "Sponsored" chip on the kicker) is **OFF by
   default** — leave `sponsor.disclosure` unset; only add it if the advertiser
   or platform explicitly asks for one.
3. **Write `type: "sponsored"` + a `sponsor` block** into `theme.json` (schema
   reference: format doc, sponsor section):
   ```jsonc
   "type": "sponsored",
   "sponsor": {
     "disclosure": "Sponsored",        // optional badge on the kicker
     "slots": {
       "kicker":   { "text": "ACME AI",        "url": "https://acme.example/" },
       "greeting": { "text": "一个 API 接入所有大模型", "url": "https://acme.example/models" },
       "tagline":  { "text": "免费额度 · 立即体验",  "url": "https://acme.example/start" }
     }
   }
   ```
   **The `sponsor.slots` own the three Hero lines — do not also set
   `home.kicker` / `home.tagline`.** In a sponsored theme the sponsor slots
   render the Hero copy and `home.kicker`/`home.tagline` are dead text that only
   drifts out of sync; omit them (keep the rest of the `home` block — height,
   focalPoint, overlay, cardOpacity, backdrop — for layout).

   Red lines the renderer enforces (don't fight them): a linked slot must LOOK
   clickable and only navigates on an explicit click (never auto/hover); the
   disclosure badge, when set, is platform-rendered. A `sponsored` theme with no
   usable slot fails to load.
4. **Tell the user it's a sponsored theme** in one line — the Hero lines will be
   clickable and open the system browser, per-slot impression/click metrics are
   recorded locally (`node scripts/inject.mjs events`), and it can be shared as a
   normal `.codextheme` (`share`) that installs like any other pack. **If you
   inferred the brand/copy/links from the user's context (step 2), name the
   source and say any line or URL can be changed by just saying so** — that one
   sentence is what lets the user correct an auto-filled guess.
5. Continue with flow B.

## Flow B — apply a theme directory

1. **Mode check.** An `auto` theme always matches — it writes BOTH chrome
   tables and follows the user's mode live — so skip this step entirely (no
   adapt, no `--set-mode`). Only a SINGLE-mode theme (`variant: "dark"`/`"light"`)
   needs the check: compare its `variant` with the user's current mode (read it
   as in flow A step 1); if they differ, the palette would land in the wrong
   chrome-theme table and stay invisible — by default ADAPT the theme (re-derive
   `surface`/`ink`, and `accent` if contrast demands, for the current mode from
   the same artwork; update its `theme.json`; keep the user's mode untouched),
   or pass `--set-mode` only when the user explicitly asked to flip the app's
   mode. Tell the user which path you took in one line.
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
（代价：Codex 以仅本机的调试端口运行；系统 launchd 会保留一个轻量事件桥接进程，
每 4 秒只检查一次本地信号，无信号时不上传、不访问网络）"
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
- **Sponsored themes** are the line between a theme and adware — stay on the
  right side of it: links fire only on an explicit click on a clearly-marked
  slot, never auto/hover and never the whole Hero as a hot zone; landing URLs
  must be http(s) (the disclosure badge is off by default). Metering is a property
  of ad themes only — a standard theme's payload records nothing. Metrics stay
  local and content-free (slot/campaign/timestamp only — never URLs, screen, or
  keystrokes), and **upload is off unless `ADS_API_BASE` is configured** (env,
  `~/.codex/codex-theme-x/config.json`, or an applied gallery pack's validated
  `adsmarket-distribution.json`); read locally with `inject.mjs events`,
  upload (when configured) with `inject.mjs report`. Uploads are **event-driven,
  never periodic**: exactly three automatic triggers — the buffer hitting 10,
  a graceful app exit, and the next launch catching up leftovers. The renderer
  only drops a one-shot localStorage flag; the keeper turns each flag into one
  `report` (a `report.lock` keeps concurrent triggers mutually exclusive).
  Before upload, `report` must remove protocol-invalid legacy events from the
  main buffer before best-effort persistence to a bounded, metadata-only local
  quarantine, so quota pressure cannot let one bad event reject or permanently
  block valid events; never copy unknown event fields into that diagnostic store.
  The platform's successful ingest response is also the authority for Campaign
  state. Persist its `campaignStates`; when the current Campaign is
  `exhausted`, keep the theme/artwork and sponsor copy in place, stop recording
  billable impressions and sponsor clicks, disable the sponsor links, and show
  the Hero status “Campaign ended / future impressions will not earn revenue”
  with a link back to the gallery. Never infer exhaustion from the client-side
  budget or event count, and never add a polling/timer request for this state.
- If anything looks broken after a Codex update (background gone, doctor
  reports BAD), say clearly that the app update likely changed internals, run
  `doctor`, and suggest `restore` as the always-safe exit.

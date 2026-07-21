# codex-theme-x

**A theme skill for the Codex desktop app: send Codex an image — it redesigns itself into that theme.**

[中文](README.md) · [Theme format](spec/codextheme-format.md)

![Blank-session page with a theme applied](public/hero.jpg)

## Install

Let Codex install it (zero terminal) — send Codex this one sentence:

```
Install codex-theme-x for me: https://github.com/focuxdot/codex-theme-x
```

Or install from your own terminal, one line:

```
git clone --depth 1 https://github.com/focuxdot/codex-theme-x /tmp/codex-theme-x && bash /tmp/codex-theme-x/install.sh
```

Then start a **new conversation** (skills are scanned at conversation start)
and send `$theme-x` + an image. Done:

```
$theme-x ~/Pictures/miku.jpg     # image → AI palette → full theme
$theme-x cyberpunk rainy night   # prompt → image → theme
$theme-x list / switch / share (export / 导出 / 分享) / restore / doctor
```

Switching is one sentence too — `$theme-x switch <name>`, no restart.
Same app, two different worlds.

**A sea-breeze theme** — one palette carried from the blank page into the task page:

![Blank page under the sea-breeze theme](public/home-sea.jpg)

![Task page under the sea-breeze theme](public/task-sea.jpg)

**Swap in an ink-wash painting** and the whole app changes character — the
artwork runs full-bleed, and the conversation sits on a soft-edged
"reading lane" with the scene at full strength around it:

![Blank page under the ink-wash theme](public/home-ink.jpg)

![Task page under the ink-wash theme](public/task-ink.jpg)

## More than a wallpaper

- **AI-designed palette** written into the **official appearance system**
  (native, persistent, survives app updates)
- **Follows light/dark automatically by default**: one image yields both a light
  and a dark palette (with per-mode frost); flipping the system or Codex mode
  swaps the whole theme live, no re-apply
- **Home Hero** on the blank page — a wide themed banner with a tagline;
  task pages keep the native full-bleed artwork
- **Copy layer**: greeting, composer placeholder and window title match the
  artwork's voice (every screenshot here shows its own); functional labels
  are never touched
- **Frosted-glass zoning**: frosted sidebar, fully transparent conversation
  area — tune by talking ("make the sidebar denser"), live
- **One-file sharing**: `.codextheme` packs; people without the tool can still
  import the embedded official color string
- **Always reversible**: `$theme-x restore` returns to stock

## How it works

1. **Colors & fonts → the official appearance system**, written into the
   native `appearance*ChromeTheme` tables in `~/.codex/config.toml` (with
   automatic backups). Persistent across restarts and app updates.
2. **Artwork, Hero, glass, copy → reversible injection** over the app's
   loopback-only (127.0.0.1) debug port. Soft selectors degrade to the native
   page if Codex's DOM changes; `$theme-x doctor` self-checks.

No `.app` / `app.asar` modification, no signature tampering, fully reversible.

## Sharing

`$theme-x share` (also `export` / `导出` / `分享`) exports `<id>.codextheme`
(a zip). Recipients with the tool
drop it into a Codex chat; recipients without it paste the embedded
`codex-theme-v1:` string into Settings → Appearance → Import for the colors.

## Sponsored themes (optional)

Themes come in two types via a `type` field: `standard` (default, a normal
theme) and `sponsored` (an ad theme). A sponsored theme turns the blank-page
Hero's three copy lines into **clickable slots that open an advertiser's link**
in the system browser, with an optional "Sponsored" disclosure badge.

- **The default is always standard** — a sponsored theme is created only on an
  explicit signal (the word 广告 / 赞助 / sponsored, or `$theme-x sponsor …`), so
  normal users are never affected.
- **Open to everyone**: the build flow is the same as a normal theme, you just
  also supply the copy and the jump links.
- **The line vs. adware**: links fire only on an explicit click on a clearly
  marked slot — never auto/hover, never the whole Hero as a hot zone; metrics
  stay local and count impressions/clicks only (never link content, screen, or
  keystrokes). Upload is off by default and, when configured, happens only at
  three event-driven moments — buffer full (10 events), a graceful app exit,
  and next-launch catch-up — never on a timer.
- **Still usable after budget exhaustion**: the platform returns Campaign state
  with the next upload response. The theme keeps its appearance, marks the Hero
  as ended/no longer earning, and stops new ad impression metering and jumps.
- **Shares the same way**: a sponsored pack is the same `.codextheme` format and
  imports identically.

macOS first; Windows is on the roadmap.

## License

Not affiliated with OpenAI. Codex is a trademark of its owner. MIT License.

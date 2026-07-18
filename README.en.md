# codex-theme-x

**Send Codex an image — it redesigns itself into that theme.**

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
$theme-x list / switch / share / restore / doctor
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

`$theme-x share` exports `<id>.codextheme` (a zip). Recipients with the tool
drop it into a Codex chat; recipients without it paste the embedded
`codex-theme-v1:` string into Settings → Appearance → Import for the colors.

macOS first; Windows is on the roadmap.

## License

Not affiliated with OpenAI. Codex is a trademark of its owner. MIT License.

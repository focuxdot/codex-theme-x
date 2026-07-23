# codex-theme-x

**A theme skill for the Codex desktop app: send Codex an image — it redesigns itself into that theme.**

It also creates, exports, and imports sponsored theme packs; platform-issued
packs can attribute earnings from eligible impressions.

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
$theme-x sponsor ~/Pictures/ad.jpg # image + ad copy/links → sponsored theme
$theme-x list / switch / share (export / 导出 / 分享) / restore / doctor
$theme-x keep on                 # restore artwork automatically + enable the event bridge
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
- **End-to-end sponsored themes**: create a clickable ad Hero, export/import
  the same pack format, and preserve platform earnings attribution
- **Always reversible**: `$theme-x restore` returns to stock

## How it works

1. **Colors & fonts → the official appearance system**, written into the
   native `appearance*ChromeTheme` tables in `~/.codex/config.toml` (with
   automatic backups). Persistent across restarts and app updates.
2. **Artwork, Hero, glass, copy → reversible injection** over the app's
   loopback-only (127.0.0.1) debug port. Soft selectors degrade to the native
   page if Codex's DOM changes; `$theme-x doctor` self-checks.

No `.app` / `app.asar` modification, no signature tampering, fully reversible.

## Exporting and importing packs

`$theme-x share` (also `export` / `导出` / `分享`) exports the current theme as
`<id>.codextheme` (a zip). Standard and sponsored themes use the same format.
Recipients with theme-x drop the file into a Codex conversation and say
“install/apply this theme”; theme-x validates `theme.json`, detects `standard`
or `sponsored`, and applies the correct behavior without a separate ad-import command.

A pack contains `theme.json`, artwork, and `official.txt`. A platform-issued
sponsored pack may also contain `adsmarket-distribution.json`; re-exporting the
theme preserves that public earnings attribution. Recipients without theme-x
can paste the embedded `codex-theme-v1:` string into Settings → Appearance →
Import, but that imports colors only—not artwork, ad links, metrics, or attribution.

## Sponsored themes: creation, distribution, and earnings

Themes come in two types via a `type` field: `standard` (default, a normal
theme) and `sponsored` (an ad theme). A sponsored theme turns the blank-page
Hero's three copy lines into **clickable slots that open an advertiser's link**
in the system browser, with an optional "Sponsored" disclosure badge.

### 1. Create a sponsored theme

The sponsored flow starts only when the user explicitly says 广告, 赞助,
`sponsored`, or uses `$theme-x sponsor …`; an ordinary image always creates a
standard theme. Anyone can create a sponsored theme, for example:

```
$theme-x sponsor ~/Pictures/product.jpg for ACME, landing at https://acme.example
$theme-x turn this image into an ad theme; headline: “One API for every model”
```

The Hero has three independent slots: `kicker`, `greeting`, and `tagline`.
Each needs copy; its link is optional and must be `http/https`. At least one
usable slot is required. theme-x first looks for real brand, copy, and domain
signals in the current project context and reports what it used; it does not
invent a plausible domain when no reliable source exists.

Links open in the system browser only after an explicit click on that slot—no
automatic or hover navigation, and no invisible whole-Hero hot zone. The
`Sponsored` disclosure badge is off by default unless the advertiser or
platform explicitly requires it.

### 2. Export, forward, and import

After creating or applying a sponsored theme, `$theme-x share` exports it as a
normal `.codextheme`. A recipient drops that file into a conversation and says
“install this theme”; the authoritative `type: "sponsored"` restores its ad
copy, links, and appearance automatically.

A pack issued by the platform for a signed-in user may additionally carry a
public `beneficiaryUserId`, theme ID, and reporting origin. These are not login
credentials; they only attribute eligible impressions. If that attributed pack
is forwarded or re-exported, eligible impressions generated by recipients
remain attributed to the beneficiary embedded in the pack.

### 3. Metrics and reporting

Only `sponsored` themes enable metrics. A `standard` theme has **zero tracking,
zero markers, and zero reporting**. Sponsored themes buffer these local events:

- `impression`: the only event that can earn revenue; the Hero must be present,
  the window focused, and the slot at least 50% visible for one continuous second.
- `click`: a real click on an ad slot; useful for performance metrics but not billable.
- `active_day` / `switch_away`: usage and retention events; not billable.

Events first enter a local buffer capped at 10. With `$theme-x keep on`, the
lightweight keeper reports only on three event-driven triggers: the buffer
reaches 10, a graceful app exit, or next-launch catch-up. There is **no periodic
upload**. Network failures preserve valid events, the server deduplicates by
anonymous install ID plus monotonic sequence, and malformed legacy events are
quarantined before upload so they cannot block valid data.

Reporting is off by default. Data is sent only when a platform pack supplies a
validated reporting origin or the user explicitly configures `ADS_API_BASE`.
A self-made/open-source sponsored theme can still render, link, export, and show
local metrics, but it does not phone home or automatically earn platform revenue.

Advanced local inspection:

```bash
node ~/.codex/skills/theme-x/scripts/inject.mjs events
node ~/.codex/skills/theme-x/scripts/inject.mjs report --json  # manual, when configured
```

### 4. How earnings are produced

Earnings require all of the following: a sponsored theme, valid platform
attribution in the pack, a valid Campaign, an impression that passes platform
validation and frequency caps, and final settlement. **A local impression
count, an accepted upload, or an `eligible` response is not settled revenue.**
Clicks and lifecycle events are non-billable. Balances, settlement, and
withdrawal follow the platform UI and platform rules.

The platform returns authoritative Campaign state with an upload response.
After the budget is exhausted, the appearance and creative remain usable, but
the Hero shows that the Campaign ended and future impressions no longer earn;
new ad-impression metering and advertiser jumps stop, with a route back to the gallery.

### 5. Privacy boundary

Events may contain only sequence, timestamp, event type, slot, Campaign, theme
ID, and public beneficiary attribution. They never include landing-page
content, screen or conversation content, or keystrokes. The renderer writes
only to a local buffer; the host-side helper performs any configured request.

## License

Not affiliated with OpenAI. Codex is a trademark of its owner. MIT License.

#!/usr/bin/env node
// codex-theme-x injector — CDP payload for the visual layers the official
// theme system cannot do: artwork, glass panels, and a themed home hero.
//
// Design constraints (see spec/codextheme-format.md):
//   - Opaque full-viewport containers are discovered at runtime. The blank
//     home page has an explicitly gated enhancement layer; if Codex changes
//     its home DOM, only that optional layout falls back to the native page.
//   - Everything lives behind CSS variables so `tune` is instant.
//   - Idempotent: re-apply replaces the previous payload; `remove` restores
//     the app to its untouched state.
//
// Usage:
//   node inject.mjs status   [--port 9341] [--json]
//   node inject.mjs apply    --theme <dir> [--port 9341] [--no-accent]
//   node inject.mjs tune     --set dim=0.8 [--set blur=24] ...
//   node inject.mjs remove
//   node inject.mjs screenshot --out /tmp/shot.png
//
// Requires Node >= 22 (global WebSocket). Zero dependencies.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAYLOAD_VERSION = 9;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { port: 9341, set: [], json: false, accent: true };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--port') opts.port = Number(rest[++i]);
    else if (a === '--theme') opts.theme = rest[++i];
    else if (a === '--set') opts.set.push(rest[++i]);
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--no-accent') opts.accent = false;
    else fail(`unknown option: ${a}`);
  }
  return { cmd, opts };
}

function fail(msg, code = 1) {
  console.error(`inject.mjs: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------- CDP client

async function findTarget(port) {
  let list;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    list = await res.json();
  } catch {
    return null;
  }
  return list.find((t) =>
    t.type === 'page' &&
    typeof t.url === 'string' && t.url.startsWith('app://') &&
    typeof t.webSocketDebuggerUrl === 'string'
  ) ?? null;
}

function assertLoopback(wsUrl, port) {
  const u = new URL(wsUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
  if (u.protocol !== 'ws:' || !loopback.includes(u.hostname) || Number(u.port) !== port) {
    fail(`refusing non-loopback debugger URL: ${wsUrl}`);
  }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; }

  static async connect(wsUrl) {
    if (typeof WebSocket === 'undefined') fail('Node >= 22 is required (global WebSocket).');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('WebSocket connection failed'));
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${method} timed out`)), 15000);
      const onMessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== id) return;
        this.ws.removeEventListener('message', onMessage);
        clearTimeout(timer);
        msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result);
      };
      this.ws.addEventListener('message', onMessage);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(`renderer exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }

  close() { this.ws.close(); }
}

async function connectToCodex(port) {
  const target = await findTarget(port);
  if (!target) return null;
  assertLoopback(target.webSocketDebuggerUrl, port);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  // Soft identity probe: a Codex renderer has a composer or a main surface.
  const looksLikeCodex = await cdp.eval(
    `Boolean(document.querySelector('main') || document.querySelector('[role="main"]'))`
  ).catch(() => false);
  if (!looksLikeCodex) { cdp.close(); fail('debug target does not look like the Codex app; refusing to touch it'); }
  return cdp;
}

// ------------------------------------------------------------------- payload

async function imageDataUrl(file) {
  const buf = await readFile(file);
  if (buf.byteLength > MAX_IMAGE_BYTES) fail(`background image exceeds 16 MB: ${file}`);
  const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
  if (!mime) fail(`unsupported background format: ${file} (png/jpg/webp/svg)`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) fail(`invalid hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function safeHomePosition(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const token = '(?:left|center|right|top|bottom|(?:100|[0-9]{1,2})(?:\\.[0-9]+)?%)';
  return new RegExp(`^${token}(?:\\s+${token})?$`).test(raw) ? raw : '72% center';
}

function safeThemeText(value, fallback, maxLength) {
  // NB: no double-escapes here — /[\\u0000-.../ would put the range '0'-'\'
  // in the class, silently swallowing every digit and uppercase letter.
  const text = String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (text || fallback).slice(0, maxLength);
}

function optionalThemeText(value, maxLength) {
  // Like safeThemeText but with no fallback: absent stays null and the
  // corresponding native copy is left untouched.
  if (value == null) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function safeThemeAssetName(value, field) {
  const name = String(value ?? '');
  if (!name || path.basename(name) !== name || name === '.' || name === '..') {
    fail(`${field} must be a file name inside the theme directory`);
  }
  return name;
}

async function loadTheme(themeDir) {
  const file = path.join(themeDir, 'theme.json');
  const theme = JSON.parse(await readFile(file, 'utf8'));
  if (theme.schema !== 'codextheme/1') fail(`${file}: expected "schema": "codextheme/1"`);
  const bg = theme.background ?? {};
  const home = theme.home ?? {};
  if (!bg.file) fail(`${file}: background.file is required`);
  const backgroundFile = safeThemeAssetName(bg.file, 'background.file');
  const homeFile = home.file ? safeThemeAssetName(home.file, 'home.file') : backgroundFile;
  const backgroundDataUrl = await imageDataUrl(path.join(themeDir, backgroundFile));
  const homeDataUrl = homeFile === backgroundFile
    ? backgroundDataUrl
    : await imageDataUrl(path.join(themeDir, homeFile));
  return {
    name: String(theme.name ?? theme.id ?? 'unnamed'),
    surface: theme.official?.surface ?? '#181818',
    accent: theme.official?.accent ?? null,
    backgroundDataUrl,
    home: {
      dataUrl: homeDataUrl,
      height: boundedNumber(home.height, 252, 200, 360),
      focalPoint: safeHomePosition(home.focalPoint),
      overlay: boundedNumber(home.overlay, 0.88, 0, 1),
      cardOpacity: boundedNumber(home.cardOpacity, 0.88, 0.55, 1),
      // Blank-page veil density. The danger zone is half-hidden (~0.55–0.9):
      // the artwork's large light/dark masses survive any feasible blur and
      // read as smudges on the calm field. Either side of it works: the
      // default 0.38 + light blur keeps the artwork RECOGNIZABLE (a visible
      // scene is atmosphere; an unrecognizable blob is a stain) while the
      // hero card, cards and composer carry their own frost for readability.
      // 1 = opaque surface canvas + accent aura tints (calmest, zero bleed —
      // for users who want the blank page quiet).
      backdrop: boundedNumber(home.backdrop, 0.38, 0, 1),
      backdropBlur: boundedNumber(home.backdropBlur, 20, 0, 120),
      kicker: safeThemeText(home.kicker, String(theme.name ?? theme.id ?? 'Your Codex'), 48),
      tagline: safeThemeText(home.tagline, '让喜欢的画面，成为今天的工作状态。', 96),
    },
    // Copy layer — flavor text only, all optional; absent = native text stays.
    // Functional labels (buttons, nav, suggestion cards, status verbs) are
    // deliberately NOT themeable: they are UI, not atmosphere.
    copy: {
      // Home greeting template. "{project}" marks where the native project
      // switcher button stays; applied only when the DOM shape matches.
      greeting: optionalThemeText(theme.copy?.greeting, 64),
      // Composer placeholder (the native app shows one string everywhere,
      // so the themed one applies everywhere too). Pure-CSS override.
      placeholder: optionalThemeText(theme.copy?.placeholder, 32),
      // Window title (Mission Control / cmd-tab flavor).
      title: optionalThemeText(theme.copy?.title, 48),
    },
    vars: {
      dim: bg.dim ?? 0.85,
      blur: bg.blur ?? 0,
      // Default look: the conversation area is FULLY transparent — the
      // artwork is the hero. The sidebar is dense scan-read text, so it gets
      // a near-solid veil instead; the decisive contrast makes the panel
      // boundary read as an intentional layer edge. Users who want more veil
      // over the art just ask ($theme tune).
      panelOpacity: bg.panelOpacity ?? 0,
      // Sidebar = FROSTED GLASS, not a flat plate: mid-density veil + heavy
      // backdrop blur. The artwork's colors bleed through the frost (visual
      // unity with the page), while the frosted↔clear material step keeps the
      // zoning unmistakable. Raise toward 0.85+ when dark busy artwork sits
      // under a light variant (density is the readability lever; blur is the
      // unity lever).
      sidebarOpacity: bg.sidebarOpacity ?? 0.6,
      sidebarBlur: bg.sidebarBlur ?? 40,
      glassBlur: bg.glassBlur ?? 18,
      // Floating panels (environment info, dropdowns, popovers) — they hold
      // text over arbitrary content, so they keep a readable veil even when
      // the main surface is fully transparent.
      floatOpacity: bg.floatOpacity ?? 0.75,
      // Composer frost. The app's own design is translucent glass
      // (bg-token-input-background/90 + backdrop blur) — an electron:dark
      // override flattens it to opaque; this restores the intent with the
      // theme's surface color. Denser than floats: it is the typing surface,
      // the one place readability outranks transparency.
      composerOpacity: bg.composerOpacity ?? 0.8,
      // Reading lane: a soft-edged surface-colored sheet behind the thread
      // column only. Text gets near-native contrast conditions (ink over a
      // mostly-surface backing) WITHOUT touching text rendering, and the
      // artwork stays full-strength outside the lane. Raise toward 0.55 for
      // dark/busy artwork under a light variant. 0 = off.
      laneOpacity: bg.laneOpacity ?? 0.45,
      // Legacy text glow. Users read with their habitual text rendering, so
      // this defaults OFF — the reading lane is the readability mechanism.
      // Kept as an explicit opt-in only.
      textHalo: bg.textHalo ?? 0,
    },
  };
}

function buildCss(theme) {
  // Variant-aware accents for hairlines/shadows (surface luminance decides).
  const [r, g, b] = hexToRgbTriplet(theme.surface).split(',').map(Number);
  const surfaceIsDark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  const hairline = surfaceIsDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.09)';
  const coverShadow = surfaceIsDark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.14)';
  const heroInk = surfaceIsDark ? 'rgba(255,255,255,0.96)' : 'rgba(20,22,24,0.94)';
  const heroMuted = surfaceIsDark ? 'rgba(255,255,255,0.72)' : 'rgba(20,22,24,0.68)';
  const heroShade = surfaceIsDark ? '0,0,0' : '255,255,255';
  return `
:root.ctx-themed {
  --ctx-dim: ${theme.vars.dim};
  --ctx-blur: ${theme.vars.blur}px;
  --ctx-panel-a: ${theme.vars.panelOpacity};
  --ctx-side-a: ${theme.vars.sidebarOpacity};
  --ctx-side-blur: ${theme.vars.sidebarBlur}px;
  --ctx-glass-blur: ${theme.vars.glassBlur}px;
  --ctx-float-a: ${theme.vars.floatOpacity};
  --ctx-lane-a: ${theme.vars.laneOpacity};
  --ctx-halo: ${theme.vars.textHalo};
  /* Initial values from theme.json; the renderer's mode-sync re-samples the
     app's LIVE surface token and overrides these (via the tune sheet) at
     inject time and on every light/dark flip — the user can switch modes at
     any moment and every veil must follow the app's real palette. */
  --ctx-surface-rgb: ${hexToRgbTriplet(theme.surface)};
  --ctx-accent-rgb: ${theme.accent ? hexToRgbTriplet(theme.accent) : hexToRgbTriplet(theme.surface)};
  --ctx-hairline: ${hairline};
  --ctx-cover-shadow: ${coverShadow};
  --ctx-hero-ink: ${heroInk};
  --ctx-hero-muted: ${heroMuted};
  --ctx-hero-shade: ${heroShade};
  --ctx-veil-scale: ${surfaceIsDark ? 0.6 : 1};
  --ctx-composer-a: ${theme.vars.composerOpacity};
  --ctx-composer-scale: ${surfaceIsDark ? 0.78 : 1};
  --ctx-home-hero-h: ${theme.home.height}px;
  --ctx-home-art-pos: ${theme.home.focalPoint};
  --ctx-home-overlay-a: ${theme.home.overlay};
  --ctx-home-card-a: ${theme.home.cardOpacity};
  --ctx-home-backdrop-a: ${theme.home.backdrop};
  --ctx-home-backdrop-blur: ${theme.home.backdropBlur}px;
  --ctx-home-kicker: ${JSON.stringify(theme.home.kicker)};
  --ctx-home-tagline: ${JSON.stringify(theme.home.tagline)};
}
:root.ctx-themed, :root.ctx-themed body { background: transparent !important; }
:root.ctx-themed body::before {
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  /* The artwork variables are short blob URLs created inside the renderer. Keeping
     the large data URL out of a CSS custom property avoids Chromium silently
     dropping multi-megabyte values while letting the home hero reuse it. */
  background-image: var(--ctx-bg-art);
  background-size: cover; background-position: center;
  filter: brightness(var(--ctx-dim)) blur(var(--ctx-blur));
  transform: scale(1.02); /* hide blur edge fringe */
}
:root.ctx-themed .ctx-glass {
  background-color: rgba(var(--ctx-surface-rgb), var(--ctx-panel-a)) !important;
  backdrop-filter: blur(var(--ctx-glass-blur));
}
:root.ctx-themed .ctx-glass-side {
  background-color: rgba(var(--ctx-surface-rgb), var(--ctx-side-a)) !important;
  backdrop-filter: blur(var(--ctx-glass-blur));
}
/* Soft enhancements — fine if these selectors stop matching after an update. */
:root.ctx-themed main.main-surface {
  background-color: rgba(var(--ctx-surface-rgb), var(--ctx-panel-a)) !important;
  border-color: transparent !important; /* zoning is veil contrast, not lines */
  /* The app outlines the main card with a 0.5px ring box-shadow — over
     artwork it reads as a stray divider between sidebar and content. */
  box-shadow: none !important;
}
:root.ctx-themed aside.app-shell-left-panel {
  background-color: rgba(var(--ctx-surface-rgb), var(--ctx-side-a)) !important;
  backdrop-filter: blur(var(--ctx-side-blur)) saturate(115%);
  border-color: transparent !important;
}
/* The aside's own ::after (overscroll/resize cover) paints the sidebar token
   color at full density — over the frost it would show as a mismatched
   strip. */
:root.ctx-themed aside.app-shell-left-panel::after {
  background: transparent !important;
}
/* Floating panels (environment info, dropdown menus, popovers) all share the
   dropdown-background token utility — one rule glasses the whole family.
   Density is scaled by --ctx-veil-scale: a dark veil over bright artwork
   reads perceptually denser than a light one at the same alpha (it subtracts
   luminance), so dark mode gets ~0.6× the configured density. */
:root.ctx-themed .bg-token-dropdown-background {
  background-color: rgba(var(--ctx-surface-rgb), calc(var(--ctx-float-a) * var(--ctx-veil-scale))) !important;
  backdrop-filter: blur(var(--ctx-glass-blur));
}
/* Panels nest the same token (e.g. the environment-info sticky header inside
   the panel body): two stacked veils double the density right where the title
   sits. Inner layers thin out to a hint — the outer frost already carries
   readability. */
:root.ctx-themed .bg-token-dropdown-background .bg-token-dropdown-background {
  background-color: rgba(var(--ctx-surface-rgb), calc(var(--ctx-float-a) * var(--ctx-veil-scale) * 0.45)) !important;
  backdrop-filter: none;
}
/* Composer frost — the app's own composer style is translucent glass
   (bg-token-input-background/90 + backdrop blur); an electron:dark override
   flattens it to an opaque slab, the last one in the glass system. Restore
   the glass intent in the theme's surface color. Its dark-mode scale (0.78)
   is gentler than the floats' veil-scale (0.6): this is the typing surface,
   so it keeps the thickest backing of any glass panel. Native backdrop blur
   is kept as-is. */
:root.ctx-themed .composer-surface-chrome {
  background-color: rgba(var(--ctx-surface-rgb), calc(var(--ctx-composer-a) * var(--ctx-composer-scale))) !important;
}
/* The nav header is already transparent; the only header/content divider is
   this native fade band (surface → transparent). Over full-strength artwork
   it reads as a stray light strip, so the art runs true full-bleed instead. */
:root.ctx-themed .app-shell-main-content-top-fade {
  background-image: none !important;
}
/* Same family, bottom edge: the composer sits on a scroll-mask plate (solid
   surface gradient, wider than the composer) that fades messages out behind
   the input. Over artwork it reads as a stray rectangular slab — the
   composer's own frosted veil already keeps the input readable. */
:root.ctx-themed main .bg-gradient-to-t[class*="from-token-main-surface"] {
  background-image: none !important;
}
/* Reading lane: a soft-edged surface-colored sheet running the length of the
   thread column (the app's own max-width wrapper; flex-1 excludes the
   composer wrappers sharing the class). Text keeps its native rendering —
   the lane restores near-native contrast underneath it instead, and the
   artwork stays full-strength on both sides. */
:root.ctx-themed main [class*="max-w-(--thread"][class*="flex-1"]::before {
  content: ""; position: absolute; top: -24px; bottom: -24px; left: -30px; right: -30px;
  z-index: -1; pointer-events: none;
  background: linear-gradient(to right,
    rgba(var(--ctx-surface-rgb), 0) 0%,
    rgba(var(--ctx-surface-rgb), var(--ctx-lane-a)) 7%,
    rgba(var(--ctx-surface-rgb), var(--ctx-lane-a)) 93%,
    rgba(var(--ctx-surface-rgb), 0) 100%);
  /* Soft vertical ends: without this the lane starts/stops as a hard
     horizontal line (most visible as a fake header/content divider). */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 160px, black calc(100% - 120px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, black 160px, black calc(100% - 120px), transparent 100%);
}
/* The lane scrolls with the thread, so mid-scroll its full-density middle
   would be clipped to a hard line at the scrollport's top edge. Masking the
   scrollport itself dissolves everything (lane + text) just under the nav
   header at ANY scroll position — the native top-fade behavior, but
   revealing artwork instead of painting surface color. 48px stays shorter
   than the content's own top offset (~35px reaches ~80% opacity), so the
   first row is barely dimmed when scrolled to the top. */
:root.ctx-themed main .thread-scroll-container {
  -webkit-mask-image: linear-gradient(to bottom, transparent 4px, black 48px);
  mask-image: linear-gradient(to bottom, transparent 4px, black 48px);
}
/* Blank "new task" page only. The page becomes a real theme home: a focused
   hero first, then native suggestions and composer as distinct work zones.
   All selectors are gated by home-suggestions, so task pages stay untouched. */
/* Backdrop: a light veil over the artwork (default 0.38 + soft blur) — the
   scene stays recognizable, which is what makes it read as atmosphere instead
   of a smudge; hero, cards and composer carry their own frost. Avoid the
   half-hidden band (~0.55–0.9): large light/dark masses survive any blur and
   smear the field. At backdrop-a 1 the page becomes an opaque surface canvas
   and the accent aura tints take over as the (designed) atmosphere. Paints
   after body::before, so it sits over the artwork and under all content; task
   pages keep the full-bleed background. */
:root.ctx-themed body:has(section[class*="home-suggestions"])::after {
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background:
    radial-gradient(60% 42% at 82% 6%, rgba(var(--ctx-accent-rgb), 0.18), transparent 100%),
    radial-gradient(55% 40% at 6% 98%, rgba(var(--ctx-accent-rgb), 0.13), transparent 100%),
    rgba(var(--ctx-surface-rgb), var(--ctx-home-backdrop-a));
  backdrop-filter: blur(var(--ctx-home-backdrop-blur));
}
:root.ctx-themed body:has(section[class*="home-suggestions"]) div[class*="home-main-content"] {
  margin: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  overflow: visible !important;
}
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) {
  --thread-content-max-width: min(1040px, calc(100cqw - 44px)) !important;
  overflow-x: hidden !important;
}
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) > div:first-child {
  /* Breathing room above the hero: on the calm canvas the hero shouldn't glue
     to the nav — a viewport-proportional top band gives the page a gallery
     rhythm (band, hero, cards, space, composer) instead of top-heavy stacking. */
  padding-top: clamp(20px, 6.5vh, 84px) !important;
  min-height: 100% !important;
}
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) > div:first-child > div:first-child {
  flex: 0 0 calc(var(--ctx-home-hero-h) + 174px) !important;
  min-height: calc(var(--ctx-home-hero-h) + 174px) !important;
  align-items: flex-start !important;
  padding-bottom: 0 !important;
}
/* The native greeting container becomes the hero; the native suggestion row
   remains live and is positioned directly beneath it. */
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) > div:first-child > div:first-child > div:first-child {
  position: relative !important;
  isolation: isolate;
  width: calc(100% - 44px) !important;
  max-width: none !important;
  height: var(--ctx-home-hero-h) !important;
  min-height: var(--ctx-home-hero-h) !important;
  flex: 0 1 auto !important;
  padding: 0 !important;
  border: 1px solid var(--ctx-hairline) !important;
  border-radius: 26px !important;
  overflow: visible !important;
  background-color: rgba(var(--ctx-surface-rgb), 0.96) !important;
  background-image:
    linear-gradient(90deg,
      rgba(var(--ctx-hero-shade), var(--ctx-home-overlay-a)) 0%,
      rgba(var(--ctx-hero-shade), calc(var(--ctx-home-overlay-a) * 0.86)) 38%,
      rgba(var(--ctx-hero-shade), calc(var(--ctx-home-overlay-a) * 0.34)) 62%,
      rgba(var(--ctx-hero-shade), 0.04) 100%),
    var(--ctx-home-art) !important;
  background-repeat: no-repeat !important;
  background-size: 100% 100%, cover !important;
  background-position: center, var(--ctx-home-art-pos) !important;
  box-shadow: 0 18px 54px var(--ctx-cover-shadow), inset 0 1px rgba(255,255,255,0.08) !important;
}
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) > div:first-child > div:first-child > div:first-child > div:first-child {
  position: relative;
  z-index: 1;
  height: 100%;
  align-items: center !important;
  justify-content: flex-start !important;
  padding-left: clamp(26px, 4vw, 48px) !important;
}
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) > div:first-child > div:first-child > div:first-child > div:first-child > div:first-child {
  width: min(54%, 540px) !important;
  align-items: flex-start !important;
  gap: 0 !important;
}
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) [data-testid="home-icon"] {
  display: none !important;
}
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) [data-feature="game-source"] {
  display: block !important;
  max-width: 100% !important;
  color: var(--ctx-hero-ink) !important;
  font-size: clamp(21px, 2.1vw, 31px) !important;
  line-height: 1.22 !important;
  font-weight: 760 !important;
  text-align: left !important;
  text-shadow: 0 2px 18px rgba(var(--ctx-hero-shade), 0.42) !important;
  opacity: 1 !important;
  pointer-events: auto !important;
}
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) [data-feature="game-source"]::before {
  content: var(--ctx-home-kicker);
  display: block;
  margin-bottom: 10px;
  color: var(--codex-base-accent, ${theme.accent ?? heroInk});
  font-size: 12px;
  line-height: 1.35;
  font-weight: 800;
  letter-spacing: 0.1em;
}
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) [data-feature="game-source"]::after {
  content: var(--ctx-home-tagline);
  display: block;
  margin-top: 13px;
  color: var(--ctx-hero-muted);
  font-size: 13px;
  line-height: 1.5;
  font-weight: 500;
  letter-spacing: 0.02em;
}
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) > div:first-child > div:first-child > div:first-child > div:nth-child(2) {
  left: 14px !important;
  right: 14px !important;
  top: 100% !important;
  margin-top: 14px !important;
}
:root.ctx-themed section[class*="home-suggestions"] {
  overflow: visible !important;
}
/* Suggestion cards → compact horizontal pills: icon + label on one centered
   row. The native tile layout (icon top-left, mt-auto label bottom) reads as
   broken when stretched over the frosted backdrop — a row of quick actions
   under the hero looks deliberate and doesn't compete with it for mass. */
:root.ctx-themed section[class*="home-suggestions"] button {
  position: relative !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 10px !important;
  min-height: 68px !important;
  padding: 12px 16px !important;
  text-align: center !important;
  border: 1px solid var(--ctx-hairline) !important;
  border-radius: 18px !important;
  background-color: rgba(var(--ctx-surface-rgb), calc(var(--ctx-home-card-a) * var(--ctx-veil-scale))) !important;
  backdrop-filter: blur(var(--ctx-glass-blur)) saturate(112%) !important;
  box-shadow: 0 10px 26px var(--ctx-cover-shadow), inset 0 1px rgba(255,255,255,0.06) !important;
  transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease !important;
}
:root.ctx-themed section[class*="home-suggestions"] button > span:first-child {
  width: auto !important;
  flex: 0 0 auto !important;
}
:root.ctx-themed section[class*="home-suggestions"] button > span:last-child {
  margin-top: 0 !important;
  min-height: 0 !important;
  width: auto !important;
  flex: 0 1 auto !important;
  justify-content: center !important;
}
:root.ctx-themed section[class*="home-suggestions"] button:hover {
  transform: translateY(-3px) !important;
  border-color: color-mix(in srgb, var(--codex-base-accent, ${theme.accent ?? heroInk}) 48%, transparent) !important;
  box-shadow: 0 15px 32px var(--ctx-cover-shadow) !important;
}
:root.ctx-themed body:has(section[class*="home-suggestions"]) .composer-surface-chrome {
  border: 1px solid var(--ctx-hairline) !important;
  border-radius: 24px !important;
  background-color: rgba(var(--ctx-surface-rgb), 0.9) !important;
  backdrop-filter: blur(var(--ctx-glass-blur)) saturate(116%) !important;
  box-shadow: 0 14px 36px var(--ctx-cover-shadow), inset 0 1px rgba(255,255,255,0.06) !important;
}
:root.ctx-themed body:has(section[class*="home-suggestions"]) div:has(> .horizontal-scroll-fade-mask [class*="project-selector"]) {
  position: relative;
  padding-top: 26px !important;
  border: 1px solid var(--ctx-hairline);
  border-bottom: 0;
  background-color: rgba(var(--ctx-surface-rgb), 0.84) !important;
  backdrop-filter: blur(var(--ctx-glass-blur)) saturate(112%);
}
:root.ctx-themed body:has(section[class*="home-suggestions"]) div:has(> .horizontal-scroll-fade-mask [class*="project-selector"])::before {
  content: "Select project";
  position: absolute;
  left: 14px;
  top: 6px;
  color: var(--codex-base-accent, ${theme.accent ?? heroInk});
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.08em;
}
@media (max-width: 860px) {
  :root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) {
    --thread-content-max-width: min(820px, calc(100cqw - 28px)) !important;
  }
  :root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) > div:first-child > div:first-child > div:first-child {
    width: calc(100% - 28px) !important;
  }
  :root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) > div:first-child > div:first-child > div:first-child > div:first-child > div:first-child {
    width: 68% !important;
  }
  :root.ctx-themed section[class*="home-suggestions"] button {
    min-height: 58px !important;
    font-size: 12px !important;
  }
}
/* Text halo: a stacked surface-colored glow behind conversation text, so the
   fully transparent main area stays readable over busy artwork. Inherits to
   all text in the main surface; invisible where text sits on its own solid
   background (same-color glow on same-color surface). */
:root.ctx-themed main.main-surface {
  text-shadow:
    0 0 2px rgba(var(--ctx-surface-rgb), var(--ctx-halo)),
    0 0 8px rgba(var(--ctx-surface-rgb), calc(var(--ctx-halo) * 0.85)),
    0 1px 16px rgba(var(--ctx-surface-rgb), calc(var(--ctx-halo) * 0.6));
}
${theme.copy.placeholder ? `
/* Themed composer placeholder. The native placeholder is painted by CSS
   (p[data-placeholder]::after, content from the attribute) — overriding the
   painted content is the ONLY safe route: ProseMirror owns the editor DOM
   and instantly rebuilds any node an outsider touches, so attribute writes
   always lose the fight. Pure CSS never enters that fight. */
:root.ctx-themed [contenteditable] p[data-placeholder]::after {
  content: ${JSON.stringify(theme.copy.placeholder)} !important;
}` : ''}
`;
}

// The renderer-side program. Self-contained; injected via Runtime.evaluate.
// Uses adoptedStyleSheets (immune to style-src CSP) and stores handles on
// window.__ctxTheme so apply is idempotent and remove is complete.
function rendererProgram({ css, backgroundDataUrl, homeDataUrl, accentRemap, name, copy }) {
  return `(() => {
  const prev = window.__ctxTheme;
  if (prev) { try { prev.remove(); } catch {} }

  const root = document.documentElement;
  const createArtUrl = (dataUrl) => {
    const comma = dataUrl.indexOf(',');
    const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || 'image/png';
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  };
  const backgroundData = ${JSON.stringify(backgroundDataUrl)};
  const homeData = ${JSON.stringify(homeDataUrl)};
  const backgroundArtUrl = createArtUrl(backgroundData);
  const homeArtUrl = homeData === backgroundData ? backgroundArtUrl : createArtUrl(homeData);

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(${JSON.stringify(css)});
  const artSheet = new CSSStyleSheet();
  artSheet.replaceSync(':root.ctx-themed {' +
    ' --ctx-bg-art: url("' + backgroundArtUrl + '");' +
    ' --ctx-home-art: url("' + homeArtUrl + '");' +
    ' }');
  // A separate sheet for live tuning: the app rewrites <html>'s style
  // attribute after startup, so inline vars don't survive — our own
  // adopted sheets do.
  const tuneSheet = new CSSStyleSheet();
  const tuneVars = {};
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet, artSheet, tuneSheet];
  root.classList.add('ctx-themed');

  // Accent remap: find every custom property whose computed value equals the
  // app's current base accent and re-point it at the theme accent. Name-blind,
  // so it survives the app renaming its variables.
  let accentSheet = null;
  const remap = ${JSON.stringify(accentRemap)};
  if (remap) {
    const cs = getComputedStyle(root);
    const base = cs.getPropertyValue('--codex-base-accent').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(base) && base !== remap.toLowerCase()) {
      const decls = [];
      for (const prop of cs) {
        if (prop.startsWith('--') && cs.getPropertyValue(prop).trim().toLowerCase() === base) {
          decls.push(prop + ': ' + remap + ' !important;');
        }
      }
      if (decls.length) {
        accentSheet = new CSSStyleSheet();
        accentSheet.replaceSync(':root.ctx-themed { ' + decls.join(' ') + ' }');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, accentSheet];
      }
    }
  }

  // Glass discovery: descend through children that cover (nearly) the whole
  // viewport and are fully opaque, and let CSS variables make them glass.
  // Depth-limited, no assumptions about class names.
  const glassed = [];
  const markGlass = () => {
    for (const el of glassed.splice(0)) { el.classList.remove('ctx-glass'); }
    let el = document.body, depth = 0;
    const vw = innerWidth, vh = innerHeight;
    while (el && depth < 6) {
      let cover = null;
      for (const child of el.children) {
        const r = child.getBoundingClientRect();
        if (r.width >= vw * 0.95 && r.height >= vh * 0.95) { cover = child; break; }
      }
      if (!cover) break;
      const bgc = getComputedStyle(cover).backgroundColor;
      const opaque = bgc && !/rgba\\(.*,\\s*0(\\.\\d+)?\\)$/.test(bgc) && bgc !== 'transparent';
      if (opaque) { cover.classList.add('ctx-glass'); glassed.push(cover); }
      el = cover; depth++;
    }
  };
  markGlass();
  let resizeTimer = 0;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(markGlass, 200); };
  addEventListener('resize', onResize);

  const applyVar = (prop, value) => {
    tuneVars[prop] = value;
    const body = Object.entries(tuneVars).map(([k, v]) => k + ': ' + v + ';').join(' ');
    tuneSheet.replaceSync(':root.ctx-themed { ' + body + ' }');
  };

  // Mode sync: every veil color must follow the APP's live palette, not the
  // theme.json surface — mode follows the user, who can flip light/dark at
  // any time. Sample the app's own surface token and re-point the color
  // variables now and on every appearance change.
  const sampleSurface = () => {
    const probe = document.createElement('div');
    probe.className = 'bg-token-main-surface-primary';
    probe.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px;';
    document.body.appendChild(probe);
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(getComputedStyle(probe).backgroundColor);
    probe.remove();
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const syncMode = () => {
    const s = sampleSurface();
    if (!s) return; // token missing → keep theme.json values
    const dark = (0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]) / 255 < 0.5;
    applyVar('--ctx-surface-rgb', s.join(', '));
    applyVar('--ctx-hairline', dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.09)');
    applyVar('--ctx-cover-shadow', dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.14)');
    applyVar('--ctx-hero-ink', dark ? 'rgba(255,255,255,0.96)' : 'rgba(20,22,24,0.94)');
    applyVar('--ctx-hero-muted', dark ? 'rgba(255,255,255,0.72)' : 'rgba(20,22,24,0.68)');
    applyVar('--ctx-hero-shade', dark ? '0,0,0' : '255,255,255');
    // Dark veils over bright artwork subtract luminance and read denser than
    // light veils at the same alpha — floats and home cards scale down.
    applyVar('--ctx-veil-scale', dark ? '0.6' : '1');
    applyVar('--ctx-composer-scale', dark ? '0.78' : '1');
  };
  syncMode();
  let modeTimer = 0;
  const queueSync = () => { clearTimeout(modeTimer); modeTimer = setTimeout(syncMode, 150); };
  const modeQuery = matchMedia('(prefers-color-scheme: dark)');
  modeQuery.addEventListener('change', queueSync);
  // The app flips its palette by rewriting <html> attributes — watch them too
  // (covers in-app appearance changes that don't touch the OS scheme).
  const modeObserver = new MutationObserver(queueSync);
  modeObserver.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });

  // Copy engine: themed flavor text (home greeting / window title). The
  // placeholder is handled in pure CSS; these two need DOM writes. React
  // never watches the DOM, it only repaints on remount — so an idempotent
  // re-apply on mutation is a settle, not a fight (unlike ProseMirror).
  const copy = ${JSON.stringify(copy ?? {})};
  const nativeTitle = document.title;
  let nativeGreeting = null;
  let copyObserver = null;
  let copyTimer = 0;
  const greetingSpan = () => {
    for (const s of document.querySelectorAll('[role="main"] span')) {
      if ((s.getAttribute('class') || '').includes('group/title')) return s;
    }
    return null;
  };
  const setGreetingTexts = (span, btn, before, after) => {
    for (const n of [...span.childNodes]) { if (n.nodeType === 3) n.remove(); }
    span.insertBefore(document.createTextNode(before), btn);
    btn.after(document.createTextNode(after));
  };
  const applyGreeting = () => {
    // Template must carry {project}: the native project-switcher button stays
    // in place, only the words around it are themed. Any other DOM shape
    // (no project chip, app redesign) leaves the native greeting untouched.
    if (!copy.greeting || !copy.greeting.includes('{project}')) return;
    const span = greetingSpan();
    if (!span) return;
    const btn = [...span.childNodes].find((n) => n.nodeType === 1 && n.tagName === 'BUTTON');
    if (!btn) return;
    const [before, after] = copy.greeting.split('{project}');
    const texts = [...span.childNodes].filter((n) => n.nodeType === 3);
    const current = texts.map((n) => n.textContent);
    if (current.join('\\u0000') === before + '\\u0000' + after) return; // settled
    nativeGreeting = nativeGreeting ?? { before: current[0] ?? '', after: current[1] ?? '' };
    setGreetingTexts(span, btn, before, after);
  };
  const runCopy = () => {
    applyGreeting();
    if (copy.title && document.title !== copy.title) document.title = copy.title;
  };
  if (copy.greeting || copy.title) {
    copyObserver = new MutationObserver(() => {
      // Leading-edge schedule (never reset): rAF is throttled in background
      // windows and a trailing debounce starves under streaming mutations.
      if (copyTimer) return;
      copyTimer = setTimeout(() => { copyTimer = 0; runCopy(); }, 120);
    });
    copyObserver.observe(document.body, { childList: true, subtree: true });
    runCopy();
  }

  window.__ctxTheme = {
    version: ${PAYLOAD_VERSION},
    name: ${JSON.stringify(name)},
    setVar: applyVar,
    remove() {
      removeEventListener('resize', onResize);
      modeQuery.removeEventListener('change', queueSync);
      modeObserver.disconnect();
      clearTimeout(modeTimer);
      if (copyObserver) copyObserver.disconnect();
      clearTimeout(copyTimer);
      if (copy.title) document.title = nativeTitle;
      if (nativeGreeting) {
        const span = greetingSpan();
        const btn = span && [...span.childNodes].find((n) => n.nodeType === 1 && n.tagName === 'BUTTON');
        if (btn) setGreetingTexts(span, btn, nativeGreeting.before, nativeGreeting.after);
      }
      for (const el of glassed) el.classList.remove('ctx-glass');
      document.adoptedStyleSheets = document.adoptedStyleSheets
        .filter((s) => s !== sheet && s !== artSheet && s !== accentSheet && s !== tuneSheet);
      root.classList.remove('ctx-themed');
      root.style.removeProperty('--ctx-bg-image'); // legacy v1 payloads
      URL.revokeObjectURL(backgroundArtUrl);
      if (homeArtUrl !== backgroundArtUrl) URL.revokeObjectURL(homeArtUrl);
      delete window.__ctxTheme;
    },
  };
  return { ok: true, glassed: glassed.length };
})()`;
}

// ------------------------------------------------------------------ commands

const TUNE_KEYS = {
  dim: '--ctx-dim', blur: '--ctx-blur', panelOpacity: '--ctx-panel-a',
  sidebarOpacity: '--ctx-side-a', sidebarBlur: '--ctx-side-blur',
  glassBlur: '--ctx-glass-blur',
  floatOpacity: '--ctx-float-a', laneOpacity: '--ctx-lane-a', textHalo: '--ctx-halo',
  composerOpacity: '--ctx-composer-a',
  homeHeight: '--ctx-home-hero-h', homeOverlay: '--ctx-home-overlay-a',
  homeCardOpacity: '--ctx-home-card-a', homeBackdrop: '--ctx-home-backdrop-a',
  homeBackdropBlur: '--ctx-home-backdrop-blur',
};
const TUNE_PX = new Set(['blur', 'glassBlur', 'homeHeight', 'homeBackdropBlur', 'sidebarBlur']);

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));

  if (cmd === 'status') {
    const target = await findTarget(opts.port);
    const status = { port: opts.port, reachable: Boolean(target), injected: false, theme: null };
    if (target) {
      const cdp = await connectToCodex(opts.port);
      const t = await cdp.eval('window.__ctxTheme ? { version: window.__ctxTheme.version, name: window.__ctxTheme.name } : null');
      status.injected = Boolean(t);
      status.theme = t?.name ?? null;
      status.payloadVersion = t?.version ?? null;
      cdp.close();
    }
    console.log(opts.json ? JSON.stringify(status) : [
      `CDP port ${status.port}: ${status.reachable ? 'reachable' : 'NOT reachable (start Codex with the debug flag)'}`,
      `background injected: ${status.injected ? `yes (${status.theme})` : 'no'}`,
    ].join('\n'));
    process.exit(status.reachable ? 0 : 2);
  }

  if (cmd === 'apply') {
    if (!opts.theme) fail('apply requires --theme <dir>');
    const theme = await loadTheme(opts.theme);
    const cdp = await connectToCodex(opts.port) ?? fail('Codex CDP port not reachable; start Codex with the debug flag first', 2);
    const program = rendererProgram({
      css: buildCss(theme),
      backgroundDataUrl: theme.backgroundDataUrl,
      homeDataUrl: theme.home.dataUrl,
      accentRemap: opts.accent ? theme.accent : null,
      name: theme.name,
      copy: theme.copy,
    });
    const result = await cdp.eval(program);
    cdp.close();
    console.log(`applied "${theme.name}" (glass containers: ${result.glassed})`);
    return;
  }

  if (cmd === 'tune') {
    if (!opts.set.length) fail('tune requires at least one --set key=value');
    const sets = opts.set.map((kv) => {
      const [k, v] = kv.split('=');
      if (!(k in TUNE_KEYS)) fail(`unknown tune key "${k}" (${Object.keys(TUNE_KEYS).join(', ')})`);
      if (Number.isNaN(Number(v))) fail(`tune value must be a number: ${kv}`);
      return [TUNE_KEYS[k], TUNE_PX.has(k) ? `${v}px` : v];
    });
    const cdp = await connectToCodex(opts.port) ?? fail('Codex CDP port not reachable', 2);
    await cdp.eval(`(() => {
      if (!window.__ctxTheme) throw new Error('no theme applied');
      for (const [prop, value] of ${JSON.stringify(sets)}) {
        if (window.__ctxTheme.setVar) window.__ctxTheme.setVar(prop, value);
        else document.documentElement.style.setProperty(prop, value); // v1 payload
      }
    })()`);
    cdp.close();
    console.log(`tuned: ${opts.set.join(', ')}`);
    return;
  }

  if (cmd === 'remove') {
    const cdp = await connectToCodex(opts.port);
    if (!cdp) { console.log('Codex CDP port not reachable; nothing to remove.'); return; }
    const removed = await cdp.eval('window.__ctxTheme ? (window.__ctxTheme.remove(), true) : false');
    cdp.close();
    console.log(removed ? 'background removed' : 'nothing was injected');
    return;
  }

  if (cmd === 'reload') {
    const cdp = await connectToCodex(opts.port) ?? fail('Codex CDP port not reachable', 2);
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', { ignoreCache: false });
    cdp.close();
    console.log('page reloaded (all injected payloads cleared)');
    return;
  }

  if (cmd === 'screenshot') {
    if (!opts.out) fail('screenshot requires --out <file.jpg>');
    const cdp = await connectToCodex(opts.port) ?? fail('Codex CDP port not reachable', 2);
    await cdp.send('Page.enable');
    // A backgrounded window produces no frames and captureScreenshot stalls;
    // bring it forward first (briefly steals focus — screenshot is opt-in).
    await cdp.send('Page.bringToFront').catch(() => {});
    // jpeg, not png: a full-window png exceeds Node's WebSocket receive limit
    // and the response is silently dropped.
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
    await writeFile(opts.out, Buffer.from(shot.data, 'base64'));
    cdp.close();
    console.log(opts.out);
    return;
  }

  fail(`unknown command "${cmd ?? ''}" (status|apply|tune|remove|screenshot)`);
}

export { loadTheme, buildCss, rendererProgram, safeHomePosition };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(err.message));
}

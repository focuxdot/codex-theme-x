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
//   node inject.mjs events [--clear] [--json]
//   node inject.mjs flush-signal          (keeper bridge: read+clear flush flag)
//   node inject.mjs report [--json]       (upload buffered ad events)
//
// Requires Node >= 22 (global WebSocket). Zero dependencies.

import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PAYLOAD_VERSION = 19;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const DISTRIBUTION_FILE = 'adsmarket-distribution.json';
const BENEFICIARY_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const AUCTION_ID_RE = /^auc_[a-zA-Z0-9_-]{8,64}$/;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { port: 9341, set: [], json: false, accent: true, clear: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--port') opts.port = Number(rest[++i]);
    else if (a === '--theme') opts.theme = rest[++i];
    else if (a === '--set') opts.set.push(rest[++i]);
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--no-accent') opts.accent = false;
    else if (a === '--clear') opts.clear = true;
    else fail(`unknown option: ${a}`);
  }
  return { cmd, opts };
}

function fail(msg, code = 1) {
  console.error(`inject.mjs: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------- CDP client

function selectTarget(list) {
  if (!Array.isArray(list)) return null;
  const pages = list.filter((t) =>
    t.type === 'page' &&
    typeof t.url === 'string' && t.url.startsWith('app://') &&
    typeof t.webSocketDebuggerUrl === 'string'
  );
  // Newer Codex builds expose a second app:// page for the avatar overlay.
  // It contains enough shell markup to pass the identity probe, but injecting
  // there leaves the visible main window untouched. Prefer the primary page
  // while retaining the old single-page fallback.
  return pages.find((t) => {
    try {
      return new URL(t.url).searchParams.get('initialRoute') !== '/avatar-overlay';
    } catch {
      return false;
    }
  }) ?? pages[0] ?? null;
}

async function findTarget(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    return selectTarget(await res.json());
  } catch {
    return null;
  }
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

// Sponsor links are platform-signed and must resolve to a real web page.
// Anything that isn't a plain http(s) URL is dropped (the slot's copy stays,
// but non-clickable) — no javascript:, data:, app:, or custom schemes.
function safeSponsorUrl(value) {
  if (value == null) return null;
  try {
    const u = new URL(String(value).trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
  } catch { return null; }
}

function parseSponsorSlot(slot, maxLength) {
  if (!slot || typeof slot !== 'object') return null;
  const text = optionalThemeText(slot.text, maxLength);
  if (!text) return null; // no copy → the slot simply isn't rendered
  return { text, url: safeSponsorUrl(slot.url) };
}

// Optional advertising layer for the blank-page Hero. Each of the three copy
// slots may carry { text, url }; a slot with a valid url becomes a clickable
// link (verified system-browser jump), a slot without one is plain copy. The
// disclosure badge is optional and OFF by default — a platform can sign a
// non-empty `disclosure` string to force one on the kicker.
function parseSponsor(sponsor) {
  if (!sponsor || typeof sponsor !== 'object') return null;
  const slots = sponsor.slots ?? {};
  const parsed = {
    kicker: parseSponsorSlot(slots.kicker, 40),
    greeting: parseSponsorSlot(slots.greeting, 80),
    tagline: parseSponsorSlot(slots.tagline, 96),
  };
  if (!parsed.kicker && !parsed.greeting && !parsed.tagline) return null;
  return {
    // Campaign id — platform-signed; rides on every per-slot event for billing
    // and attribution. Absent in the demo/self-serve case → events carry null.
    campaign: optionalThemeText(sponsor.campaign, 64),
    // Optional disclosure badge on the kicker. Absent = no badge; a platform
    // that wants to force one just signs a non-empty string into the block.
    disclosure: optionalThemeText(sponsor.disclosure, 16),
    slots: parsed,
  };
}

function safeAdsApiBase(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}

async function loadDistribution(themeDir, themeId) {
  let raw;
  try { raw = JSON.parse(await readFile(path.join(themeDir, DISTRIBUTION_FILE), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail(`${DISTRIBUTION_FILE}: invalid JSON`);
  }
  const adsApiBase = safeAdsApiBase(raw?.adsApiBase);
  if (raw?.v === 1) {
    const beneficiaryUserId = String(raw?.beneficiaryUserId || '');
    if (raw?.themeId !== themeId || !BENEFICIARY_RE.test(beneficiaryUserId) || !adsApiBase)
      fail(`${DISTRIBUTION_FILE}: invalid or mismatched adsMarket attribution`);
    return { v: 1, beneficiaryUserId, themeId, source: raw.source === 'gallery' ? 'gallery' : null, adsApiBase };
  }
  if (raw?.v === 2) {
    const auctionId = String(raw?.auctionId || '');
    const targetUserId = String(raw?.targetUserId || '');
    if (raw?.source !== 'targeted_auction' || raw?.themeId !== themeId || !AUCTION_ID_RE.test(auctionId) ||
        !BENEFICIARY_RE.test(targetUserId) || !adsApiBase)
      fail(`${DISTRIBUTION_FILE}: invalid or mismatched targeted auction delivery`);
    return { v: 2, source: 'targeted_auction', auctionId, targetUserId, themeId, adsApiBase };
  }
  fail(`${DISTRIBUTION_FILE}: unsupported distribution version`);
}

function safeThemeAssetName(value, field) {
  const name = String(value ?? '');
  if (!name || path.basename(name) !== name || name === '.' || name === '..') {
    fail(`${field} must be a file name inside the theme directory`);
  }
  return name;
}

// Resolve one background block into the renderer's veil/opacity vars. Called
// once per single-mode theme, or twice (light + dark) for an auto theme.
function resolveVars(bg) {
  return {
    dim: bg.dim ?? 0.85,
    blur: bg.blur ?? 0,
    // Default look: the conversation area is FULLY transparent — the artwork is
    // the hero. The sidebar is dense scan-read text, so it gets a near-solid
    // veil instead; the decisive contrast makes the panel boundary read as an
    // intentional layer edge. Users who want more veil over the art just ask.
    panelOpacity: bg.panelOpacity ?? 0,
    // Sidebar = FROSTED GLASS, not a flat plate: mid-density veil + heavy
    // backdrop blur. The artwork's colors bleed through the frost (visual unity
    // with the page), while the frosted↔clear material step keeps the zoning
    // unmistakable. Raise toward 0.85+ when dark busy artwork sits under a light
    // variant (density is the readability lever; blur is the unity lever).
    sidebarOpacity: bg.sidebarOpacity ?? 0.6,
    sidebarBlur: bg.sidebarBlur ?? 40,
    glassBlur: bg.glassBlur ?? 18,
    // Floating panels (environment info, dropdowns, popovers) — they hold text
    // over arbitrary content, so they keep a readable veil even when the main
    // surface is fully transparent.
    floatOpacity: bg.floatOpacity ?? 0.75,
    // Composer frost. The app's own design is translucent glass
    // (bg-token-input-background/90 + backdrop blur) — an electron:dark override
    // flattens it to opaque; this restores the intent with the theme's surface
    // color. Denser than floats: it is the typing surface, the one place
    // readability outranks transparency.
    composerOpacity: bg.composerOpacity ?? 0.8,
    // Reading lane: a soft-edged surface-colored sheet behind the thread column
    // only. Text gets near-native contrast conditions (ink over a mostly-surface
    // backing) WITHOUT touching text rendering, and the artwork stays
    // full-strength outside the lane. Raise toward 0.55 for dark/busy artwork
    // under a light variant. 0 = off.
    laneOpacity: bg.laneOpacity ?? 0.45,
    // Legacy text glow. Users read with their habitual text rendering, so this
    // defaults OFF — the reading lane is the readability mechanism. Kept as an
    // explicit opt-in only.
    textHalo: bg.textHalo ?? 0,
  };
}

async function loadTheme(themeDir) {
  const file = path.join(themeDir, 'theme.json');
  const theme = JSON.parse(await readFile(file, 'utf8'));
  if (theme.schema !== 'codextheme/1') fail(`${file}: expected "schema": "codextheme/1"`);
  // Two theme types. "standard" (default) is a normal personalization theme;
  // "sponsored" is an advertising theme that carries a sponsor block and renders
  // the clickable Hero links. type is AUTHORITATIVE: the sponsor layer renders
  // only for a sponsored theme, so a stray sponsor block on a standard theme is
  // ignored and can never turn a normal user's theme into an ad.
  const type = theme.type === 'sponsored' ? 'sponsored' : 'standard';
  const sponsor = type === 'sponsored' ? parseSponsor(theme.sponsor) : null;
  if (type === 'sponsored' && !sponsor) {
    fail(`${file}: type "sponsored" requires a "sponsor" block with at least one slot (text + optional url)`);
  }
  const bg = theme.background ?? {};
  const home = theme.home ?? {};
  if (!bg.file) fail(`${file}: background.file is required`);

  // Color mode. "dark"/"light" = a single-mode pack (one palette, one chrome
  // table). "auto" = a dual-mode pack carrying BOTH palettes + per-mode veil
  // densities in a `modes` block; it follows the user's light/dark mode with no
  // re-apply. Anything else falls back to a single dark pack.
  const isAuto = theme.variant === 'auto' && theme.modes && theme.modes.light && theme.modes.dark;
  const variant = isAuto ? 'auto' : (theme.variant === 'light' ? 'light' : 'dark');
  // Effective background vars for a mode = top-level background merged with the
  // mode's own overrides (image + blurs live at the top level and are shared).
  const modeBg = (m) => (isAuto ? { ...bg, ...(theme.modes[m].background ?? {}) } : bg);
  const modeOfficial = (m) => (isAuto ? (theme.modes[m].official ?? {}) : (theme.official ?? {}));
  const surfaceOf = (m) => modeOfficial(m).surface ?? '#181818';
  const accentOf = (m) => modeOfficial(m).accent ?? null;
  // Seed the static CSS from the dark set (auto) or the single palette; the
  // renderer's syncMode overrides every mode-dependent var on inject anyway.
  const seed = isAuto ? 'dark' : variant;

  const backgroundFile = safeThemeAssetName(bg.file, 'background.file');
  const homeFile = home.file ? safeThemeAssetName(home.file, 'home.file') : backgroundFile;
  const backgroundDataUrl = await imageDataUrl(path.join(themeDir, backgroundFile));
  const homeDataUrl = homeFile === backgroundFile
    ? backgroundDataUrl
    : await imageDataUrl(path.join(themeDir, homeFile));
  const themeId = String(theme.id ?? theme.name ?? path.basename(themeDir));
  const distribution = type === 'sponsored' ? await loadDistribution(themeDir, themeId) : null;
  return {
    name: String(theme.name ?? theme.id ?? 'unnamed'),
    // Stable id used as the event `theme` field (handoff: theme = 主题 id).
    id: themeId,
    surface: surfaceOf(seed),
    accent: accentOf(seed),
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
    type,
    sponsor,
    distribution,
    variant,
    // Seed vars = the current-mode (dark for auto) set; the static CSS uses it
    // only until the renderer's syncMode kicks in on inject.
    vars: resolveVars(modeBg(seed)),
    // Per-mode veil densities + accent, swapped live by syncMode on every
    // light/dark flip. For a single-mode theme both entries are identical, so
    // the swap is a no-op and behavior is unchanged.
    modeVars: {
      light: { vars: resolveVars(modeBg('light')), accent: accentOf('light') },
      dark: { vars: resolveVars(modeBg('dark')), accent: accentOf('dark') },
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
/* The main landmark is substantially more stable than Codex's styling class.
   Builds before 26.727 used main-surface; newer builds use a hashed CSS
   Modules class (_MainContentSurface_*). Target the semantic element so an
   app update cannot silently put an opaque plate back over the artwork. */
:root.ctx-themed main {
  background-color: rgba(var(--ctx-surface-rgb), var(--ctx-panel-a)) !important;
  border-color: transparent !important; /* zoning is veil contrast, not lines */
  /* The app outlines the main card with a 0.5px ring box-shadow — over
     artwork it reads as a stray divider between sidebar and content. */
  box-shadow: none !important;
}
/* Newer Codex builds wrap the whole workspace in a page-surface frame with
   its own opaque oklab background. It sits outside both <main> and the left
   panel, so clearing those children alone still leaves the skin looking dead. */
:root.ctx-themed [data-app-shell-page-surface="true"] {
  background: transparent !important;
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
:root.ctx-themed .bg-token-dropdown-background,
:root.ctx-themed [class~="electron:elevation-prominent"].bg-surface-elevated-secondary {
  background-color: rgba(var(--ctx-surface-rgb), calc(var(--ctx-float-a) * var(--ctx-veil-scale))) !important;
  backdrop-filter: blur(var(--ctx-glass-blur));
}
/* Panels nest the same token (e.g. the environment-info sticky header inside
   the panel body): two stacked veils double the density right where the title
   sits. Inner layers thin out to a hint — the outer frost already carries
   readability. */
:root.ctx-themed .bg-token-dropdown-background .bg-token-dropdown-background,
:root.ctx-themed [class~="electron:elevation-prominent"].bg-surface-elevated-secondary .bg-surface-elevated-secondary {
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
:root.ctx-themed .composer-surface-chrome,
:root.ctx-themed [data-composer-surface-variant] {
  background-color: rgba(var(--ctx-surface-rgb), calc(var(--ctx-composer-a) * var(--ctx-composer-scale))) !important;
}
/* Codex 26.928 moved an opaque surface onto the composer's inner body. Keep
   the glass on the root and make the new inner plate transparent. */
:root.ctx-themed [data-composer-surface-variant] [data-composer-body] {
  background: transparent !important;
}
/* The nav header is already transparent; the only header/content divider is
   this native fade band (surface → transparent). Over full-strength artwork
   it reads as a stray light strip, so the art runs true full-bleed instead. */
:root.ctx-themed .app-shell-main-content-top-fade,
:root.ctx-themed [class*="_MainContentTopFade_"] {
  display: none !important;
  background: transparent !important;
  box-shadow: none !important;
}
/* Newer CSS-Modules builds also draw a hairline on the content frame directly
   beneath the fade. Remove that second half of the separator as well. */
:root.ctx-themed [class*="_MainContentFrame_"] {
  border-top-color: transparent !important;
}
/* Same family, bottom edge: the composer sits on a scroll-mask plate (solid
   surface gradient, wider than the composer) that fades messages out behind
   the input. Over artwork it reads as a stray rectangular slab — the
   composer's own frosted veil already keeps the input readable. */
:root.ctx-themed main .bg-gradient-to-t[class*="from-token-main-surface"],
:root.ctx-themed main .bg-gradient-to-t.from-surface.via-surface {
  background-image: none !important;
}
/* When the above-composer portal contains transient content (for example the
   "N files changed" pill), Codex inserts a second, shorter surface gradient.
   It is absent in the empty state, which made the dark strip look intermittent. */
:root.ctx-themed main [data-above-composer-portal] .bg-gradient-to-t.from-surface.to-transparent {
  background-image: none !important;
}
/* Codex 26.928 replaced the sticky footer mask with two new siblings: a short
   gradient plus a full-width solid surface. Both sit behind the composer and
   must be clear when the thread itself is transparent. */
:root.ctx-themed main [data-thread-scroll-footer="true"] {
  background: transparent !important;
}
:root.ctx-themed main [data-thread-scroll-footer="true"] > .bg-gradient-to-t.from-surface {
  background-image: none !important;
}
:root.ctx-themed main [data-thread-scroll-footer="true"] > .bg-surface {
  background: transparent !important;
}
/* One layout variant places the same two layers as siblings of the footer
   inside a sticky wrapper. This is the thin black edge seen immediately above
   the composer in the current conversation layout. */
:root.ctx-themed main .sticky.bottom-0 > .bg-gradient-to-t.from-surface {
  background-image: none !important;
}
:root.ctx-themed main .sticky.bottom-0 > .from-surface {
  background-image: none !important;
}
:root.ctx-themed main .sticky.bottom-0 > .bg-surface {
  background: transparent !important;
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
:root.ctx-themed body:not(:has([data-app-shell-active-page])):has(section[class*="home-suggestions"])::after,
:root.ctx-themed body:has([data-app-shell-active-page="true"] section[class*="home-suggestions"])::after {
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background:
    radial-gradient(60% 42% at 82% 6%, rgba(var(--ctx-accent-rgb), 0.18), transparent 100%),
    radial-gradient(55% 40% at 6% 98%, rgba(var(--ctx-accent-rgb), 0.13), transparent 100%),
    rgba(var(--ctx-surface-rgb), var(--ctx-home-backdrop-a));
  backdrop-filter: blur(var(--ctx-home-backdrop-blur));
}
:root.ctx-themed body:not(:has([data-app-shell-active-page])):has(section[class*="home-suggestions"]) div[class~="home-main-content"],
:root.ctx-themed [data-app-shell-active-page="true"]:has(section[class*="home-suggestions"]) div[class~="home-main-content"] {
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
/* Anchor the Hero to the stable greeting node rather than to positional
   ancestors. Recent Codex builds insert a home-banners sibling ahead of the
   content and expose home-main-content as a container-name utility; positional
   selectors pushed the real content below the viewport after that change. */
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) div:has(> [data-feature="game-source"]) {
  position: relative !important;
  isolation: isolate;
  width: calc(100% - 44px) !important;
  max-width: none !important;
  height: var(--ctx-home-hero-h) !important;
  min-height: var(--ctx-home-hero-h) !important;
  flex: 0 0 auto !important;
  box-sizing: border-box !important;
  align-items: flex-start !important;
  justify-content: center !important;
  gap: 0 !important;
  padding: 0 clamp(26px, 4vw, 48px) !important;
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
:root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) div:has(> [data-feature="game-source"]) > [data-feature="game-source"] {
  position: relative;
  z-index: 1;
  width: min(54%, 540px) !important;
  flex: 0 0 auto !important;
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
:root.ctx-themed body:not(:has([data-app-shell-active-page])):has(section[class*="home-suggestions"]) .composer-surface-chrome,
:root.ctx-themed body:not(:has([data-app-shell-active-page])):has(section[class*="home-suggestions"]) [data-composer-surface-variant],
:root.ctx-themed [data-app-shell-active-page="true"]:has(section[class*="home-suggestions"]) .composer-surface-chrome,
:root.ctx-themed [data-app-shell-active-page="true"]:has(section[class*="home-suggestions"]) [data-composer-surface-variant] {
  border: 1px solid var(--ctx-hairline) !important;
  border-radius: 24px !important;
  background-color: rgba(var(--ctx-surface-rgb), 0.9) !important;
  backdrop-filter: blur(var(--ctx-glass-blur)) saturate(116%) !important;
  box-shadow: 0 14px 36px var(--ctx-cover-shadow), inset 0 1px rgba(255,255,255,0.06) !important;
}
:root.ctx-themed body:not(:has([data-app-shell-active-page])):has(section[class*="home-suggestions"]) div:has(> .horizontal-scroll-fade-mask [class*="project-selector"]),
:root.ctx-themed [data-app-shell-active-page="true"]:has(section[class*="home-suggestions"]) div:has(> .horizontal-scroll-fade-mask [class*="project-selector"]) {
  position: relative;
  padding-top: 26px !important;
  border: 1px solid var(--ctx-hairline);
  border-bottom: 0;
  background-color: rgba(var(--ctx-surface-rgb), 0.84) !important;
  backdrop-filter: blur(var(--ctx-glass-blur)) saturate(112%);
}
:root.ctx-themed body:not(:has([data-app-shell-active-page])):has(section[class*="home-suggestions"]) div:has(> .horizontal-scroll-fade-mask [class*="project-selector"])::before,
:root.ctx-themed [data-app-shell-active-page="true"]:has(section[class*="home-suggestions"]) div:has(> .horizontal-scroll-fade-mask [class*="project-selector"])::before {
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
  :root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) div:has(> [data-feature="game-source"]) {
    width: calc(100% - 28px) !important;
  }
  :root.ctx-themed [role="main"]:has(section[class*="home-suggestions"]) div:has(> [data-feature="game-source"]) > [data-feature="game-source"] {
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
:root.ctx-themed main {
  text-shadow:
    0 0 2px rgba(var(--ctx-surface-rgb), var(--ctx-halo)),
    0 0 8px rgba(var(--ctx-surface-rgb), calc(var(--ctx-halo) * 0.85)),
    0 1px 16px rgba(var(--ctx-surface-rgb), calc(var(--ctx-halo) * 0.6));
}
/* ---- Sponsored Hero slots -------------------------------------------------
   Only live when a sponsor block is present (the .ctx-sponsored / .ctx-sponsor-hero
   hooks are added by the renderer). The three native slots — kicker (::before),
   greeting (child span), tagline (::after) — are pseudo-elements/text and can't
   host a link, so the renderer replaces them with real, individually clickable
   elements. Two red lines (jump-feasibility.md 跳转落地设计): a linked slot must
   LOOK clickable (accent + hover underline + ↗) and only navigate on an explicit
   click (never auto/hover, the whole Hero is never a hot zone); the disclosure
   badge is platform-rendered and cannot be removed by advertiser copy. */
:root.ctx-themed [data-feature="game-source"].ctx-sponsored { align-items: flex-start !important; }
:root.ctx-themed [data-feature="game-source"].ctx-sponsored > span { display: none !important; }
:root.ctx-themed [data-feature="game-source"].ctx-sponsored::before,
:root.ctx-themed [data-feature="game-source"].ctx-sponsored::after { content: none !important; }
:root.ctx-themed .ctx-sponsor-hero {
  display: flex; flex-direction: column; align-items: flex-start;
  width: 100%; text-align: left;
}
:root.ctx-themed .ctx-hero-slot {
  display: block; max-width: 100%; text-decoration: none; color: inherit;
}
:root.ctx-themed .ctx-hero-kicker {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
  color: var(--codex-base-accent, ${theme.accent ?? heroInk});
  font-size: 12px; line-height: 1.35; font-weight: 800; letter-spacing: 0.1em;
}
:root.ctx-themed .ctx-hero-greeting {
  color: var(--ctx-hero-ink);
  font-size: clamp(21px, 2.1vw, 31px); line-height: 1.22; font-weight: 760;
  text-shadow: 0 2px 18px rgba(var(--ctx-hero-shade), 0.42);
}
:root.ctx-themed .ctx-hero-tagline {
  margin-top: 13px; color: var(--ctx-hero-muted);
  font-size: 13px; line-height: 1.5; font-weight: 500; letter-spacing: 0.02em;
}
/* Platform-forced disclosure badge — rides on the kicker, advertiser can't suppress it. */
:root.ctx-themed .ctx-hero-badge {
  display: inline-block; padding: 2px 7px; border-radius: 999px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--ctx-hero-ink);
  background: rgba(var(--ctx-surface-rgb), 0.55);
  border: 1px solid var(--ctx-hairline);
}
/* Link affordance: only slots carrying a URL look and behave clickable. */
:root.ctx-themed .ctx-hero-link { cursor: pointer; }
:root.ctx-themed .ctx-hero-link:hover .ctx-hero-label {
  text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px;
}
/* The ↗ jump marker rides only on the tagline; the other linked slots signal
   clickability through the hover underline + pointer alone. */
:root.ctx-themed .ctx-hero-link.ctx-hero-tagline .ctx-hero-label::after {
  content: " ↗"; font-size: 0.82em; opacity: 0.7;
}
/* Campaign exhaustion is a quiet, persistent Hero state — never a modal or
   system notification. Keep the artwork and original copy, but make it clear
   that the installed theme no longer earns and disable advertiser navigation. */
:root.ctx-themed .ctx-campaign-state {
  display: none; align-items: center; flex-wrap: wrap; gap: 7px 10px;
  margin-top: 15px; padding: 8px 10px; border-radius: 10px;
  color: var(--ctx-hero-muted); background: rgba(var(--ctx-surface-rgb), 0.52);
  border: 1px solid var(--ctx-hairline); backdrop-filter: blur(12px);
  font-size: 11px; line-height: 1.4;
}
:root.ctx-themed .ctx-sponsor-hero.ctx-campaign-ended .ctx-campaign-state { display: flex; }
:root.ctx-themed .ctx-campaign-ended .ctx-hero-link {
  cursor: default; opacity: 0.62;
}
:root.ctx-themed .ctx-campaign-ended .ctx-hero-link:hover .ctx-hero-label {
  text-decoration: none;
}
:root.ctx-themed .ctx-campaign-ended .ctx-hero-link.ctx-hero-tagline .ctx-hero-label::after {
  content: none;
}
:root.ctx-themed .ctx-campaign-state-badge {
  color: var(--ctx-hero-ink); font-weight: 760;
}
:root.ctx-themed .ctx-campaign-state-action {
  appearance: none; border: 0; padding: 0; background: transparent;
  color: var(--codex-base-accent, ${theme.accent ?? heroInk});
  cursor: pointer; font: inherit; font-weight: 700;
}
:root.ctx-themed .ctx-campaign-state-action:hover { text-decoration: underline; text-underline-offset: 3px; }

${theme.copy.placeholder ? `
/* Codex 26.928 moved the native placeholder from ::after to ::before.
   Override the current painter and explicitly suppress the legacy painter so
   the native and themed strings can never stack. */
:root.ctx-themed [contenteditable] p[data-placeholder]::before {
  content: ${JSON.stringify(theme.copy.placeholder)} !important;
}
:root.ctx-themed [contenteditable] p[data-placeholder]::after {
  content: none !important;
}` : ''}
`;
}

// The renderer-side program. Self-contained; injected via Runtime.evaluate.
// Uses adoptedStyleSheets (immune to style-src CSP) and stores handles on
// window.__ctxTheme so apply is idempotent and remove is complete.
function rendererProgram({ css, backgroundDataUrl, homeDataUrl, accentRemap, name, copy, sponsor, distribution, themeId, modeVars }) {
  // Per-mode CSS-var maps swapped live by syncMode on every light/dark flip.
  // sidebar/lane/dim/panel are NOT scaled by veil-scale, so a per-mode value is
  // their only control; float/composer keep the existing veil-scale
  // compensation (seeded from the dark set) and are intentionally not swapped.
  const modeCssVars = (mv) => {
    if (!mv) return null;
    const o = {
      '--ctx-dim': String(mv.vars.dim),
      '--ctx-blur': mv.vars.blur + 'px',
      '--ctx-panel-a': String(mv.vars.panelOpacity),
      '--ctx-side-a': String(mv.vars.sidebarOpacity),
      '--ctx-side-blur': mv.vars.sidebarBlur + 'px',
      '--ctx-glass-blur': mv.vars.glassBlur + 'px',
      '--ctx-lane-a': String(mv.vars.laneOpacity),
      '--ctx-halo': String(mv.vars.textHalo),
    };
    if (mv.accent) o['--ctx-accent-rgb'] = hexToRgbTriplet(mv.accent);
    return o;
  };
  const modeVarsJson = JSON.stringify({ light: modeCssVars(modeVars?.light), dark: modeCssVars(modeVars?.dark) });
  return `(() => {
  const prev = window.__ctxTheme;
  // Pass the incoming theme id so the OUTGOING ad payload can tell a real switch
  // (emit switch_away) from an idempotent re-apply of the same theme (no event).
  if (prev) { try { prev.remove({ next: ${JSON.stringify(themeId ?? null)} }); } catch {} }

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

  // Report whether each live glass surface follows the configured opacity.
  // Merely finding window.__ctxTheme is insufficient: a Codex update can
  // rename one selector while leaving the payload and the other layers alive.
  const colorAlpha = (value) => {
    if (!value || value === 'transparent') return 0;
    const match = /^rgba?\\(([^)]+)\\)$/.exec(value.trim());
    if (!match) return null;
    const parts = match[1].split(',').map((part) => part.trim());
    return parts.length < 4 ? 1 : Number(parts[3]);
  };
  const health = () => {
    const main = document.querySelector('main');
    const sidebar = document.querySelector('aside.app-shell-left-panel');
    const pageSurface = document.querySelector('[data-app-shell-page-surface="true"]');
    const activePage = document.querySelector('[data-app-shell-active-page="true"]');
    const composer = (activePage || document).querySelector('.composer-surface-chrome, [data-composer-surface-variant]');
    const composerBody = composer?.querySelector('[data-composer-body]') ?? null;
    const floating = document.querySelector(
      '.bg-token-dropdown-background, [class~="electron:elevation-prominent"].bg-surface-elevated-secondary'
    );
    const bottomMasks = [...document.querySelectorAll([
      'main .bg-gradient-to-t[class*="from-token-main-surface"]',
      'main .bg-gradient-to-t.from-surface.via-surface',
      'main [data-above-composer-portal] .bg-gradient-to-t.from-surface.to-transparent',
      'main [data-thread-scroll-footer="true"] > .bg-gradient-to-t.from-surface',
      'main .sticky.bottom-0 > .bg-gradient-to-t.from-surface',
      'main .sticky.bottom-0 > .from-surface',
    ].join(', '))];
    const bottomSolid = document.querySelector([
      'main [data-thread-scroll-footer="true"] > .bg-surface',
      'main .sticky.bottom-0 > .bg-surface',
    ].join(', '));
    const rootStyle = getComputedStyle(root);
    const readVar = (name) => Number.parseFloat(
      typeof rootStyle.getPropertyValue === 'function' ? rootStyle.getPropertyValue(name).trim() : ''
    );
    const expectedPanelOpacity = readVar('--ctx-panel-a');
    const expectedSidebarOpacity = readVar('--ctx-side-a');
    const expectedComposerOpacity = readVar('--ctx-composer-a') * readVar('--ctx-composer-scale');
    const expectedFloatingOpacity = readVar('--ctx-float-a') * readVar('--ctx-veil-scale');
    const mainBackground = main ? getComputedStyle(main).backgroundColor : null;
    const sidebarBackground = sidebar ? getComputedStyle(sidebar).backgroundColor : null;
    const pageSurfaceBackground = pageSurface ? getComputedStyle(pageSurface).backgroundColor : null;
    const composerBackground = composer ? getComputedStyle(composer).backgroundColor : null;
    const composerBodyBackground = composerBody ? getComputedStyle(composerBody).backgroundColor : null;
    const floatingBackground = floating ? getComputedStyle(floating).backgroundColor : null;
    const bottomMaskBackgroundImages = bottomMasks.map((mask) => getComputedStyle(mask).backgroundImage);
    const bottomMaskBackgroundImage = bottomMaskBackgroundImages.length
      ? bottomMaskBackgroundImages.join(' | ')
      : null;
    const bottomSolidBackground = bottomSolid ? getComputedStyle(bottomSolid).backgroundColor : null;
    const actualPanelOpacity = colorAlpha(mainBackground);
    const actualSidebarOpacity = colorAlpha(sidebarBackground);
    const actualPageSurfaceOpacity = colorAlpha(pageSurfaceBackground);
    const actualComposerOpacity = colorAlpha(composerBackground);
    const actualComposerBodyOpacity = colorAlpha(composerBodyBackground);
    const actualFloatingOpacity = colorAlpha(floatingBackground);
    const actualBottomSolidOpacity = colorAlpha(bottomSolidBackground);
    const follows = (el, expected, actual) => Boolean(el) && Number.isFinite(expected) &&
      Number.isFinite(actual) && Math.abs(actual - expected) <= 0.03;
    return {
      mainFound: Boolean(main),
      mainBackground,
      expectedPanelOpacity: Number.isFinite(expectedPanelOpacity) ? expectedPanelOpacity : null,
      actualPanelOpacity: Number.isFinite(actualPanelOpacity) ? actualPanelOpacity : null,
      mainSurfaceApplied: follows(main, expectedPanelOpacity, actualPanelOpacity),
      sidebarFound: Boolean(sidebar),
      sidebarBackground,
      expectedSidebarOpacity: Number.isFinite(expectedSidebarOpacity) ? expectedSidebarOpacity : null,
      actualSidebarOpacity: Number.isFinite(actualSidebarOpacity) ? actualSidebarOpacity : null,
      sidebarSurfaceApplied: follows(sidebar, expectedSidebarOpacity, actualSidebarOpacity),
      pageSurfaceFound: Boolean(pageSurface),
      pageSurfaceBackground,
      actualPageSurfaceOpacity: Number.isFinite(actualPageSurfaceOpacity) ? actualPageSurfaceOpacity : null,
      pageSurfaceApplied: Boolean(pageSurface) && Number.isFinite(actualPageSurfaceOpacity) &&
        Math.abs(actualPageSurfaceOpacity) <= 0.03,
      composerFound: Boolean(composer),
      composerBackground,
      expectedComposerOpacity: Number.isFinite(expectedComposerOpacity) ? expectedComposerOpacity : null,
      actualComposerOpacity: Number.isFinite(actualComposerOpacity) ? actualComposerOpacity : null,
      composerSurfaceApplied: follows(composer, expectedComposerOpacity, actualComposerOpacity),
      composerBodyFound: Boolean(composerBody),
      composerBodyBackground,
      actualComposerBodyOpacity: Number.isFinite(actualComposerBodyOpacity) ? actualComposerBodyOpacity : null,
      composerBodySurfaceApplied: composerBody ? Number.isFinite(actualComposerBodyOpacity) &&
        Math.abs(actualComposerBodyOpacity) <= 0.03 : null,
      floatingFound: Boolean(floating),
      floatingBackground,
      expectedFloatingOpacity: Number.isFinite(expectedFloatingOpacity) ? expectedFloatingOpacity : null,
      actualFloatingOpacity: Number.isFinite(actualFloatingOpacity) ? actualFloatingOpacity : null,
      floatingSurfaceApplied: floating ? follows(floating, expectedFloatingOpacity, actualFloatingOpacity) : null,
      bottomMaskFound: bottomMasks.length > 0,
      bottomMaskBackgroundImage,
      bottomMaskClear: bottomMasks.length ? bottomMaskBackgroundImages.every((image) => image === 'none') : null,
      bottomSolidFound: Boolean(bottomSolid),
      bottomSolidBackground,
      actualBottomSolidOpacity: Number.isFinite(actualBottomSolidOpacity) ? actualBottomSolidOpacity : null,
      bottomSolidClear: bottomSolid ? Number.isFinite(actualBottomSolidOpacity) &&
        Math.abs(actualBottomSolidOpacity) <= 0.03 : null,
      artworkPresent: typeof rootStyle.getPropertyValue === 'function' &&
        Boolean(rootStyle.getPropertyValue('--ctx-bg-art').trim()),
    };
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
  // Per-mode veil densities + accent for an auto (dual-mode) theme. For a
  // single-mode theme both entries are identical, so the swap is a no-op; when
  // modeVars was not supplied at all, both are null and the swap is skipped.
  const MODE_VARS = ${modeVarsJson};
  const syncMode = () => {
    const s = sampleSurface();
    if (!s) return; // token missing → keep theme.json values
    const dark = (0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]) / 255 < 0.5;
    applyVar('--ctx-surface-rgb', s.join(', '));
    // Swap the mode-specific densities/accent (sidebar/lane/dim/panel + accent).
    const mv = dark ? MODE_VARS.dark : MODE_VARS.light;
    if (mv) for (const k in mv) applyVar(k, mv[k]);
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

  // Sponsor Hero: render the three Hero copy lines (kicker / greeting /
  // tagline) as real, individually clickable elements. jump-feasibility.md
  // verified on a live Codex that a renderer window.open(url,'_blank') routes
  // through Electron's deny+openExternal handler and opens the SYSTEM browser —
  // so a plain click on an injected anchor navigates out, with no host bridge.
  // The native slots are pseudo-elements/text (::before kicker, child span
  // greeting, ::after tagline) which cannot host a link, so we replace them.
  const sponsor = ${JSON.stringify(sponsor ?? null)};
  const beneficiaryUserId = ${JSON.stringify(distribution?.beneficiaryUserId ?? null)};
  const targetedDelivery = ${JSON.stringify(distribution?.v === 2 ? distribution : null)};
  const themeId = ${JSON.stringify(themeId ?? name)};
  const initialGalleryUrl = ${JSON.stringify(distribution?.adsApiBase ?? null)};
  let sponsorObserver = null, sponsorTimer = 0, sponsorIO = null;

  // --- ad-theme metering (impression-feasibility.md, two-stage §三) ----------
  // The ENTIRE metering + buffer subsystem lives behind sponsor: a standard
  // theme's payload runs none of it (zero events, zero markers, zero upload).
  // Events buffer to localStorage — page-in-app fetch is CSP-blocked, so the
  // host side collects the buffer out of band (inject.mjs report / keeper hook).
  // Privacy death-line: field whitelist {s,t,type,slot,campaign,theme,beneficiary} only —
  // never URL content, screen content, or keystrokes.
  const AD_KEY = '__ctxAdEvents';
  const AD_DAY_KEY = '__ctxAdActiveDay';
  const AD_CAMPAIGN_KEY = '__ctxAdCampaignStates';
  const AD_CAP = 10; // at most one upload batch; when full, drop NEW (never overwrite unconfirmed)
  const readAdStore = () => { try { return JSON.parse(localStorage.getItem(AD_KEY)) || null; } catch { return null; } };
  const readCampaignStore = () => { try {
    const value = JSON.parse(localStorage.getItem(AD_CAMPAIGN_KEY));
    return value && typeof value === 'object' ? value : { v: 1, campaigns: {}, galleryUrl: initialGalleryUrl };
  } catch { return { v: 1, campaigns: {}, galleryUrl: initialGalleryUrl }; } };
  let campaignStore = readCampaignStore();
  if (!campaignStore.campaigns || typeof campaignStore.campaigns !== 'object') campaignStore.campaigns = {};
  let campaignEnded = Boolean(sponsor && sponsor.campaign && campaignStore.campaigns[sponsor.campaign]?.status === 'exhausted');
  let campaignGalleryUrl = (/^https?:\\/\\//i.test(String(campaignStore.galleryUrl || ''))
    ? String(campaignStore.galleryUrl) : initialGalleryUrl);
  // RFC 4122 v4, always. crypto.randomUUID is the fast path; older WebViews
  // fall back to getRandomValues, then (last resort) Math.random — still
  // formatted as a standard UUID, since the platform rejects anything else.
  const ctxRandomUuid = () => {
    const c = self.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    const hex = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  };
  const ensureAdStore = () => {
    let s = readAdStore();
    if (!s || typeof s !== 'object') s = { v: 1, installId: null, seq: 0, events: [] };
    // Tolerate a partially-written / tampered store so the writer never wedges.
    if (!Array.isArray(s.events)) s.events = [];
    if (typeof s.seq !== 'number') s.seq = 0;
    if (!s.installId) s.installId = ctxRandomUuid();
    return s;
  };
  const pushAdEvent = (build) => {
    try {
      const s = ensureAdStore();
      // Full & unconfirmed → drop the new event, but persist (keeps a freshly
      // minted installId). Never evict older unconfirmed events. Re-arm the
      // flush signal: if a previous report failed after the keeper consumed
      // the flag, this keeps "buffer is full" observable without a timer —
      // each new push attempt re-asserts the one-shot signal.
      if (s.events.length >= AD_CAP) {
        localStorage.setItem(AD_KEY, JSON.stringify(s));
        if (!localStorage.getItem(AD_FLUSH_KEY)) signalAdFlush('buffer-full');
        return;
      }
      s.seq += 1; // monotonic, never reused → server dedupe key
      s.events.push(build(s.seq)); // build() returns an object with ONLY whitelisted keys
      localStorage.setItem(AD_KEY, JSON.stringify(s));
      // Event-driven flush signal #1 (handoff §4): the 10th event asks the host
      // for one immediate report. The flag is read-and-cleared by the keeper's
      // CDP probe; the console line is the controlled renderer→host marker.
      if (s.events.length === AD_CAP) signalAdFlush('buffer-full');
    } catch {}
  };
  const AD_FLUSH_KEY = '__ctxAdFlush';
  // One signal = one upload. Coalescing repeat signals for the same cause is
  // correct: they all mean "the same unconfirmed batch is still waiting".
  const signalAdFlush = (reason) => {
    try { localStorage.setItem(AD_FLUSH_KEY, JSON.stringify({ reason: reason, t: Date.now() })); } catch {}
    try { console.log('__CTX_AD_FLUSH__:' + reason); } catch {}
  };
  // impression / click carry slot + campaign; active_day / switch_away are
  // theme-level. Each builder emits exactly its allowed key set (whitelist by
  // construction — an extra key makes the platform reject the whole batch).
  const recordSlotEvent = (type, slot) => {
    if (targetedDelivery) return;
    if (campaignEnded) return;
    pushAdEvent((seq) => {
    const event = { s: seq, t: Date.now(), type: type, slot: slot,
      campaign: (sponsor && sponsor.campaign) || null, theme: themeId };
    if (beneficiaryUserId) event.beneficiary = beneficiaryUserId;
    return event;
    });
  };
  const recordThemeEvent = (type, theme) => {
    if (targetedDelivery) return;
    pushAdEvent((seq) => ({ s: seq, t: Date.now(), type: type, theme: theme }));
  };

  // Targeted auction delivery uses a separate, tiny lifecycle queue. It does
  // not count active minutes and never emits heartbeats: activation starts one
  // continuous wall-clock window, switching away resets it, and a single
  // completion_check is scheduled for the server-confirmed due time.
  const AUCTION_KEY = '__ctxAuctionEvents';
  const AUCTION_STATE_KEY = '__ctxAuctionStates';
  let auctionCompletionTimer = 0;
  const readAuctionRoot = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value && typeof value === 'object' ? value : fallback;
    } catch { return fallback; }
  };
  const ensureAuctionQueue = () => {
    const root = readAuctionRoot(AUCTION_KEY, { v: 1, queues: {} });
    if (!root.queues || typeof root.queues !== 'object') root.queues = {};
    let queue = targetedDelivery ? root.queues[targetedDelivery.auctionId] : null;
    if (!queue || typeof queue !== 'object') queue = {
      v: 1, auctionId: targetedDelivery.auctionId,
      adsApiBase: targetedDelivery.adsApiBase, installId: ctxRandomUuid(), seq: 0, events: [],
    };
    if (!Array.isArray(queue.events)) queue.events = [];
    if (!queue.installId) queue.installId = ctxRandomUuid();
    queue.adsApiBase = targetedDelivery.adsApiBase;
    root.queues[targetedDelivery.auctionId] = queue;
    return { root, queue };
  };
  const pushAuctionEvent = (type) => {
    if (!targetedDelivery) return;
    try {
      const { root: auctionRoot, queue } = ensureAuctionQueue();
      if (['activation', 'completion_check'].includes(type) &&
          queue.events.some((event) => event?.type === type)) return;
      if (queue.events.length >= 10) {
        localStorage.setItem(AUCTION_KEY, JSON.stringify(auctionRoot));
        signalAdFlush('auction-buffer-full');
        return;
      }
      queue.seq = Number(queue.seq || 0) + 1;
      queue.events.push({ s: queue.seq, t: Date.now(), type: type, theme: themeId });
      localStorage.setItem(AUCTION_KEY, JSON.stringify(auctionRoot));
      signalAdFlush('auction-' + type);
    } catch {}
  };
  const scheduleAuctionCompletion = (state) => {
    clearTimeout(auctionCompletionTimer);
    auctionCompletionTimer = 0;
    if (!targetedDelivery || state?.status !== 'active' || !Number.isFinite(Number(state?.dueAt))) return;
    const serverAdjustedNow = Date.now() + Number(state.clockOffsetMs || 0);
    const delay = Number(state.dueAt) - serverAdjustedNow;
    if (delay <= 0) { pushAuctionEvent('completion_check'); return; }
    auctionCompletionTimer = setTimeout(() => {
      const states = readAuctionRoot(AUCTION_STATE_KEY, { v: 1, auctions: {} });
      scheduleAuctionCompletion(states.auctions?.[targetedDelivery.auctionId]);
    }, Math.min(delay, 2147483647));
  };
  const updateAuctionState = (auction, serverNow) => {
    if (!targetedDelivery || !auction || auction.id !== targetedDelivery.auctionId) return;
    const states = readAuctionRoot(AUCTION_STATE_KEY, { v: 1, auctions: {} });
    if (!states.auctions || typeof states.auctions !== 'object') states.auctions = {};
    const observedAt = Date.now();
    const state = {
      status: String(auction.status || ''),
      dueAt: auction.due_at == null ? null : Number(auction.due_at),
      clockOffsetMs: Number.isFinite(Number(serverNow)) ? Number(serverNow) - observedAt : 0,
      updatedAt: observedAt,
    };
    states.auctions[targetedDelivery.auctionId] = state;
    try { localStorage.setItem(AUCTION_STATE_KEY, JSON.stringify(states)); } catch {}
    if (state.status === 'accepted') pushAuctionEvent('activation');
    else scheduleAuctionCompletion(state);
  };
  if (targetedDelivery) {
    const states = readAuctionRoot(AUCTION_STATE_KEY, { v: 1, auctions: {} });
    const state = states.auctions?.[targetedDelivery.auctionId];
    if (state?.status === 'active') scheduleAuctionCompletion(state);
    else if (!['fulfilled', 'settled'].includes(state?.status)) pushAuctionEvent('activation');
  }

  const openSponsor = (url) => { try { window.open(url, '_blank', 'noopener'); } catch {} };

  // L3-per-slot impression gate: hero present × window focused × slot ≥50%
  // visible × dwell ≥1s → one impression per view session (re-arms on re-entry).
  // Only-count-less-never-more: any gate failing just withholds the event.
  const slotState = new WeakMap();
  // "Already counted this view" is tracked per slot KIND, not per element, so a
  // React rebuild of the hero (which swaps in fresh elements) can't re-count an
  // uninterrupted view. A kind resets only on a genuine scroll-away (its live
  // element drops <50% visible WHILE still connected), never on the detach a
  // rebuild causes — that keeps impressions on the "count-less-never-more" side.
  const slotCounted = { kicker: false, greeting: false, tagline: false };
  const heroPresent = () => Boolean(document.querySelector('section[class*="home-suggestions"]'));
  const evalSlot = (el) => {
    const st = slotState.get(el);
    if (!st) return;
    if (campaignEnded) {
      st.armed = false;
      clearTimeout(st.timer);
      return;
    }
    const eligible = st.visible && document.hasFocus() && heroPresent();
    if (eligible && !st.armed) {
      st.armed = true;
      st.timer = setTimeout(() => {
        if (st.visible && document.hasFocus() && heroPresent() && !slotCounted[st.kind]) {
          slotCounted[st.kind] = true;
          recordSlotEvent('impression', st.kind);
        }
      }, 1000);
    } else if (!eligible) {
      st.armed = false;
      clearTimeout(st.timer);
      // Reset for a fresh impression only on a REAL scroll-away: the element is
      // still in the DOM but no longer visible. A detached element (hero rebuilt)
      // must NOT reset, or its replacement would double-count the same view.
      if (!st.visible && document.contains(el)) slotCounted[st.kind] = false;
    }
  };
  const reEvalSlots = () => { for (const el of document.querySelectorAll('.ctx-hero-slot')) evalSlot(el); };
  if (sponsor) {
    sponsorIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const st = slotState.get(e.target);
        if (!st) continue;
        st.visible = e.intersectionRatio >= 0.5;
        evalSlot(e.target);
      }
    }, { threshold: [0, 0.5, 1] });
  }

  const buildSponsorSlot = (kind, slot) => {
    const linked = Boolean(slot && slot.url);
    const el = document.createElement(linked ? 'a' : 'span');
    el.className = 'ctx-hero-slot ctx-hero-' + kind + (linked ? ' ctx-hero-link' : '');
    el.setAttribute('data-ctx-slot', kind);
    if (linked) {
      el.href = slot.url; el.target = '_blank'; el.rel = 'noreferrer';
      el.addEventListener('click', (e) => {
        // Navigate ONLY on an explicit click on a clearly-linked slot — never
        // auto/hover. preventDefault stops the app's in-app navigation; the
        // openSponsor call is the verified system-browser route.
        e.preventDefault(); e.stopPropagation();
        if (campaignEnded) return;
        recordSlotEvent('click', kind);
        openSponsor(slot.url);
      });
    }
    if (kind === 'kicker' && sponsor.disclosure) {
      const badge = document.createElement('span');
      badge.className = 'ctx-hero-badge';
      badge.textContent = sponsor.disclosure;
      el.appendChild(badge);
    }
    const label = document.createElement('span');
    label.className = 'ctx-hero-label';
    label.textContent = (slot && slot.text) || '';
    el.appendChild(label);
    slotState.set(el, { kind: kind, visible: false, armed: false, timer: 0 });
    if (sponsorIO) sponsorIO.observe(el);
    return el;
  };
  const campaignCopy = () => {
    // Codex currently leaves <html lang="en"> in place even when the Electron
    // renderer is running in Chinese. navigator.language is the locale that
    // drives the native UI, so prefer it and keep the document language only
    // as a fallback for older builds.
    const navigatorLang = typeof navigator !== 'undefined'
      ? ((Array.isArray(navigator.languages) && navigator.languages[0]) || navigator.language || '')
      : '';
    const lang = String(navigatorLang || document.documentElement.lang || '').toLowerCase();
    return lang.startsWith('zh')
      ? { badge: '投放已结束', detail: '此主题后续曝光不再产生收益', action: '更换可收益主题 →' }
      : { badge: 'Campaign ended', detail: 'Future impressions from this theme will not earn revenue', action: 'Choose an earning theme →' };
  };
  const applyCampaignCopy = (state) => {
    const copy = campaignCopy();
    const badge = state.querySelector('.ctx-campaign-state-badge');
    const detail = state.querySelector('.ctx-campaign-state-detail');
    const action = state.querySelector('.ctx-campaign-state-action');
    if (badge) badge.textContent = copy.badge;
    if (detail) detail.textContent = copy.detail;
    if (action) action.textContent = copy.action;
  };
  const ensureCampaignState = (box) => {
    let state = box.querySelector(':scope > .ctx-campaign-state');
    if (state) {
      applyCampaignCopy(state);
      return state;
    }
    state = document.createElement('div');
    state.className = 'ctx-campaign-state';
    state.setAttribute('role', 'status');
    const badge = document.createElement('span');
    badge.className = 'ctx-campaign-state-badge';
    const detail = document.createElement('span');
    detail.className = 'ctx-campaign-state-detail';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'ctx-campaign-state-action';
    action.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      if (campaignGalleryUrl) openSponsor(String(campaignGalleryUrl).replace(/\\\/+$/, '') + '/');
    });
    state.appendChild(badge);
    state.appendChild(detail);
    state.appendChild(action);
    box.appendChild(state);
    applyCampaignCopy(state);
    return state;
  };
  const syncCampaignState = () => {
    const box = document.querySelector('.ctx-sponsor-hero');
    if (!box || !sponsor) return;
    if (campaignEnded) box.classList.add('ctx-campaign-ended');
    else box.classList.remove('ctx-campaign-ended');
    ensureCampaignState(box);
    for (const el of box.querySelectorAll('.ctx-hero-link')) {
      const kind = el.getAttribute('data-ctx-slot');
      const url = sponsor.slots?.[kind]?.url;
      if (campaignEnded) {
        el.removeAttribute('href');
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('tabindex', '-1');
      } else if (url) {
        el.setAttribute('href', url);
        el.removeAttribute('aria-disabled');
        el.removeAttribute('tabindex');
      }
      const st = slotState.get(el);
      if (campaignEnded && st) { st.armed = false; clearTimeout(st.timer); }
    }
    if (!campaignEnded) reEvalSlots();
  };
  const updateCampaignStates = (states, galleryUrl) => {
    if (!sponsor || !Array.isArray(states)) return;
    const store = readCampaignStore();
    if (!store.campaigns || typeof store.campaigns !== 'object') store.campaigns = {};
    for (const state of states) {
      if (!state || typeof state.campaign !== 'string' || typeof state.status !== 'string') continue;
      store.campaigns[state.campaign] = {
        status: state.status,
        earning: state.earning === true,
        updatedAt: Date.now(),
      };
    }
    if (/^https?:\\/\\//i.test(String(galleryUrl || ''))) store.galleryUrl = String(galleryUrl).replace(/\\\/+$/, '');
    store.v = 1;
    try { localStorage.setItem(AD_CAMPAIGN_KEY, JSON.stringify(store)); } catch {}
    campaignStore = store;
    campaignGalleryUrl = store.galleryUrl || campaignGalleryUrl;
    campaignEnded = Boolean(sponsor.campaign && store.campaigns[sponsor.campaign]?.status === 'exhausted');
    syncCampaignState();
  };
  const buildSponsorHero = () => {
    const gs = document.querySelector('[data-feature="game-source"]');
    if (!gs || gs.querySelector(':scope > .ctx-sponsor-hero')) return;
    gs.classList.add('ctx-sponsored');
    const box = document.createElement('div');
    box.className = 'ctx-sponsor-hero';
    for (const kind of ['kicker', 'greeting', 'tagline']) {
      if (sponsor.slots[kind]) box.appendChild(buildSponsorSlot(kind, sponsor.slots[kind]));
    }
    gs.insertBefore(box, gs.firstChild);
    syncCampaignState();
  };
  const onPageHideFlush = () => {
    const s = readAdStore();
    if (s && Array.isArray(s.events) && s.events.length) signalAdFlush('normal-exit');
  };
  if (sponsor) {
    // active_day is CPM-only. A targeted delivery must not claim the shared
    // daily marker, or a CPM theme applied later that day would be undercounted.
    if (!targetedDelivery) {
      // One per local calendar day while a CPM ad theme is applied (L1 applied
      // retention signal). Fires on the day's first CPM payload load.
      try {
        const now = new Date();
        const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        if (localStorage.getItem(AD_DAY_KEY) !== today) {
          recordThemeEvent('active_day', themeId);
          localStorage.setItem(AD_DAY_KEY, today);
        }
      } catch {}
    }
    // Same settle-not-fight pattern as the copy engine: React repaints on
    // remount and wipes our node; the observer re-inserts it (idempotent).
    sponsorObserver = new MutationObserver(() => {
      if (sponsorTimer) return;
      sponsorTimer = setTimeout(() => { sponsorTimer = 0; buildSponsorHero(); }, 120);
    });
    sponsorObserver.observe(document.body, { childList: true, subtree: true });
    addEventListener('focus', reEvalSlots);
    addEventListener('blur', reEvalSlots);
    addEventListener('languagechange', syncCampaignState);
    document.addEventListener('visibilitychange', reEvalSlots);
    // Event-driven flush signal #2 (handoff §4): a graceful page unload asks
    // the host for one best-effort report while CDP can still read the buffer.
    // pagehide is the reliable one; beforeunload covers older paths. Crashes
    // and force-quits fire neither — startup catch-up owns those.
    addEventListener('pagehide', onPageHideFlush);
    addEventListener('beforeunload', onPageHideFlush);
    buildSponsorHero();
  }

  window.__ctxTheme = {
    version: ${PAYLOAD_VERSION},
    name: ${JSON.stringify(name)},
    setVar: applyVar,
    health,
    updateCampaignStates,
    updateAuctionState,
    remove(opts) {
      // switch_away: emitted by the AD theme's OWN teardown when leaving to a
      // different theme (opts.next) or to native (next === null). Idempotent
      // re-apply/tune passes the same id → no event. Standard themes never reach
      // this branch (sponsor is null), so they emit nothing on removal either.
      if (sponsor && opts && opts.next !== themeId) recordThemeEvent('switch_away', themeId);
      if (targetedDelivery && opts && opts.next !== themeId) pushAuctionEvent('deactivated');
      clearTimeout(auctionCompletionTimer);
      if (sponsorObserver) sponsorObserver.disconnect();
      clearTimeout(sponsorTimer);
      if (sponsorIO) sponsorIO.disconnect();
      removeEventListener('focus', reEvalSlots);
      removeEventListener('blur', reEvalSlots);
      removeEventListener('languagechange', syncCampaignState);
      document.removeEventListener('visibilitychange', reEvalSlots);
      removeEventListener('pagehide', onPageHideFlush);
      removeEventListener('beforeunload', onPageHideFlush);
      for (const n of document.querySelectorAll('.ctx-sponsor-hero')) n.remove();
      for (const n of document.querySelectorAll('.ctx-sponsored')) n.classList.remove('ctx-sponsored');
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
  return { ok: true, glassed: glassed.length, health: health() };
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

// --- host-side upload helpers (two-stage §四) -------------------------------
// Pure and exported so the batching/pruning logic is unit-tested without a live
// Codex (the CDP-dependent glue lives in the report command).

// Telemetry endpoint. Default OFF: no ADS_API_BASE anywhere → report is a no-op,
// so a self-made / open-source theme never phones home. The platform build (or
// a gallery install) supplies it via env or config.json.
function resolveAdsApiBase(env = process.env, configJson = null) {
  const fromEnv = typeof env?.ADS_API_BASE === 'string' ? env.ADS_API_BASE.trim() : '';
  if (fromEnv) return safeAdsApiBase(fromEnv);
  const fromConfig = typeof configJson?.adsApiBase === 'string' ? configJson.adsApiBase.trim() : '';
  return fromConfig ? safeAdsApiBase(fromConfig) : null;
}

// Oldest-first by monotonic seq; at most `max` events per batch (handoff §4).
function selectBatch(events, max = 10) {
  return [...events].sort((a, b) => a.s - b.s).slice(0, max);
}

// Keep only events the platform hasn't acknowledged. Events created DURING an
// upload get a higher seq than the batch, so they survive (never mis-deleted).
function pruneConfirmed(events, batchMaxSeq) {
  return (events ?? []).filter((e) => e.s > batchMaxSeq);
}

// Mirror the platform envelope validator closely enough to keep one legacy or
// tampered local event from poisoning an otherwise uploadable batch. Invalid
// events are never rewritten into a more billable shape: the report command
// moves them out of the bounded upload queue and records metadata-only local
// diagnostics instead.
function uploadEventIssue(event) {
  const eventTypes = new Set(['impression', 'click', 'listing_exposure', 'preview', 'install', 'active_day', 'switch_away']);
  const adTypes = new Set(['impression', 'click']);
  const slots = new Set(['kicker', 'greeting', 'tagline']);
  const keys = new Set(['s', 't', 'type', 'slot', 'campaign', 'theme', 'beneficiary']);
  const beneficiaryRe = /^[a-zA-Z0-9_-]{1,128}$/;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'event_not_object';
  if (!Number.isInteger(event.s) || event.s < 0) return 'invalid_seq';
  if (event.t !== undefined && (!Number.isInteger(event.t) || event.t < 0)) return 'invalid_timestamp';
  if (!eventTypes.has(event.type)) return 'invalid_type';
  if (event.slot !== undefined && !slots.has(event.slot)) return 'invalid_slot';
  if (adTypes.has(event.type) && !slots.has(event.slot)) return 'ad_event_missing_slot';
  if (event.campaign !== undefined && (typeof event.campaign !== 'string' || !event.campaign || event.campaign.length > 64))
    return 'invalid_campaign';
  if (event.theme !== undefined && (typeof event.theme !== 'string' || !event.theme || event.theme.length > 128))
    return 'invalid_theme';
  if (event.beneficiary !== undefined && (typeof event.beneficiary !== 'string' || !beneficiaryRe.test(event.beneficiary)))
    return 'invalid_beneficiary';
  if (event.beneficiary !== undefined && !adTypes.has(event.type)) return 'beneficiary_on_lifecycle_event';
  if (Object.keys(event).some((key) => !keys.has(key))) return 'unknown_field';
  return null;
}

function partitionUploadEvents(events) {
  const valid = [];
  const invalid = [];
  for (const event of Array.isArray(events) ? events : []) {
    const reason = uploadEventIssue(event);
    if (reason) invalid.push({ event, reason });
    else valid.push(event);
  }
  return { valid, invalid };
}

// Run the same partition against the LIVE renderer store so events appended
// after the host snapshot are preserved. Quarantine is deliberately metadata
// only: arbitrary legacy fields must never become a second telemetry store.
function quarantineInvalidEventsProgram(limit = 50) {
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  return `(() => { try {
    const storeKey = '__ctxAdEvents';
    const quarantineKey = '__ctxAdEventsQuarantine';
    const store = JSON.parse(localStorage.getItem(storeKey));
    if (!store || !Array.isArray(store.events)) return {
      ok: true, quarantined: 0, diagnosticsDropped: 0, remaining: 0
    };
    const issue = ${uploadEventIssue.toString()};
    const valid = [], diagnostics = [], at = Date.now();
    for (const event of store.events) {
      const reason = issue(event);
      if (!reason) valid.push(event);
      else diagnostics.push({ seq: Number.isInteger(event?.s) ? event.s : null, reason, quarantinedAt: at });
    }
    if (!diagnostics.length) return {
      ok: true, quarantined: 0, diagnosticsDropped: 0, remaining: valid.length
    };
    let previous = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(quarantineKey));
      if (parsed && Array.isArray(parsed.events)) previous = parsed.events.slice(-${boundedLimit}).flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const seq = entry.seq === null || Number.isInteger(entry.seq) ? entry.seq : null;
        const reason = typeof entry.reason === 'string' ? entry.reason.slice(0, 64) : 'unknown';
        const quarantinedAt = Number.isInteger(entry.quarantinedAt) && entry.quarantinedAt >= 0
          ? entry.quarantinedAt : at;
        return [{ seq, reason, quarantinedAt }];
      });
    } catch {}
    // Free the upload queue first. Writing diagnostics needs additional quota
    // and must never be allowed to keep a poisoned event uploadable forever.
    store.events = valid;
    localStorage.setItem(storeKey, JSON.stringify(store));
    let diagnosticsDropped = 0;
    try {
      // Drop the old value before rewriting it: this both purges unsanitized
      // legacy content and frees its quota for the bounded replacement.
      localStorage.removeItem(quarantineKey);
      localStorage.setItem(quarantineKey, JSON.stringify({
        v: 1, events: previous.concat(diagnostics).slice(-${boundedLimit})
      }));
    } catch {
      diagnosticsDropped = previous.length + diagnostics.length;
    }
    return { ok: true, quarantined: diagnostics.length, diagnosticsDropped, remaining: valid.length };
  } catch { return { ok: false, quarantined: 0, diagnosticsDropped: 0, remaining: null }; } })()`;
}

const CAMPAIGN_STATE_STATUSES = new Set(['pending', 'active', 'paused', 'exhausted', 'closed']);
const CAMPAIGN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function normalizeCampaignStates(value) {
  if (!Array.isArray(value)) return [];
  const states = new Map();
  for (const item of value.slice(0, 20)) {
    const campaign = typeof item?.campaign === 'string' ? item.campaign : '';
    const status = typeof item?.status === 'string' ? item.status : '';
    if (!CAMPAIGN_ID_RE.test(campaign) || !CAMPAIGN_STATE_STATUSES.has(status)) continue;
    states.set(campaign, { campaign, status, earning: status === 'active' && item.earning === true });
  }
  return [...states.values()];
}

async function readAdsConfig() {
  const home = process.env.CTX_HOME ?? path.join(os.homedir(), '.codex', 'codex-theme-x');
  try { return JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')); }
  catch { return null; }
}

async function rememberAdsApiBase(adsApiBase) {
  if (!adsApiBase) return;
  const home = process.env.CTX_HOME ?? path.join(os.homedir(), '.codex', 'codex-theme-x');
  await mkdir(home, { recursive: true });
  let config = {};
  try { config = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')); } catch {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  if (config.adsApiBase === adsApiBase) return;
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ ...config, adsApiBase }, null, 2) + '\n');
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));

  if (cmd === 'status') {
    const target = await findTarget(opts.port);
    const status = { port: opts.port, reachable: Boolean(target), injected: false, theme: null };
    if (target) {
      const cdp = await connectToCodex(opts.port);
      const t = await cdp.eval(`window.__ctxTheme ? {
        version: window.__ctxTheme.version,
        name: window.__ctxTheme.name,
        health: typeof window.__ctxTheme.health === 'function' ? window.__ctxTheme.health() : null
      } : null`);
      status.injected = Boolean(t);
      status.theme = t?.name ?? null;
      status.payloadVersion = t?.version ?? null;
      status.health = t?.health ?? null;
      cdp.close();
    }
    console.log(opts.json ? JSON.stringify(status) : [
      `CDP port ${status.port}: ${status.reachable ? 'reachable' : 'NOT reachable (start Codex with the debug flag)'}`,
      `background injected: ${status.injected ? `yes (${status.theme})` : 'no'}`,
      status.health ? `main surface: ${status.health.mainSurfaceApplied ? 'matches theme opacity' : 'OPAQUE / selector mismatch'} (${status.health.mainBackground})` : null,
    ].filter(Boolean).join('\n'));
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
      sponsor: theme.sponsor,
      distribution: theme.distribution,
      themeId: theme.id,
      modeVars: theme.modeVars,
    });
    const result = await cdp.eval(program);
    cdp.close();
    await rememberAdsApiBase(theme.distribution?.adsApiBase);
    const sponsorNote = theme.type === 'sponsored'
      ? `, sponsored: ${Object.values(theme.sponsor.slots).filter(Boolean).length} slot(s)`
      : '';
    console.log(`applied "${theme.name}" (glass containers: ${result.glassed}${sponsorNote})`);
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
    // next: null → leaving to native; an ad payload emits switch_away on teardown.
    const removed = await cdp.eval('window.__ctxTheme ? (window.__ctxTheme.remove({ next: null }), true) : false');
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

  if (cmd === 'events') {
    // Host-side collection point of the two-stage pipeline: read (and optionally
    // clear) the renderer's localStorage event buffer and summarize per slot.
    const cdp = await connectToCodex(opts.port) ?? fail('Codex CDP port not reachable', 2);
    const store = await cdp.eval(`(() => { try { return JSON.parse(localStorage.getItem('__ctxAdEvents')); } catch { return null; } })()`);
    // Clear drains only the events (called after a successful upload). installId
    // and the monotonic seq are preserved so identity survives across upload
    // cycles — resetting them would break frequency-capping and server dedupe.
    if (opts.clear) await cdp.eval(`(() => { try {
      const s = JSON.parse(localStorage.getItem('__ctxAdEvents'));
      if (s) { s.events = []; localStorage.setItem('__ctxAdEvents', JSON.stringify(s)); }
    } catch {} })()`);
    cdp.close();
    const events = store?.events ?? [];
    const perSlot = {};   // impression/click → per-slot CTR
    const themeEvents = {}; // active_day/switch_away → counts
    for (const e of events) {
      if (e.type === 'impression' || e.type === 'click') {
        const k = e.slot ?? 'unknown';
        (perSlot[k] ??= { impression: 0, click: 0 })[e.type] = (perSlot[k][e.type] ?? 0) + 1;
      } else {
        themeEvents[e.type] = (themeEvents[e.type] ?? 0) + 1;
      }
    }
    const summary = {
      installId: store?.installId ?? null,
      total: events.length,
      slots: Object.fromEntries(Object.entries(perSlot).map(([k, v]) => {
        const ctr = v.impression ? +(v.click / v.impression).toFixed(3) : null;
        return [k, { ...v, ctr }];
      })),
      theme: themeEvents,
      cleared: opts.clear,
    };
    if (opts.json) { console.log(JSON.stringify(summary)); return; }
    console.log(`install ${summary.installId ?? '(none)'} · ${summary.total} events${opts.clear ? ' (buffer cleared)' : ''}`);
    for (const [slot, v] of Object.entries(summary.slots)) {
      console.log(`  ${slot.padEnd(9)} impressions=${v.impression}  clicks=${v.click}  ctr=${v.ctr ?? '—'}`);
    }
    for (const [type, n] of Object.entries(summary.theme)) {
      console.log(`  ${type.padEnd(12)} ${n}`);
    }
    if (!Object.keys(summary.slots).length && !Object.keys(summary.theme).length) {
      console.log('  no events yet');
    }
    return;
  }

  if (cmd === 'flush-signal') {
    // The keeper's event-driven flush bridge, host end: atomically read-and-
    // clear the renderer's one-shot flush flag and print it as JSON (null when
    // no signal is pending). Deliberately a FIXED probe — not a general eval —
    // so the host's only renderer read beyond events/report is this one flag.
    const cdp = await connectToCodex(opts.port) ?? fail('Codex CDP port not reachable', 2);
    const value = await cdp.eval(`(() => { try {
      const k = '__ctxAdFlush';
      const raw = localStorage.getItem(k);
      if (!raw) return null;
      localStorage.removeItem(k);
      return JSON.parse(raw);
    } catch { return null; } })()`);
    cdp.close();
    console.log(JSON.stringify(value ?? null));
    return;
  }

  if (cmd === 'report') {
    // Host-side leg of the two-stage pipeline: read the renderer's localStorage
    // buffer, POST batches to /api/ingest, and prune only what the platform
    // acknowledged. Default OFF: no ADS_API_BASE → no-op (privacy default).
    const base = resolveAdsApiBase(process.env, await readAdsConfig());
    if (!base) {
      const msg = 'telemetry disabled (no ADS_API_BASE); nothing uploaded';
      console.log(opts.json ? JSON.stringify({ disabled: true, uploaded: 0 }) : msg);
      return;
    }
    // Mutually exclusive upload: resident keeper, launchd oneshot, and a manual
    // run can overlap. The platform dedupes by (installId, s) so a race would
    // only waste a batch, but the lock makes "one report at a time" explicit.
    // O_EXCL create; stale lock from a crashed process is retried after 60s.
    const home = process.env.CTX_HOME ?? path.join(os.homedir(), '.codex', 'codex-theme-x');
    const lockPath = path.join(home, 'report.lock');
    const lockAgeMs = 60000;
    let lockFd = null;
    try {
      await mkdir(home, { recursive: true });
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > lockAgeMs) await unlink(lockPath);
      } catch { /* no lock yet */ }
      lockFd = await open(lockPath, 'wx');
      await lockFd.writeFile(String(process.pid));
    } catch {
      console.log(opts.json ? JSON.stringify({ skipped: 'locked', uploaded: 0 }) : 'another report is running; skipped');
      return;
    }
    try {
      await report(base, opts);
    } catch (err) {
      if (lockFd) await lockFd.close();
      await unlink(lockPath).catch(() => {});
      lockFd = null;
      fail(err.message, 3);
    } finally {
      if (lockFd) await lockFd.close();
      await unlink(lockPath).catch(() => {});
    }
    return;
  }

  fail(`unknown command "${cmd ?? ''}" (status|apply|tune|remove|reload|screenshot|events|flush-signal|report)`);
}

// The upload loop proper, run under the report lock. Reads the renderer's
// buffer over CDP, quarantines locally-invalid legacy events, POSTs ≤10-event
// batches oldest-first, and prunes only what the platform acknowledged (events
// arriving mid-upload have a higher seq and survive). A failed valid batch
// leaves that batch untouched for the next trigger.
async function report(base, opts) {
  const cdp = await connectToCodex(opts.port) ?? fail('Codex CDP port not reachable', 2);
  const readStore = () => cdp.eval(`(() => { try { return JSON.parse(localStorage.getItem('__ctxAdEvents')); } catch { return null; } })()`);
  const readAuctionStore = () => cdp.eval(`(() => { try { return JSON.parse(localStorage.getItem('__ctxAuctionEvents')); } catch { return null; } })()`);
  const totals = {
    uploaded: 0, accepted: 0, duplicates: 0, eligible: 0, batches: 0,
    quarantined: 0, quarantineDiagnosticsDropped: 0,
    auctionUploaded: 0, auctionAccepted: 0, auctionDuplicates: 0, auctionBatches: 0,
  };
  const campaignStates = new Map();
  let auctionRoot = await readAuctionStore();
  for (const auctionId of Object.keys(auctionRoot?.queues || {}).sort()) {
    let queue = auctionRoot.queues[auctionId];
    while (queue && Array.isArray(queue.events) && queue.events.length) {
      const batch = selectBatch(queue.events, 10);
      const endpoint = safeAdsApiBase(queue.adsApiBase) || base;
      let resp;
      try {
        const response = await fetch(`${endpoint}/api/auction-events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            v: 1, auctionId: queue.auctionId,
            installId: queue.installId, events: batch,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        resp = await response.json();
      } catch (error) {
        cdp.close();
        throw new Error(`auction upload failed (buffer kept): ${error.message}`);
      }
      const batchMaxSeq = batch[batch.length - 1].s;
      await cdp.eval(`(() => { try {
        const root = JSON.parse(localStorage.getItem('__ctxAuctionEvents'));
        const queue = root?.queues?.[${JSON.stringify(auctionId)}];
        if (queue) {
          queue.events = (queue.events || []).filter((event) => event.s > ${batchMaxSeq});
          localStorage.setItem('__ctxAuctionEvents', JSON.stringify(root));
        }
        const auction = ${JSON.stringify(resp.auction || null)};
        const serverNow = ${JSON.stringify(resp.receivedAt || null)};
        if (auction && auction.id) {
          let states = { v: 1, auctions: {} };
          try {
            const parsed = JSON.parse(localStorage.getItem('__ctxAuctionStates'));
            if (parsed && typeof parsed === 'object') states = parsed;
          } catch {}
          if (!states.auctions || typeof states.auctions !== 'object') states.auctions = {};
          const observedAt = Date.now();
          states.auctions[auction.id] = {
            status: String(auction.status || ''),
            dueAt: auction.due_at == null ? null : Number(auction.due_at),
            clockOffsetMs: Number.isFinite(Number(serverNow)) ? Number(serverNow) - observedAt : 0,
            updatedAt: observedAt,
          };
          localStorage.setItem('__ctxAuctionStates', JSON.stringify(states));
        }
        if (window.__ctxTheme && typeof window.__ctxTheme.updateAuctionState === 'function') {
          window.__ctxTheme.updateAuctionState(auction, serverNow);
        }
      } catch {} })()`);
      totals.auctionUploaded += batch.length;
      totals.auctionAccepted += Number(resp.accepted || 0);
      totals.auctionDuplicates += Number(resp.duplicates || 0);
      totals.auctionBatches += 1;
      auctionRoot = await readAuctionStore();
      queue = auctionRoot?.queues?.[auctionId];
      if (queue && Array.isArray(queue.events) && queue.events.some((event) => event.s <= batchMaxSeq)) break;
    }
  }
  let store = await readStore();
  while (store && Array.isArray(store.events) && store.events.length) {
    const quarantine = await cdp.eval(quarantineInvalidEventsProgram());
    if (!quarantine?.ok) {
      cdp.close();
      throw new Error('local quarantine failed (buffer kept)');
    }
    totals.quarantined += Number(quarantine?.quarantined || 0);
    totals.quarantineDiagnosticsDropped += Number(quarantine?.diagnosticsDropped || 0);
    store = await readStore();
    if (!store || !Array.isArray(store.events) || !store.events.length) break;
    const before = store.events.length;
    const batch = selectBatch(store.events, 10);
    const envelope = { v: store.v ?? 1, installId: store.installId, seq: store.seq ?? 0, events: batch };
    let resp;
    try {
      const r = await fetch(`${base}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      resp = await r.json();
    } catch (err) {
      cdp.close();
      // Buffer kept intact — a failed batch is retried on the next run. Throw
      // (not fail()) so the caller's finally releases the report lock first.
      throw new Error(`upload failed (buffer kept): ${err.message}`);
    }
    const acknowledgedStates = normalizeCampaignStates(resp.campaignStates);
    for (const state of acknowledgedStates) campaignStates.set(state.campaign, state);
    // Success: persist Campaign state and prune acknowledged events (s ≤ batch
    // max) from the LIVE store in one renderer turn. If Codex disappears before
    // this runs, the buffer remains and the next idempotent retry gets the same
    // authoritative state again.
    const batchMaxSeq = batch[batch.length - 1].s;
    await cdp.eval(`(() => { try {
      if (window.__ctxTheme && typeof window.__ctxTheme.updateCampaignStates === 'function') {
        window.__ctxTheme.updateCampaignStates(${JSON.stringify(acknowledgedStates)}, ${JSON.stringify(base)});
      }
      const s = JSON.parse(localStorage.getItem('__ctxAdEvents'));
      if (!s) return;
      s.events = (s.events || []).filter((e) => e.s > ${batchMaxSeq});
      localStorage.setItem('__ctxAdEvents', JSON.stringify(s));
    } catch {} })()`);
    totals.uploaded += batch.length;
    totals.accepted += resp.accepted ?? 0;
    totals.duplicates += resp.duplicates ?? 0;
    totals.eligible += resp.eligible ?? 0;
    totals.batches += 1;
    store = await readStore();
    // Safety: if the prune didn't shrink the buffer, stop rather than loop.
    if (store && Array.isArray(store.events) && store.events.length >= before) break;
  }
  cdp.close();
  totals.campaignStates = [...campaignStates.values()];
  if (opts.json) { console.log(JSON.stringify(totals)); return; }
  console.log(`uploaded ${totals.uploaded} CPM event(s) and ${totals.auctionUploaded} auction event(s) → CPM accepted=${totals.accepted} auction accepted=${totals.auctionAccepted} duplicates=${totals.duplicates + totals.auctionDuplicates} quarantined=${totals.quarantined}`);
}

export {
  loadTheme, loadDistribution, buildCss, rendererProgram, safeHomePosition, selectTarget,
  resolveAdsApiBase, selectBatch, pruneConfirmed, normalizeCampaignStates,
  uploadEventIssue, partitionUploadEvents, quarantineInvalidEventsProgram,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(err.message));
}

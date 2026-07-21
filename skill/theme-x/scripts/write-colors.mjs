#!/usr/bin/env node
// codex-theme-x color writer — persists a theme's colors through the OFFICIAL
// Codex appearance system (config.toml), so colors survive app restarts with
// zero injection. Line-based TOML surgery, no dependencies.
//
// The app reads config.toml at startup only, and rewrites it itself when the
// user changes settings — so callers (apply.sh) must run this while Codex is
// quitting/closed. This script only does the file work.
//
// Usage:
//   node write-colors.mjs apply   --theme <dir> [--config <path>]
//   node write-colors.mjs restore [--config <path>]
//   node write-colors.mjs export  --theme <dir>       # codex-theme-v1 string
//
// State kept under ~/.codex/codex-theme-x/:
//   backups/config-<ts>.toml     full-file backup before every write
//   appearance-original.toml     the pristine appearance state (first run only)

import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const STATE_DIR = path.join(os.homedir(), '.codex', 'codex-theme-x');
const DEFAULT_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');

function fail(msg, code = 1) { console.error(`write-colors.mjs: ${msg}`); process.exit(code); }

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { config: DEFAULT_CONFIG, setMode: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--theme') opts.theme = rest[++i];
    else if (rest[i] === '--config') opts.config = rest[++i];
    else if (rest[i] === '--set-mode') opts.setMode = true;
    else if (rest[i] === '--mode') opts.mode = rest[++i];
    else fail(`unknown option: ${rest[i]}`);
  }
  return { cmd, opts };
}

function validateOfficial(o, where) {
  for (const key of ['accent', 'ink', 'surface']) {
    if (!/^#[0-9a-fA-F]{6}$/.test(o[key] ?? '')) fail(`theme.json: ${where}.${key} must be a 6-digit hex color`);
  }
  return o;
}

async function loadTheme(themeDir) {
  const theme = JSON.parse(await readFile(path.join(themeDir, 'theme.json'), 'utf8'));
  if (theme.schema !== 'codextheme/1') fail('theme.json: expected "schema": "codextheme/1"');
  const name = theme.name ?? theme.id;
  // "auto" = dual-mode pack: both palettes live under modes.{light,dark} and
  // BOTH chrome tables get written, so the theme follows the user's light/dark
  // mode with no re-apply. "dark"/"light" = single-mode (one table).
  if (theme.variant === 'auto' && theme.modes?.light && theme.modes?.dark) {
    return {
      variant: 'auto',
      officialLight: validateOfficial(theme.modes.light.official ?? {}, 'modes.light.official'),
      officialDark: validateOfficial(theme.modes.dark.official ?? {}, 'modes.dark.official'),
      name,
    };
  }
  const variant = theme.variant === 'light' ? 'light' : 'dark';
  return { variant, official: validateOfficial(theme.official ?? {}, 'official'), name };
}

// --------------------------------------------------------- TOML line surgery

// Split into lines; a "table" starts at a `[header]` line and runs until the
// next header. Top-of-file keys (before any header) belong to the root table.
function tableRanges(lines) {
  const ranges = []; // { header: 'desktop', start, end } — end exclusive
  let current = { header: '', start: 0 };
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (m) {
      ranges.push({ ...current, end: i });
      current = { header: m[1].trim(), start: i };
    }
  }
  ranges.push({ ...current, end: lines.length });
  return ranges;
}

function removeTables(lines, prefix) {
  const keep = [];
  for (const r of tableRanges(lines)) {
    const h = r.header;
    if (h === prefix || h.startsWith(`${prefix}.`)) continue;
    keep.push(...lines.slice(r.start, r.end));
  }
  return keep;
}

function extractTables(lines, prefix) {
  const out = [];
  for (const r of tableRanges(lines)) {
    if (r.header === prefix || r.header.startsWith(`${prefix}.`)) {
      out.push(...lines.slice(r.start, r.end));
    }
  }
  return out;
}

// Set key = value inside [table]; insert the key (or the table) if missing.
function setKey(lines, table, key, tomlValue) {
  const ranges = tableRanges(lines);
  const r = ranges.find((x) => x.header === table);
  if (!r) return [...lines, '', `[${table}]`, `${key} = ${tomlValue}`];
  const body = lines.slice(r.start, r.end);
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const idx = body.findIndex((l) => keyRe.test(l));
  if (idx >= 0) body[idx] = `${key} = ${tomlValue}`;
  else body.splice(1, 0, `${key} = ${tomlValue}`); // right after the header
  return [...lines.slice(0, r.start), ...body, ...lines.slice(r.end)];
}

function getKey(lines, table, key) {
  const r = tableRanges(lines).find((x) => x.header === table);
  if (!r) return null;
  const keyRe = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`);
  for (const line of lines.slice(r.start, r.end)) {
    const m = keyRe.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

function chromeThemeTables(variant, o) {
  const table = `desktop.appearance${variant === 'light' ? 'Light' : 'Dark'}ChromeTheme`;
  const sem = o.semanticColors ?? {};
  const fonts = o.fonts ?? {};
  const lines = [
    `[${table}]`,
    `accent = "${o.accent}"`,
    `contrast = ${Number.isFinite(o.contrast) ? o.contrast : 60}`,
    `ink = "${o.ink}"`,
    `opaqueWindows = ${o.opaqueWindows === true}`,
    `surface = "${o.surface}"`,
    '',
    `[${table}.fonts]`,
    ...Object.entries(fonts).filter(([, v]) => v).map(([k, v]) => `${k} = "${v}"`),
    '',
    `[${table}.semanticColors]`,
    ...Object.entries(sem).map(([k, v]) => `${k} = "${v}"`),
  ];
  return { table, lines };
}

// ------------------------------------------------------------------ commands

async function backup(configPath) {
  const dir = path.join(STATE_DIR, 'backups');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `config-${stamp}.toml`);
  await copyFile(configPath, dest);
  return dest;
}

async function snapshotOriginal(lines) {
  const file = path.join(STATE_DIR, 'appearance-original.toml');
  try { await access(file); return; } catch { /* first run — take the snapshot */ }
  await mkdir(STATE_DIR, { recursive: true });
  const appearanceTheme = getKey(lines, 'desktop', 'appearanceTheme') ?? '"system"';
  const original = [
    `# Pristine appearance state captured by codex-theme-x before its first write.`,
    `# Used by \`restore\`. Do not edit.`,
    `[desktop]`,
    `appearanceTheme = ${appearanceTheme}`,
    '',
    ...extractTables(lines, 'desktop.appearanceDarkChromeTheme'),
    '',
    ...extractTables(lines, 'desktop.appearanceLightChromeTheme'),
  ];
  await writeFile(file, original.join('\n') + '\n');
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));

  if (cmd === 'export') {
    if (!opts.theme) fail('export requires --theme <dir>');
    const loaded = await loadTheme(opts.theme);
    // The official.txt one-liner is a single-mode color string (for people
    // without the tool). An auto theme has two palettes; emit the dark one by
    // default (override with --mode light).
    const variant = loaded.variant === 'auto' ? (opts.mode === 'light' ? 'light' : 'dark') : loaded.variant;
    const o = loaded.variant === 'auto'
      ? (variant === 'light' ? loaded.officialLight : loaded.officialDark)
      : loaded.official;
    const payload = {
      codeThemeId: o.codeThemeId ?? 'one', // custom ids are rejected by the importer; reuse a built-in id
      theme: {
        accent: o.accent,
        contrast: Number.isFinite(o.contrast) ? o.contrast : 60,
        fonts: { code: o.fonts?.code ?? null, ui: o.fonts?.ui ?? null },
        ink: o.ink,
        opaqueWindows: o.opaqueWindows === true,
        semanticColors: o.semanticColors ?? {},
        surface: o.surface,
      },
      variant,
    };
    console.log(`codex-theme-v1:${JSON.stringify(payload)}`);
    return;
  }

  if (cmd === 'apply') {
    if (!opts.theme) fail('apply requires --theme <dir>');
    const loaded = await loadTheme(opts.theme);
    const { variant, name } = loaded;
    const text = await readFile(opts.config, 'utf8');
    let lines = text.split('\n');

    await snapshotOriginal(lines);
    const backupPath = await backup(opts.config);

    // auto → write BOTH chrome tables (the theme follows whatever mode the user
    // is in). single-mode → write just the one. Mode follows the USER, not the
    // image: a theme apply never flips the app's light/dark mode (that made
    // every image swap bounce the whole UI); --set-mode opts back in.
    const written = variant === 'auto'
      ? [chromeThemeTables('light', loaded.officialLight), chromeThemeTables('dark', loaded.officialDark)]
      : [chromeThemeTables(variant, loaded.official)];
    for (const w of written) lines = removeTables(lines, w.table);

    const currentMode = (getKey(lines, 'desktop', 'appearanceTheme') ?? '"system"').replace(/"/g, '');
    if (opts.setMode && variant !== 'auto') {
      lines = setKey(lines, 'desktop', 'appearanceTheme', `"${variant}"`);
    }
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    for (const w of written) lines.push('', ...w.lines);
    lines.push('');

    await writeFile(opts.config, lines.join('\n'));
    console.log(`colors written for "${name}" (${variant}); backup: ${backupPath}`);
    if (variant === 'auto') {
      console.log('note: auto theme — both light and dark palettes written; follows the app mode automatically.');
    } else if (!opts.setMode && currentMode !== variant) {
      console.log(currentMode === 'system'
        ? `note: appearanceTheme is "system" — the palette shows whenever the app is in ${variant} mode.`
        : `note: app mode stays "${currentMode}"; this palette targets ${variant} mode and will not be visible until the mode matches. Adapt the palette to ${currentMode} or pass --set-mode if the user explicitly wants the flip.`);
    }
    console.log('note: Codex reads config.toml at startup — restart the app to see them.');
    return;
  }

  if (cmd === 'restore') {
    const file = path.join(STATE_DIR, 'appearance-original.toml');
    let original;
    try { original = (await readFile(file, 'utf8')).split('\n'); } catch { fail('no pristine snapshot found; nothing to restore'); }
    const text = await readFile(opts.config, 'utf8');
    let lines = text.split('\n');
    const backupPath = await backup(opts.config);

    lines = removeTables(lines, 'desktop.appearanceDarkChromeTheme');
    lines = removeTables(lines, 'desktop.appearanceLightChromeTheme');
    // appearanceTheme is deliberately NOT restored: mode belongs to the user
    // (apply never touches it), and the pristine snapshot's value goes stale
    // the moment they change modes themselves. A --set-mode flip was an
    // explicit user request, so it stays too.
    const restoredTables = [
      ...extractTables(original, 'desktop.appearanceDarkChromeTheme'),
      '',
      ...extractTables(original, 'desktop.appearanceLightChromeTheme'),
    ].filter((l, i, a) => !(l.trim() === '' && a[i - 1]?.trim() === ''));
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (restoredTables.some((l) => l.trim())) lines.push('', ...restoredTables);
    lines.push('');

    await writeFile(opts.config, lines.join('\n'));
    console.log(`original appearance restored; backup of current state: ${backupPath}`);
    return;
  }

  fail(`unknown command "${cmd ?? ''}" (apply|restore|export)`);
}

main().catch((err) => fail(err.message));

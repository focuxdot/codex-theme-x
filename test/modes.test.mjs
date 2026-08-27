import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildCss, loadTheme, rendererProgram } from '../skill/theme-x/scripts/inject.mjs';

const WRITE_COLORS = new URL('../skill/theme-x/scripts/write-colors.mjs', import.meta.url).pathname;

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function autoFixture(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-modes-'));
  writeFileSync(path.join(dir, 'background.png'), pixel);
  const theme = {
    schema: 'codextheme/1',
    id: 'auto-test',
    name: 'Auto Test',
    variant: 'auto',
    background: { file: 'background.png', sidebarBlur: 40, glassBlur: 20 },
    modes: {
      light: {
        official: { surface: '#F2EFE7', ink: '#232527', accent: '#B13B24', contrast: 58 },
        background: { sidebarOpacity: 0.6, laneOpacity: 0.45, dim: 1 },
      },
      dark: {
        official: { surface: '#0D1B2A', ink: '#F3F9FF', accent: '#41B6F3', contrast: 68 },
        background: { sidebarOpacity: 0.85, laneOpacity: 0.62, dim: 0.72 },
      },
    },
    ...extra,
  };
  writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme));
  return dir;
}

function singleFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-single-'));
  writeFileSync(path.join(dir, 'background.png'), pixel);
  writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({
    schema: 'codextheme/1',
    id: 'single-test',
    name: 'Single Test',
    variant: 'dark',
    official: { surface: '#0D1B2A', ink: '#F3F9FF', accent: '#41B6F3' },
    background: { file: 'background.png', sidebarOpacity: 0.7, laneOpacity: 0.5, dim: 0.8 },
  }));
  return dir;
}

test('auto theme resolves both palettes + per-mode densities, seeded from dark', async () => {
  const t = await loadTheme(autoFixture());
  assert.equal(t.variant, 'auto');
  // Static seed = the dark set (syncMode overrides live on inject).
  assert.equal(t.surface, '#0D1B2A');
  assert.equal(t.accent, '#41B6F3');
  // Per-mode density sets differ and merge the shared top-level background.
  assert.equal(t.modeVars.light.vars.sidebarOpacity, 0.6);
  assert.equal(t.modeVars.dark.vars.sidebarOpacity, 0.85);
  assert.equal(t.modeVars.light.vars.dim, 1);
  assert.equal(t.modeVars.dark.vars.dim, 0.72);
  assert.equal(t.modeVars.light.accent, '#B13B24');
  assert.equal(t.modeVars.dark.accent, '#41B6F3');
  // Shared blur flows into both merged sets.
  assert.equal(t.modeVars.light.vars.sidebarBlur, 40);
  assert.equal(t.modeVars.dark.vars.sidebarBlur, 40);
});

test('rendererProgram embeds a live per-mode density swap for an auto theme', async () => {
  const t = await loadTheme(autoFixture());
  const program = rendererProgram({
    css: '', backgroundDataUrl: t.backgroundDataUrl, homeDataUrl: t.home.dataUrl,
    accentRemap: null, name: t.name, copy: t.copy, sponsor: t.sponsor, themeId: t.id,
    modeVars: t.modeVars,
  });
  assert.match(program, /const MODE_VARS = /);          // both maps embedded
  assert.match(program, /if \(mv\) for \(const k in mv\) applyVar\(k, mv\[k\]\)/); // swap loop
  // both modes' sidebar densities are present in the embedded maps
  assert.match(program, /"--ctx-side-a":"0\.6"/);
  assert.match(program, /"--ctx-side-a":"0\.85"/);
  // per-mode accent swap
  assert.match(program, /"--ctx-accent-rgb":"177, 59, 36"/); // #B13B24 light
  assert.match(program, /mainSurfaceApplied/);
  assert.match(program, /expectedPanelOpacity/);
  assert.match(program, /sidebarSurfaceApplied/);
  assert.match(program, /composerSurfaceApplied/);
  assert.match(program, /floatingSurfaceApplied/);
  assert.match(program, /bottomMaskClear/);
});

test('main surface glass targets the semantic landmark, not a volatile Codex class', async () => {
  const css = buildCss(await loadTheme(autoFixture()));
  assert.match(css, /:root\.ctx-themed main \{/);
  assert.doesNotMatch(css, /main\.main-surface/);
});

test('glass CSS supports current and legacy composer and floating-panel hooks', async () => {
  const css = buildCss(await loadTheme(autoFixture()));
  assert.match(css, /\.composer-surface-chrome,/);
  assert.match(css, /\[data-composer-surface-variant\]/);
  assert.match(css, /\.bg-token-dropdown-background,/);
  assert.match(css, /\[class~="electron:elevation-prominent"\]\.bg-surface-elevated-secondary/);
});

test('bottom scroll mask is removed for current and legacy Codex utility names', async () => {
  const css = buildCss(await loadTheme(autoFixture()));
  assert.match(css, /\.bg-gradient-to-t\[class\*="from-token-main-surface"\],/);
  assert.match(css, /\.bg-gradient-to-t\.from-surface\.via-surface/);
  assert.match(css, /background-image: none !important/);
});

test('single-mode theme yields identical light/dark sets (swap is a no-op)', async () => {
  const t = await loadTheme(singleFixture());
  assert.equal(t.variant, 'dark');
  assert.deepEqual(t.modeVars.light.vars, t.modeVars.dark.vars);
  assert.equal(t.modeVars.light.vars.sidebarOpacity, 0.7);
  assert.equal(t.modeVars.light.accent, t.modeVars.dark.accent);
});

test('write-colors apply writes BOTH chrome tables for an auto theme', () => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'ctx-state-'));
  const cfg = path.join(state, 'config.toml');
  writeFileSync(cfg, '[desktop]\nappearanceTheme = "light"\n');
  const themeDir = autoFixture();
  execFileSync(process.execPath, [WRITE_COLORS, 'apply', '--theme', themeDir, '--config', cfg],
    { stdio: 'pipe', env: { ...process.env, CTX_HOME: state } });
  const out = readFileSync(cfg, 'utf8');
  assert.match(out, /\[desktop\.appearanceLightChromeTheme\]/);
  assert.match(out, /\[desktop\.appearanceDarkChromeTheme\]/);
  assert.match(out, /surface = "#F2EFE7"/); // light palette
  assert.match(out, /surface = "#0D1B2A"/); // dark palette
});

test('write-colors export defaults to the dark palette for an auto theme', () => {
  const themeDir = autoFixture();
  const dark = execFileSync(process.execPath, [WRITE_COLORS, 'export', '--theme', themeDir], { encoding: 'utf8' });
  assert.match(dark, /"surface":"#0D1B2A"/);
  assert.match(dark, /"variant":"dark"/);
  const light = execFileSync(process.execPath, [WRITE_COLORS, 'export', '--theme', themeDir, '--mode', 'light'], { encoding: 'utf8' });
  assert.match(light, /"surface":"#F2EFE7"/);
  assert.match(light, /"variant":"light"/);
});

test('auto theme with a malformed modes palette fails to load (write-colors)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-bad-'));
  writeFileSync(path.join(dir, 'background.png'), pixel);
  writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({
    schema: 'codextheme/1', id: 'bad', name: 'Bad', variant: 'auto',
    background: { file: 'background.png' },
    modes: {
      light: { official: { surface: 'not-a-hex', ink: '#232527', accent: '#B13B24' } },
      dark: { official: { surface: '#0D1B2A', ink: '#F3F9FF', accent: '#41B6F3' } },
    },
  }));
  assert.throws(() => execFileSync(process.execPath, [WRITE_COLORS, 'export', '--theme', dir], { stdio: 'pipe' }));
});

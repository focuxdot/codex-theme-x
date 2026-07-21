import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCss, loadTheme, rendererProgram, safeHomePosition } from '../skill/theme-x/scripts/inject.mjs';

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function fixture(home = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-home-'));
  writeFileSync(path.join(dir, 'background.png'), pixel);
  writeFileSync(path.join(dir, 'hero.png'), pixel);
  writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({
    schema: 'codextheme/1',
    id: 'home-test',
    name: 'Home Test',
    variant: 'dark',
    official: { surface: '#10173a', ink: '#e6edf7', accent: '#2ee6a8', contrast: 60 },
    background: { file: 'background.png' },
    home,
  }));
  return dir;
}

test('home theme accepts a separate hero asset and bounded presentation values', async () => {
  const theme = await loadTheme(fixture({
    file: 'hero.png',
    height: 999,
    focalPoint: '83% center',
    overlay: -1,
    cardOpacity: 2,
    kicker: 'My Workspace',
    tagline: 'Make the empty state feel intentional.',
  }));

  assert.notEqual(theme.backgroundDataUrl, undefined);
  assert.notEqual(theme.home.dataUrl, undefined);
  assert.equal(theme.home.height, 360);
  assert.equal(theme.home.focalPoint, '83% center');
  assert.equal(theme.home.overlay, 0);
  assert.equal(theme.home.cardOpacity, 1);

  const css = buildCss(theme);
  assert.match(css, /--ctx-home-hero-h: 360px/);
  assert.match(css, /--ctx-home-art-pos: 83% center/);
  assert.match(css, /home-suggestions/);
  assert.match(css, /var\(--ctx-home-art\)/);
  assert.doesNotMatch(css, /data:image\/png;base64/);

  const program = rendererProgram({
    css,
    backgroundDataUrl: theme.backgroundDataUrl,
    homeDataUrl: theme.home.dataUrl,
    accentRemap: theme.accent,
    name: theme.name,
  });
  assert.match(program, /--ctx-bg-art/);
  assert.match(program, /--ctx-home-art/);
  assert.match(program, /URL\.revokeObjectURL/);
});

test('home focal point only accepts the supported CSS position subset', () => {
  assert.equal(safeHomePosition('right center'), 'right center');
  assert.equal(safeHomePosition('72.5% 40%'), '72.5% 40%');
  assert.equal(safeHomePosition('center; color: red'), '72% center');
});

test('codextheme packing includes an optional separate home hero', () => {
  const dir = fixture({ file: 'hero.png' });
  const out = path.join(dir, 'home-test.codextheme');
  const packer = path.resolve('skill/theme-x/scripts/pack.mjs');
  execFileSync(process.execPath, [packer, 'pack', '--theme', dir, '--out', out]);
  const files = execFileSync('/usr/bin/unzip', ['-Z1', out]).toString().trim().split('\n');
  assert.deepEqual(files.sort(), ['background.png', 'hero.png', 'official.txt', 'theme.json'].sort());
});

test('codextheme packing preserves adsMarket distribution attribution', () => {
  const dir = fixture({ file: 'hero.png' });
  writeFileSync(path.join(dir, 'adsmarket-distribution.json'), JSON.stringify({
    v: 1, beneficiaryUserId: 'usr_test', themeId: 'home-test', source: 'gallery', adsApiBase: 'https://ads.example',
  }));
  const out = path.join(dir, 'attributed.codextheme');
  const packer = path.resolve('skill/theme-x/scripts/pack.mjs');
  execFileSync(process.execPath, [packer, 'pack', '--theme', dir, '--out', out]);
  const files = execFileSync('/usr/bin/unzip', ['-Z1', out]).toString().trim().split('\n');
  assert.ok(files.includes('adsmarket-distribution.json'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK = fileURLToPath(new URL('../skill/theme-x/scripts/pack.mjs', import.meta.url));

test('sponsored export strips platform-owned campaign id without mutating the saved theme', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'theme-pack-test-'));
  const themeDir = path.join(root, 'theme');
  const out = path.join(root, 'out.codextheme');
  try {
    mkdirSync(themeDir);
    const theme = {
      schema: 'codextheme/1', id: 'campaign-bound-ad', name: 'Campaign Bound Ad',
      variant: 'dark', type: 'sponsored',
      official: { accent: '#2ee6a8', ink: '#e6edf7', surface: '#10173a', contrast: 60 },
      background: { file: 'background.jpg' },
      sponsor: {
        campaign: 'cmp-platform-owned',
        slots: { kicker: { text: 'ACME', url: 'https://example.com/' } },
      },
    };
    writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify(theme, null, 2));
    writeFileSync(path.join(themeDir, 'background.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));

    execFileSync(process.execPath, [PACK, 'pack', '--theme', themeDir, '--out', out]);
    const exported = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', out, 'theme.json'], { encoding: 'utf8' }));
    assert.equal('campaign' in exported.sponsor, false);
    assert.equal(JSON.parse(readFileSync(path.join(themeDir, 'theme.json'), 'utf8')).sponsor.campaign, 'cmp-platform-owned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

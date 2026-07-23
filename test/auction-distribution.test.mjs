import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDistribution, rendererProgram } from '../skill/theme-x/scripts/inject.mjs';

test('theme-x accepts the targeted auction v2 distribution contract', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'theme-x-auction-'));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'adsmarket-distribution.json'), JSON.stringify({
    v: 2,
    source: 'targeted_auction',
    auctionId: 'auc_12345678',
    targetUserId: 'usr_target',
    themeId: 'target-theme',
    adsApiBase: 'https://contextmarket.net/path',
  }));
  assert.deepEqual(await loadDistribution(root, 'target-theme'), {
    v: 2,
    source: 'targeted_auction',
    auctionId: 'auc_12345678',
    targetUserId: 'usr_target',
    themeId: 'target-theme',
    adsApiBase: 'https://contextmarket.net',
  });
});

test('targeted renderer emits only activation, deactivation, and one-shot completion checks', () => {
  const program = rendererProgram({
    css: '', backgroundDataUrl: 'data:image/png;base64,', homeDataUrl: 'data:image/png;base64,',
    accentRemap: null, name: 'Target', copy: {}, sponsor: { slots: {} },
    distribution: {
      v: 2, source: 'targeted_auction', auctionId: 'auc_12345678', targetUserId: 'usr_target',
      themeId: 'target-theme', adsApiBase: 'https://contextmarket.net',
    },
    themeId: 'target-theme', modeVars: {},
  });
  assert.match(program, /pushAuctionEvent\('activation'\)/);
  assert.match(program, /pushAuctionEvent\('deactivated'\)/);
  assert.match(program, /pushAuctionEvent\('completion_check'\)/);
  assert.match(program, /state\.status === 'accepted'\) pushAuctionEvent\('activation'\)/);
  assert.match(program, /serverAdjustedNow = Date\.now\(\) \+ Number\(state\.clockOffsetMs \|\| 0\)/);
  assert.match(program, /queue\.events\.some\(\(event\) => event\?\.type === type\)/);
  assert.doesNotMatch(program, /pushAuctionEvent\('heartbeat'\)/);
});

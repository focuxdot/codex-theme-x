import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {
  buildCss, loadTheme, rendererProgram,
  resolveAdsApiBase, selectBatch, pruneConfirmed, normalizeCampaignStates,
  uploadEventIssue, partitionUploadEvents, quarantineInvalidEventsProgram,
} from '../skill/theme-x/scripts/inject.mjs';

const INJECT_URL = new URL('../skill/theme-x/scripts/inject.mjs', import.meta.url).href;

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function fixture(sponsor, { type = 'sponsored', distribution = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-sponsor-'));
  writeFileSync(path.join(dir, 'background.png'), pixel);
  const theme = {
    schema: 'codextheme/1',
    id: 'sponsor-test',
    name: 'Sponsor Test',
    variant: 'dark',
    official: { accent: '#4aa8ff', ink: '#eaf4ff', surface: '#0a1626' },
    background: { file: 'background.png' },
  };
  if (type != null) theme.type = type;
  if (sponsor !== undefined) theme.sponsor = sponsor;
  writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme));
  if (distribution) writeFileSync(path.join(dir, 'adsmarket-distribution.json'), JSON.stringify(distribution));
  return dir;
}

test('sponsor block parses slots, whitelists URLs, and keeps campaign/disclosure', async () => {
  const theme = await loadTheme(fixture({
    campaign: 'cmp-x',
    disclosure: 'Sponsored',
    slots: {
      kicker: { text: 'ACME', url: 'https://acme.example/' },
      greeting: { text: 'headline', url: 'javascript:alert(1)' }, // unsafe → dropped
      tagline: { text: '', url: 'https://acme.example/x' },        // no copy → slot absent
    },
  }));
  assert.equal(theme.type, 'sponsored');
  assert.equal(theme.sponsor.campaign, 'cmp-x');
  assert.equal(theme.sponsor.disclosure, 'Sponsored');
  // valid http(s) url is kept and the slot is clickable
  assert.equal(theme.sponsor.slots.kicker.url, 'https://acme.example/');
  // javascript: scheme is stripped — copy stays, but the slot is not linkable
  assert.equal(theme.sponsor.slots.greeting.text, 'headline');
  assert.equal(theme.sponsor.slots.greeting.url, null);
  // a slot without copy is not rendered at all
  assert.equal(theme.sponsor.slots.tagline, null);
});

test('a standard theme is the default and never renders a sponsor block', async () => {
  // No type field at all → standard, sponsor ignored even if a block is present.
  const noType = await loadTheme(fixture({
    slots: { kicker: { text: 'ACME', url: 'https://acme.example/' } },
  }, { type: null }));
  assert.equal(noType.type, 'standard');
  assert.equal(noType.sponsor, null);

  // Explicit standard type with a stray sponsor block → still ignored (type is
  // authoritative, so a normal user's theme can never become an ad).
  const stray = await loadTheme(fixture({
    slots: { kicker: { text: 'ACME', url: 'https://acme.example/' } },
  }, { type: 'standard' }));
  assert.equal(stray.type, 'standard');
  assert.equal(stray.sponsor, null);
});

test('absent sponsor block on a standard theme leaves theme.sponsor null (v1 back-compat)', async () => {
  const theme = await loadTheme(fixture(undefined, { type: null }));
  assert.equal(theme.type, 'standard');
  assert.equal(theme.sponsor, null);
});

test('a sponsored theme with no usable sponsor block fails to load', () => {
  const dir = fixture(undefined, { type: 'sponsored' }); // sponsored but no block
  const code = `const { loadTheme } = await import(${JSON.stringify(INJECT_URL)});`
    + ` await loadTheme(${JSON.stringify(dir)}); console.log('LOADED');`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' }));
});

test('disclosure defaults to none unless explicitly signed', async () => {
  const theme = await loadTheme(fixture({
    slots: { kicker: { text: 'ACME', url: 'https://acme.example/' } },
  }));
  assert.equal(theme.sponsor.disclosure, null);
});

test('buildCss: only the tagline slot carries the ↗ jump marker', async () => {
  const theme = await loadTheme(fixture({
    slots: { tagline: { text: 't', url: 'https://acme.example/' } },
  }));
  const css = buildCss(theme);
  assert.match(css, /\.ctx-hero-link\.ctx-hero-tagline \.ctx-hero-label::after/);
  // the arrow must NOT be attached to every linked slot
  assert.doesNotMatch(css, /\.ctx-hero-link \.ctx-hero-label::after/);
});

test('rendererProgram embeds sponsor data, the verified jump, and per-slot instrumentation', async () => {
  const theme = await loadTheme(fixture({
    campaign: 'cmp-x',
    slots: { kicker: { text: 'ACME', url: 'https://acme.example/' } },
  }, { distribution: {
    v: 1, beneficiaryUserId: 'usr_11111111-2222-3333-4444-555555555555',
    themeId: 'sponsor-test', source: 'gallery', adsApiBase: 'https://ads.example/path',
  } }));
  const program = rendererProgram({
    css: buildCss(theme),
    backgroundDataUrl: theme.backgroundDataUrl,
    homeDataUrl: theme.home.dataUrl,
    accentRemap: null,
    name: theme.name,
    copy: theme.copy,
    sponsor: theme.sponsor,
    distribution: theme.distribution,
  });
  assert.match(program, /https:\/\/acme\.example\//);        // slot url embedded
  assert.match(program, /window\.open\(url, '_blank', 'noopener'\)/); // verified jump path
  assert.match(program, /recordSlotEvent\('click', kind\)/);  // click instrumentation
  assert.match(program, /recordSlotEvent\('impression', st\.kind\)/); // L3 impression
  assert.match(program, /document\.hasFocus\(\)/);            // focus gate present
  assert.match(program, /__ctxAdEvents/);                     // localStorage buffer key
  assert.match(program, /usr_11111111-2222-3333-4444-555555555555/); // public earnings attribution
  assert.match(program, /event\.beneficiary = beneficiaryUserId/);
  assert.deepEqual(theme.distribution, {
    v: 1, beneficiaryUserId: 'usr_11111111-2222-3333-4444-555555555555',
    themeId: 'sponsor-test', source: 'gallery', adsApiBase: 'https://ads.example',
  });
});

test('rendererProgram embeds retention events + bounded buffer for an ad theme', async () => {
  const theme = await loadTheme(fixture({
    campaign: 'cmp-x',
    slots: { kicker: { text: 'ACME', url: 'https://acme.example/' } },
  }));
  const program = rendererProgram({
    css: buildCss(theme), backgroundDataUrl: theme.backgroundDataUrl,
    homeDataUrl: theme.home.dataUrl, accentRemap: null, name: theme.name,
    copy: theme.copy, sponsor: theme.sponsor, themeId: theme.id,
  });
  assert.match(program, /recordThemeEvent\('active_day', themeId\)/); // L1 retention
  assert.match(program, /recordThemeEvent\('switch_away', themeId\)/); // switch-away
  assert.match(program, /__ctxAdActiveDay/);                  // per-day marker
  assert.match(program, /opts\.next !== themeId/);            // real-switch guard (no double count)
  assert.match(program, /AD_CAP = 10/);                       // one bounded upload batch
  // Impression dedup survives a React rebuild: counted per-kind, reset only when
  // a still-connected element scrolls away (never on rebuild's detach).
  assert.match(program, /slotCounted\[st\.kind\]/);
  assert.match(program, /!st\.visible && document\.contains\(el\)/);
});

test('a mismatched distribution file is rejected', () => {
  const dir = fixture({ slots: { kicker: { text: 'ACME', url: 'https://acme.example/' } } }, {
    distribution: { v: 1, beneficiaryUserId: 'usr_ok', themeId: 'another-theme', adsApiBase: 'https://ads.example' },
  });
  const code = `const { loadTheme } = await import(${JSON.stringify(INJECT_URL)});`
    + ` await loadTheme(${JSON.stringify(dir)}); console.log('LOADED');`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' }));
});

test('a standard theme payload gates all metering off (sponsor === null)', async () => {
  const theme = await loadTheme(fixture(undefined, { type: null }));
  const program = rendererProgram({
    css: buildCss(theme), backgroundDataUrl: theme.backgroundDataUrl,
    homeDataUrl: theme.home.dataUrl, accentRemap: null, name: theme.name,
    copy: theme.copy, sponsor: theme.sponsor, themeId: theme.id,
  });
  // The metering code is present but inert: the sponsor gate is null, so no
  // events, markers, or observers ever run for a standard theme.
  assert.match(program, /const sponsor = null;/);
});

test('resolveAdsApiBase: env > config.json > null, trailing slash stripped', () => {
  assert.equal(resolveAdsApiBase({ ADS_API_BASE: 'https://ads.example/' }, { adsApiBase: 'https://x' }), 'https://ads.example');
  assert.equal(resolveAdsApiBase({}, { adsApiBase: 'https://cfg.example//' }), 'https://cfg.example');
  assert.equal(resolveAdsApiBase({}, null), null);
  assert.equal(resolveAdsApiBase({ ADS_API_BASE: '   ' }, null), null);
});

test('selectBatch: oldest-first by seq, capped at max', () => {
  const events = [{ s: 5 }, { s: 1 }, { s: 3 }, { s: 2 }, { s: 4 }];
  assert.deepEqual(selectBatch(events, 3).map((e) => e.s), [1, 2, 3]);
  assert.equal(selectBatch(events, 10).length, 5);
});

test('pruneConfirmed: keeps only s > batch max (upload-race safe)', () => {
  const events = [{ s: 1 }, { s: 2 }, { s: 3 }, { s: 7 }]; // 7 arrived during upload
  assert.deepEqual(pruneConfirmed(events, 3).map((e) => e.s), [7]);
  assert.deepEqual(pruneConfirmed([], 3), []);
});

test('upload validation isolates a legacy null-campaign event without changing valid events', () => {
  const valid = {
    s: 11, t: 1784620334416, type: 'impression', slot: 'kicker',
    campaign: 'cmp-live', theme: 'theme-live', beneficiary: 'usr_123',
  };
  const legacy = { ...valid, s: 10, campaign: null };
  assert.equal(uploadEventIssue(valid), null);
  assert.equal(uploadEventIssue({ s: 12, type: 'switch_away', theme: 'theme-live' }), null);
  assert.equal(uploadEventIssue(legacy), 'invalid_campaign');
  assert.equal(uploadEventIssue({ ...valid, secret: 'must-not-survive' }), 'unknown_field');
  const partitioned = partitionUploadEvents([legacy, valid]);
  assert.deepEqual(partitioned.valid, [valid]);
  assert.equal(partitioned.invalid.length, 1);
  assert.equal(partitioned.invalid[0].reason, 'invalid_campaign');
});

test('live quarantine frees a full poisoned buffer and stores metadata-only diagnostics', () => {
  const oldEvents = Array.from({ length: 10 }, (_, index) => ({
    s: index + 1, t: 1784620334416 + index, type: 'impression', slot: 'kicker',
    campaign: null, theme: 'legacy-theme', secret: `private-${index}`,
  }));
  const valid = { s: 11, t: 1784620334500, type: 'impression', slot: 'kicker', campaign: 'cmp-live', theme: 'theme-live' };
  const storage = new Map([['__ctxAdEvents', JSON.stringify({
    v: 1, installId: '11111111-2222-4333-8444-555555555555', seq: 11, events: [...oldEvents, valid],
  })]]);
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const result = vm.runInNewContext(quarantineInvalidEventsProgram(), { localStorage, Date, JSON, Number, Object, Array, Set });
  assert.deepEqual({ ...result }, {
    ok: true, quarantined: 10, diagnosticsDropped: 0, remaining: 1,
  });
  const live = JSON.parse(storage.get('__ctxAdEvents'));
  assert.deepEqual(live.events, [valid]);
  const quarantine = JSON.parse(storage.get('__ctxAdEventsQuarantine'));
  assert.equal(quarantine.events.length, 10);
  assert.deepEqual(quarantine.events[0], { seq: 1, reason: 'invalid_campaign', quarantinedAt: quarantine.events[0].quarantinedAt });
  assert.doesNotMatch(storage.get('__ctxAdEventsQuarantine'), /private-/);
});

test('quarantine storage exhaustion never leaves a poisoned event uploadable', () => {
  const invalid = { s: 1, t: 1784620334416, type: 'impression', slot: 'kicker', campaign: null, theme: 'legacy-theme' };
  const valid = { s: 2, t: 1784620334500, type: 'active_day', theme: 'theme-live' };
  const storage = new Map([['__ctxAdEvents', JSON.stringify({
    v: 1, installId: '11111111-2222-4333-8444-555555555555', seq: 2, events: [invalid, valid],
  })]]);
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem(key, value) {
      if (key === '__ctxAdEventsQuarantine') throw new Error('quota exceeded');
      storage.set(key, String(value));
    },
    removeItem: (key) => storage.delete(key),
  };
  const result = vm.runInNewContext(quarantineInvalidEventsProgram(), { localStorage, Date, JSON, Number, Object, Array, Set });
  assert.deepEqual({ ...result }, {
    ok: true, quarantined: 1, diagnosticsDropped: 1, remaining: 1,
  });
  assert.deepEqual(JSON.parse(storage.get('__ctxAdEvents')).events, [valid]);
});

test('main-buffer storage failure is reported before an invalid batch can upload', () => {
  const invalid = { s: 1, type: 'impression', slot: 'kicker', campaign: null, theme: 'legacy-theme' };
  const raw = JSON.stringify({
    v: 1, installId: '11111111-2222-4333-8444-555555555555', seq: 1, events: [invalid],
  });
  const storage = new Map([['__ctxAdEvents', raw]]);
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem(key) {
      if (key === '__ctxAdEvents') throw new Error('storage unavailable');
    },
    removeItem: (key) => storage.delete(key),
  };
  const result = vm.runInNewContext(quarantineInvalidEventsProgram(), { localStorage, Date, JSON, Number, Object, Array, Set });
  assert.deepEqual({ ...result }, {
    ok: false, quarantined: 0, diagnosticsDropped: 0, remaining: null,
  });
  assert.equal(storage.get('__ctxAdEvents'), raw);
});

test('existing quarantine entries are rebuilt from bounded metadata only', () => {
  const invalid = { s: 2, type: 'impression', slot: 'kicker', campaign: null, theme: 'legacy-theme' };
  const storage = new Map([
    ['__ctxAdEvents', JSON.stringify({ v: 1, installId: '11111111-2222-4333-8444-555555555555', seq: 2, events: [invalid] })],
    ['__ctxAdEventsQuarantine', JSON.stringify({
      v: 1,
      events: [{ seq: 1, reason: 'x'.repeat(200), quarantinedAt: 1784620334000, secret: 'must-not-survive' }],
    })],
  ]);
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  vm.runInNewContext(quarantineInvalidEventsProgram(), { localStorage, Date, JSON, Number, Object, Array, Set });
  const quarantine = JSON.parse(storage.get('__ctxAdEventsQuarantine'));
  assert.deepEqual(Object.keys(quarantine.events[0]).sort(), ['quarantinedAt', 'reason', 'seq']);
  assert.equal(quarantine.events[0].reason.length, 64);
  assert.doesNotMatch(storage.get('__ctxAdEventsQuarantine'), /must-not-survive/);
});

test('normalizeCampaignStates keeps only authoritative bounded Campaign states', () => {
  assert.deepEqual(normalizeCampaignStates([
    { campaign: 'cmp-a', status: 'active', earning: true },
    { campaign: 'cmp-a', status: 'exhausted', earning: true },
    { campaign: 'cmp-b', status: 'paused', earning: true },
    { campaign: 'bad id!', status: 'exhausted', earning: false },
    { campaign: 'cmp-c', status: 'invented', earning: false },
  ]), [
    { campaign: 'cmp-a', status: 'exhausted', earning: false },
    { campaign: 'cmp-b', status: 'paused', earning: false },
  ]);
});

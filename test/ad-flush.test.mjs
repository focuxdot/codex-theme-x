// Event-driven ad-upload regression tests (handoff §4/§5 TS1–TS5).
//
// Strategy: run the REAL rendererProgram in a Node vm with a minimal DOM stub,
// so the metering/buffer/flush-signal logic is executed rather than
// string-matched. The host-side batching/pruning helpers are already covered in
// sponsor.test.mjs; here we cover the three allowed triggers and the forbidden
// periodic path.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCss, loadTheme, rendererProgram } from '../skill/theme-x/scripts/inject.mjs';

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function themeFixture({ type = 'sponsored', sponsor, distribution = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-flush-'));
  writeFileSync(path.join(dir, 'background.png'), pixel);
  const theme = {
    schema: 'codextheme/1', id: 'flush-test', name: 'Flush Test', variant: 'dark',
    official: { accent: '#4aa8ff', ink: '#eaf4ff', surface: '#0a1626' },
    background: { file: 'background.png' },
  };
  if (type != null) theme.type = type;
  if (sponsor !== undefined) theme.sponsor = sponsor;
  writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme));
  if (distribution) writeFileSync(path.join(dir, 'adsmarket-distribution.json'), JSON.stringify(distribution));
  return dir;
}

const SPONSOR = {
  campaign: 'cmp-flush',
  slots: { kicker: { text: 'ACME', url: 'https://acme.example/' } },
};

// ---------------------------------------------------------------- DOM stub --
// Just enough browser surface for the payload to boot: storage, event
// listeners, stylesheets, observers, and the hero/sponsor anchor nodes.

function makeEl(tag = 'div') {
  const classes = (node) => new Set([
    ...String(node.className || '').split(/\s+/).filter(Boolean),
    ...(node.classList?._set || []),
  ]);
  const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
  const matching = (node, selector) => {
    if (!selector.startsWith('.')) return false;
    return classes(node).has(selector.slice(1));
  };
  const el = {
    tagName: tag.toUpperCase(), nodeType: 1, children: [], childNodes: [],
    className: '', style: {}, attrs: {}, listeners: {},
    classList: {
      _set: new Set(),
      add(...cs) { for (const c of cs) this._set.add(c); },
      remove(...cs) { for (const c of cs) this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); this.childNodes.unshift(c); return c; },
    remove() {},
    after() {},
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { width: 0, height: 0 }; },
    querySelector(selector) {
      const direct = /^:scope > (\.[\w-]+)$/.exec(selector);
      if (direct) return this.children.find((child) => matching(child, direct[1])) ?? null;
      return descendants(this).find((child) => matching(child, selector)) ?? null;
    },
    querySelectorAll(selector) { return descendants(this).filter((child) => matching(child, selector)); },
    textContent: '',
  };
  return el;
}

function makeSandbox(initialStorage = {}, { language = 'en-US', documentLanguage = 'en' } = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const winListeners = {};
  const consoleLines = [];
  const opened = [];
  const gs = makeEl('div'); // [data-feature="game-source"]
  const documentElement = makeEl('html');
  documentElement.lang = documentLanguage;
  const sandbox = {
    localStorage,
    console: { log: (...a) => consoleLines.push(a.join(' ')) },
    document: {
      documentElement,
      body: makeEl('body'),
      title: 'Codex',
      adoptedStyleSheets: [],
      createElement: (t) => makeEl(t),
      createTextNode: (t) => ({ nodeType: 3, textContent: t }),
      querySelector(sel) {
        if (sel === '[data-feature="game-source"]') return gs;
        if (sel.startsWith('.')) return gs.querySelector(sel);
        return null; // no hero → impressions never fire; we push events directly
      },
      querySelectorAll: (sel) => gs.querySelectorAll(sel),
      addEventListener() {},
      removeEventListener() {},
      hasFocus: () => true,
      contains: () => true,
    },
    window: {},
    self: {},
    navigator: { language, languages: [language] },
    innerWidth: 1200, innerHeight: 800,
    addEventListener(t, fn) { (winListeners[t] ??= []).push(fn); },
    removeEventListener(t, fn) {
      winListeners[t] = (winListeners[t] ?? []).filter((f) => f !== fn);
    },
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ backgroundColor: 'rgb(10, 22, 38)' }),
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    CSSStyleSheet: class { replaceSync() {} },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    Blob: class {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math,
  };
  sandbox.window = sandbox;
  sandbox.open = (url) => opened.push(url);
  sandbox.self = sandbox;
  return { sandbox, storage, consoleLines, winListeners, gs, opened };
}

async function bootPayload({ type = 'sponsored', sponsor = SPONSOR, distribution = null, initialStorage = {},
  language = 'en-US', documentLanguage = 'en' } = {}) {
  const theme = await loadTheme(themeFixture({ type, sponsor, distribution }));
  const program = rendererProgram({
    css: buildCss(theme), backgroundDataUrl: theme.backgroundDataUrl,
    homeDataUrl: theme.home.dataUrl, accentRemap: null, name: theme.name,
    copy: theme.copy ?? {}, sponsor: theme.sponsor, themeId: theme.id,
    distribution: theme.distribution,
  });
  const env = makeSandbox(initialStorage, { language, documentLanguage });
  vm.runInNewContext(program, env.sandbox, { timeout: 5000 });
  return env;
}

const readEvents = (storage) =>
  JSON.parse(storage.get('__ctxAdEvents') ?? '{"events":[]}').events;
const readFlush = (storage) => {
  const raw = storage.get('__ctxAdFlush');
  return raw ? JSON.parse(raw) : null;
};

// Push N slot events by invoking the payload's own click path on a built slot.
// The click listener is the public recordSlotEvent surface inside the payload;
// driving it exercises the real pushAdEvent → buffer → signal chain.
async function pushEvents(env, n) {
  const hero = env.gs.children.find((c) => String(c.className).includes('ctx-sponsor-hero'));
  assert.ok(hero, 'sponsor hero should have been built');
  const slot = hero.children[0];
  assert.ok(slot, 'at least one slot should exist');
  const click = slot.listeners.click?.[0];
  assert.ok(click, 'linked slot should carry a click listener');
  for (let i = 0; i < n; i++) click({ preventDefault() {}, stopPropagation() {} });
}

// ------------------------------------------------------------------- tests --

test('TS4: installId is always a standard RFC 4122 v4 UUID', async () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  // randomUUID present (fast path)
  const a = await bootPayload();
  assert.match(JSON.parse(a.storage.get('__ctxAdEvents')).installId, UUID_RE);
  // no randomUUID, only getRandomValues
  const b = await bootPayload();
  b.sandbox.crypto = { getRandomValues: (arr) => arr.fill(7) };
  // re-run payload fresh against the stubbed crypto
  const theme = await loadTheme(themeFixture({ sponsor: SPONSOR }));
  const program = rendererProgram({
    css: buildCss(theme), backgroundDataUrl: theme.backgroundDataUrl,
    homeDataUrl: theme.home.dataUrl, accentRemap: null, name: theme.name,
    copy: theme.copy ?? {}, sponsor: theme.sponsor, themeId: theme.id,
  });
  const env = makeSandbox();
  env.sandbox.crypto = { getRandomValues: (arr) => arr.map((_, i) => (i * 37) & 0xff) };
  vm.runInNewContext(program, env.sandbox, { timeout: 5000 });
  assert.match(JSON.parse(env.storage.get('__ctxAdEvents')).installId, UUID_RE);
  // no crypto at all (last-resort Math.random path) — still UUID-shaped
  const env2 = makeSandbox();
  env2.sandbox.crypto = undefined;
  vm.runInNewContext(program, env2.sandbox, { timeout: 5000 });
  assert.match(JSON.parse(env2.storage.get('__ctxAdEvents')).installId, UUID_RE);
});

test('TS5: standard theme never creates the ad buffer or flush state', async () => {
  const env = await bootPayload({ type: null, sponsor: undefined });
  assert.equal(env.storage.has('__ctxAdEvents'), false);
  assert.equal(env.storage.has('__ctxAdFlush'), false);
  assert.equal(env.storage.has('__ctxAdActiveDay'), false);
  assert.equal(env.winListeners.pagehide?.length ?? 0, 0);
  assert.equal(env.winListeners.beforeunload?.length ?? 0, 0);
});

test('TS1: the 10th buffered event raises exactly one buffer-full signal', async () => {
  const env = await bootPayload();
  // boot already buffered one active_day event
  const atBoot = readEvents(env.storage).length;
  await pushEvents(env, 9 - atBoot);
  assert.equal(readEvents(env.storage).length, 9);
  assert.equal(readFlush(env.storage), null, 'no flush signal before the cap');
  await pushEvents(env, 1);
  assert.equal(readEvents(env.storage).length, 10);
  assert.equal(readFlush(env.storage)?.reason, 'buffer-full');
  assert.ok(env.consoleLines.some((l) => l.startsWith('__CTX_AD_FLUSH__:buffer-full')));
});

test('TS1: a full buffer drops new events, never overwrites, and re-arms the signal', async () => {
  const env = await bootPayload();
  await pushEvents(env, 10);
  const seqsBefore = readEvents(env.storage).map((e) => e.s);
  // consume the signal (host took it), then a report "fails" — buffer intact
  env.storage.delete('__ctxAdFlush');
  await pushEvents(env, 3); // dropped, but re-arm the one-shot signal
  const events = readEvents(env.storage);
  assert.equal(events.length, 10);
  assert.deepEqual(events.map((e) => e.s), seqsBefore, 'old unconfirmed events untouched');
  assert.equal(readFlush(env.storage)?.reason, 'buffer-full', 'signal re-armed after failure');
});

test('TS2: graceful unload with a partial buffer raises normal-exit once', async () => {
  const env = await bootPayload();
  await pushEvents(env, 3);
  const pagehide = env.winListeners.pagehide?.[0];
  assert.ok(pagehide, 'pagehide listener registered');
  pagehide();
  assert.equal(readFlush(env.storage)?.reason, 'normal-exit');
  assert.ok(env.consoleLines.some((l) => l.startsWith('__CTX_AD_FLUSH__:normal-exit')));
});

test('TS2: unload with an empty buffer signals nothing', async () => {
  const env = await bootPayload();
  // clear the active_day event the payload emitted at boot
  const store = JSON.parse(env.storage.get('__ctxAdEvents'));
  store.events = [];
  env.storage.set('__ctxAdEvents', JSON.stringify(store));
  env.winListeners.pagehide[0]();
  assert.equal(readFlush(env.storage), null);
});

test('TS5: no ADS_API_BASE → zero upload (report is a no-op without config)', async () => {
  // resolveAdsApiBase is covered in sponsor.test.mjs; here assert the payload
  // itself never fetches — there is no fetch in the sandbox at all.
  const env = await bootPayload();
  assert.equal(typeof env.sandbox.fetch, 'undefined');
  await pushEvents(env, 12);
  env.winListeners.pagehide[0]();
  // events + signals buffered locally; nothing left the renderer
  assert.equal(readEvents(env.storage).length, 10);
  assert.ok(readFlush(env.storage));
});

test('an exhausted Campaign persists, disables earnings/clicks, and marks the Hero', async () => {
  const env = await bootPayload({
    distribution: {
      v: 1,
      beneficiaryUserId: 'usr_11111111-2222-4333-8444-555555555555',
      themeId: 'flush-test',
      source: 'gallery',
      adsApiBase: 'https://contextmarket.net',
    },
  });
  const before = readEvents(env.storage).length;
  env.sandbox.__ctxTheme.updateCampaignStates([
    { campaign: 'cmp-flush', status: 'exhausted', earning: false },
  ], 'https://contextmarket.net');

  const hero = env.gs.querySelector('.ctx-sponsor-hero');
  assert.ok(hero.classList.contains('ctx-campaign-ended'));
  assert.ok(hero.querySelector('.ctx-campaign-state'));
  const slot = hero.querySelector('.ctx-hero-link');
  assert.equal(slot.getAttribute('href'), null);
  assert.equal(slot.getAttribute('aria-disabled'), 'true');
  slot.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(readEvents(env.storage).length, before, 'ended Campaign creates no click event');
  assert.deepEqual(env.opened, [], 'ended sponsor link does not open');

  const action = hero.querySelector('.ctx-campaign-state-action');
  action.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(env.opened, ['https://contextmarket.net/']);
  const saved = JSON.parse(env.storage.get('__ctxAdCampaignStates'));
  assert.equal(saved.campaigns['cmp-flush'].status, 'exhausted');

  const reloaded = await bootPayload({
    initialStorage: { __ctxAdCampaignStates: JSON.stringify(saved) },
    distribution: {
      v: 1,
      beneficiaryUserId: 'usr_11111111-2222-4333-8444-555555555555',
      themeId: 'flush-test',
      source: 'gallery',
      adsApiBase: 'https://contextmarket.net',
    },
  });
  assert.ok(reloaded.gs.querySelector('.ctx-sponsor-hero').classList.contains('ctx-campaign-ended'));
});

test('Campaign exhaustion copy follows the current Codex language and updates live', async () => {
  // Real Codex currently keeps html lang="en" while navigator.language carries
  // the Chinese UI locale. This reproduces the exact mismatch from the app.
  const env = await bootPayload({ language: 'zh-CN', documentLanguage: 'en' });
  env.sandbox.__ctxTheme.updateCampaignStates([
    { campaign: 'cmp-flush', status: 'exhausted', earning: false },
  ], 'https://contextmarket.net');

  const hero = env.gs.querySelector('.ctx-sponsor-hero');
  assert.equal(hero.querySelector('.ctx-campaign-state-badge').textContent, '投放已结束');
  assert.equal(hero.querySelector('.ctx-campaign-state-detail').textContent, '此主题后续曝光不再产生收益');
  assert.equal(hero.querySelector('.ctx-campaign-state-action').textContent, '更换可收益主题 →');

  env.sandbox.navigator.language = 'en-US';
  env.sandbox.navigator.languages = ['en-US'];
  env.winListeners.languagechange[0]();
  assert.equal(hero.querySelector('.ctx-campaign-state-badge').textContent, 'Campaign ended');
  assert.equal(hero.querySelector('.ctx-campaign-state-detail').textContent, 'Future impressions from this theme will not earn revenue');
  assert.equal(hero.querySelector('.ctx-campaign-state-action').textContent, 'Choose an earning theme →');
});

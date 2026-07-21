import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeBackgroundTheme, parseCodexMainProcesses } from '../skill/theme-x/scripts/keeper.mjs';

const KEEPER_SRC = readFileSync(
  new URL('../skill/theme-x/scripts/keeper.mjs', import.meta.url), 'utf8');
const INJECT_SRC = readFileSync(
  new URL('../skill/theme-x/scripts/inject.mjs', import.meta.url), 'utf8');
const KEEPER_INSTALL_SRC = readFileSync(
  new URL('../skill/theme-x/scripts/keeper-install.sh', import.meta.url), 'utf8');

function fixture(manifest, withBackground = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ctx-keeper-'));
  const themeDir = path.join(root, 'themes', 'test');
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(path.join(root, 'current-theme'), `${themeDir}\n`);
  writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify(manifest));
  if (withBackground) writeFileSync(path.join(themeDir, 'background.png'), 'fake');
  return { root, themeDir };
}

test('requires an applied theme pointer', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ctx-keeper-'));
  assert.equal(activeBackgroundTheme(root), null);
});

test('ignores an applied color-only theme', () => {
  const { root } = fixture({ schema: 'codextheme/1', name: 'Colors only' });
  assert.equal(activeBackgroundTheme(root), null);
});

test('ignores a theme whose background file is missing', () => {
  const { root } = fixture({ schema: 'codextheme/1', background: { file: 'background.png' } });
  assert.equal(activeBackgroundTheme(root), null);
});

test('ignores an existing file that is not a supported background image', () => {
  const { root, themeDir } = fixture({ schema: 'codextheme/1', background: { file: 'background.txt' } });
  writeFileSync(path.join(themeDir, 'background.txt'), 'not an image');
  assert.equal(activeBackgroundTheme(root), null);
});

test('accepts an applied theme with an existing background image', () => {
  const { root, themeDir } = fixture({ schema: 'codextheme/1', name: 'Image theme', background: { file: 'background.png' } }, true);
  const realThemeDir = realpathSync(themeDir);
  assert.deepEqual(activeBackgroundTheme(root), {
    themeDir: realThemeDir,
    backgroundPath: path.join(realThemeDir, 'background.png'),
    name: 'Image theme',
  });
});

test('distinguishes normal desktop launches from debug launches', () => {
  const normal = ' 123 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const debug = ' 456 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=9341';
  const helper = ' 789 /Applications/ChatGPT.app/Contents/Frameworks/Codex (Service).app/Contents/MacOS/Codex (Service) --type=gpu-process';
  assert.deepEqual(parseCodexMainProcesses([normal, debug, helper].join('\n')), [
    { pid: 123, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', command: '', debug: false },
    {
      pid: 456,
      executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      command: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9341',
      debug: true,
    },
  ]);
});

// --- two-stage upload trigger discipline (handoff §4) -----------------------
// These read the keeper source to pin the control-flow invariants that the
// live-Codex e2e (TS6) will exercise: no periodic upload, signals drive the
// only mid-session reports, startup keeps its catch-up.

test('TS3: the resident tick never uploads periodically after startup', () => {
  // The injected-state branch consumes signals and permits one guarded
  // new-session catch-up; it must not contain an unguarded recurring report.
  const tickBody = KEEPER_SRC.slice(KEEPER_SRC.indexOf('async function tick()'));
  const injectedBranch = tickBody.slice(0, tickBody.indexOf("if (state === 'missing')"));
  assert.match(injectedBranch, /flushIfSignaled\(\)/, 'injected state consumes flush signals');
  assert.match(injectedBranch, /if \(catchUpPending\)[\s\S]*if \(!flushed\) catchUpReport\(\)/,
    'startup report stays behind the one-shot session guard');
  assert.equal((injectedBranch.match(/catchUpReport\(\)/g) ?? []).length, 1,
    'there is no second periodic report call in the poll loop');
  // No min-interval throttle parameter remains anywhere (was the 1/min timer).
  assert.doesNotMatch(KEEPER_SRC, /catchUpReport\(\d+\)/);
  assert.doesNotMatch(KEEPER_SRC, /minIntervalMs/);
});

test('default install keeps the signal bridge resident', () => {
  assert.match(KEEPER_INSTALL_SRC, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(KEEPER_INSTALL_SRC, /<string>--oneshot<\/string>/);
  assert.doesNotMatch(KEEPER_INSTALL_SRC, /<key>WatchPaths<\/key>/);
});

test('TS1/TS2: flush signals are consumed atomically and drive exactly one report', () => {
  // The probe (inject.mjs flush-signal) read-and-clears the one-shot flag —
  // the atomicity lives in the renderer read, not in the keeper.
  assert.match(INJECT_SRC, /localStorage\.removeItem\(k\)/);
  assert.match(INJECT_SRC, /__ctxAdFlush/);
  // The keeper calls ONLY the fixed flush-signal probe — no general-purpose
  // eval surface on the host (review: an --expr flag would be arbitrary JS).
  assert.match(KEEPER_SRC, /'flush-signal'/);
  assert.doesNotMatch(KEEPER_SRC, /--expr|FLUSH_PROBE/);
  // One consumed signal → one report, in flushIfSignaled.
  const flush = KEEPER_SRC.slice(
    KEEPER_SRC.indexOf('async function flushIfSignaled'),
    KEEPER_SRC.indexOf('async function tick()'));
  assert.match(flush, /catchUpReport\(\)/);
  assert.doesNotMatch(flush, /setInterval|setTimeout|while\s*\(/, 'no timer/loop in the flush path');
});

test('TS2: the injected → unreachable edge catches the normal-exit signal', () => {
  // The 4s poll lands after the process is gone; without an edge probe the
  // exit signal would wait until next startup. The keeper must remember the
  // injected state and probe once on the transition.
  const tickBody = KEEPER_SRC.slice(KEEPER_SRC.indexOf('async function tick()'));
  assert.match(tickBody, /wasInjected = true/);
  assert.match(tickBody, /state === 'unreachable' && wasInjected/);
});

test('report uploads are mutually exclusive (lock file)', () => {
  assert.match(INJECT_SRC, /report\.lock/);
  assert.match(INJECT_SRC, /open\(lockPath, 'wx'\)/);
  assert.match(INJECT_SRC, /unlink\(lockPath\)/);
});

test('startup catch-up is preserved (oneshot injected/missing/starting paths)', () => {
  const oneshotBody = KEEPER_SRC.slice(KEEPER_SRC.indexOf('async function oneshot()'));
  // Startup drain still happens on the launchd-fired passes…
  const reports = oneshotBody.match(/catchUpReport\(\)/g) ?? [];
  assert.ok(reports.length >= 2, 'oneshot keeps startup catch-up reports');
  // …but the flush-signal consumer is NOT in oneshot (its report already drains
  // the same buffer; consuming the flag would be redundant).
  assert.doesNotMatch(oneshotBody, /flushIfSignaled/);
});

test('resident bridge catches up once per newly reachable Codex session', () => {
  const tickBody = KEEPER_SRC.slice(KEEPER_SRC.indexOf('async function tick()'));
  const injectedBranch = tickBody.slice(0, tickBody.indexOf("if (state === 'starting')"));
  assert.match(KEEPER_SRC, /let catchUpPending = true/);
  assert.match(injectedBranch, /if \(catchUpPending\)/);
  assert.match(injectedBranch, /if \(!flushed\) catchUpReport\(\)/);
  assert.match(tickBody, /state === 'unreachable'[\s\S]*catchUpPending = true/);
});

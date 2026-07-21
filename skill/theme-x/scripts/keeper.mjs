#!/usr/bin/env node
// codex-theme-x keeper — opt-in theme restorer (LaunchAgent).
//
// It only acts when current-theme points at an applied theme with a real
// background image:
//   - Codex already has the loopback CDP port: restore a missing injection.
//   - Codex was opened normally from Finder/Dock: restart it once with the
//     loopback CDP flags, then restore the injection.
//
// Ad-event flush (event-driven, NEVER periodic upload — handoff §4): the renderer
// drops a one-shot flag in localStorage on buffer-full (10th event) and on
// graceful unload (normal-exit); this host consumes the flag via
// `inject.mjs flush-signal` and runs exactly one report per signal. The only
// other upload is startup catch-up (drains whatever a crash/force-quit left).
// A lightweight resident probe checks for that one-shot flag every 4 seconds;
// a check without a flag does not call report and does not touch the network.
//
// Two modes:
//   (no flag, default install): resident event bridge. It observes one-shot
//     flags because launchd filesystem watches cannot see localStorage writes,
//     and backs off to ~30s state checks while Codex stays fully closed.
//   --oneshot: compatibility/manual launch mode for a single startup pass.
//
// Themes without a background, unapplied themes, and users who did not enable
// the keeper are never affected.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const CTX_HOME = process.env.CTX_HOME ?? path.join(os.homedir(), '.codex', 'codex-theme-x');
const PORT = process.env.CTX_PORT ?? '9341';
const INTERVAL_MS = 4000;
// While Codex is fully closed the resident poller drops to a slow cadence:
// after BACKOFF_AFTER consecutive unreachable ticks it sleeps an extra
// BACKOFF_INTERVAL_MS per tick (state checks still run, just less often).
const BACKOFF_AFTER = 5;
const BACKOFF_INTERVAL_MS = 26000; // 4s + 26s ≈ one poll per 30s when idle
const RELAUNCH_GRACE_MS = 60000;
const INJECT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'inject.mjs');
const CODEX_BUNDLE_ID = 'com.openai.codex';
const MAIN_PROCESS_RE = /^\s*(\d+)\s+(\/Applications\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex))(?:\s+(.*))?$/;
const BACKGROUND_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export function activeBackgroundTheme(ctxHome = CTX_HOME) {
  const pointer = path.join(ctxHome, 'current-theme');
  if (!existsSync(pointer)) return null;

  try {
    const themeDir = realpathSync(readFileSync(pointer, 'utf8').trim());
    const manifest = path.join(themeDir, 'theme.json');
    if (!existsSync(manifest)) return null;

    const theme = JSON.parse(readFileSync(manifest, 'utf8'));
    if (theme.schema !== 'codextheme/1') return null;
    const backgroundFile = theme.background?.file;
    if (typeof backgroundFile !== 'string' || !backgroundFile.trim()) return null;

    const backgroundPath = path.resolve(themeDir, backgroundFile);
    const relative = path.relative(themeDir, backgroundPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(backgroundPath)) return null;
    const backgroundStat = statSync(backgroundPath);
    if (!BACKGROUND_EXTENSIONS.has(path.extname(backgroundPath).toLowerCase()) || !backgroundStat.isFile()) return null;
    if (backgroundStat.size > MAX_IMAGE_BYTES) return null;

    return { themeDir, backgroundPath, name: String(theme.name ?? theme.id ?? path.basename(themeDir)) };
  } catch {
    return null;
  }
}

export function parseCodexMainProcesses(psOutput, port = PORT) {
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const portPattern = new RegExp(`(?:^|\\s)--remote-debugging-port(?:=|\\s+)${escapedPort}(?:\\s|$)`);
  return psOutput.split('\n').flatMap((line) => {
    const match = MAIN_PROCESS_RE.exec(line);
    if (!match) return [];
    const command = match[3] ?? '';
    return [{ pid: Number(match[1]), executable: match[2], command, debug: portPattern.test(command) }];
  });
}

function codexMainProcesses() {
  try {
    const output = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { timeout: 5000 }).toString();
    return parseCodexMainProcesses(output);
  } catch {
    return [];
  }
}

function findCodexBundle() {
  const candidates = ['/Applications/ChatGPT.app', '/Applications/Codex.app'];
  try {
    const found = execFileSync('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${CODEX_BUNDLE_ID}"`], { timeout: 5000 })
      .toString().split('\n').filter((item) => item.startsWith('/Applications/'));
    candidates.push(...found);
  } catch {}

  for (const candidate of candidates) {
    const plist = path.join(candidate, 'Contents', 'Info.plist');
    if (!existsSync(plist)) continue;
    try {
      const bundleId = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { timeout: 5000 }).toString().trim();
      if (bundleId === CODEX_BUNDLE_ID) return candidate;
    } catch {}
  }
  return null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function injectionState() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
    const page = (await res.json()).find((target) => target.type === 'page' && target.url?.startsWith('app://'));
    if (!page) return 'starting';
  } catch {
    return 'unreachable';
  }
  try {
    // stderr silenced: during page boot the identity probe fails with a
    // "does not look like the Codex app" line on every poll — expected.
    const out = execFileSync(process.execPath, [INJECT, 'status', '--port', PORT, '--json'],
      { timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return JSON.parse(out).injected ? 'injected' : 'missing';
  } catch {
    return 'starting';
  }
}

async function quitCodex() {
  try {
    execFileSync('/usr/bin/osascript', ['-e', `tell application id "${CODEX_BUNDLE_ID}" to quit`], { timeout: 10000 });
  } catch {}

  const deadline = Date.now() + 20000;
  while (codexMainProcesses().length && Date.now() < deadline) await delay(250);
  if (codexMainProcesses().length) throw new Error('Codex did not quit within 20s');
}

async function relaunchWithDebug(theme) {
  const bundle = findCodexBundle();
  if (!bundle) throw new Error('Codex app not found in /Applications');

  await quitCodex();
  execFileSync('/usr/bin/open', [
    '-na', bundle, '--args',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${PORT}`,
  ], { timeout: 10000 });
  console.log(`[${new Date().toISOString()}] relaunched Codex with loopback CDP for ${path.basename(theme.themeDir)}`);
}

let lastFailureLog = 0;
let restartBusy = false;
let relaunchGraceUntil = 0;
let wasInjected = false;    // injected → unreachable edge detector (exit flush)
let unreachableStreak = 0;  // consecutive unreachable ticks, for idle backoff
let catchUpPending = true;   // once per newly reachable Codex session
const handledNormalPids = new Set();

function logFailure(message) {
  if (Date.now() - lastFailureLog <= 60000) return;
  console.error(`[${new Date().toISOString()}] ${message}`);
  lastFailureLog = Date.now();
}

// One-shot startup catch-up ONLY (handoff §4: the sole host-side automatic
// triggers are buffer-full, normal-exit, and next-startup — never a timer).
// inject.mjs report no-ops without ADS_API_BASE, so this is inert unless
// telemetry is configured.
function catchUpReport() {
  try {
    execFileSync(process.execPath, [INJECT, 'report', '--port', PORT],
      { timeout: 30000, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (err) {
    logFailure(`report catch-up failed: ${err.message}`);
  }
}

// Event-driven flush bridge (handoff §4/§5.1): the renderer never fetches the
// platform — it only drops a one-shot flag in localStorage (buffer-full on the
// 10th event, normal-exit on graceful unload) and logs a controlled console
// marker. The keeper's CDP probe (inject.mjs flush-signal) atomically reads-
// and-clears the flag and the keeper runs exactly one report per consumed
// signal. No periodic upload: a poll that finds no flag does nothing, and a
// crashed/killed Codex simply leaves the flag unread until the next startup.
async function takeFlushSignal() {
  try {
    const out = execFileSync(process.execPath, [INJECT, 'flush-signal', '--port', PORT],
      { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out && out !== 'null' ? JSON.parse(out) : null;
  } catch {
    return null; // CDP gone mid-exit — the flag stays put for next startup
  }
}

async function flushIfSignaled() {
  const signal = await takeFlushSignal();
  if (!signal) return false;
  console.log(`[${new Date().toISOString()}] ad flush signaled (${signal.reason ?? 'unknown'}); reporting once`);
  catchUpReport();
  return true;
}

async function tick() {
  const theme = activeBackgroundTheme();
  if (!theme) return;

  const state = await injectionState();
  // Any reachable CDP state proves the controlled relaunch succeeded. Clear
  // the grace window so a later user launch can be handled immediately.
  if (state !== 'unreachable') relaunchGraceUntil = 0;
  // Theme is live: consume any renderer flush signal (buffer-full / normal-
  // exit) and run at most one report per signal. No signal → no upload.
  if (state === 'injected') {
    wasInjected = true;
    unreachableStreak = 0;
    const flushed = await flushIfSignaled();
    // A new reachable app session is the third allowed upload trigger. If a
    // flush flag was already consumed above, that report drained the same
    // buffer, so do not issue a redundant startup report.
    if (catchUpPending) {
      catchUpPending = false;
      if (!flushed) catchUpReport();
    }
    return;
  }
  if (state === 'starting') return;

  // injected → unreachable edge: a graceful quit fires the renderer's
  // normal-exit signal an instant before CDP dies. The 4s poll almost always
  // lands AFTER the process is gone, so without an edge catch that signal
  // would sit unread until the next startup. Probe immediately — a dying
  // renderer often still answers for a beat; a dead one just returns null and
  // the flag stays put for startup catch-up.
  if (state === 'unreachable' && wasInjected) {
    wasInjected = false;
    await flushIfSignaled();
  }

  // Backoff while Codex stays closed: no app, no CDP, no point polling at full
  // rate (and no point spawning status probes against a dead port).
  if (state === 'unreachable') {
    catchUpPending = true;
    unreachableStreak += 1;
    if (unreachableStreak >= BACKOFF_AFTER) await delay(BACKOFF_INTERVAL_MS);
  } else {
    unreachableStreak = 0;
  }

  if (state === 'missing') {
    try {
      execFileSync(process.execPath, [INJECT, 'apply', '--theme', theme.themeDir, '--port', PORT], { timeout: 30000 });
      console.log(`[${new Date().toISOString()}] re-applied ${path.basename(theme.themeDir)}`);
    } catch (err) {
      logFailure(`re-apply failed: ${err.message}`);
    }
    return;
  }

  // No CDP endpoint. A debug-launched Codex may still be starting, so leave it
  // alone. A normally launched Codex is restarted at most once for this PID.
  const processes = codexMainProcesses();
  if (!processes.length || processes.some((process) => process.debug) || restartBusy) return;

  const normal = processes[0];
  if (Date.now() < relaunchGraceUntil) {
    handledNormalPids.add(normal.pid);
    return;
  }
  if (handledNormalPids.has(normal.pid)) return;

  handledNormalPids.add(normal.pid);
  restartBusy = true;
  relaunchGraceUntil = Date.now() + RELAUNCH_GRACE_MS;
  try {
    console.log(`[${new Date().toISOString()}] applied background theme detected on normal Codex launch; restarting once`);
    await relaunchWithDebug(theme);
  } catch (err) {
    logFailure(`debug relaunch failed: ${err.message}`);
  } finally {
    restartBusy = false;
  }
}

// ----------------------------------------------------------- oneshot mode

const STATE_FILE = path.join(CTX_HOME, 'keeper-state.json');
const RESTART_COOLDOWN_MS = 90000;

function readOneshotState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

async function waitForCdpAndInject(theme, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let absentChecks = 0;
  while (Date.now() < deadline) {
    // The watch event may have been a QUIT: if the app stays gone, stop
    // waiting quietly instead of burning the timeout and logging a failure.
    // (Tolerate short absence — a controlled relaunch has a quit→open gap.)
    if (!codexMainProcesses().length) {
      if (++absentChecks >= 3) return false;
    } else {
      absentChecks = 0;
    }
    const state = await injectionState();
    if (state === 'injected') return true;
    if (state === 'missing') {
      try {
        // stderr silenced: "target does not look like Codex" retries during
        // page boot are expected and would spam the log every second.
        execFileSync(process.execPath, [INJECT, 'apply', '--theme', theme.themeDir, '--port', PORT],
          { timeout: 30000, stdio: ['ignore', 'ignore', 'ignore'] });
        console.log(`[${new Date().toISOString()}] re-applied ${path.basename(theme.themeDir)}`);
        return true;
      } catch { /* page not ready yet — keep waiting */ }
    }
    await delay(1000);
  }
  logFailure('CDP never became injectable after relaunch');
  return false;
}

// One compatibility/manual pass: check the deterministic conditions (image
// theme active + not currently loaded), fix what needs fixing, and exit.
async function oneshot() {
  const theme = activeBackgroundTheme();
  if (!theme) return;

  const state = await injectionState();
  // Startup catch-up drains whatever a previous crash/force-quit left behind;
  // a pending flush signal is consumed by that same single report. Note the
  // report uploads the WHOLE current buffer — including events written moments
  // ago by this very launch (e.g. today's active_day) — not only "historical"
  // leftovers. Handoff §4 allows this (startup is one of the three triggers);
  // the platform dedupes by (installId, s) either way.
  if (state === 'injected') { catchUpReport(); return; }

  if (state === 'missing') {
    try {
      execFileSync(process.execPath, [INJECT, 'apply', '--theme', theme.themeDir, '--port', PORT], { timeout: 30000 });
      console.log(`[${new Date().toISOString()}] re-applied ${path.basename(theme.themeDir)} (page reload)`);
      catchUpReport();
    } catch (err) {
      logFailure(`re-apply failed: ${err.message}`);
    }
    return;
  }

  // 'starting': the CDP port exists — a controlled relaunch is booting. Stay
  // with it until the page is ready, then inject.
  if (state === 'starting') { if (await waitForCdpAndInject(theme)) catchUpReport(); return; }

  // 'unreachable': no CDP endpoint at all.
  const processes = codexMainProcesses();
  if (!processes.length) return; // quit event — nothing to do
  if (processes.some((p) => p.debug)) { await waitForCdpAndInject(theme); return; }

  // Normal Finder/Dock launch with an image theme active: restart once with
  // the loopback debug port. The cooldown file is the loop guard — if a
  // restart within the window did not produce a debug process, something is
  // off and we leave the app alone rather than bounce it again.
  if (Date.now() - (readOneshotState().lastRestartTs ?? 0) < RESTART_COOLDOWN_MS) return;

  // Quit events also fire the watcher, and a dying process still shows in ps
  // for a beat. Restarting it would resurrect an app the user just closed —
  // confirm the same PID is still alive before treating this as a launch.
  const normalPid = processes[0].pid;
  await delay(2500);
  if (!codexMainProcesses().some((p) => p.pid === normalPid && !p.debug)) return;

  writeFileSync(STATE_FILE, JSON.stringify({ lastRestartTs: Date.now(), pid: normalPid }));
  try {
    console.log(`[${new Date().toISOString()}] applied background theme detected on normal Codex launch; restarting once`);
    await relaunchWithDebug(theme);
  } catch (err) {
    logFailure(`debug relaunch failed: ${err.message}`);
    return;
  }
  if (await waitForCdpAndInject(theme)) catchUpReport();
}

function main() {
  if (process.argv.includes('--oneshot')) {
    oneshot()
      .catch((err) => logFailure(`keeper oneshot failed: ${err.message}`))
      .finally(() => process.exit(0));
    return;
  }
  console.log(`[${new Date().toISOString()}] keeper started (port ${PORT}, every ${INTERVAL_MS}ms)`);
  setInterval(() => tick().catch((err) => logFailure(`keeper tick failed: ${err.message}`)), INTERVAL_MS);
  tick().catch((err) => logFailure(`keeper tick failed: ${err.message}`));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();

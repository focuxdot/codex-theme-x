import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeBackgroundTheme, parseCodexMainProcesses } from '../skill/theme-x/scripts/keeper.mjs';

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

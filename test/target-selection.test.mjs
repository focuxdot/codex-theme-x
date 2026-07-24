import test from 'node:test';
import assert from 'node:assert/strict';

import { selectTarget } from '../skill/theme-x/scripts/inject.mjs';

const page = (url, id) => ({
  id,
  type: 'page',
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1:9341/devtools/page/${id}`,
});

test('prefers the visible Codex page over the avatar overlay', () => {
  const overlay = page('app://-/index.html?initialRoute=%2Favatar-overlay', 'overlay');
  const main = page('app://-/index.html', 'main');

  assert.equal(selectTarget([overlay, main]), main);
});

test('keeps the legacy single-page target fallback', () => {
  const main = page('app://-/index.html', 'main');

  assert.equal(selectTarget([main]), main);
});

#!/usr/bin/env node
// codex-theme-x packer — turn a theme directory into a shareable .codextheme
// file and back. A .codextheme is a plain zip: theme.json + background image
// + official.txt (the codex-theme-v1 string, usable without this tool).
//
// Usage:
//   node pack.mjs pack   --theme <dir> [--out <file.codextheme>]
//   node pack.mjs unpack --file <file.codextheme> [--dest <dir>]
//
// Uses /usr/bin/zip and /usr/bin/unzip (present on macOS).

import { readFile, writeFile, mkdir, access, cp, rm, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DISTRIBUTION_FILE = 'adsmarket-distribution.json';

function fail(msg) { console.error(`pack.mjs: ${msg}`); process.exit(1); }

function safeAssetName(value, field) {
  const name = String(value ?? '');
  if (!name || path.basename(name) !== name || name === '.' || name === '..') {
    fail(`${field} must be a file name inside the theme directory`);
  }
  return name;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--theme') opts.theme = rest[++i];
    else if (rest[i] === '--out') opts.out = rest[++i];
    else if (rest[i] === '--file') opts.file = rest[++i];
    else if (rest[i] === '--dest') opts.dest = rest[++i];
    else fail(`unknown option: ${rest[i]}`);
  }
  return { cmd, opts };
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));

  if (cmd === 'pack') {
    if (!opts.theme) fail('pack requires --theme <dir>');
    const dir = path.resolve(opts.theme);
    const theme = JSON.parse(await readFile(path.join(dir, 'theme.json'), 'utf8'));
    if (theme.schema !== 'codextheme/1') fail('theme.json: expected "schema": "codextheme/1"');
    const bg = safeAssetName(theme.background?.file, 'background.file');
    const home = theme.home?.file ? safeAssetName(theme.home.file, 'home.file') : null;
    const assets = [...new Set([bg, home].filter(Boolean))];
    for (const asset of assets) {
      await access(path.join(dir, asset)).catch(() => fail(`theme asset not found: ${asset}`));
    }

    const staging = await mkdtemp(path.join(os.tmpdir(), 'codextheme-'));
    try {
      await cp(path.join(dir, 'theme.json'), path.join(staging, 'theme.json'));
      for (const asset of assets) await cp(path.join(dir, asset), path.join(staging, asset));
      const distribution = path.join(dir, DISTRIBUTION_FILE);
      let hasDistribution = false;
      try { await access(distribution); hasDistribution = true; } catch {}
      if (hasDistribution) await cp(distribution, path.join(staging, DISTRIBUTION_FILE));
      // Embed the official color string so people WITHOUT codex-theme-x can
      // still paste the colors into Settings → Appearance → Import.
      const official = execFileSync(process.execPath,
        [path.join(SCRIPT_DIR, 'write-colors.mjs'), 'export', '--theme', dir]).toString();
      await writeFile(path.join(staging, 'official.txt'), official);

      const out = path.resolve(opts.out ?? `${theme.id ?? path.basename(dir)}.codextheme`);
      await rm(out, { force: true });
      execFileSync('/usr/bin/zip', ['-q', '-j', out,
        ...['theme.json', ...assets, 'official.txt', ...(hasDistribution ? [DISTRIBUTION_FILE] : [])].map((f) => path.join(staging, f))]);
      console.log(out);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return;
  }

  if (cmd === 'unpack') {
    if (!opts.file) fail('unpack requires --file <file.codextheme>');
    const file = path.resolve(opts.file);
    const staging = await mkdtemp(path.join(os.tmpdir(), 'codextheme-'));
    try {
      execFileSync('/usr/bin/unzip', ['-q', '-o', file, '-d', staging]);
      const theme = JSON.parse(await readFile(path.join(staging, 'theme.json'), 'utf8'));
      if (theme.schema !== 'codextheme/1') fail('not a codextheme/1 package');
      const assets = [
        safeAssetName(theme.background?.file, 'background.file'),
        theme.home?.file ? safeAssetName(theme.home.file, 'home.file') : null,
      ].filter(Boolean);
      for (const asset of assets) {
        await access(path.join(staging, asset)).catch(() => fail(`theme asset not found: ${asset}`));
      }
      const id = String(theme.id ?? path.basename(file, '.codextheme')).replace(/[^a-zA-Z0-9_-]/g, '-');
      const dest = path.resolve(opts.dest ?? path.join(os.homedir(), '.codex', 'codex-theme-x', 'themes', id));
      await mkdir(dest, { recursive: true });
      await cp(staging, dest, { recursive: true });
      console.log(dest);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return;
  }

  fail(`unknown command "${cmd ?? ''}" (pack|unpack)`);
}

main().catch((err) => fail(err.message));

#!/usr/bin/env node
// Maintainer push guard: verifies the GitHub SSH identity matches the expected account
// BEFORE pushing, so commits/pushes can never go out under the wrong account.
//
// The repo also pins the key via `git config core.sshCommand` (see scripts/install-hooks.sh),
// which forces every git op here to use the maintainer key regardless of ~/.ssh/config.
// This script is the extra assertion on top: it refuses to push unless
// `ssh -T git@github.com` greets the expected account.
//
// Config (namespaced ctx.*, or env fallback):
//   ctx.githubAccount / CTX_GITHUB_ACCOUNT   expected GitHub login (default: remote owner)
//   ctx.githubSshKey  / CTX_GITHUB_SSH_KEY   path to the account's private key
//
// Usage:
//   node scripts/git-push-maintainer.mjs --check         # verify identity only
//   node scripts/git-push-maintainer.mjs origin main     # verify then push
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SSH_ARGS_BASE = ["-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes"];

const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const pushArgs = checkOnly ? args.slice(1) : args;

try {
  const remote = readRemote();
  const repo = parseGitHubSshRemote(remote);
  const expectedAccount = readConfig("ctx.githubAccount") || process.env.CTX_GITHUB_ACCOUNT || repo.owner;
  const keyPath = readConfig("ctx.githubSshKey") || process.env.CTX_GITHUB_SSH_KEY;

  verifyKeyFile(keyPath);
  verifySshAccount({ expectedAccount, keyPath });

  if (checkOnly) {
    console.log(`OK: GitHub SSH identity verified as ${expectedAccount} for maintainer push.`);
    process.exit(0);
  }

  if (pushArgs.length === 0) {
    throw new Error("Usage: node scripts/git-push-maintainer.mjs origin main");
  }

  const result = spawnSync("git", ["push", ...pushArgs], {
    env: { ...process.env, GIT_SSH_COMMAND: buildSshCommand(keyPath) },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function verifyKeyFile(keyPath) {
  if (!keyPath) {
    throw new Error(
      "Maintainer SSH key is not configured. Set `git config ctx.githubSshKey <path>` or CTX_GITHUB_SSH_KEY.",
    );
  }
  if (!existsSync(keyPath)) {
    throw new Error(`Configured maintainer SSH key file does not exist: ${keyPath}`);
  }
}

function verifySshAccount({ expectedAccount, keyPath }) {
  const result = spawnSync("ssh", ["-i", keyPath, ...SSH_ARGS_BASE, "-T", "git@github.com"], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!output.includes(`Hi ${expectedAccount}!`)) {
    throw new Error(
      `Refusing to push: GitHub SSH identity did not greet "${expectedAccount}". Got:\n${output.trim()}`,
    );
  }
}

function readRemote() {
  return run("git", ["remote", "get-url", "origin"]).trim();
}

function parseGitHubSshRemote(remote) {
  const match = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/u);
  if (!match) {
    throw new Error(`Unexpected origin SSH remote: ${remote}`);
  }
  return { owner: match[1], repo: match[2] };
}

function readConfig(name) {
  const result = spawnSync("git", ["config", "--get", name], { encoding: "utf8" });
  return result.status !== 0 ? "" : (result.stdout ?? "").trim();
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout ?? "";
}

function buildSshCommand(keyPath) {
  return `ssh -i ${shellQuote(keyPath)} -o IdentitiesOnly=yes`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

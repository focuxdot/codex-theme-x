#!/bin/bash
# Maintainer setup: enable the account-guard hooks (pre-commit identity check,
# pre-push SSH identity check) and pin the maintainer SSH key for this repo.
#
#   bash scripts/install-hooks.sh <github-login> <ssh-key-path>
#   bash scripts/install-hooks.sh                # hooks only (contributor mode)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push
echo "hooks enabled (core.hooksPath = .githooks)"

if [ $# -ge 2 ]; then
  git config ctx.githubAccount "$1"
  git config ctx.githubSshKey "$2"
  git config core.sshCommand "ssh -i $2 -o IdentitiesOnly=yes -o BatchMode=yes"
  echo "maintainer guard armed for '$1' (key: $2)"
else
  echo "no maintainer account configured — hooks stay silent (contributor mode)"
fi

#!/usr/bin/env bash
# Re-seal the working directory into the vault and push the result.
# Called by src/publish.mjs after each batch of chapters, and once more at the end of a run.
set -euo pipefail

message="${1:-chore: upload progress}"

node src/vault.mjs pack

git add vault
if git diff --cached --quiet; then
  echo "vault unchanged"
  exit 0
fi

git commit -m "$message"

if ! git push; then
  echo "push failed, rebasing and retrying" >&2
  git pull --rebase --autostash
  git push
fi

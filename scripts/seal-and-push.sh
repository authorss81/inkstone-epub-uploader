#!/usr/bin/env bash
# Re-seal the working directory into the vault and push the result to a dedicated branch.
#
# The workflow is the only writer of `vault-state`, so this push can never be a non-fast-forward.
# Rebasing a shallow Actions clone onto a moved `main` is not an option: it silently drops commits.
set -euo pipefail

message="${1:-chore: upload progress}"
branch="${VAULT_BRANCH:-vault-state}"

node src/vault.mjs pack

git add vault
if git diff --cached --quiet; then
  echo "vault unchanged"
  exit 0
fi

git commit -m "$message"

if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
  git push -q origin "HEAD:refs/heads/$branch"
else
  git push -q origin "HEAD:refs/heads/$branch"
fi
echo "pushed vault state to $branch"

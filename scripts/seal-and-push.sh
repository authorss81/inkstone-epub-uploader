#!/usr/bin/env bash
# Re-seal the working directory into the vault and push it to a dedicated branch.
#
# Two things learned the hard way here:
#   1. This workflow is the only writer of the vault branch, so a code push to main can never make
#      this a non-fast-forward.
#   2. Each run still has to be *parented on the previous run's vault commit*. Building the commit
#      on top of main (which is what a plain `git commit && git push HEAD:branch` does) makes every
#      run a sibling of the last one, so the second run's push is rejected.
#   3. Never rebase to fix that: a shallow Actions clone silently drops commits while claiming
#      success. `git commit-tree` sets the parent explicitly and needs no ancestry walking.
set -euo pipefail

message="${1:-chore: upload progress}"
branch="${VAULT_BRANCH:-vault-state}"

# Belt and braces: the workflow configures git, but commit-tree still needs a committer identity.
if [ -z "$(git config user.email 2>/dev/null)" ] || [ -z "$(git config user.name 2>/dev/null)" ]; then
  git config user.email "inkstone-uploader@users.noreply.github.com"
  git config user.name "inkstone-uploader"
fi

node src/vault.mjs pack

git add vault
if git diff --cached --quiet; then
  echo "vault unchanged"
  exit 0
fi

parent=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch" || true)

if [ -n "$parent" ]; then
  tree=$(git write-tree)
  commit=$(git commit-tree "$tree" -p "$parent" -m "$message")
  git push -q origin "$commit:refs/heads/$branch"
  echo "pushed vault state to $branch, parented on the previous save"
else
  git commit -q -m "$message"
  git push -q origin "HEAD:refs/heads/$branch"
  echo "created $branch"
fi

#!/usr/bin/env bash
# Commit whatever is in vault/ to the vault-state branch and push it.
#
# The workflow reads its vault from vault-state, not main, so a session you refresh by hand has to
# land there too. This does that for you instead of making you juggle branches.
#
#   node src/import-cookies.mjs "cookies.json" --account second
#   scripts/push-vault.sh
set -euo pipefail

branch="${VAULT_BRANCH:-vault-state}"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "not inside a git repository" >&2
  exit 1
fi

# git refuses to commit with no identity, and git commit-tree needs a committer too. Set a local
# one for this repository only if the machine has none, so this works on a fresh clone.
if [ -z "$(git config user.email 2>/dev/null)" ] || [ -z "$(git config user.name 2>/dev/null)" ]; then
  git config user.email "inkstone-uploader@users.noreply.github.com"
  git config user.name "inkstone-uploader"
  echo "set a repository-local git identity (author inkstone-uploader <inkstone-uploader@users.noreply.github.com>)"
fi

if ! git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null &&
   ! git fetch -q --depth=1 origin "+refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null; then
  echo "could not reach origin/$branch yet, continuing" >&2
fi

git add vault

# Compare the branch against what is actually committed, not just against uncommitted work. The
# usual case is that import-cookies already wrote vault/ and the user committed it to main, so there
# is nothing staged even though the branch is behind.
branch_vault=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch:vault" 2>/dev/null || echo "")
head_vault=$(git rev-parse --verify --quiet "HEAD:vault" 2>/dev/null || echo "")

if [ -n "$branch_vault" ] && [ "$branch_vault" = "$head_vault" ] && git diff --cached --quiet; then
  echo "vault on $branch already matches, nothing to push"
  exit 0
fi

message="${1:-chore: refresh the vault from a workstation}"

parent=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch" || true)
if [ -n "$parent" ]; then
  tree=$(git write-tree)
  commit=$(git commit-tree "$tree" -p "$parent" -m "$message")
  git push -q origin "$commit:refs/heads/$branch"
  echo "pushed vault to $branch, parented on the previous save"
else
  git commit -q -m "$message"
  git push -q origin "HEAD:refs/heads/$branch"
  echo "created $branch"
fi
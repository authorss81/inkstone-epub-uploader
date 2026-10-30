#!/usr/bin/env bash
# Re-seal the working directory into the vault and push it to a dedicated branch.
#
# Four things learned the hard way here:
#   1. This workflow is the only writer of the vault branch, so a code push to main can never make
#      this a non-fast-forward.
#   2. Each run still has to be *parented on the previous run's vault commit*, and the tree has to be
#      that parent's tree plus the vault/ changes only. Building the tree from the main checkout
#      instead drags every workflow file that landed on main into the vault commit, and GitHub
#      rejects the push with "refusing to allow a GitHub App to create or update workflow ... without
#      `workflows` permission". The session then silently stops being saved.
#   3. Never rebase to fix that: a shallow Actions clone silently drops commits while claiming
#      success. `git commit-tree` sets the parent explicitly and needs no ancestry walking.
#   4. The branch tip can move while a run is in progress (a session refresh from another workflow
#      does exactly that), so the parent must be re-fetched for every commit and the push retried.
#      Without that, one racing push makes every later save fail as non-fast-forward while the
#      uploader keeps publishing chapters into a state file nobody can see.
set -euo pipefail

message="${1:-chore: upload progress}"
account="${2:-}"
branch="${VAULT_BRANCH:-vault-state}"

# Belt and braces: the workflow configures git, but commit-tree still needs a committer identity.
if [ -z "$(git config user.email 2>/dev/null)" ] || [ -z "$(git config user.name 2>/dev/null)" ]; then
  git config user.email "inkstone-uploader@users.noreply.github.com"
  git config user.name "inkstone-uploader"
fi

# Pack only what a publish run can legitimately change: the progress state, and the rotated token
# for the account it actually used. The other accounts' sessions were a snapshot taken at startup;
# writing those back would revert a token another workflow just refreshed.
if [ -n "$account" ]; then
  node src/vault.mjs pack --only "state,session/$account.json"
else
  node src/vault.mjs pack --only "state"
fi

# A run that was cancelled before "Restore vault"/"Unpack vault" still reaches this step (it is
# `if: always()`), and packing an empty work/ would republish the checkout's stale vault over the
# branch. That is how eighteen books' progress files went missing on 27 Oct. Refuse to save then.
if [ -z "$(ls -A work/session 2>/dev/null)" ] && [ -z "$(ls -A work/state 2>/dev/null)" ]; then
  echo "nothing was unpacked into work/, so there is nothing to save"
  exit 0
fi

fetch_parent() {
  git fetch --depth 1 origin "+refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null || true
  git rev-parse --verify --quiet "refs/remotes/origin/$branch" || true
}

for attempt in 1 2 3; do
  parent=$(fetch_parent)
  if [ -z "$parent" ]; then
    echo "there is no $branch branch to update"
    exit 1
  fi

  # Base the commit on the previous save, then stage only vault/. --ignore-removal keeps a file the
  # branch has but this worktree does not (a book sealed on another machine) instead of deleting it.
  git read-tree "$parent"
  git add --ignore-removal vault
  tree=$(git write-tree)
  if [ "$tree" = "$(git rev-parse "$parent^{tree}")" ]; then
    echo "vault unchanged"
    exit 0
  fi

  commit=$(git commit-tree "$tree" -p "$parent" -m "$message")
  if git push -q origin "$commit:refs/heads/$branch"; then
    echo "pushed vault state to $branch, parented on the previous save"
    exit 0
  fi

  echo "push rejected on attempt $attempt, refetching the branch tip"
  sleep $((attempt * 2))
done

echo "could not push the vault after 3 attempts"
exit 1

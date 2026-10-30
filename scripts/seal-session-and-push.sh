#!/usr/bin/env bash
# Re-encrypt one account's session and push it straight to the vault branch.
#
# create-novel, update-novel and account-status each rotate the site's auth token while they run,
# so the fresh token has to go back into the vault or the stored cookie ages out an hour later.
# Sealing the one file the run touched (rather than the whole vault) keeps this cheap and stops a
# status check from rewriting every other account's session.
#
# The tree is built from the previous vault commit plus this one file, never from the main checkout:
# a main checkout drags workflow files into the vault commit, and GitHub refuses to let the Actions
# token create or update a workflow file, which kills the push and loses the fresh token.
#
# The branch tip can move while this runs (publish saves progress every few chapters), so fetch the
# parent for every attempt and retry the push instead of failing the session save on one race.
set -euo pipefail

account="${1:?usage: seal-session-and-push.sh <account> [message]}"
message="${2:-chore: refresh the $account session}"
branch="${VAULT_BRANCH:-vault-state}"
plain="work/session/$account.json"
enc="vault/session/$account.json.enc"

if [ ! -f "$plain" ]; then
  echo "no unpacked session at $plain, nothing to save"
  exit 0
fi

if [ -z "$(git config user.email 2>/dev/null)" ] || [ -z "$(git config user.name 2>/dev/null)" ]; then
  git config user.email "inkstone-uploader@users.noreply.github.com"
  git config user.name "inkstone-uploader"
fi

node src/vault.mjs seal "$plain" "$enc"

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

  git read-tree "$parent"
  git add --ignore-removal "$enc"
  tree=$(git write-tree)
  if [ "$tree" = "$(git rev-parse "$parent^{tree}")" ]; then
    echo "the $account session is unchanged"
    exit 0
  fi

  commit=$(git commit-tree "$tree" -p "$parent" -m "$message")
  if git push -q origin "$commit:refs/heads/$branch"; then
    echo "pushed the $account session to $branch"
    exit 0
  fi

  echo "push rejected on attempt $attempt, refetching the branch tip"
  sleep $((attempt * 2))
done

echo "could not push the $account session after 3 attempts"
exit 1

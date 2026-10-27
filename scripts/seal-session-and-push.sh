#!/usr/bin/env bash
# Re-encrypt one account's session and push it straight to the vault branch.
#
# create-novel and update-novel each rotate the site's auth token while they run, but for a long time
# they threw that rotation away, so the stored cookie aged out an hour later and every workflow had
# to be fed a fresh export. Sealing the one file the run touched (rather than the whole vault) keeps
# this cheap, and parenting on the previous vault commit keeps the push a fast-forward.
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

git add "$enc"
if git diff --cached --quiet; then
  echo "the $account session is unchanged"
  exit 0
fi

git fetch --depth 1 origin "+refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null || true
parent=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch" || true)
tree=$(git write-tree)

if [ -n "$parent" ]; then
  commit=$(git commit-tree "$tree" -p "$parent" -m "$message")
  git push -q origin "$commit:refs/heads/$branch"
  echo "pushed the $account session to $branch"
else
  git commit -q -m "$message"
  git push -q origin "HEAD:refs/heads/$branch"
  echo "created $branch with the $account session"
fi

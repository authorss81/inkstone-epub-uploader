import { spawnSync } from 'node:child_process';

// Sends vault/ to the branch the workflow actually reads.
//
// The workflow restores its vault from vault-state, not main, so a session you refresh by hand has
// to land there too. This does that for you instead of making you juggle branches.
//
//   node src/import-cookies.mjs "cookies.json" --account second
//   npm run push:vault
//
// This runs git through Node on purpose. An earlier version was a bash script, and on Windows
// `bash` means WSL, so it silently used a different git with no GitHub credentials and then sat at
// a username prompt.

const branch = process.env.VAULT_BRANCH || 'vault-state';
const message = process.argv[2] || 'chore: refresh the vault from a workstation';

// Always capture stdout. execFileSync with stdio 'inherit' returns null, which silently turned into
// an empty refspec, and `git push origin :refs/heads/x` DELETES a branch.
function git(args, { quiet = false } = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  const out = (res.stdout || '').trim();
  const errOut = (res.stderr || '').trim();
  if (!quiet) {
    if (out) console.log(out);
    if (errOut) console.error(errOut);
  }
  if (res.status !== 0) return out;
  return out;
}

// A refspec that starts with a colon deletes the remote branch. Refuse to ever build one.
function assertPushable(refspec) {
  if (!/^[0-9a-f]{40}:refs\/heads\/.+/.test(refspec)) {
    console.error(`[vault] refusing to push a non-commit refspec: ${JSON.stringify(refspec)}`);
    process.exit(1);
  }
}

function shaOf(out) {
  return /^[0-9a-f]{40}$/.test(out) ? out : '';
}

function hasIdentity() {
  return Boolean(git(['config', 'user.email'], { quiet: true })) &&
    Boolean(git(['config', 'user.name'], { quiet: true }));
}

if (!git(['rev-parse', '--git-dir'], { quiet: true })) {
  console.error('[vault] not inside a git repository');
  process.exit(1);
}

// git refuses to commit with no identity, and commit-tree needs a committer too. Set a local one for
// this repository only if the machine has none, so this works on a fresh clone.
if (!hasIdentity()) {
  git(['config', 'user.email', 'inkstone-uploader@users.noreply.github.com']);
  git(['config', 'user.name', 'inkstone-uploader']);
  console.log('[vault] set a repository-local git identity');
}

console.log('[vault] adding vault/');
git(['add', 'vault'], { quiet: true });

// Best effort: we only need the remote branch to compare against, and a brand new repo has none.
git(['fetch', '--depth=1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
  quiet: true,
});

function treeAt(rev) {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}:vault`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return (res.stdout || '').trim();
}

// Compare the branch against what is committed, not just against uncommitted work. The usual case is
// that import-cookies already wrote vault/ and it was committed to main, so nothing is staged even
// though the branch is behind.
const branchVault = treeAt(`refs/remotes/origin/${branch}`);
const headVault = treeAt('HEAD');
const stagedIsEmpty = (() => {
  try {
    spawnSync('git', ['diff', '--cached', '--quiet', '--', 'vault'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

if (branchVault && branchVault === headVault && stagedIsEmpty) {
  console.log(`[vault] vault on ${branch} already matches, nothing to push`);
  process.exit(0);
}

const parent = shaOf(git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
  quiet: true,
}));

if (parent) {
  // Parent the new save on the previous one, so the branch keeps its history like the workflow does.
  const tree = shaOf(git(['write-tree'], { quiet: true }));
  if (!tree) {
    console.error('[vault] could not write the tree, refusing to push');
    process.exit(1);
  }
  const commit = shaOf(git(['commit-tree', tree, '-p', parent, '-m', message], { quiet: true }));
  if (!commit) {
    console.error('[vault] could not create the save commit, refusing to push');
    process.exit(1);
  }
  console.log(`[vault] pushing to ${branch}, parented on the previous save`);
  const refspec = `${commit}:refs/heads/${branch}`;
  assertPushable(refspec);
  git(['push', 'origin', refspec]);
} else {
  console.log(`[vault] creating ${branch}`);
  if (stagedIsEmpty) {
    console.error('[vault] nothing to commit, refusing to create an empty branch');
    process.exit(1);
  }
  const commit = shaOf(git(['commit', '-m', message, '--', 'vault'], { quiet: true }));
  if (!commit) {
    console.error('[vault] could not commit the vault, refusing to push');
    process.exit(1);
  }
  const refspec = `${commit}:refs/heads/${branch}`;
  assertPushable(refspec);
  git(['push', 'origin', refspec]);
}

console.log(`[vault] done, vault is on ${branch}`);
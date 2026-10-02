import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, sep } from 'node:path';

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

// Every file currently in vault/ on this machine.
function localVaultFiles(dir = 'vault', root = '.', found = []) {
  let entries;
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return found;
  }
  for (const name of entries) {
    const rel = posix.join(dir.split(sep).join('/'), name);
    const abs = join(root, dir, name);
    if (statSync(abs).isDirectory()) localVaultFiles(rel, root, found);
    else found.push(rel);
  }
  return found;
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

console.log('[vault] reading the branch vault as the base');

// Best effort: we only need the remote branch as a base, and a brand new repo has none.
git(['fetch', '--depth=1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
  quiet: true,
});
const parent = shaOf(
  git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { quiet: true }),
);
if (!parent) {
  console.error('[vault] no vault-state branch to update, refusing to create one from a workstation');
  process.exit(1);
}

// Overlay only the files this machine actually has, so progress the workflow wrote on the branch
// (vault/state) is never dropped by a workstation that has never seen it. An earlier version replaced
// the whole tree and silently lost two books' progress files this way.
const indexFile = join(mkdtempSync(join(tmpdir(), 'push-vault-')), 'index');
const withIndex = { ...process.env, GIT_INDEX_FILE: indexFile };
function gitIndex(args, { quiet = false } = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8', env: withIndex });
  const out = (res.stdout || '').trim();
  const errOut = (res.stderr || '').trim();
  if (!quiet) {
    if (out) console.log(out);
    if (errOut) console.error(errOut);
  }
  return res.status === 0 ? out : null;
}

function cleanup() {
  rmSync(join(indexFile, '..'), { recursive: true, force: true });
}

gitIndex(['read-tree', parent], { quiet: true });

const files = localVaultFiles();
if (!files.length) {
  console.error('[vault] no files in vault/, nothing to do');
  process.exit(1);
}

for (const file of files) {
  const blob = shaOf(git(['hash-object', '-w', file], { quiet: true }));
  if (!blob) {
    console.error(`[vault] could not hash ${file}, refusing to push`);
    process.exit(1);
  }
  const ok = gitIndex(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], {
    quiet: true,
  });
  if (ok === null) {
    console.error(`[vault] could not stage ${file}, refusing to push`);
    process.exit(1);
  }
}
console.log(`[vault] overlaying ${files.length} local file(s) onto ${branch}`);

const tree = shaOf(gitIndex(['write-tree'], { quiet: true }) || '');
if (!tree) {
  console.error('[vault] could not write the tree, refusing to push');
  cleanup();
  process.exit(1);
}

const parentVaultTree = (() => {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${parent}^{tree}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return (res.stdout || '').trim();
})();
if (tree === parentVaultTree) {
  console.log(`[vault] vault on ${branch} already matches this machine, nothing to push`);
  cleanup();
  process.exit(0);
}

// Parent the new save on the previous one, so the branch keeps its history like the workflow does.
const commit = shaOf(git(['commit-tree', tree, '-p', parent, '-m', message], { quiet: true }));
if (!commit) {
  console.error('[vault] could not create the save commit, refusing to push');
  cleanup();
  process.exit(1);
}

console.log(`[vault] pushing to ${branch}, parented on the previous save`);
const refspec = `${commit}:refs/heads/${branch}`;
assertPushable(refspec);
git(['push', 'origin', refspec]);
cleanup();

console.log(`[vault] done, vault is on ${branch}`);
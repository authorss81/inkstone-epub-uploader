import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { encrypt } from './vault.mjs';
import { loadBook } from './lib/epub.mjs';

// Queues several novels at once instead of running add-book once per EPUB.
//
//   node src/add-batch.mjs --account second \
//     --add "C:\books\a.epub=111222333" \
//     --add "C:\books\b.epub=444555666"
//
// Each --add pairs one EPUB with the Inkstone book id it should go into. The pairing is explicit on
// purpose: matching novels to books by sorting would silently send the wrong text to the wrong book.

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
}
function allFlags(name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === name && args[i + 1]) out.push(args[i + 1]);
  return out;
}

const account = flag('--account') || 'main';
const pairs = allFlags('--add');

if (!pairs.length) {
  console.error('usage: node src/add-batch.mjs --add "<epub>=<bookId>" [--add ...] [--account name]');
  console.error('       set VAULT_PASSPHRASE first so the EPUBs can be sealed');
  process.exit(1);
}
if (!process.env.VAULT_PASSPHRASE) {
  console.error('VAULT_PASSPHRASE must be set so the EPUBs can be sealed');
  process.exit(1);
}

const CONFIG = resolve(process.env.BOOKS_CONFIG ?? 'books.json');
const VAULT = resolve(process.env.VAULT_DIR ?? 'vault');

let config = { books: [] };
if (existsSync(CONFIG)) {
  try {
    config = JSON.parse(readFileSync(CONFIG, 'utf8'));
    if (Array.isArray(config)) config = { books: config };
  } catch (err) {
    console.error(`${CONFIG} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}
config.books ??= [];

const proposed = [];
const problems = [];

for (const pair of pairs) {
  const eq = pair.lastIndexOf('=');
  if (eq < 1) {
    problems.push(`cannot parse "${pair}", expected <epub path>=<bookId>`);
    continue;
  }
  const epub = pair.slice(0, eq).trim();
  const bookId = pair.slice(eq + 1).trim();

  if (!existsSync(epub)) {
    problems.push(`no such file: ${epub}`);
    continue;
  }
  if (!/^\d{6,}$/.test(bookId)) {
    problems.push(`"${bookId}" does not look like an Inkstone book id (digits only)`);
    continue;
  }
  if (config.books.some((b) => b.bookId === bookId)) {
    problems.push(`bookId ${bookId} is already queued, skipping it`);
    continue;
  }
  if (proposed.some((p) => p.bookId === bookId)) {
    problems.push(`bookId ${bookId} was given twice, skipping the duplicate`);
    continue;
  }

  const parsed = loadBook(epub);
  proposed.push({
    bookId,
    epub,
    title: basename(epub, '.epub'),
    chapters: parsed.total,
    words: parsed.chapter(1).title ? undefined : undefined,
  });
}

if (problems.length) {
  console.error('problems:');
  for (const p of problems) console.error(`  - ${p}`);
}
if (!proposed.length) {
  console.error('nothing to add');
  process.exit(1);
}

console.log('');
console.log('about to queue:');
let nextId = Math.max(0, ...config.books.map((b) => b.id ?? 0));
for (const p of proposed) {
  nextId += 1;
  console.log(`  [${nextId}] ${p.title.padEnd(34)} ${String(p.chapters).padStart(5)} chapters  ->  book ${p.bookId}`);
}
console.log('');

const apply = args.includes('--apply');
if (!apply) {
  console.log('PREVIEW ONLY, nothing written. Re-run with --apply to seal and queue these.');
  process.exit(0);
}

nextId = Math.max(0, ...config.books.map((b) => b.id ?? 0));
for (const p of proposed) {
  nextId += 1;
  const slot = `book/book-${p.bookId}.epub.enc`;
  const out = join(VAULT, slot);
  mkdirSync(dirname(out), { recursive: true });
  encrypt(readFileSync(p.epub), out);

  const entry = { id: nextId, bookId: p.bookId, title: p.title, epub: slot };
  if (account !== 'main') entry.account = account;
  config.books.push(entry);
  console.log(`sealed ${p.epub} -> ${out}`);
}

writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);

console.log(`\nadded ${proposed.length} novel(s) to ${CONFIG}`);
if (account !== 'main') {
  console.log(`\nthese are on the "${account}" Inkstone account, so import its cookies if you have not:`);
  console.log(`  node src/import-cookies.mjs "C:\\path\\to\\cookies.json" --account ${account}`);
}
console.log(`\ncommit and run the workflow:`);
console.log('  git add books.json vault');
console.log(`  git commit -m "feat: queue ${proposed.length} more novel(s)"`);
console.log('  git push');
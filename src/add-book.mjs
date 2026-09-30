import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { encrypt } from './vault.mjs';

// Adds a novel to books.json and seals its EPUB into the vault in one step.
//
//   node src/add-book.mjs --id 2 --book-id 98765432109876 --title "My Second Novel" --epub C:\books\two.epub
//
// Book ids are public (they are in the URL of a published book), so nothing secret is involved.

const args = process.argv.slice(2);
function arg(flag) {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : null;
}

const bookId = arg('--book-id');
const title = arg('--title');
const epub = arg('--epub');
const explicitId = arg('--id');

if (!bookId || !epub) {
  console.error('usage: node src/add-book.mjs --book-id <id> --epub <path> [--title "Name"] [--id N]');
  process.exit(1);
}
if (!existsSync(epub)) {
  console.error(`no such file: ${epub}`);
  process.exit(1);
}
if (!process.env.VAULT_PASSPHRASE) {
  console.error('VAULT_PASSPHRASE must be set so the EPUB can be sealed');
  process.exit(1);
}

const CONFIG = resolve(process.env.BOOKS_CONFIG ?? 'books.json');
const VAULT = resolve(process.env.VAULT_DIR ?? 'vault');
const SLOT = `book/book-${bookId}.epub.enc`;

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

if (config.books.some((b) => b.bookId === bookId)) {
  console.error(`bookId ${bookId} is already in ${CONFIG} as "${config.books.find((b) => b.bookId === bookId).title ?? ''}"`);
  console.error('nothing changed');
  process.exit(1);
}

const nextId = explicitId ? Number(explicitId) : Math.max(0, ...config.books.map((b) => b.id ?? 0)) + 1;
if (config.books.some((b) => b.id === nextId)) {
  console.error(`id ${nextId} is already taken, pass a different --id`);
  process.exit(1);
}

const out = join(VAULT, SLOT);
mkdirSync(dirname(out), { recursive: true });
encrypt(readFileSync(epub), out);

config.books.push({ id: nextId, bookId, title: title ?? `Book ${nextId}`, epub: SLOT });
writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);

console.log(`sealed ${epub} -> ${out}`);
console.log(`added book ${nextId} "${config.books.at(-1).title}" to ${CONFIG}`);
console.log('');
console.log('books.json now reads:');
console.log(readFileSync(CONFIG, 'utf8'));
console.log('commit both files:');
console.log('  git add books.json vault && git commit -m "feat: add ' + (config.books.at(-1).title) + '" && git push');

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const BOOKS_CONFIG = resolve(process.env.BOOKS_CONFIG ?? 'books.json');
export const VAULT_DIR = resolve(process.env.VAULT_DIR ?? 'vault');
export const WORK_DIR = resolve(process.env.WORK_DIR ?? 'work');

// Book ids are public (they sit in the URL of a published book), so they live in the repo rather
// than in a secret. Only the Inkstone login has to be secret.
export function loadBooks() {
  if (!existsSync(BOOKS_CONFIG)) return { books: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(BOOKS_CONFIG, 'utf8'));
  } catch (err) {
    throw new Error(`${BOOKS_CONFIG} is not valid JSON: ${err.message}`);
  }
  const books = Array.isArray(parsed) ? parsed : parsed.books;
  if (!Array.isArray(books)) throw new Error(`${BOOKS_CONFIG} must contain a "books" array`);

  const seen = new Set();
  for (const [i, book] of books.entries()) {
    for (const field of ['bookId', 'epub']) {
      if (!book?.[field]) throw new Error(`books[${i}] is missing "${field}"`);
    }
    if (seen.has(book.bookId)) throw new Error(`duplicate bookId ${book.bookId}`);
    seen.add(book.bookId);
  }
  return { books };
}

export const statePathFor = (bookId) => join(WORK_DIR, 'state', `${bookId}.json`);
// vault.mjs unpacks <vault>/<path>.enc to <work>/<path>, so the book path mirrors the vault path
// with the .enc suffix dropped. It is not nested under an extra "vault" directory.
export const epubPathFor = (book) => join(WORK_DIR, book.epub.replace(/\.enc$/, ''));

// Inkstone caps how many novels one account may own, so a second account needs its own session.
// Books with no explicit account share the "main" one.
export const accountFor = (book) => book?.account || 'main';
export const sessionPathFor = (book) => join(WORK_DIR, 'session', `${accountFor(book)}.json`);

function readState(path) {
  if (!existsSync(path)) return { nextChapter: 0, published: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { nextChapter: 0, published: [] };
  }
}

export const isDone = (book) => readState(statePathFor(book.bookId)).done === true;
export const stateFor = (book) => readState(statePathFor(book.bookId));

// Done books are skipped entirely, so a finished novel is never opened, re-detected or re-checked.
export function nextBook(config = loadBooks()) {
  return config.books.filter((book) => !isDone(book)).sort((a, b) => (a.id ?? 0) - (b.id ?? 0))[0] ?? null;
}

export function summary(config = loadBooks()) {
  return config.books
    .map((book) => {
      const state = stateFor(book);
      const status = state.done ? 'done' : state.nextChapter ? `chapter ${state.nextChapter - 1}` : 'not started';
      return `  [${book.id ?? '?'}] ${(book.title ?? book.bookId).padEnd(40)} ${status}`;
    })
    .join('\n');
}

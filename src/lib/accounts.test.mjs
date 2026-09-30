import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'acct-test-'));
process.env.BOOKS_CONFIG = join(dir, 'books.json');
process.env.WORK_DIR = dir;
process.env.VAULT_DIR = join(dir, 'vault');

const { accountFor, sessionPathFor, epubPathFor, statePathFor, loadBooks, nextBook } = await import('./books.mjs');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        ${JSON.stringify(actual)}${ok ? '' : `\n        expected ${JSON.stringify(expected)}`}`);
}

const rel = (p) => p.replace(dir, '<work>').replaceAll('\\', '/');

check('book with no account defaults to main', accountFor({ bookId: '1' }), 'main');
check('book with an explicit account is kept', accountFor({ bookId: '2', account: 'second' }), 'second');
check('two books on one account share a session', sessionPathFor({ bookId: '1' }) === sessionPathFor({ bookId: '2' }), true);
check('two accounts get different sessions', sessionPathFor({ bookId: '1' }) !== sessionPathFor({ bookId: '2', account: 'second' }), true);
check('main session path', rel(sessionPathFor({ bookId: '1' })), '<work>/session/main.json');
check('second session path', rel(sessionPathFor({ bookId: '2', account: 'second' })), '<work>/session/second.json');
check('per-book state is still per book', statePathFor('1') !== statePathFor('2'), true);

// A queue that crosses the account boundary, with book 1 finished on account main.
writeFileSync(
  process.env.BOOKS_CONFIG,
  JSON.stringify({
    books: [
      { id: 1, bookId: 'AAA', epub: 'a.enc' },
      { id: 2, bookId: 'BBB', epub: 'b.enc', account: 'second' },
      { id: 3, bookId: 'CCC', epub: 'c.enc' },
    ],
  }),
);
mkdirSync(join(dir, 'state'), { recursive: true });
writeFileSync(statePathFor('AAA'), JSON.stringify({ nextChapter: 999, done: true }));

const next = nextBook();
console.log(`\nnext book after finishing AAA: ${next.id} ${next.bookId} on account "${accountFor(next)}"`);
check('moves to the second account once main is done', next.bookId, 'BBB');
check('and uses that account session', rel(sessionPathFor(next)), '<work>/session/second.json');

console.log(failures ? `\n${failures} FAILURES` : '\nall per-account tests passed');
process.exit(failures ? 1 : 0);

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'books-test-'));
process.env.BOOKS_CONFIG = join(dir, 'books.json');
process.env.WORK_DIR = dir;
process.env.VAULT_DIR = join(dir, 'vault');

const { loadBooks, nextBook, isDone, stateFor, statePathFor, summary } = await import(
  '../src/lib/books.mjs'
);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

function write(config) {
  writeFileSync(process.env.BOOKS_CONFIG, JSON.stringify(config, null, 2));
}
function markDone(bookId) {
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(statePathFor(bookId), JSON.stringify({ nextChapter: 999, done: true }));
}

// 1. empty config
write({ books: [] });
check('no books -> no next book', nextBook(), null);

// 2. picks the lowest id, and orders numerically not lexically (10 before 9)
write({
  books: [
    { id: 9, bookId: 'B9', epub: 'b9.enc' },
    { id: 10, bookId: 'B10', epub: 'b10.enc' },
    { id: 2, bookId: 'B2', epub: 'b2.enc' },
  ],
});
check('picks lowest id (2, not 10)', nextBook()?.bookId, 'B2');

// 3. a done book is skipped, and the next one is taken
markDone('B2');
check('B2 is done', isDone({ bookId: 'B2' }), true);
check('skips done B2, picks 9 not 10', nextBook()?.bookId, 'B9');

// 4. mark every one done -> chain stops
markDone('B9');
markDone('B10');
check('all done -> nothing left', nextBook(), null);
console.log('\nsummary:\n' + summary());

// 5. order is numeric, not string
rmSync(join(dir, 'state'), { recursive: true, force: true });
write({
  books: [
    { id: 10, bookId: 'B10', epub: 'b10.enc' },
    { id: 9, bookId: 'B9', epub: 'b9.enc' },
  ],
});
check('id 9 sorts before id 10', nextBook()?.bookId, 'B9');

// 6. validation rejects bad config
write({ books: [{ id: 1, bookId: 'X' }] });
try {
  loadBooks();
  console.log('FAIL  missing epub should throw');
  failures += 1;
} catch (err) {
  console.log(`PASS  missing epub rejected -> ${err.message}`);
}

write({ books: [{ id: 1, bookId: 'X', epub: 'a' }, { id: 2, bookId: 'X', epub: 'b' }] });
try {
  loadBooks();
  console.log('FAIL  duplicate bookId should throw');
  failures += 1;
} catch (err) {
  console.log(`PASS  duplicate bookId rejected -> ${err.message}`);
}

// 7. unfinished state is reported, and a bare state file with no done flag is not treated as done
write({ books: [{ id: 1, bookId: 'B1', title: 'One', epub: 'a.enc' }] });
mkdirSync(join(dir, 'state'), { recursive: true });
writeFileSync(statePathFor('B1'), JSON.stringify({ nextChapter: 42 }));
check('partial state is not done', isDone({ bookId: 'B1' }), false);
check('partial state reports its chapter', stateFor({ bookId: 'B1' }).nextChapter, 42);
console.log('\nsummary:\n' + summary());

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nall book selection tests passed');
process.exit(failures ? 1 : 0);

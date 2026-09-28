import { loadBook } from './lib/epub.mjs';

const epubPath = process.argv[2];
const chapter = Number(process.argv[3] ?? 1);

if (!epubPath) {
  console.error('usage: node src/inspect.mjs <book.epub> [chapterNumber]');
  process.exit(1);
}

const book = loadBook(epubPath);
console.log(`spine entries: ${book.total}`);
console.log(`chapter file:  ${book.chapterFileName(chapter)}`);

for (const n of [1, 2, book.total]) {
  const ch = book.chapter(n);
  console.log(`\n--- chapter ${n} ---`);
  console.log(`title:     ${ch.title}`);
  console.log(`words:     ${ch.wordCount}`);
  console.log(`paragraphs:${ch.paragraphs.length}`);
  console.log(`first:     ${ch.paragraphs[0]?.slice(0, 120)}`);
  console.log(`last:      ${ch.paragraphs.at(-1)?.slice(0, 120)}`);
}

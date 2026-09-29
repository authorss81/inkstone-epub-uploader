import { Inkstone } from './lib/inkstone.mjs';

// Lists the unpublished drafts on a book, and optionally moves them to the trash with
// removeChapter. Trash is recoverable from Inkstone's own TRASH tab, so this is not a hard delete.
//
// Preview only by default. Nothing is deleted unless --delete is passed.

const DELETE = process.argv.includes('--delete');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1] : null;
})();

const bookId = process.env.INKSTONE_BOOK_ID;
if (!bookId) {
  console.error('INKSTONE_BOOK_ID is not set');
  process.exit(1);
}

const inkstone = new Inkstone({
  bookId,
  sessionPath: process.env.SESSION_PATH || null,
  artifactPath: process.env.ARTIFACT_DIR || 'artifacts',
  headless: process.env.HEADLESS !== '0',
  profileDir: process.env.PROFILE_DIR || null,
});

await inkstone.launch();

if (!(await inkstone.isAuthenticated())) {
  console.error('not signed in. Unpack the vault first, or set PROFILE_DIR.');
  await inkstone.close();
  process.exit(1);
}

const timezone = -(new Date().getTimezoneOffset() / 60).toFixed(2);

async function allDrafts() {
  const out = [];
  for (let pageNo = 1; pageNo <= 200; pageNo += 1) {
    const { body } = await inkstone.apiGet('/tauthorweb/chapter/paginateDraftList', {
      CBID: bookId,
      timezone,
      pageNo,
    });
    const result = body?.result;
    if (!result) {
      console.error('unexpected response from paginateDraftList:', JSON.stringify(body).slice(0, 500));
      break;
    }

    // Show the shape, because Inkstone's UI count and this endpoint have been seen to disagree.
    const keys = Object.keys(result);
    const records = result.records ?? result.list ?? [];
    console.error(
      `[cleanup] page ${pageNo}: result keys [${keys.join(', ')}] totalCount=${result.totalCount} records=${records.length}`,
    );
    if (pageNo === 1) {
      console.error(`[cleanup] first record: ${JSON.stringify(records[0] ?? null).slice(0, 400)}`);
    }

    out.push(...records);
    if (!records.length) break;
    if (result.totalCount !== undefined && out.length >= result.totalCount) break;
  }
  return out;
}

const drafts = await allDrafts();
console.log(`[cleanup] book ${bookId} has ${drafts.length} unpublished draft(s)`);

if (!drafts.length) {
  console.log('[cleanup] nothing to do');
  await inkstone.close();
  process.exit(0);
}

for (const d of drafts) {
  const title = (d.chapterTitle || d.title || '(untitled)').trim();
  console.log(`  CCID ${String(d.CCID).padEnd(22)} "${title}"  created ${d.createTime ?? d.create_time ?? '?'}`);
}

const targets = ONLY ? drafts.filter((d) => (d.chapterTitle || '').includes(ONLY)) : drafts;
if (ONLY) console.log(`[cleanup] --only "${ONLY}" narrowed ${drafts.length} drafts down to ${targets.length}`);

if (!DELETE) {
  console.log('');
  console.log('[cleanup] PREVIEW ONLY, nothing was deleted. Re-run with --delete to move these to the trash.');
  await inkstone.close();
  process.exit(0);
}

if (!targets.length) {
  console.log('[cleanup] nothing matched, nothing deleted');
  await inkstone.close();
  process.exit(0);
}

console.log('');
console.log(`[cleanup] moving ${targets.length} draft(s) to the trash (recoverable from the TRASH tab)...`);

let ok = 0;
let failed = 0;
for (const d of targets) {
  const { body } = await inkstone.apiPost('/tauthorweb/chapter/removeChapter', {
    CBID: bookId,
    CCID: d.CCID,
  });
  const flag = body?.result?.flag;
  const title = (d.chapterTitle || '').trim();
  if (flag) {
    ok += 1;
    console.log(`  removed "${title}"`);
  } else {
    failed += 1;
    console.error(`  FAILED "${title}": ${body?.result?.msg ?? body?.returnMsg ?? 'no reason given'}`);
  }
}

console.log(`[cleanup] done: ${ok} moved to trash, ${failed} failed`);
await inkstone.close();
process.exit(failed ? 1 : 0);

import { Inkstone } from './lib/inkstone.mjs';

// Read-only look at what Inkstone thinks the state of the account is: which novels exist, how many,
// and whether the account itself looks restricted. Nothing here writes anything.

const bookId = process.env.CHECK_BOOK_ID || '';
const MATCH = (process.env.MATCH_NAME || 'rain').toLowerCase();
const inkstone = new Inkstone({
  bookId: bookId || '0',
  sessionPath: process.env.SESSION_PATH || null,
  artifactPath: process.env.ARTIFACT_DIR || 'artifacts',
  profileDir: process.env.PROFILE_DIR || null,
});

await inkstone.launch();
try {
  const user = await inkstone.currentUser();
  if (!user) {
    console.error('[status] not signed in');
    process.exitCode = 1;
  } else {
    console.log('[status] signed in as:', user.name ?? user.penName ?? user.userName ?? JSON.stringify(user).slice(0, 120));
    for (const key of ['status', 'vipStatus', 'penName', 'isBanned', 'state']) {
      if (user[key] !== undefined) console.log(`[status]   ${key} = ${JSON.stringify(user[key])}`);
    }
  }

  const sources = [
    ['/tauthorweb/message/getBookList', {}],
    ['/ccauthorweb/promote/operation/getAuthorBookList', {}],
  ];
  for (const [path, params] of sources) {
    const { status, body } = await inkstone.apiGet(path, params);
    const result = body?.result;
    if (!result) {
      console.log(`[status] ${path} -> http ${status} returnCode ${body?.returnCode} ${body?.returnMsg ?? ''}`);
      continue;
    }
    const list = Array.isArray(result) ? result : result.records ?? result.list ?? [];
    console.log(`[status] ${path} -> ${Array.isArray(list) ? list.length : '?'} novel(s)`);
    if (Array.isArray(list)) {
      for (const b of list) {
        console.log(
          `         ${String(b.bookId).padEnd(20)} "${(b.bookName ?? b.name ?? '?').slice(0, 40)}" ` +
            `status=${b.status ?? '?'} words=${b.totalWords ?? b.wordCount ?? '?'} ` +
            `vipStatus=${b.vipStatus ?? '?'}`,
        );
      }
      // The id in this list is not always the same value as the CBID the chapter endpoints want,
      // so dump the full record for anything matching, rather than guessing which field to trust.
      const matches = list.filter((b) => {
        const name = String(b.bookName ?? b.name ?? '');
        return name.toLowerCase().includes(MATCH) || String(b.bookId) === bookId;
      });
      for (const m of matches) {
        console.log(`[status] full record for "${m.bookName ?? m.name}" matching "${MATCH}":`);
        console.log(`[status]   ${JSON.stringify(m)}`);
      }
    } else {
      console.log(`         keys: ${Object.keys(result).join(', ')}`);
    }
  }

  if (bookId) {
    const { body } = await inkstone.apiGet('/tauthorweb/chapter/getBookChapterList', { CBID: bookId });
    const r = body?.result;
    if (r) {
      const list = r.chapters ?? r.records ?? [];
      console.log(`[status] book ${bookId}: ${Array.isArray(list) ? list.length : JSON.stringify(r).slice(0, 200)}`);
    } else {
      console.log(`[status] book ${bookId}: returnCode ${body?.returnCode} ${body?.returnMsg ?? ''}`);
    }
  }
} finally {
  await inkstone.close();
}

import { Inkstone } from './lib/inkstone.mjs';

// READ-ONLY. Opens the real "create novel" form in a signed-in browser and reports what it would
// submit: the form field names, what each select offers, and what the create endpoints return.
// Nothing is typed, nothing is submitted, and no novel is created.

const bookId = process.env.CHECK_BOOK_ID || '0';
const inkstone = new Inkstone({
  bookId,
  sessionPath: process.env.SESSION_PATH || null,
  artifactPath: process.env.ARTIFACT_DIR || 'artifacts',
  profileDir: process.env.PROFILE_DIR || null,
});

await inkstone.launch();
try {
  if (!(await inkstone.isAuthenticated())) {
    const which = process.env.ACCOUNT_NAME || 'this';
    console.error(`[probe] the stored session for "${which}" is no longer valid.`);
    console.error('[probe] Inkstone sessions age out, and a session captured a day or two ago is normally');
    console.error('[probe] dead. Sign in to that account in a normal browser, export the cookies, and:');
    console.error(`[probe]   node src/import-cookies.mjs "C:\\path\\to\\cookies.json" --account ${which}`);
    console.error('[probe] then git add vault && git commit -m "chore: refresh session" && git push');
    await inkstone.close();
    process.exit(1);
  }

  // The endpoints createNovel will need, called on their own.
  const pre = await inkstone.apiGet('/tauthorweb/novel/getSaveBookPreInfo', {});
  console.log(`[probe] getSaveBookPreInfo -> returnCode ${pre.body?.returnCode} ${pre.body?.returnMsg ?? ''}`);
  const preResult = pre.body?.result ?? {};
  console.log(`[probe]   keys: ${Object.keys(preResult).join(', ')}`);
  console.log(`[probe]   token present: ${Boolean(preResult.token)}`);
  for (const key of ['novelLanguage', 'openTagSwitch', 'novelRangeList', 'relationshipEnum', 'lengthType']) {
    if (preResult[key] !== undefined) {
      console.log(`[probe]   ${key} = ${JSON.stringify(preResult[key]).slice(0, 200)}`);
    }
  }

  const cats = await inkstone.apiGet('/tauthorweb/novel/categories', { freetype: 'novel', language: 'en' });
  const catList = cats.body?.result;
  console.log(`[probe] novel/categories -> returnCode ${cats.body?.returnCode}, ${Array.isArray(catList) ? catList.length : '?'} categories`);
  if (Array.isArray(catList)) {
    for (const c of catList.slice(0, 12)) {
      console.log(`[probe]   ${String(c.id ?? c.categoryId).padEnd(8)} ${String(c.name ?? c.categoryName ?? '').slice(0, 40)}`);
    }
  }

  // Open the form and read it. No interaction that submits.
  console.log('\n[probe] opening the create-novel form...');
  await inkstone.page.goto('https://inkstone.webnovel.com/novels/create', { waitUntil: 'domcontentloaded' });
  await inkstone.page.waitForTimeout(8000);

  const shape = await inkstone.page.evaluate(() => {
    const fields = [...document.querySelectorAll('input, textarea')].map((el) => ({
      tag: el.tagName,
      type: el.type,
      id: el.id,
      name: el.getAttribute('name'),
      placeholder: el.placeholder,
      maxLength: el.maxLength,
    }));
    const labels = [...document.querySelectorAll('label, .ant-form-item-label label')].map((l) =>
      (l.textContent || '').replace(/\s+/g, ' ').trim(),
    );
    const selects = [...document.querySelectorAll('.ant-select')].map((s) => ({
      placeholder: (s.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    }));
    const buttons = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim());
    return { fields, labels, selects, buttons, url: location.href };
  });

  console.log(`[probe] form url: ${shape.url}`);
  console.log(`[probe] field labels: ${shape.labels.filter(Boolean).join(' | ') || '(none found)'}`);
  console.log(`[probe] selects: ${shape.selects.map((s) => s.placeholder).join(' | ') || '(none)'}`);
  console.log(`[probe] buttons: ${shape.buttons.filter(Boolean).join(' | ') || '(none)'}`);
  console.log('[probe] input fields (antd derives ids from the form field path, so these ARE the payload names):');
  for (const f of shape.fields) {
    console.log(`[probe]   <${f.tag}> id="${f.id}" name="${f.name}" type=${f.type} maxlen=${f.maxLength} placeholder="${f.placeholder ?? ''}"`);
  }

  await inkstone.snapshot('create-novel-form');
} finally {
  await inkstone.close();
}
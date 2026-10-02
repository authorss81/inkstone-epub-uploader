import { Inkstone } from './lib/inkstone.mjs';

// READ-ONLY. Prints every value the create-novel form will actually accept: the genre list per
// leading gender, the languages, the lengths, the warning notices, the tag categories and the tags
// themselves. Nothing is created and nothing is typed.
//
// The point is that these are closed lists. Guessing an id or inventing a tag produces a novel that
// is miscategorised or carries a tag the site never had.

const account = process.env.ACCOUNT_NAME || 'this';
const inkstone = new Inkstone({
  bookId: '0',
  sessionPath: process.env.SESSION_PATH || null,
  artifactPath: process.env.ARTIFACT_DIR || 'artifacts',
});

const GENDERS = [
  ['male', 1],
  ['female', 2],
  ['common', 3],
];
const FREE_TYPE_NOVEL = 5;

function dump(body, key = 'result') {
  return body?.returnCode === 200 ? body[key] : null;
}

await inkstone.launch();
try {
  if (!(await inkstone.isAuthenticated())) {
    console.error(`[meta] the stored session for "${account}" is not signed in.`);
    process.exit(1);
  }

  const pre = await inkstone.apiGet('/tauthorweb/novel/getSaveBookPreInfo', {});
  const result = pre.body?.result ?? {};
  console.log(`[meta] getSaveBookPreInfo -> ${pre.body?.returnCode}`);

  console.log('\n[meta] === LANGUAGES ===');
  for (const l of result.novelLanguage ?? []) {
    console.log(`[meta]   id=${String(l.id).padEnd(4)} ${l.language} (${l.shortName})`);
  }

  console.log('\n[meta] === WARNING NOTICE (ageGroup) ===');
  for (const r of result.novelRangeList ?? []) {
    console.log(`[meta]   type=${String(r.type).padEnd(4)} ${r.value}`);
  }

  console.log('\n[meta] === LENGTH (expectedLength) ===');
  for (const [v, n] of [[3, 'Novels'], [2, 'Short Stories'], [1, 'Super-Short-Stories']]) {
    console.log(`[meta]   value=${String(v).padEnd(4)} ${n}`);
  }

  console.log('\n[meta] === GENRES, per leading gender ===');
  const genreIds = new Set();
  for (const [name, value] of GENDERS) {
    const params = { freetype: FREE_TYPE_NOVEL, language: 1 };
    if (value !== 3) params.sexattr = name;
    const res = await inkstone.apiGet('/tauthorweb/novel/categories', params);
    const list = dump(res.body);
    console.log(`[meta] gender=${name} -> ${res.body?.returnCode}, ${Array.isArray(list) ? list.length : 0} genres`);
    for (const c of list ?? []) {
      genreIds.add(c.cateid);
      console.log(`[meta]   ${String(c.cateid).padEnd(8)} ${c.catename}`);
    }
  }
  console.log(`[meta] (${genreIds.size} distinct genre ids across all three genders)`);

  console.log('\n[meta] === TAG CATEGORIES ===');
  const cats = await inkstone.apiGet('/ccauthorweb/novel/getAllTagCats', {
    freeType: FREE_TYPE_NOVEL,
    language: 1,
  });
  const tagCats = dump(cats.body) ?? [];
  console.log(`[meta] getAllTagCats -> ${cats.body?.returnCode}, ${tagCats.length} categories`);
  console.log(`[meta] raw first entry: ${JSON.stringify(tagCats[0] ?? null)}`);
  for (const c of tagCats) {
    console.log(`[meta]   ${JSON.stringify(c)}`);
  }

  // The tags themselves. getPopularTags wants a NUMERIC gender, not a word: passing "male" comes
  // back as returnCode 4002, which is the API saying it could not convert the parameter.
  console.log('\n[meta] === TAGS (popular, per category) ===');
  const total = new Set();
  const catOf = (c) => c.tagCatId ?? c.id ?? c.catid ?? c.catId;
  const wanted = [
    { id: 0, name: 'all' },
    ...tagCats.map((c) => ({ id: catOf(c), name: c.tagCatName ?? c.catename ?? c.name ?? catOf(c) })),
  ];
  for (const [gname, gvalue] of GENDERS) {
    for (const cat of wanted) {
      const res = await inkstone.apiGet('/ccauthorweb/novel/getPopularTags', {
        gender: gvalue,
        language: 1,
        freeType: FREE_TYPE_NOVEL,
        tagCatId: cat.id,
      });
      const list = dump(res.body);
      if (!Array.isArray(list)) {
        console.log(`[meta] gender=${gname} cat=${cat.name} -> ${res.body?.returnCode} (${res.body?.returnMsg ?? ''})`);
        continue;
      }
      console.log(`[meta] gender=${gname} cat=${cat.name} -> ${list.length} tags`);
      for (const t of list) {
        total.add(`${gname}:${t.tagId}:${t.tagName}`);
        console.log(`[meta]   ${String(t.tagId).padEnd(8)} ${t.tagName}`);
      }
    }
  }
  console.log(`[meta] (${total.size} tag rows printed; the form allows at most 10 tags per novel)`);

  console.log('\n[meta] === RELATIONSHIP ===');
  for (const r of result.relationshipEnum ?? []) {
    console.log(`[meta]   type=${String(r.type).padEnd(4)} ${r.name}`);
  }
  console.log(`[meta] openTagSwitch = ${result.openTagSwitch}`);
} finally {
  await inkstone.close();
}
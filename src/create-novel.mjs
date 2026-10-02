import { Inkstone } from './lib/inkstone.mjs';
import { readEpubMetadata } from './lib/epub-meta.mjs';

// Creates a novel on Inkstone, then prints the CBID so it can be queued for uploading.
//
//   node src/create-novel.mjs --epub "C:\books\a.epub" --create
//
// Everything comes from the EPUB's own metadata when it is there, and command line flags win over it.
// See src/lib/epub-meta.mjs for the field names an EPUB has to carry.
//
// Previews by default. Pass --create to actually create it.
//
// Every enum value here was read out of the live create form, not guessed:
//   freeType       5 = novel, 8 = fanfic        (constants-CyPiuB-B / utils-BB24B4f5)
//   gender         1 = male, 2 = female, 3 = common
//   expectedLength 3 = Novels, 2 = Short Stories, 1 = Super-Short-Stories
//   ageGroup       1 = General Audiences .. 5 = No One 17 and Under
// The form refuses to submit without a leading gender, and the genre list is chosen from it, so
// --genre is resolved against the list the API returns for that gender.

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
}
const has = (name) => args.includes(name);

const FREE_TYPE = { novel: 5, fanfic: 8 };
const GENDER = { male: 1, female: 2, common: 3, 'male oriented': 1, 'female oriented': 2 };
const LENGTH = { novels: 3, novel: 3, short: 2, 'short stories': 2, 'super short': 1, 'super-short-stories': 1 };
const AGE_GROUP = {
  'general audiences': 1,
  'parental guidance suggested': 2,
  'parents strongly cautioned': 3,
  restricted: 4,
  'no one 17 and under admitted': 5,
};

const epubPath = flag('--epub');
const fromEpub = epubPath ? readEpubMetadata(epubPath) : null;
if (epubPath && !fromEpub) {
  console.error(`[create] could not read metadata out of ${epubPath}`);
  process.exit(1);
}
const pick = (flagValue, epubValue) => flagValue || epubValue || '';

const title = pick(flag('--title'), fromEpub?.title);
const genre = pick(flag('--genre'), fromEpub?.genre);
const account = flag('--account') || 'main';
const synopsis = pick(flag('--synopsis'), fromEpub?.synopsis);
const abbreviation = pick(flag('--abbreviation'), fromEpub?.abbreviation);
const tags = pick(flag('--tags'), (fromEpub?.subjects || []).join(','))
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
const genderName = pick(flag('--gender'), fromEpub?.gender || 'male').toLowerCase();
const lengthName = pick(flag('--length'), fromEpub?.length || 'novels').toLowerCase();
const ageName = pick(flag('--warning'), fromEpub?.warning || 'general audiences').toLowerCase();
const language = Number(flag('--language') || 1);
const shouldCreate = has('--create');

if (fromEpub) {
  console.log(`[create] metadata read from ${epubPath}`);
  for (const k of ['title', 'synopsis', 'genre', 'gender', 'length', 'warning', 'abbreviation']) {
    const v = k === 'title' || k === 'synopsis' ? fromEpub[k] : fromEpub[k];
    console.log(`[create]   ${k.padEnd(13)} ${v ? JSON.stringify(String(v).slice(0, 90)) : '(missing)'}`);
  }
  console.log(`[create]   subjects      ${fromEpub.subjects.length ? JSON.stringify(fromEpub.subjects) : '(missing)'}`);
  console.log('');
}

if (!title) {
  console.error('usage: node src/create-novel.mjs --epub "book.epub" [--create]');
  console.error('   or: node src/create-novel.mjs --title "Name" --genre Fantasy [--create]');
  console.error('  --gender male|female|common   --length novels|short|super-short');
  console.error('  --warning "general audiences"  --synopsis "..."  --tags "a,b,c"');
  console.error('  --abbreviation ABC  --account name');
  process.exit(1);
}
if (!synopsis) {
  console.error('[create] no synopsis. Put <dc:description> in the EPUB, or pass --synopsis.');
  console.error('[create] Inkstone shows the synopsis to readers before anything else, so this one matters.');
  process.exit(1);
}
if (!(genderName in GENDER)) {
  console.error(`--gender must be one of: ${Object.keys(GENDER).join(', ')}`);
  process.exit(1);
}
if (!(lengthName in LENGTH)) {
  console.error(`--length must be one of: ${Object.keys(LENGTH).join(', ')}`);
  process.exit(1);
}
if (!(ageName in AGE_GROUP)) {
  console.error(`--warning must be one of: ${Object.keys(AGE_GROUP).join(', ')}`);
  process.exit(1);
}
if (title.length > 70) {
  console.error(`the title is ${title.length} characters, the form allows 70`);
  process.exit(1);
}
if (abbreviation.length > 15) {
  console.error(`the abbreviation is ${abbreviation.length} characters, the form allows 15`);
  process.exit(1);
}

const gender = GENDER[genderName];
const inkstone = new Inkstone({
  bookId: '0',
  sessionPath: process.env.SESSION_PATH || null,
  profileDir: process.env.PROFILE_DIR || null,
});

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

await inkstone.launch();
try {
  if (!(await inkstone.isAuthenticated())) {
    console.error(`[create] the session for "${account}" is not signed in.`);
    console.error(`[create]   node src/import-cookies.mjs "cookies.json" --account ${account}`);
    console.error('[create] then commit and run npm run push:vault');
    process.exit(1);
  }

  const pre = await inkstone.apiGet('/tauthorweb/novel/getSaveBookPreInfo', {});
  const token = pre.body?.result?.token;
  if (!token) {
    console.error(`[create] no create token (returnCode ${pre.body?.returnCode} ${pre.body?.returnMsg ?? ''})`);
    process.exit(1);
  }
  console.log('[create] create token acquired');

  // The genre list depends on the leading gender, exactly as the form does.
  const params = { freetype: FREE_TYPE.novel, language };
  if (gender !== GENDER.common) params.sexattr = gender === GENDER.male ? 'male' : 'female';
  const cats = await inkstone.apiGet('/tauthorweb/novel/categories', params);
  const list = cats.body?.result;
  if (!Array.isArray(list)) {
    console.error(`[create] could not list genres (returnCode ${cats.body?.returnCode} ${cats.body?.returnMsg ?? ''})`);
    console.error(`[create] tried: ${JSON.stringify(params)}`);
    process.exit(1);
  }

  // The API returns cateid/catename; the form renames them to categoryId/categoryName.
  const genres = list.map((c) => ({
    id: c.cateid ?? c.categoryId ?? c.id,
    name: c.catename ?? c.categoryName ?? c.name,
  }));
  console.log(`[create] ${genres.length} genres available for gender="${genderName}"`);
  for (const g of genres) console.log(`[create]   ${String(g.id).padEnd(8)} ${g.name}`);

  if (genres.some((g) => g.id === undefined || g.id === null)) {
    console.error('[create] the genre list had no ids, refusing to guess');
    process.exit(1);
  }

  if (!genre) {
    console.error('[create] --genre is required, pick one of the ids above');
    process.exit(1);
  }
  const wanted = genres.find(
    (g) => String(g.id) === String(genre) || (g.name || '').toLowerCase().replace(/\(.*\)/, '').trim() === genre.toLowerCase(),
  );
  if (!wanted) {
    console.error(`[create] no genre matches "${genre}". Use an id from the list above.`);
    process.exit(1);
  }

  // Tags are a closed list, so resolve them against the catalogue the site actually serves rather
  // than searching and hoping. An unknown name is refused, because a made-up tag silently does
  // nothing for discoverability and the form caps a novel at 10 tags.
  let tagIds = [];
  if (tags.length) {
    const popular = await inkstone.apiGet('/ccauthorweb/novel/getPopularTags', {
      gender,
      language,
      freeType: FREE_TYPE.novel,
      tagCatId: 0,
    });
    const catalogue = Array.isArray(popular.body?.result) ? popular.body.result : [];
    if (!catalogue.length) {
      console.error('[create] could not load the tag catalogue, refusing to guess tag ids');
      process.exit(1);
    }
    const byName = new Map(catalogue.map((t) => [String(t.tagName).toLowerCase(), t.tagId]));
    for (const tag of tags) {
      const id = byName.get(tag.toLowerCase());
      if (id) {
        tagIds.push(id);
        console.log(`[create] tag "${tag}" -> ${id}`);
      } else {
        console.error(`[create] "${tag}" is not a tag Inkstone offers. Refusing rather than dropping it.`);
        console.error(`[create] available: ${catalogue.map((t) => t.tagName).join(', ')}`);
        process.exit(1);
      }
    }
    if (tagIds.length > 10) {
      console.error(`[create] ${tagIds.length} tags, the form allows at most 10`);
      process.exit(1);
    }
  }

  const payload = {
    bookTitle: title,
    freeType: FREE_TYPE.novel,
    gender,
    categoryId: wanted.id,
    language,
    synopsis: clean(synopsis),
    expectedLength: LENGTH[lengthName],
    ageGroup: AGE_GROUP[ageName],
    contestId: '',
    abbreviation: clean(abbreviation),
    authorTagIds: tagIds.join(','),
    token,
  };

  console.log('\n[create] payload:');
  console.log(JSON.stringify({ ...payload, token: `${String(token).slice(0, 12)}...` }, null, 2));

  if (!shouldCreate) {
    console.log('\n[create] preview only. Re-run with --create to actually create this novel.');
    process.exit(0);
  }

  const res = await inkstone.apiPost('/tauthorweb/novel/createNovel', payload);
  const result = res.body?.result ?? {};
  if (res.body?.returnCode !== 200 || !result.CBID) {
    console.error(`[create] failed (returnCode ${res.body?.returnCode}): ${res.body?.returnMsg ?? 'no message'}`);
    process.exit(1);
  }

  console.log('\n[create] created.');
  console.log(`CBID=${result.CBID}`);
  console.log(`https://inkstone.webnovel.com/novels/view/${result.CBID}`);
} finally {
  await inkstone.close();
}
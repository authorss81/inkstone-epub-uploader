import { writeEpubMetadata, addCoverImage, readEpubMetadata } from './lib/epub-meta.mjs';

// Puts the metadata a novel needs into an EPUB, so the rest of the pipeline can just read the file
// and nobody has to repeat the same facts on a command line later.
//
//   node src/set-epub-metadata.mjs "C:\books\a.epub" \
//     --synopsis "..." --genre Fantasy --gender male --tags "Detective,Magic" \
//     --cover "C:\covers\a.png"
//
// Rewrites only the OPF metadata block, so the manifest, spine and every chapter stay untouched.

const args = process.argv.slice(2);
const epub = args.find((a) => !a.startsWith('--') && /\.(epub)$/i.test(a));
function flag(name) {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
}

if (!epub) {
  console.error('usage: node src/set-epub-metadata.mjs <book.epub> [--synopsis ...] [--genre ...]');
  console.error('  --synopsis "..."        -> <dc:description>, what readers see first');
  console.error('  --genre Fantasy        -> inkstone:genre, by name or id');
  console.error('  --gender male|female|common');
  console.error('  --length novels|short|super-short');
  console.error('  --warning "general audiences"');
  console.error('  --abbreviation ABC');
  console.error('  --tags "a,b,c"         -> one <dc:subject> each');
  console.error('  --cover "image.png"    -> embeds a cover image');
  console.error('  --title "Name"');
  console.error('  --language en');
  console.error('  --show                 print what the file carries now, change nothing');
  process.exit(1);
}

if (flag('--show') || args.length === 2) {
  const meta = readEpubMetadata(epub);
  if (!meta) {
    console.error(`[meta] ${epub} has no OPF to read`);
    process.exit(1);
  }
  console.log(`[meta] ${epub}`);
  for (const key of ['title', 'synopsis', 'language', 'creator', 'genre', 'gender', 'length', 'warning', 'abbreviation']) {
    const value = meta[key];
    const text = value ? String(value) : '(missing)';
    console.log(`[meta]   ${key.padEnd(13)} ${text.length > 100 ? `${text.slice(0, 100)}...` : text}`);
  }
  console.log(`[meta]   subjects      ${meta.subjects.length ? meta.subjects.join(', ') : '(missing)'}`);
  const before = { ...meta };
  void before;
  process.exit(0);
}

const tags = flag('--tags');
const fields = {
  title: flag('--title'),
  synopsis: flag('--synopsis'),
  language: flag('--language'),
  subjects: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : null,
  genre: flag('--genre'),
  gender: flag('--gender'),
  length: flag('--length'),
  warning: flag('--warning'),
  abbreviation: flag('--abbreviation'),
};

const changed = Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && v !== '');
if (!changed.length && !flag('--cover')) {
  console.error('[meta] nothing to change. Pass at least one field, or --show to inspect the file.');
  process.exit(1);
}

const cover = flag('--cover');
if (cover) {
  const ext = (cover.match(/\.(\w+)$/)?.[1] || 'png').toLowerCase();
  const href = addCoverImage(epub, cover, ext);
  console.log(`[meta] embedded ${cover} as ${href}`);
}

writeEpubMetadata(epub, fields);
console.log(`[meta] updated ${changed.map(([k]) => k).join(', ')} in ${epub}`);

const after = readEpubMetadata(epub);
const missing = ['synopsis', 'genre'].filter((k) => !after[k]);
console.log(`[meta] still missing: ${missing.length ? missing.join(', ') : 'nothing required'}`);
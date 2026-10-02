import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

// Reads and writes the book metadata an Inkstone novel needs, straight from the EPUB's OPF, so the
// pipeline never has to be told the same things twice on a command line.
//
// The mapping, which is what an EPUB has to carry for this to be automatic:
//
//   <dc:title>                     -> bookTitle
//   <dc:description>               -> synopsis
//   <dc:language>                  -> language (shortName, e.g. "en")
//   <dc:subject> (repeatable)      -> tags
//   <meta property="inkstone:genre">      -> categoryId, by name or id
//   <meta property="inkstone:gender">     -> male | female | common
//   <meta property="inkstone:length">     -> novels | short | super-short
//   <meta property="inkstone:warning">    -> general audiences | parental guidance suggested | ...
//   <meta property="inkstone:abbreviation"> -> abbreviation
//   an EPUB cover image             -> cover (see coverPath)

const INKSTONE_PROPS = ['genre', 'gender', 'length', 'warning', 'abbreviation'];

function locateOpf(entries) {
  const container = entries['META-INF/container.xml'];
  if (container) {
    const m = strFromU8(container).match(/full-path\s*=\s*"([^"]+)"/i);
    if (m && entries[m[1]]) return m[1];
  }
  const guess = Object.keys(entries).find((k) => k.toLowerCase().endsWith('.opf'));
  return guess || null;
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Turn a page's XHTML into plain paragraphs. These books keep their title page and their synopsis on
// their own pages rather than in the OPF, so the reader has to look at both.
function pageParagraphs(html) {
  const body = html.replace(/<head[\s\S]*?<\/head>/i, '');
  return [...body.matchAll(/<(?:p|h1|h2|div)[^>]*>([\s\S]*?)<\/(?:p|h1|h2|div)>/gi)]
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

function findPage(entries, name) {
  const key = Object.keys(entries).find((k) => k.toLowerCase().endsWith(`/${name}.xhtml`));
  return key ? strFromU8(entries[key]) : null;
}

// Everything the create step can learn from the file alone.
export function readEpubMetadata(epubPath) {
  const entries = unzipSync(new Uint8Array(readFileSync(epubPath)));
  const opfPath = locateOpf(entries);
  if (!opfPath) return null;
  const opf = strFromU8(entries[opfPath]);

  const one = (re) => opf.match(re)?.[1]?.trim() ?? '';
  const all = (re) => [...opf.matchAll(new RegExp(re.source, `${re.flags}g`))].map((m) => m[1].trim()).filter(Boolean);

  const meta = { opfPath, entries, title: '', synopsis: '', language: '', creator: '', subjects: [] };
  meta.title = one(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  meta.synopsis = one(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i);
  meta.language = one(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i);
  meta.creator = one(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
  meta.subjects = all(/<dc:subject[^>]*>([\s\S]*?)<\/dc:subject>/i);
  for (const p of INKSTONE_PROPS) {
    meta[p] = one(new RegExp(`<meta[^>]*property=["']inkstone:${p}["'][^>]*>([\\s\\S]*?)</meta>`, 'i'));
  }

  // These books put the synopsis on their own page and describe themselves on a title page:
  //   <h1> title </h1> <p>author</p> <p>N chapters</p> <p>genre line</p> <hr/> <p>blurb</p>
  const titlePage = findPage(entries, 'title');
  if (titlePage) {
    // pageParagraphs also picks up the <h1>, so drop it before reading the lines underneath it.
    const heading = titlePage.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '').trim();
    const parts = pageParagraphs(titlePage).filter((p) => p !== heading);
    if (heading && !meta.title) meta.title = heading;

    const [authorLine, ...rest] = parts;
    if (authorLine && !meta.creator) meta.creator = authorLine;

    const chapters = rest.find((p) => /^\d+\s+chapters?$/i.test(p));
    if (chapters) meta.chapterCount = Number(chapters.match(/\d+/)[0]);

    const genreLine = rest.find((p) => /[a-z]/i.test(p) && p.includes('/') && p.length < 80);
    if (genreLine) meta.genreLine = genreLine;

    const blurb = rest.filter((p) => p !== chapters && p !== genreLine);
    if (blurb.length) meta.blurb = blurb.join(' ');
  }

  const synopsisPage = findPage(entries, 'synopsis');
  if (synopsisPage) {
    const paras = pageParagraphs(synopsisPage).filter((p) => !/^synopsis$/i.test(p));
    if (paras.length) meta.synopsisPage = paras.join('\n\n');
    // The OPF description wins if it exists, otherwise fall back to the synopsis page.
    if (!meta.synopsis) meta.synopsis = meta.synopsisPage;
  }

  return meta;
}

// Rewrites the OPF metadata in place and writes the EPUB back. Only touches the metadata block, so
// the manifest, spine and every chapter stay byte-identical.
export function writeEpubMetadata(epubPath, fields = {}) {
  const entries = unzipSync(new Uint8Array(readFileSync(epubPath)));
  const opfPath = locateOpf(entries);
  if (!opfPath) throw new Error(`${epubPath} has no OPF file, so there is nowhere to put metadata`);
  let opf = strFromU8(entries[opfPath]);

  function setDc(tag, value) {
    if (!value) return;
    const re = new RegExp(`<dc:${tag}[^>]*>[\\s\\S]*?</dc:${tag}>`, 'i');
    if (re.test(opf)) opf = opf.replace(re, `<dc:${tag}>${esc(value)}</dc:${tag}>`);
    else opf = opf.replace(/(<\/metadata>)/i, `  <dc:${tag}>${esc(value)}</dc:${tag}>\n  $1`);
  }
  function setProp(prop, value) {
    if (!value) return;
    const re = new RegExp(`<meta[^>]*property=["']inkstone:${prop}["'][^>]*/?>`, 'i');
    if (re.test(opf)) opf = opf.replace(re, `<meta property="inkstone:${prop}">${esc(value)}</meta>`);
    else opf = opf.replace(/(<\/metadata>)/i, `  <meta property="inkstone:${prop}">${esc(value)}</meta>\n  $1`);
  }

  setDc('title', fields.title);
  setDc('description', fields.synopsis);
  setDc('language', fields.language);
  if (fields.subjects?.length) {
    opf = opf.replace(/<dc:subject[^>]*>[\s\S]*?<\/dc:subject>/gi, '');
    const block = fields.subjects.map((s) => `  <dc:subject>${esc(s)}</dc:subject>`).join('\n');
    opf = opf.replace(/(<\/metadata>)/i, `${block}\n  $1`);
  }
  for (const p of INKSTONE_PROPS) setProp(p, fields[p]);

  entries[opfPath] = strToU8(opf);
  // mimetype must stay first and stored, or strict readers reject the file.
  const ordered = {};
  if (entries.mimetype) ordered.mimetype = entries.mimetype;
  for (const [k, v] of Object.entries(entries)) if (k !== 'mimetype') ordered[k] = v;
  writeFileSync(epubPath, Buffer.from(zipSync(ordered, { level: 0 })));
  return fields;
}

// --cover adds an image to the EPUB so create-novel can upload one.
export function addCoverImage(epubPath, imagePath, extension = 'png') {
  const entries = unzipSync(new Uint8Array(readFileSync(epubPath)));
  const opfPath = locateOpf(entries);
  if (!opfPath) throw new Error(`${epubPath} has no OPF file`);
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) + '/' : '';
  const href = `${baseDir}cover.${extension}`;
  const id = 'cover-image';

  entries[href] = new Uint8Array(readFileSync(imagePath));
  let opf = strFromU8(entries[opfPath]);
  if (!/<meta[^>]*name=["']cover["']/i.test(opf)) {
    opf = opf.replace(/(<\/metadata>)/i, `  <meta name="cover" content="${id}"/>\n  $1`);
  }
  if (!new RegExp(`id=["']${id}["']`).test(opf)) {
    const type = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : 'image/png';
    opf = opf.replace(/(<manifest[^>]*>)/i, `$1\n    <item id="${id}" href="${href}" media-type="${type}"/>`);
  }
  entries[opfPath] = strToU8(opf);

  const ordered = {};
  if (entries.mimetype) ordered.mimetype = entries.mimetype;
  for (const [k, v] of Object.entries(entries)) if (k !== 'mimetype') ordered[k] = v;
  writeFileSync(epubPath, Buffer.from(zipSync(ordered, { level: 0 })));
  return href;
}
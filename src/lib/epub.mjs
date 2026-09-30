import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { parse } from 'node-html-parser';

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'UL', 'OL', 'BLOCKQUOTE', 'SECTION', 'ARTICLE',
  'PRE', 'TABLE', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION', 'HR',
]);

function readEntry(entries, name) {
  const data = entries[name];
  if (!data) return null;
  return strFromU8(data);
}

function resolvePath(baseDir, href) {
  const decoded = decodeURIComponent(href.split('#')[0]);
  const parts = (baseDir ? `${baseDir}/` : '').split('/').filter(Boolean);
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

const NON_CHAPTER =
  /(^|[-_.])(cover|title|titlepage|title-page|synopsis|blurb|summary|introduction|foreword|frontmatter|front-matter|toc|nav|copyright|acknowledg(?:e)?ments?|contents|legal|dedicat(?:ion|e)|about|intro(?:duction)?|preface|book-info|metadata)([-_.]|\d*\.[^.]*$)/i;

function looksLikeFrontMatter(href) {
  const name = href.split('/').pop() ?? href;
  return NON_CHAPTER.test(name);
}

function readSpine(entries) {
  const container = readEntry(entries, 'META-INF/container.xml');
  let opfPath = null;
  if (container) {
    const rootfile = parse(container).querySelector('rootfile');
    if (rootfile) opfPath = rootfile.getAttribute('full-path');
  }

  if (opfPath && entries[opfPath]) {
    const opf = parse(readEntry(entries, opfPath));
    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const manifest = new Map();
    const skip = new Set();

    for (const item of opf.querySelectorAll('manifest > item')) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (!id || !href) continue;
      const full = resolvePath(baseDir, href);
      manifest.set(id, full);
      const props = item.getAttribute('properties') ?? '';
      if (/cover-image/i.test(props) || looksLikeFrontMatter(full)) skip.add(id);
    }

    const spine = [];
    for (const ref of opf.querySelectorAll('spine > itemref')) {
      const idref = ref.getAttribute('idref');
      if (skip.has(idref) || ref.getAttribute('linear') === 'no') continue;
      const href = manifest.get(idref);
      if (href && entries[href]) spine.push(href);
    }
    if (spine.length) return spine;
  }

  return Object.keys(entries)
    .filter((name) => /\.(x?html?|xml)$/i.test(name) && !/^META-INF|container\.xml/i.test(name))
    .sort((a, b) => {
      const na = Number((a.match(/(\d+)(?=\.[^.]+$)/) || [])[1] ?? NaN);
      const nb = Number((b.match(/(\d+)(?=\.[^.]+$)/) || [])[1] ?? NaN);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a.localeCompare(b);
    });
}

function extractParagraphs(bodyEl) {
  const raw = [];
  let cur = '';

  const flush = () => {
    for (const line of cur.split('\n')) {
      const text = line
        .replace(/\u00a0/g, ' ')
        .replace(/\u200b/g, '')
        .replace(/[ \t\f\v]+/g, ' ')
        .trim();
      if (text) raw.push(text);
    }
    cur = '';
  };

  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        cur += child.text;
        continue;
      }
      const tag = (child.rawTagName || '').toUpperCase();
      if (tag === 'BR') {
        cur += '\n';
        continue;
      }
      if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'STYLE') continue;
      if (BLOCK_TAGS.has(tag)) {
        visit(child);
        flush();
        continue;
      }
      visit(child);
    }
  };

  visit(bodyEl);
  flush();
  return raw;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STRIP_NUMBER = process.env.TITLE_STRIP_NUMBER !== '0';

// "Chapter 12: Foo", "Chapter 12 Foo", "Chapter 12 - Foo" -> "Foo". Requires digits so that a
// title like "Chapter of the End" is left alone.
const LEADING_NUMBER = /^chapter\s+\d+\b\s*[^\w\s]?\s*/i;

function cleanTitle(value, index) {
  const original = value.replace(/\s+/g, ' ').trim();
  if (!STRIP_NUMBER) return original || `Chapter ${index}`;

  let title = original;
  for (let i = 0; i < 2; i += 1) {
    const next = title.replace(LEADING_NUMBER, '').trim();
    if (next === title) break;
    title = next;
  }
  return title || original || `Chapter ${index}`;
}

export function loadBook(epubPath) {
  const bytes = readFileSync(epubPath);
  const entries = unzipSync(new Uint8Array(bytes), {
    filter: (file) => /\.(xhtml|html|xml|opf|css|jpg|png|webp|gif|svg|ttf|otf|woff2?|txt|json)$/i.test(file.name),
  });

  const spine = readSpine(entries);

  return {
    total: spine.length,
    chapterFileName(n) {
      return spine[n - 1] ?? null;
    },
    chapter(n) {
      const name = spine[n - 1];
      if (!name) throw new Error(`Chapter ${n} is out of range (book has ${spine.length})`);

      const doc = parse(readEntry(entries, name), {
        blockTextElements: { script: 0, noscript: 0, style: 0, pre: 1 },
      });

      const headTitle = doc.querySelector('head title');
      const h1 = doc.querySelector('body h1');
      const body = doc.querySelector('body') ?? doc;
      h1?.remove();

      const title = cleanTitle((headTitle ?? h1)?.text ?? '', n);

      const paragraphs = extractParagraphs(body);
      const wordCount = paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
      const html = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');

      return { index: n, source: name, title, paragraphs, html, wordCount };
    },
  };
}

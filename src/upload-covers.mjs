import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadBooks } from './lib/books.mjs';
import { Inkstone } from './lib/inkstone.mjs';

// Sets the cover image on novels that are already created.
//
//   node src/upload-covers.mjs --account second --images "C:\covers" [--only "The Ninth Furnace"]
//
// Runs on your machine, not in CI, because the images are local files and the vault passphrase is a
// secret. Set VAULT_PASSPHRASE and unpack the vault first:
//
//   node src/vault.mjs unpack
//   node src/upload-covers.mjs --account second --images "C:\covers"
//
// This drives the real Novel Information form in a signed-in browser and submits it, rather than
// guessing the shape of the cover upload call. The form is the same one used to create the novel, so
// submitting it rewrites only what the form holds, which is why the chapter count and the rest of
// the settings stay as they are.

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
}
const has = (n) => args.includes(n);

const account = flag('--account') || 'main';
const imageDir = flag('--images');
const only = flag('--only');
const apply = has('--apply');

if (!imageDir || !existsSync(imageDir)) {
  console.error('usage: node src/upload-covers.mjs --account second --images "<folder>" [--apply]');
  console.error('  --only "Title"   just one novel');
  console.error('  Run "node src/vault.mjs unpack" first, with VAULT_PASSPHRASE set.');
  process.exit(1);
}

const IMAGES = readdirSync(imageDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));

// "The Harbour Register" should find "The Harbour Register at Dawn.png", but if both
// "X.png" and "X (1).png" exist the exact name has to win, or covers land at random.
const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
function findImage(title, extra) {
  // An override that names a real file wins outright, because two files can normalise to the same
  // thing: "X (1).png" and "X(1).png" differ only in a space, and the user named one of them.
  if (extra && IMAGES.includes(extra)) return extra;
  const wanted = normalise(String(extra || title).replace(/\.[^.]+$/, ''));
  const exact = IMAGES.find((f) => normalise(f.replace(/\.[^.]+$/, '')) === wanted);
  if (exact) return exact;
  const loose = IMAGES.filter((f) => normalise(f.replace(/\.[^.]+$/, '')).includes(wanted));
  return loose[0] || null;
}

// Overrides for the ones whose file is not simply "<title>.png".
const OVERRIDES = {
  'The Worldroot Engineer': 'The Worldroot Engineer(1).png',
  'The Clockwork Cathedral': 'The Clockwork Cathedral at Dusk.png',
  'The Harbour Register': 'The Harbour Register at Dawn.png',
  'The Dungeon Architect': 'The Dungeon Architect_ Blueprint of Shadows.png',
};

const config = loadBooks();
const targets = config.books
  .filter((b) => accountFor(b) === account)
  .filter((b) => !only || (b.title ?? '') === only);

function accountFor(book) {
  return book?.account || 'main';
}

const plan = [];
for (const b of targets) {
  const title = b.title ?? b.bookId;
  const file = findImage(title, OVERRIDES[title]);
  plan.push({ ...b, title, image: file });
}

const missing = plan.filter((p) => !p.image);
const found = plan.filter((p) => p.image);

console.log(`[cover] account "${account}", ${found.length} image(s) matched, ${missing.length} without one`);
for (const p of found) console.log(`[cover]   ${p.title}  <-  ${p.image}`);
for (const p of missing) console.log(`[cover]   ${p.title}  <-  NO IMAGE, skipped`);
if (!found.length) process.exit(0);

if (!apply) {
  console.log('\n[cover] PREVIEW ONLY. Re-run with --apply to set the covers.');
  process.exit(0);
}

// This only ever reads the already-unpacked session file, so it needs no passphrase of its own.
// Default to the unpacked per-account session so it works without any environment set up.
const defaultSession = join('work', 'session', `${account}.json`);
if (!process.env.SESSION_PATH && existsSync(defaultSession)) process.env.SESSION_PATH = defaultSession;

const inkstone = new Inkstone({
  bookId: '0',
  sessionPath: process.env.SESSION_PATH || defaultSession,
});

if (!existsSync(process.env.SESSION_PATH)) {
  console.error(`[cover] no session at ${process.env.SESSION_PATH}. Unpack the vault first:`);
  console.error('  $env:VAULT_PASSPHRASE = Read-Host "vault passphrase"');
  console.error('  node src/vault.mjs unpack');
  process.exit(1);
}
console.log(`[cover] using session ${process.env.SESSION_PATH}`);

await inkstone.launch();
const results = [];
try {
  // Without this the run reports "no file input found" for every novel, because an expired session
  // just redirects to the sign-in page. That message sent me looking for a broken selector.
  if (!(await inkstone.isAuthenticated())) {
    console.error('[cover] the stored session is not signed in, so there is no form to fill.');
    console.error('[cover] sign in to that account in a browser, export the cookies, then:');
    console.error(`[cover]   node src/import-cookies.mjs "<cookies.json>" --account ${account}`);
    console.error('[cover] then git add vault && git commit -m "chore: refresh session" && npm run push:vault');
  } else {
    console.log('[cover] signed in');
    for (const p of found) {
    const file = join(imageDir, p.image);
    console.log(`\n[cover] ${p.title} (${p.bookId})`);
    try {
      // The settings page, not the create page: /novels/create/<CBID> is a 404, and /novels/setting/<CBID>
      // is the form that holds the existing novel and submits updateNovel.
      const url = `https://inkstone.webnovel.com/novels/setting/${p.bookId}`;
      await inkstone.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await inkstone.page.waitForTimeout(6000);

      const onForm = await inkstone.page.locator('#bookTitle').count();
      if (!onForm) {
        console.log(`[cover]   ${url} did not load the novel form`);
        results.push({ ...p, ok: false, why: 'settings form did not load' });
        continue;
      }

      const before = await inkstone.page.evaluate(() =>
        [...document.querySelectorAll('img')].find((i) => /bookcover|cover\//.test(i.src || ''))?.src || '');

      // The real <input type=file> only exists once the cover modal is open. The button labelled
      // "Upload" is the one that opens it; the wrapper's class is CSS-module hashed, so match on the
      // label instead of on ".book_cover_wrap", which never matches the generated name.
      let input = inkstone.page.locator('input[type=file]').first();
      if (!(await input.count())) {
        // Clicked through the DOM rather than with Playwright: the button sits under an overlay that
        // makes the actionability check wait forever, but a plain .click() on the element works.
        const opened = await inkstone.page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')]
            .find((b) => (b.textContent || '').trim() === 'Upload');
          if (!btn) return false;
          btn.click();
          return true;
        });
        if (!opened) {
          await inkstone.page.locator('[class*="book_cover"]').first().click({ timeout: 10000 }).catch(() => {});
        }
        await inkstone.page.waitForTimeout(4000);
        input = inkstone.page.locator('input[type=file]').first();
      }

      if (!(await input.count())) {
        console.log(`[cover]   no file input found on ${url}`);
        results.push({ ...p, ok: false, why: 'no file input' });
        continue;
      }

      await input.setInputFiles(file);
      console.log('[cover]   file chosen, waiting for the upload');
      await inkstone.page.waitForTimeout(9000);

      // Choosing a file adds a "confirm" button to the modal. Match on the exact label: a substring
      // match for "upload" hits the Upload button first, which does nothing, and then the modal is
      // dismissed and the selection is lost. That is why an earlier run reported success and changed
      // nothing at all.
      const confirmed = await inkstone.page.evaluate(() => {
        const scope = document.querySelector('[class*=modal], [role=dialog]') || document;
        const btn = [...scope.querySelectorAll('button')]
          .find((b) => (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'confirm');
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!confirmed) {
        console.log('[cover]   the modal never offered a confirm button, cover not applied');
        results.push({ ...p, ok: false, why: 'no confirm button' });
        await inkstone.page.keyboard.press('Escape').catch(() => {});
        continue;
      }
      console.log('[cover]   confirmed');
      await inkstone.page.waitForTimeout(7000);

      // The settings form saves with "update settings", not "create".
      const submitted = await inkstone.page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => /^(update settings|save)$/i.test((b.textContent || '').replace(/\s+/g, ' ').trim()));
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!submitted) {
        console.log('[cover]   no submit button found, the cover was not saved');
        results.push({ ...p, ok: false, why: 'no submit button' });
        continue;
      }
      await inkstone.page.waitForTimeout(9000);

      // Verify. Reporting success without checking is how fifteen novels silently kept their
      // placeholder covers while the log said everything was fine.
      const coverOf = () => inkstone.page.evaluate(() =>
        [...document.querySelectorAll('img')].find((i) => /bookcover|cover\//.test(i.src || ''))?.src || '');
      await inkstone.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await inkstone.page.waitForTimeout(6000);
      const after = await coverOf();
      const changed = Boolean(after) && after !== before;
      console.log(changed ? '[cover]   cover changed, verified' : '[cover]   cover did NOT change');
      await inkstone.snapshot(`cover-${p.bookId}`);
      results.push({ ...p, ok: changed, why: changed ? '' : 'cover unchanged' });
    } catch (err) {
      console.log(`[cover]   failed: ${err.message.split('\n')[0]}`);
      results.push({ ...p, ok: false, why: err.message.split('\n')[0] });
    }
    }
  }
} finally {
  await inkstone.close();
}

const good = results.filter((r) => r.ok);
console.log(`\n[cover] ${good.length} of ${results.length} covers set`);
for (const r of results) console.log(`[cover]   ${r.ok ? 'ok  ' : 'FAIL'} ${r.title}${r.why ? ` (${r.why})` : ''}`);
void extname;
process.exitCode = results.length && good.length === results.length ? 0 : 1;
import { existsSync, readFileSync } from 'node:fs';
import { Inkstone } from './lib/inkstone.mjs';

// Rewrites the novel information form for novels that already exist: the synopsis, and the title
// only when a new one is given. Nothing here creates a novel.
//
//   node src/update-novel.mjs --account third --plan data/novel-updates.json [--apply]
//   node src/update-novel.mjs --account third --plan-file plan.json --only 37291443000414305
//
// The plan is a JSON array:
//   [{ "cbid": "372914...", "synopsis": "...", "title": "optional new title" }]
//
// Without --apply it only reads the form back and reports what it would change, which is also the
// only safe way to find out whether the stored session still works. --probe dumps every field on
// the form, because guessing a selector is how the cover uploader spent a day setting nothing.
//
// The site saves through updateNovel from the settings page, and that is the same request the form
// makes, so driving the form is the honest way in. Filling 2,000 characters through the UI is slow
// but it is what a person does.

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
}
const has = (n) => args.includes(n);

const account = flag('--account') || 'third';
const apply = has('--apply');
const probe = has('--probe');
const only = flag('--only');

const inline = flag('--plan');
const planFile = flag('--plan-file');

let plan;
if (inline) {
  plan = JSON.parse(inline);
} else if (planFile) {
  if (!existsSync(planFile)) {
    console.error(`[update] no plan file at ${planFile}`);
    process.exit(1);
  }
  plan = JSON.parse(readFileSync(planFile, 'utf8'));
} else if (!probe) {
  console.error('usage: node src/update-novel.mjs --account third --plan-file plan.json [--apply] [--probe]');
  process.exit(1);
}

if (!Array.isArray(plan)) {
  console.error('[update] the plan has to be a JSON array of { cbid, synopsis, title? }');
  process.exit(1);
}
const targets = plan.filter((p) => p && p.cbid).filter((p) => !only || String(p.cbid) === String(only));
if (!targets.length) {
  console.error('[update] the plan had no usable entries');
  process.exit(1);
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const settingsUrl = (cbid) => `https://inkstone.webnovel.com/novels/setting/${cbid}`;

const inkstone = new Inkstone({
  bookId: '0',
  sessionPath: process.env.SESSION_PATH || null,
  artifactPath: process.env.ARTIFACT_DIR || 'artifacts',
});

// The settings page is a React form. Mark the elements we want so later actions do not have to
// re-derive a selector from hashed class names, and report what the page actually contained.
async function tagFields(page) {
  return page.evaluate(() => {
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || '',
      maxLength: el.getAttribute('maxlength') || '',
      len: String(el.value ?? el.innerText ?? '').length,
      placeholder: el.getAttribute('placeholder') || '',
    });
    const controls = [...document.querySelectorAll('textarea, input[type=text], input:not([type])')];
    const editables = [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')];
    const fields = [...controls, ...editables].map(describe);

    // The synopsis is the long free-text box. The title has its own id; anything else is found by
    // name or placeholder, and the longest field is the last resort.
    const looksSynopsis = (el) =>
      /synop|blurb|summary|intro|desc/i.test(`${el.id} ${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''}`);
    let synopsis = controls.find(looksSynopsis) ?? editables.find(looksSynopsis);
    if (!synopsis) {
      const ranked = [...controls, ...editables].sort(
        (a, b) => String(b.value ?? b.innerText ?? '').length - String(a.value ?? a.innerText ?? '').length,
      );
      synopsis = ranked[0] ?? null;
    }
    if (synopsis) synopsis.setAttribute('data-nvl-synopsis', '1');

    const buttons = [...document.querySelectorAll('button')]
      .map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    return {
      fields,
      buttons,
      hasTitle: Boolean(document.querySelector('#bookTitle')),
      synopsisFound: Boolean(synopsis),
      synopsisId: synopsis ? synopsis.id || synopsis.getAttribute('name') || synopsis.tagName.toLowerCase() : '',
    };
  });
}

async function readState(page) {
  return page.evaluate(() => {
    const title = document.querySelector('#bookTitle');
    const syn = document.querySelector('[data-nvl-synopsis="1"]');
    return {
      title: title ? title.value : '',
      synopsis: syn ? String(syn.value ?? syn.innerText ?? '') : '',
    };
  });
}

async function fill(page, { title, synopsis }) {
  if (title) {
    await page.locator('#bookTitle').fill(title);
  }
  if (synopsis) {
    const el = page.locator('[data-nvl-synopsis="1"]').first();
    const tag = await el.evaluate((node) => node.tagName.toLowerCase());
    const editable = await el.evaluate((node) => node.getAttribute('contenteditable'));
    if (tag === 'textarea' || tag === 'input') {
      await el.fill(synopsis);
    } else if (editable !== null) {
      await el.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      // insertText is one event instead of thousands of keystrokes, and React sees it as typing.
      await page.keyboard.insertText(synopsis);
    } else {
      throw new Error(`the synopsis field is a <${tag}> and I do not know how to fill it`);
    }
  }
}

async function submit(page) {
  const clicked = await page.evaluate(() => {
    const wanted = /^(update settings|save|save changes|submit)$/i;
    const btn = [...document.querySelectorAll('button')]
      .find((b) => wanted.test((b.textContent || '').replace(/\s+/g, ' ').trim()) && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  });
  return clicked;
}

await inkstone.launch();
const results = [];
try {
  if (!(await inkstone.isAuthenticated())) {
    console.error(`[update] the stored session for "${account}" is not signed in; nothing was changed.`);
    console.error('[update] refresh it with: node src/import-cookies.mjs "<cookies.json>" --account ' + account);
    process.exitCode = 1;
  } else {
    console.log(`[update] signed in for account "${account}", ${targets.length} novel(s) in the plan`);

    for (const target of targets) {
      const label = target.cbid;
      console.log(`\n[update] ${label}${target.title ? ` -> "${target.title}"` : ''}`);
      try {
        const page = inkstone.page;
        const posts = [];
        const onRequest = (req) => {
          if (req.method() !== 'POST') return;
          const url = req.url();
          if (/log|track|collect|beacon|ping|stats|monitor/i.test(url)) return;
          let keys = '';
          try {
            const body = JSON.parse(req.postData() || '{}');
            keys = Object.keys(body).join(',');
          } catch {
            keys = `(${(req.postData() || '').length} bytes, not JSON)`;
          }
          posts.push({ url, keys });
        };
        page.on('request', onRequest);

        await page.goto(settingsUrl(label), { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(7000);

        if (!(await page.locator('#bookTitle').count())) {
          console.log(`[update]   ${settingsUrl(label)} did not load the novel form`);
          results.push({ ...target, ok: false, why: 'form did not load' });
          page.off('request', onRequest);
          continue;
        }

        const shape = await tagFields(page);
        console.log(`[update]   form: title=${shape.hasTitle} synopsisField=<${shape.synopsisId}> buttons=${JSON.stringify(shape.buttons.slice(0, 8))}`);
        if (probe) {
          for (const f of shape.fields) {
            console.log(`[update]   field ${JSON.stringify(f)}`);
          }
        }

        const live = await readState(page);
        console.log(`[update]   live title: ${JSON.stringify(live.title)}`);
        console.log(`[update]   live synopsis: ${live.synopsis.length} chars`);

        const wantTitle = target.title ? String(target.title) : '';
        const wantSynopsis = target.synopsis ? String(target.synopsis) : '';
        const titleChanged = Boolean(wantTitle) && norm(wantTitle) !== norm(live.title);
        const synopsisChanged = Boolean(wantSynopsis) && norm(wantSynopsis) !== norm(live.synopsis);
        console.log(`[update]   planned: title ${titleChanged ? 'change' : 'unchanged'}, synopsis ${synopsisChanged ? 'change' : 'unchanged'} (plan ${wantSynopsis.length} chars)`);

        if (!titleChanged && !synopsisChanged) {
          console.log('[update]   nothing to do');
          results.push({ ...target, ok: true, why: 'already up to date' });
          page.off('request', onRequest);
          continue;
        }

        if (!apply) {
          console.log('[update]   preview only, form not submitted');
          results.push({ ...target, ok: true, why: 'preview' });
          page.off('request', onRequest);
          continue;
        }

        let ok = false;
        let why = '';
        let attempt = 0;
        // A title the site already holds makes updateNovel refuse the whole form, so retry once
        // with the synopsis alone rather than losing the synopsis change to a naming clash.
        for (const withTitle of titleChanged ? [true, false] : [false]) {
          attempt += 1;
          if (attempt > 1) console.log('[update]   retrying with the synopsis only');
          await fill(page, {
            title: withTitle ? wantTitle : '',
            synopsis: synopsisChanged ? wantSynopsis : '',
          });
          const submitted = await submit(page);
          if (!submitted) {
            why = 'no submit button';
            console.log(`[update]   ${why}`);
            break;
          }
          console.log('[update]   submitted, waiting for the save');
          await page.waitForTimeout(9000);
          for (const p of posts) console.log(`[update]   POST ${p.url} {${p.keys}}`);
          posts.length = 0;

          // Verify against a fresh load of the settings page, not against the DOM we just typed in.
          await page.goto(settingsUrl(label), { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(6000);
          const shape2 = await tagFields(page);
          void shape2;
          const after = await readState(page);
          const titleOk = !wantTitle || norm(after.title) === norm(wantTitle);
          const synOk = !synopsisChanged || norm(after.synopsis) === norm(wantSynopsis);
          console.log(`[update]   after reload: title ${titleOk ? 'ok' : 'DIFFERENT'}, synopsis ${after.synopsis.length} chars (${synOk ? 'ok' : 'DIFFERENT'})`);
          if (titleOk && synOk) {
            ok = true;
            break;
          }
          why = `${titleOk ? '' : 'title rejected'}${!titleOk && !synOk ? ', ' : ''}${synOk ? '' : 'synopsis not saved'}`;
          if (withTitle && !titleOk) {
            console.log(`[update]   the site refused the title "${wantTitle}"`);
            continue;
          }
          break;
        }

        if (ok) console.log('[update]   saved and verified');
        else console.error(`[update]   NOT SAVED (${why || 'unknown'})`);
        await inkstone.snapshot(`update-${label}`);
        results.push({ ...target, ok, why: why || 'saved' });
        page.off('request', onRequest);
      } catch (err) {
        console.error(`[update]   failed: ${err.message.split('\n')[0]}`);
        results.push({ ...target, ok: false, why: err.message.split('\n')[0] });
      }
    }
  }
} finally {
  await inkstone.close();
}

const good = results.filter((r) => r.ok);
console.log(`\n[update] ${good.length} of ${results.length} novel(s) handled`);
for (const r of results) console.log(`[update]   ${r.ok ? 'ok  ' : 'FAIL'} ${r.cbid} ${r.title ? `"${r.title}"` : ''} (${r.why})`);
if (results.length && good.length !== results.length) process.exitCode = 1;

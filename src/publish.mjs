import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadBook } from './lib/epub.mjs';
import { Inkstone, InkstoneError, sleep } from './lib/inkstone.mjs';

function listFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else out.push(relative(dir, full));
  }
  return out;
}

const log = (msg) => console.log(`[publish] ${msg}`);
const warn = (msg) => console.warn(`[publish] ${msg}`);

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const ASSETS_DIR = resolve(process.env.ASSETS_DIR ?? 'assets');
const EPUB_PATH = resolve(process.env.EPUB_PATH ?? join(ASSETS_DIR, 'book', 'book.epub'));
const STATE_PATH = resolve(process.env.STATE_PATH ?? join(ASSETS_DIR, 'state', 'state.json'));
const SESSION_PATH = resolve(process.env.SESSION_PATH ?? join(ASSETS_DIR, 'session', 'storage-state.json'));
const ARTIFACT_DIR = resolve(process.env.ARTIFACT_DIR ?? 'artifacts');
const PROFILE_DIR = process.env.PROFILE_DIR ? resolve(process.env.PROFILE_DIR) : null;

// Tuned from real run timings: each chapter costs ~10s of browser work, so the delay dominated
// everything. 10s keeps a comfortable margin under Inkstone's rate limits while finishing the book
// roughly twice as fast as the original 45s pacing.
const DEFAULT_MAX_CHAPTERS = 200;
const DEFAULT_DELAY_SECONDS = 10;

const START_INPUT = num(process.env.START_CHAPTER);
const END_INPUT = num(process.env.END_CHAPTER);
const MAX_CHAPTERS = num(process.env.MAX_CHAPTERS, DEFAULT_MAX_CHAPTERS);
const DELAY_SECONDS = num(process.env.DELAY_SECONDS, DEFAULT_DELAY_SECONDS);
const COMMIT_EVERY = num(process.env.COMMIT_EVERY, 5);
const RESTART_EVERY = num(process.env.RESTART_EVERY, 25);
const MAX_FAILURES = num(process.env.MAX_FAILURES, 3);
const DRY_RUN = process.env.DRY_RUN === '1';

function loadState() {
  if (!existsSync(STATE_PATH)) return { nextChapter: 0, published: [] };
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { nextChapter: 0, published: [] };
  }
}

// Returns the usable Inkstone cookies from the stored session, or null when there are none.
function readSession() {
  if (!existsSync(SESSION_PATH)) return null;
  try {
    const state = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
    const cookies = (state.cookies ?? []).filter(
      (c) => c.name === 'inkstone_auth_token' && c.domain.includes('webnovel.com'),
    );
    return cookies.length ? state.cookies : null;
  } catch {
    return null;
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function describeExecError(err) {
  // execFileSync puts the child's diagnostics on stderr as a Buffer, which is truthy even when
  // empty, so `err.stderr ?? err.message` silently printed nothing. Fall through to stdout.
  const out = [err.stderr, err.stdout, err.message]
    .map((v) => (v ? String(v).trim() : ''))
    .filter(Boolean)
    .join(' | ');
  return out.split('\n').filter(Boolean).slice(-3).join(' / ') || 'no output';
}

// In CI this is scripts/seal-and-push.sh, which re-encrypts work/ into the vault and pushes it.
// Locally, GIT_COMMIT=1 falls back to committing ASSETS_DIR directly when it is a git checkout.
function commitState(message) {
  const hook = process.env.PROGRESS_HOOK;
  if (hook) {
    try {
      execFileSync(hook, [message], { stdio: 'pipe' });
      log('progress sealed into the vault and pushed');
    } catch (err) {
      log(`progress save failed: ${describeExecError(err)}`);
    }
    return;
  }
  if (process.env.GIT_COMMIT !== '1') return;
  try {
    execFileSync('git', ['add', '-A'], { cwd: ASSETS_DIR, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', message], { cwd: ASSETS_DIR, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: ASSETS_DIR, stdio: 'pipe' });
    log(`state committed: ${message}`);
  } catch (err) {
    log(`state commit skipped: ${describeExecError(err)}`);
  }
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
  else log(`output ${name}=${value}`);
}

async function main() {
  if (!existsSync(EPUB_PATH)) {
    const found = existsSync(ASSETS_DIR) ? listFiles(ASSETS_DIR).slice(0, 12) : [];
    throw new Error(
      `EPUB not found at ${EPUB_PATH}.` +
        (found.length ? ` Files actually unpacked: ${found.join(', ')}` : ` Nothing found under ${ASSETS_DIR}.`),
    );
  }
  const book = loadBook(EPUB_PATH);
  log(`book has ${book.total} chapters`);
  log(`range inputs: start=${START_INPUT || 'auto'} end=${END_INPUT || 'auto'} max=${MAX_CHAPTERS} delay=${DELAY_SECONDS}s`);

  const state = loadState();
  const end = END_INPUT || book.total;

  // Already finished a previous book and nobody asked for a specific range: stop before spending a
  // browser and a login on a run that has nothing to do. An explicit start_chapter always wins.
  if (!START_INPUT && state.finishedAt && num(state.nextChapter) > end) {
    log(`state says this book finished at ${state.finishedAt}, nothing to do`);
    setOutput('published', 0);
    setOutput('remaining', 0);
    setOutput('next_chapter', state.nextChapter);
    setOutput('finished', 'true');
    return;
  }

  if (DRY_RUN) {
    log('DRY RUN: previewing the parser only. No browser, no login, nothing uploaded, nothing committed.');
    const from = START_INPUT || 1;
    for (const n of [from, Math.min(book.total, from + 2)]) {
      const ch = book.chapter(n);
      log(`  preview EPUB chapter ${n}: title="${ch.title}" words=${ch.wordCount} paragraphs=${ch.paragraphs.length}`);
      log(`    html head: ${ch.html.slice(0, 160)}`);
    }
    log(
      `this preview always shows chapters from ${from}; it is a sample of the parser, not the resume point. ` +
        'A real run decides where to start after signing in to Inkstone.',
    );
    setOutput('remaining', 0);
    setOutput('published', 0);
    setOutput('finished', 'true');
    return;
  }

  const bookId = process.env.INKSTONE_BOOK_ID;
  if (!bookId) throw new Error('INKSTONE_BOOK_ID is not set');

  // Three ways to be authenticated: a saved browser profile, a stored cookie session, or an
  // email+password account. Check all three before giving up, and say which one is missing.
  const session = readSession();
  if (!PROFILE_DIR && !session && !process.env.INKSTONE_EMAIL) {
    throw new Error(
      'no way to sign in: there is no browser profile at PROFILE_DIR, no Inkstone session in ' +
        `${SESSION_PATH}, and no INKSTONE_EMAIL. Export the cookies from a signed-in browser with\n` +
        '  node src/import-cookies.mjs <cookies.json>\n' +
        'or, for a password account, set INKSTONE_EMAIL and INKSTONE_PASSWORD.',
    );
  }
  if (!PROFILE_DIR && session) log(`using the stored cookie session (${session.length} cookies)`);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const inkstone = new Inkstone({
    bookId,
    sessionPath: SESSION_PATH,
    artifactPath: ARTIFACT_DIR,
    headless: process.env.HEADLESS !== '0',
    profileDir: PROFILE_DIR,
  });

  await inkstone.launch();
  let published = 0;
  let next = START_INPUT;
  let stopped = null;

  try {
    await inkstone.ensureLoggedIn({
      email: process.env.INKSTONE_EMAIL,
      password: process.env.INKSTONE_PASSWORD,
    });

    if (!next) {
      inkstone.startKeepalive();
      const detected = await inkstone.publishedCount().catch((err) => {
        warn(`chapter count probe threw: ${err.message}`);
        return null;
      });

      if (detected !== null && Number.isFinite(detected)) {
        next = detected + 1;
        log(`platform reports ${detected} published chapters, resuming at EPUB chapter ${next}`);
      } else if (num(state.nextChapter)) {
        next = state.nextChapter;
        log(`could not read the platform count, falling back to the saved pointer: chapter ${next}`);
      } else {
        // Never guess. Starting at 1 on a book that already has chapters would duplicate them.
        throw new Error(
          'Cannot tell where to resume: the platform chapter count was unreadable and there is no saved ' +
            'pointer in the vault. Re-run with start_chapter set to the EPUB chapter number you want to ' +
            'publish next (1 if the book is genuinely empty, otherwise the number after your last one).',
        );
      }
    } else {
      log(`using explicit start ${next}`);
    }

    if (end < next) {
      log(`nothing to do: end (${end}) is before start (${next})`);
    }

    let failures = 0;
    for (let n = next; n <= end && published < MAX_CHAPTERS; n += 1) {
      const chapter = book.chapter(n);
      if (chapter.wordCount < 10) {
        log(`chapter ${n} looks empty (${chapter.wordCount} words), skipping`);
        state.nextChapter = n + 1;
        continue;
      }

      try {
        if (inkstone.sessionAlive === false) {
          throw new InkstoneError(
            'the Inkstone session expired mid-run (keepalive failed). Re-grab cookies or run npm run signin, then rerun.',
          );
        }
        await inkstone.publishChapter(chapter);
        published += 1;
        failures = 0;
        state.nextChapter = n + 1;
        state.bookId = bookId;
        state.totalChapters = book.total;
        state.published = [
          ...(state.published ?? []),
          { index: n, title: chapter.title, words: chapter.wordCount, at: new Date().toISOString() },
        ].slice(-500);
        log(`chapter ${n} published (${published}/${MAX_CHAPTERS} this run)`);

        saveState(state);
        if (published % COMMIT_EVERY === 0) commitState(`chore: progress through EPUB chapter ${n}`);

        // Keep the browser flat so chapter 2000 is as quick as chapter 1.
        if (RESTART_EVERY > 0 && published % RESTART_EVERY === 0) {
          await inkstone.restart();
          inkstone.startKeepalive();
        }

        if (published < MAX_CHAPTERS && n < end && DELAY_SECONDS > 0) await sleep(DELAY_SECONDS * 1000);
      } catch (err) {
        failures += 1;
        warn(`chapter ${n} failed: ${err.message}`);
        saveState(state);
        commitState(`chore: record failure at EPUB chapter ${n}`);
        if (failures >= MAX_FAILURES) {
          stopped = `stopped after ${failures} consecutive failures`;
          break;
        }
        await sleep(20000 * failures);
      }
    }

    await inkstone.saveSession();
  } catch (err) {
    await inkstone.saveSession().catch(() => {});
    throw err;
  } finally {
    await inkstone.close();
  }

  // A run that started past the end of the range (or that could not move the pointer) must not
  // report "remaining", or the workflow would dispatch itself forever.
  const noProgress = published === 0 && num(state.nextChapter) < next;
  const remaining = noProgress ? 0 : Math.max(0, end - state.nextChapter + 1);

  state.finishedAt = remaining === 0 ? new Date().toISOString() : null;
  saveState(state);
  commitState(`chore: upload progress ${state.nextChapter - 1}/${book.total}`);

  log(`published ${published} chapter(s) this run; next pending EPUB chapter is ${state.nextChapter}`);
  if (noProgress) {
    log(`nothing was publishable in the range ${next}..${end}; treating this as done so the chain stops`);
  } else if (remaining > 0) {
    log(`${remaining} chapter(s) still to go`);
  } else {
    log('all chapters in range are uploaded');
  }

  setOutput('published', published);
  setOutput('remaining', remaining);
  setOutput('next_chapter', state.nextChapter);
  setOutput('finished', remaining === 0 ? 'true' : 'false');
  if (stopped) log(stopped);

  return { remaining, published, stopped, next: state.nextChapter };
}

// Local unattended mode: keep re-entering the loop until the range is done, instead of relying on
// GitHub to dispatch the next run.
async function runLoop() {
  let total = 0;
  for (let attempt = 1; ; attempt += 1) {
    log(`=== batch ${attempt} ===`);
    const result = await main();
    total += result?.published ?? 0;
    if (!result || result.remaining === 0 || result.stopped) {
      if (result?.stopped) warn(`${result.stopped}; rerun once you have looked into it`);
      break;
    }
    await sleep(5000);
  }
  log(`done: ${total} chapter(s) published across this session`);
}

const entry = process.env.PUBLISH_LOOP === '1' ? runLoop() : main();
entry.catch((err) => {
  console.error(`[publish] FAILED: ${err instanceof InkstoneError ? err.message : err.stack}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'remaining=1\n');
  process.exit(1);
});

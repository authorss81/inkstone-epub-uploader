import { Inkstone } from './lib/inkstone.mjs';

const PROFILE_DIR = process.env.PROFILE_DIR || '.profile';
const BOOK_ID = process.env.INKSTONE_BOOK_ID || '';
const WAIT_MINUTES = Number(process.env.SIGNIN_WAIT_MINUTES || 10);

console.log('[signin] opening a real browser window');
console.log(`[signin] profile: ${PROFILE_DIR}`);
console.log('[signin] a Chrome window will open on the Inkstone login page.');
console.log('[signin] sign in however you normally do, including Google if that is your account.');
console.log(`[signin] waiting up to ${WAIT_MINUTES} minutes for the session to appear...`);

const inkstone = new Inkstone({
  bookId: BOOK_ID || '0',
  sessionPath: null,
  artifactPath: 'artifacts',
  headless: false,
  profileDir: PROFILE_DIR,
});

await inkstone.launch();
await inkstone.page.goto('https://inkstone.webnovel.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

const deadline = Date.now() + WAIT_MINUTES * 60 * 1000;
let signedIn = false;
while (Date.now() < deadline) {
  if (await inkstone.isAuthenticated()) {
    signedIn = true;
    break;
  }
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 5000));
}
console.log('');

if (!signedIn) {
  console.error('[signin] timed out without a valid session. Nothing was saved, try again.');
  await inkstone.close();
  process.exit(1);
}

const user = await inkstone.currentUser();
const count = BOOK_ID ? await inkstone.publishedCount().catch(() => null) : null;

console.log('[signin] signed in.');
if (user) {
  const name = user.name ?? user.penName ?? user.userName ?? '(no display name)';
  console.log(`[signin] account: ${name}`);
}
if (BOOK_ID) console.log(`[signin] book ${BOOK_ID} currently has ${count ?? 'an unknown number of'} published chapters`);
console.log(`[signin] profile saved to ${PROFILE_DIR}. You do not need to sign in again.`);

await inkstone.close();

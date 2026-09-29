import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE } from './lib/inkstone.mjs';
import { encrypt } from './vault.mjs';

const OUT = process.env.VAULT_DIR ? join(process.env.VAULT_DIR, 'session', 'storage-state.json.enc') : null;
const WAIT_MINUTES = Number(process.env.SIGNIN_WAIT_MINUTES || 10);
const CHANNEL = process.env.BROWSER_CHANNEL || undefined;

if (!OUT) {
  console.error('[grab] set VAULT_DIR (default "vault") so the cookies know where to be sealed');
  process.exit(1);
}
if (!process.env.VAULT_PASSPHRASE) {
  console.error('[grab] VAULT_PASSPHRASE must be set so the cookies can be encrypted');
  process.exit(1);
}

const { chromium } = await import('playwright');
const scratch = mkdtempSync(join(tmpdir(), 'inkstone-grab-'));

console.log('[grab] opening a browser window on the Inkstone login page');
console.log('[grab] sign in with Google (or however you normally do), then leave the window open');
console.log(`[grab] waiting up to ${WAIT_MINUTES} minutes...`);

const context = await chromium.launchPersistentContext(scratch, {
  headless: false,
  ...(CHANNEL ? { channel: CHANNEL } : {}),
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  timezoneId: 'Asia/Shanghai',
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});

const deadline = Date.now() + WAIT_MINUTES * 60 * 1000;
let ok = false;
while (Date.now() < deadline) {
  const token = (await context.cookies([BASE]).catch(() => []))
    .find((c) => c.name === 'inkstone_auth_token')?.value;
  if (token) {
    ok = true;
    describeToken(token);
    break;
  }
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 5000));
}
console.log('');

if (!ok) {
  console.error('[grab] no session appeared, nothing saved');
  await context.close();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const state = await context.storageState();
await context.close();
rmSync(scratch, { recursive: true, force: true });

const webnovel = state.cookies.filter((c) => c.domain.endsWith('webnovel.com'));
if (!webnovel.some((c) => c.name === 'inkstone_auth_token')) {
  console.error('[grab] signed in but no inkstone_auth_token cookie was issued, refusing to save');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'inkstone-state-'));
const plain = join(tmp, 'storage-state.json');
writeFileSync(plain, JSON.stringify(state, null, 2));
encrypt(readFileSync(plain), OUT);
rmSync(tmp, { recursive: true, force: true });
rmSync(plain, { force: true });

console.log(`[grab] sealed ${webnovel.length} webnovel.com cookies into ${OUT}`);
console.log('[grab] plaintext was never written inside the repo. Now commit it:');
console.log('        git add vault && git commit -m "chore: refresh inkstone session" && git push');

function describeToken(token) {
  console.log(`[grab] inkstone_auth_token: ${token.length} characters`);
  if (token.split('.').length === 3) {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const exp = payload.exp ?? payload.expire_time;
    console.log('[grab] this is a JWT');
    if (exp) {
      const minutes = Math.round((exp * 1000 - Date.now()) / 60000);
      console.log(`[grab] server-side expiry: ${new Date(exp * 1000).toISOString()} (${minutes} minutes from now)`);
      console.log(
        minutes < 60
          ? '[grab] note: a short server-side life means the keepalive is essential, not optional'
          : '[grab] the keepalive should be plenty to hold this open',
      );
    }
    return;
  }
  console.log('[grab] this is an opaque session token, so only the keepalive can keep it alive');
}

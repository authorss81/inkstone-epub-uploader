import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt } from './vault.mjs';

// Reads a Cookie Editor / EditThisCookie / Chrome-extension JSON export and seals it into the
// vault as a Playwright storageState. The export comes from a normal, human-driven browser, which
// is the only way to get a Google session: Google refuses sign-in from automated browsers.

const SAME_SITE = {
  no_restriction: 'None',
  lax: 'Lax',
  lax_only: 'Lax',
  strict: 'Strict',
  unspecified: 'Lax',
  unset: 'Lax',
  true: 'Lax',
  false: 'Lax',
};

function normalise(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.cookies)) return input.cookies;
  throw new Error('unrecognised export shape: expected a JSON array of cookies');
}

function toPlaywright(cookie) {
  const expires = Number(cookie.expirationDate ?? cookie.expires);
  return {
    name: cookie.name,
    value: String(cookie.value ?? ''),
    domain: cookie.domain,
    path: cookie.path || '/',
    expires: Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : -1,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: SAME_SITE[String(cookie.sameSite ?? 'unset').toLowerCase()] ?? 'Lax',
  };
}

function describeToken(token) {
  console.log(`[import] inkstone_auth_token: ${token.length} characters`);
  if (token.split('.').length === 3) {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const exp = payload.exp ?? payload.expire_time;
    console.log('[import] this is a JWT');
    if (exp) {
      const minutes = Math.round((exp * 1000 - Date.now()) / 60000);
      console.log(`[import] server-side expiry: ${new Date(exp * 1000).toISOString()} (${minutes} minutes from now)`);
      if (minutes <= 0) {
        console.error('[import] WARNING: this token has ALREADY expired, the server will reject it. Re-export the cookies.');
      } else if (minutes < 90) {
        console.log('[import] the run rotates the token on every response and saves the fresh one back,');
        console.log('[import] so starting with a short life is fine as long as the first request lands quickly.');
      } else {
        console.log('[import] plenty of headroom.');
      }
    }
    return;
  }
  console.log('[import] this is an opaque session token, so only the keepalive can keep it alive');
}

const [inputPath, vaultDirArg] = process.argv.slice(2);
const VAULT_DIR = vaultDirArg || process.env.VAULT_DIR || 'vault';
const OUT = join(VAULT_DIR, 'session', 'storage-state.json.enc');

if (!inputPath) {
  console.error('usage: node src/import-cookies.mjs <cookies.json> [vaultDir]');
  console.error('  set VAULT_PASSPHRASE first so the cookies can be encrypted');
  process.exit(1);
}
if (!process.env.VAULT_PASSPHRASE) {
  console.error('[import] VAULT_PASSPHRASE must be set');
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch (err) {
  console.error(`[import] could not read ${inputPath}: ${err.message}`);
  process.exit(1);
}

const cookies = normalise(parsed)
  .map(toPlaywright)
  .filter((c) => c.domain.endsWith('webnovel.com') || c.domain.includes('webnovel.com'))
  .filter((c) => c.name && c.value);

if (!cookies.length) {
  console.error('[import] no *.webnovel.com cookies in that file.');
  console.error('[import] In the extension, make sure you are on inkstone.webnovel.com and export that site, not another one.');
  process.exit(1);
}

const token = cookies.find((c) => c.name === 'inkstone_auth_token');
console.log(`[import] ${cookies.length} webnovel.com cookies found`);
if (token) describeToken(token.value);
else console.log('[import] WARNING: no inkstone_auth_token cookie, the session will probably not authenticate');

const domains = [...new Set(cookies.map((c) => c.domain))];
console.log(`[import] domains: ${domains.join(', ')}`);

const state = { cookies, origins: [] };

// Never write the plaintext next to the vault, even briefly.
const tmp = mkdtempSync(join(tmpdir(), 'inkstone-import-'));
const plain = join(tmp, 'storage-state.json');
writeFileSync(plain, JSON.stringify(state, null, 2));
encrypt(readFileSync(plain), OUT);
rmSync(tmp, { recursive: true, force: true });
rmSync(plain, { force: true });

console.log(`[import] sealed into ${OUT}`);
console.log('[import] now commit it:');
console.log('         git add vault && git commit -m "chore: refresh inkstone session" && git push');

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const MAGIC = Buffer.from('INKVAULT1', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

const log = (msg) => console.log(`[vault] ${msg}`);

function passphrase() {
  const value = process.env.VAULT_PASSPHRASE;
  if (!value) throw new Error('VAULT_PASSPHRASE is not set');
  if (value.length < 16) throw new Error('VAULT_PASSPHRASE is shorter than 16 characters');
  return value;
}

export function encrypt(plain, encPath) {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(passphrase(), salt, KEY_BYTES, SCRYPT);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  mkdirSync(dirname(encPath), { recursive: true });
  writeFileSync(encPath, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]));
  return encPath;
}

export function decrypt(encPath, plainPath) {
  const blob = readFileSync(encPath);
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`${encPath} is not an Inkstone vault file`);
  }
  let offset = MAGIC.length;
  const salt = blob.subarray(offset, (offset += SALT_BYTES));
  const iv = blob.subarray(offset, (offset += IV_BYTES));
  const tag = blob.subarray(offset, (offset += TAG_BYTES));
  const body = blob.subarray(offset);

  const key = scryptSync(passphrase(), salt, KEY_BYTES, SCRYPT);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);

  mkdirSync(dirname(plainPath), { recursive: true });
  writeFileSync(plainPath, plain);
  return plainPath;
}

// Every .enc file under the vault maps to the same relative path without the suffix.
const VAULT_DIR = resolve(process.env.VAULT_DIR ?? 'vault');
const WORK_DIR = resolve(process.env.WORK_DIR ?? 'work');

function walk(dir, suffix, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, suffix, out);
    else if (name.endsWith(suffix)) out.push(full);
  }
  return out;
}

function unpack() {
  const files = walk(VAULT_DIR, '.enc');
  if (!files.length) throw new Error(`no encrypted files found in ${VAULT_DIR}`);
  for (const encPath of files) {
    const rel = relative(VAULT_DIR, encPath).slice(0, -'.enc'.length);
    const plainPath = join(WORK_DIR, rel);
    decrypt(encPath, plainPath);
    log(`unpacked ${rel} (${statSync(plainPath).size} bytes)`);
  }
  return files.length;
}

// Walk both sides: files already in the vault, plus anything new that appeared in work/.
function pack() {
  const rels = new Set(walk(VAULT_DIR, '.enc').map((p) => relative(VAULT_DIR, p).slice(0, -'.enc'.length)));
  for (const plainPath of walk(WORK_DIR, '')) rels.add(relative(WORK_DIR, plainPath));

  let count = 0;
  for (const rel of [...rels].sort()) {
    const plainPath = join(WORK_DIR, rel);
    const encPath = join(VAULT_DIR, `${rel}.enc`);
    if (!existsSync(plainPath)) continue;
    const before = existsSync(encPath) ? readFileSync(encPath) : null;
    encrypt(readFileSync(plainPath), encPath);
    const changed = !before || !before.equals(readFileSync(encPath));
    log(`packed ${rel}${changed ? '' : ' (unchanged)'}`);
    count += 1;
  }
  return count;
}

const command = process.argv[2];
try {
  if (command === 'unpack') log(`unpacked ${unpack()} file(s) into ${WORK_DIR}`);
  else if (command === 'pack') log(`packed ${pack()} file(s) into ${VAULT_DIR}`);
  else if (command === 'seal') {
    const [input, output] = process.argv.slice(3);
    encrypt(readFileSync(input), output);
    log(`sealed ${input} -> ${output}`);
  } else throw new Error('usage: node src/vault.mjs <unpack|pack|seal input output>');
} catch (err) {
  console.error(`[vault] ${err.message}`);
  process.exit(1);
}

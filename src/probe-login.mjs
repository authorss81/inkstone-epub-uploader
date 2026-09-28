import { chromium } from 'playwright';

const BASE = 'https://inkstone.webnovel.com';
const redirectUrl = `${BASE}/novels/list`;
const returnurl = `${BASE}/login/callback?redirectUrl=${encodeURIComponent(redirectUrl)}`;
const params = new URLSearchParams({
  auto: '1',
  target: 'iframe',
  maskOpacity: '50',
  popup: '1',
  format: 'redirect',
  appid: '900',
  areaid: '8',
  source: 'qidianoversea',
  channel: 'pc',
  returnurl,
});

const loginUrl = `${'https://passport.webnovel.com'}/emaillogin.html?${params}`;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
const page = await context.newPage();
page.setDefaultTimeout(45000);

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
const signIn = page.locator('a[class*="login_button"]').first();
await signIn
  .waitFor({ state: 'visible', timeout: 30000 })
  .then(() => console.log('inkstone sign-in button          : found'))
  .catch(() => console.log('inkstone sign-in button          : MISSING'));

await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const checks = [
  ['passport email field', 'input#email, input.loginEmail'],
  ['passport password field', 'input[type="password"]'],
  ['passport submit button', 'button#submit'],
  ['trust-code challenge (0 = not shown)', '#trustcode'],
];
for (const [label, selector] of checks) {
  const count = await page.locator(selector).count();
  console.log(`${label.padEnd(40)}: ${count}`);
}

// The editor is only reachable once signed in, so this part is optional.
if (process.env.INKSTONE_BOOK_ID && process.env.SESSION_PATH) {
  const { Inkstone } = await import('./lib/inkstone.mjs');
  const inkstone = new Inkstone({
    bookId: process.env.INKSTONE_BOOK_ID,
    sessionPath: process.env.SESSION_PATH,
    artifactPath: process.env.ARTIFACT_DIR || 'artifacts',
  });
  await inkstone.launch();
  console.log(`\nsigned in                        : ${await inkstone.isAuthenticated()}`);
  console.log(`inkstone reports this many chapters: ${await inkstone.publishedCount()}`);
  await inkstone.close();
}

await browser.close();

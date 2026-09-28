import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

export const BASE = 'https://inkstone.webnovel.com';
const PASSPORT_HOST = 'https://passport.webnovel.com';

const log = (msg) => console.log(`[inkstone] ${msg}`);
const warn = (msg) => console.warn(`[inkstone] ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class InkstoneError extends Error {}

async function shoot(page, name, dir) {
  const target = dir || process.env.ARTIFACT_DIR || 'artifacts';
  mkdirSync(target, { recursive: true });
  const file = join(target, `${name}-${Date.now()}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    warn(`screenshot saved: ${file}`);
  } catch {
    /* ignore */
  }
}

function collectErrorText() {
  const selectors = [
    '.codeTip',
    '._error',
    '[class*="error"]',
    '[class*="Error"]',
    '[role="alert"]',
    '.tips',
    '.tip',
    '.m-form-fieldset span',
  ];
  const found = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && text.length < 200) found.push(text);
    }
  }
  return [...new Set(found)];
}

function loadJson(path, fallback = null) {
  if (!path || !existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export class Inkstone {
  constructor({ bookId, sessionPath, artifactPath, headless = true }) {
    this.bookId = String(bookId);
    this.sessionPath = sessionPath;
    this.artifactPath = artifactPath;
    this.headless = headless;
    this.authToken = '';
    this.context = null;
    this.page = null;
  }

  async launch() {
    const storageState = loadJson(this.sessionPath);
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH || undefined;
    this.browser = await chromium.launch({
      headless: this.headless,
      executablePath,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'Asia/Shanghai',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      storageState: storageState ?? undefined,
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(45000);
    this.page.setDefaultNavigationTimeout(60000);
    await this.refreshAuthToken();
    return this;
  }

  async close() {
    await this.browser?.close();
  }

  snapshot(name) {
    return shoot(this.page, name, this.artifactPath);
  }

  async saveSession() {
    if (!this.sessionPath) return;
    mkdirSync(dirname(this.sessionPath), { recursive: true });
    const state = await this.context.storageState();
    writeFileSync(this.sessionPath, JSON.stringify(state, null, 2));
    log('session persisted');
  }

  async clearSession() {
    if (this.sessionPath && existsSync(this.sessionPath)) {
      mkdirSync(dirname(this.sessionPath), { recursive: true });
      writeFileSync(this.sessionPath, JSON.stringify({ cookies: [], origins: [] }));
    }
    if (this.context) await this.context.clearCookies();
    this.authToken = '';
  }

  async refreshAuthToken() {
    const cookies = await this.context.cookies([BASE, PASSPORT_HOST]);
    const token = cookies.find((c) => c.name === 'inkstone_auth_token');
    this.authToken = token?.value ?? '';
    return this.authToken;
  }

  apiHeaders() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Referer: `${BASE}/`,
      Origin: BASE,
      ...(this.authToken ? { Authorization: this.authToken } : {}),
    };
  }

  async apiGet(path, params = {}) {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await this.context.request.get(url.toString(), { headers: this.apiHeaders() });
    return { status: res.status(), body: await safeJson(res) };
  }

  async apiPost(path, data = {}) {
    const res = await this.context.request.post(new URL(path, BASE).toString(), {
      headers: this.apiHeaders(),
      data,
    });
    return { status: res.status(), body: await safeJson(res) };
  }

  async currentUser() {
    await this.refreshAuthToken();
    if (!this.authToken) return null;
    const { body } = await this.apiGet('/externalsite', {
      service: 'userinfoservice',
      action: 'getUserInfo',
    });
    if (body?.returnCode === 200 && body?.result) return body.result;
    return null;
  }

  async isAuthenticated() {
    return Boolean(await this.currentUser());
  }

  async ensureLoggedIn({ email, password }) {
    if (await this.isAuthenticated()) {
      log('reusing stored session');
      return;
    }
    if (!email || !password) throw new InkstoneError('no valid session and no INKSTONE_EMAIL/INKSTONE_PASSWORD available');

    warn('session invalid, logging in');
    await this.clearSession();
    await this.login({ email, password });
    if (!(await this.isAuthenticated())) throw new InkstoneError('login finished but session is not authenticated');
    await this.saveSession();
  }

  async login({ email, password }) {
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
    const loginUrl = `${PASSPORT_HOST}/emaillogin.html?${params}`;

    log('opening the email login page');
    await this.page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    const emailInput = this.page.locator('input#email, input.loginEmail').first();
    const passwordInput = this.page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 60000 });
    await emailInput.fill(email);
    await passwordInput.fill(password);

    const trust = this.page.locator('#trustcode:visible, input[name="trustcode"]:visible').first();
    if (await trust.count()) {
      await this.snapshot('login-needs-trust-code');
      throw new InkstoneError(
        'the passport is asking for a verification code for this login attempt. Sign in once by hand in a normal browser; later runs reuse the stored session.',
      );
    }

    log('submitting credentials');
    await this.page.locator('button#submit').first().click();

    log('waiting for the callback into inkstone');
    await this.page
      .waitForURL((url) => url.hostname.endsWith('inkstone.webnovel.com'), { timeout: 120000 })
      .catch(async () => {
        await this.snapshot('login-stuck');
        const problems = await this.page.evaluate(collectErrorText).catch(() => []);
        throw new InkstoneError(
          `login was rejected before reaching inkstone. ${problems.length ? `passport said: ${problems.join(' | ')}` : 'No error text was rendered, check the screenshot.'}`,
        );
      });

    // /login/callback calls /tauthorweb/login/verify and then lands on redirectUrl.
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page
      .waitForFunction(
        () => document.cookie.includes('inkstone_auth_token'),
        null,
        { timeout: 90000 },
      )
      .catch(async () => {
        await this.snapshot('login-no-token');
        throw new InkstoneError(
          'inkstone accepted the redirect but never issued a session token. The account may need a device or captcha check once.',
        );
      });

    await this.page.goto(redirectUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.refreshAuthToken();
  }

  async chapterList() {
    const attempts = [
      { path: '/tauthorweb/chapter/getBookChapterList', params: { CBID: this.bookId } },
      {
        path: '/externalsite',
        params: {
          service: 'novelservice',
          action: 'paginateNovelPublishedList',
          CBID: this.bookId,
          pn: 1,
          rn: 500,
        },
      },
      {
        path: '/externalsite',
        params: { service: 'novelservice', action: 'getChaptersByVolume', CBID: this.bookId },
      },
    ];

    for (const attempt of attempts) {
      const { status, body } = await this.apiGet(attempt.path, attempt.params);
      const result = body?.result;
      if (!result) {
        warn(`chapter count: ${attempt.path} gave http ${status} returnCode ${body?.returnCode ?? '?'} (${body?.returnMsg ?? 'no result'})`);
        continue;
      }

      const list =
        result.chapters ??
        result.chapterList ??
        result.records ??
        result.list ??
        (Array.isArray(result) ? result : null);
      if (Array.isArray(list)) {
        log(`chapter list from ${attempt.path} (${list.length} entries)`);
        return list;
      }

      const total = result.total ?? result.totalCount ?? result.totalNum ?? result.count;
      if (typeof total === 'number') {
        log(`chapter count from ${attempt.path} = ${total}`);
        return { total };
      }

      warn(`chapter count: ${attempt.path} returned keys [${Object.keys(result).slice(0, 12).join(', ')}], no count found`);
    }
    warn('could not determine the published chapter count from any known endpoint');
    return null;
  }

  async publishedCount() {
    const list = await this.chapterList();
    if (!list) return null;
    if (Array.isArray(list)) return list.length;
    return list.total ?? null;
  }

  async openNewChapter() {
    const url = `${BASE}/novels/chapter/create/${this.bookId}`;
    log(`opening editor ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForFunction(() => window.tinymce?.activeEditor?.initialized === true, null, {
      timeout: 90000,
    });
  }

  async fillEditor({ title, html }) {
    const titleInput = this.page.locator('input[maxlength="200"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 60000 });
    await titleInput.fill(title);

    await this.page.evaluate((content) => {
      const editor = window.tinymce.activeEditor;
      editor.setContent(content);
      editor.fire('keyup');
      editor.fire('change');
    }, html);

    await this.page
      .waitForFunction(
        (expected) => {
          const editor = window.tinymce?.activeEditor;
          return editor && editor.getContent().replace(/<[^>]+>/g, '').length >= expected * 0.8;
        },
        html.replace(/<[^>]+>/g, '').length,
        { timeout: 30000 },
      )
      .catch(() => warn('could not confirm editor content length, continuing anyway'));
  }

  // Each target is either { name: /regex/ } matched against the accessible button name, or
  // { css: 'selector' }. Labels move around between Inkstone builds, so try several.
  async clickButton(targets, { timeout = 60000 } = {}) {
    const budget = Math.max(4000, Math.floor(timeout / targets.length));
    for (const target of targets) {
      const locator = target.css
        ? this.page.locator(target.css).first()
        : this.page.getByRole('button', { name: target.name }).first();
      try {
        await locator.waitFor({ state: 'visible', timeout: budget });
        await locator.click({ timeout: budget });
        return true;
      } catch {
        /* try the next strategy */
      }
    }
    return false;
  }

  async dismissOptionalModal() {
    const modal = this.page.locator('.ant-modal:visible').last();
    if ((await modal.count()) === 0) return false;
    const hasThoughtBox = (await modal.locator('#author_thought_area').count()) > 0;
    if (!hasThoughtBox) return false;
    log('submitting the author-thought dialog');
    await modal.locator('button:has-text("Submit"), button:has-text("OK")').last().click();
    return true;
  }

  async publishChapter(chapter) {
    await this.openNewChapter();
    await this.fillEditor(chapter);

    log(`saving chapter ${chapter.index} "${chapter.title}"`);
    const saved = await this.clickButton([
      { name: /^save$/i },
      { name: /^update$/i },
      { css: 'button.g_header_btn' },
    ]);
    if (!saved) {
      await this.snapshot(`save-failed-${chapter.index}`);
      throw new InkstoneError(`could not find the Save button for chapter ${chapter.index}`);
    }

    await this.page
      .waitForURL(/\/novels\/chapter\/edit\//, { timeout: 90000 })
      .catch(() => warn('still on the create route after save, continuing to publish'));
    await sleep(1500);

    log(`publishing chapter ${chapter.index}`);
    const opened = await this.clickButton([{ name: /^publish$/i }, { name: /^publish now$/i }]);
    if (!opened) {
      await this.snapshot(`publish-button-missing-${chapter.index}`);
      throw new InkstoneError(`could not find the Publish button for chapter ${chapter.index}`);
    }

    await sleep(2500);
    await this.dismissOptionalModal();
    await sleep(1500);

    const confirmed = await this.clickButton(
      [
        { name: /^confirm$/i },
        { css: '.ant-modal-footer .ant-btn-primary' },
        { name: /^ok$/i },
        { name: /^yes$/i },
      ],
      { timeout: 45000 },
    );
    if (!confirmed) warn('no confirm dialog appeared, assuming publish went through');

    await sleep(3000);
    await this.dismissOptionalModal();

    const bodyText = (await this.page.locator('body').innerText().catch(() => '')) ?? '';
    const blocked = /please\s+(complete|fill|set)|can'?t\s+publish|not allowed|too\s+(fast|often)|reached\s+(the\s+)?(daily|limit)|forbidden/i.test(
      bodyText,
    );
    if (blocked) {
      await this.snapshot(`publish-blocked-${chapter.index}`);
      throw new InkstoneError(
        `Inkstone refused the publish. On-page message: ${bodyText.replace(/\s+/g, ' ').slice(0, 400)}`,
      );
    }
  }
}

async function safeJson(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export { InkstoneError, sleep };

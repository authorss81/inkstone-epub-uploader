import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright';

export const BASE = 'https://inkstone.webnovel.com';
const PASSPORT_HOST = 'oa-passport.webnovel.com';

const log = (msg) => console.log(`[inkstone] ${msg}`);
const warn = (msg) => console.warn(`[inkstone] ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class InkstoneError extends Error {}

function artifactDir() {
  const dir = process.env.ARTIFACT_DIR || 'artifacts';
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function shoot(page, name) {
  const file = `${artifactDir()}/${name}-${Date.now()}.png`;
  try {
    await page.screenshot({ path: file, fullPage: true });
    warn(`screenshot saved: ${file}`);
  } catch {
    /* ignore */
  }
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
    this.browser = await chromium.launch({
      headless: this.headless,
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
    const cookies = await this.context.cookies([BASE, `https://.${PASSPORT_HOST.replace(/\.webnovel\.com$/, '.webnovel.com')}`].flat());
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
    const returnUrl = `${BASE}/novels/list`;
    log('opening login page');
    await this.page.goto(`${BASE}/login?returnUrl=${encodeURIComponent(returnUrl)}`, {
      waitUntil: 'domcontentloaded',
    });

    const signInButton = this.page.locator('a[class*="login_button"]').first();
    await signInButton.waitFor({ state: 'visible', timeout: 60000 });
    await signInButton.click();

    const frameElement = this.page.frameLocator('iframe[title="login"]');
    const emailInput = frameElement.locator('input[type="text"], input:not([type])').first();
    const passwordInput = frameElement.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 60000 });

    log('submitting credentials');
    await emailInput.fill(email);
    await passwordInput.fill(password);

    const submit = frameElement.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Log in")').first();
    await submit.click();

    log('waiting for redirect back to inkstone');
    await this.page
      .waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 120000 })
      .catch(async () => {
        await shoot(this.page, 'login-stuck');
        throw new InkstoneError(
          'login did not complete. A captcha, email code or unusual-device check probably needs to be cleared once from a normal browser.',
        );
      });

    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
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
      const { body } = await this.apiGet(attempt.path, attempt.params);
      const result = body?.result;
      if (!result) continue;

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
    }
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

  async clickButton(patterns, { timeout = 60000 } = {}) {
    for (const pattern of patterns) {
      const locator = this.page.getByRole('button', { name: pattern }).first();
      try {
        await locator.waitFor({ state: 'visible', timeout: Math.min(timeout, 15000) });
        await locator.click();
        return true;
      } catch {
        /* try next */
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
    const saved = await this.clickButton([/^save$/i, /^save and/i]);
    if (!saved) {
      await shoot(this.page, `save-failed-${chapter.index}`);
      throw new InkstoneError(`could not find the Save button for chapter ${chapter.index}`);
    }

    await this.page
      .waitForURL(/\/novels\/chapter\/edit\//, { timeout: 90000 })
      .catch(() => warn('still on the create route after save, continuing to publish'));
    await sleep(1500);

    log(`publishing chapter ${chapter.index}`);
    const opened = await this.clickButton([/^publish$/i, /^publish and/i]);
    if (!opened) {
      await shoot(this.page, `publish-button-missing-${chapter.index}`);
      throw new InkstoneError(`could not find the Publish button for chapter ${chapter.index}`);
    }

    await sleep(2500);
    await this.dismissOptionalModal();
    await sleep(1500);

    const confirmed = await this.clickButton([/^confirm$/i, /^ok$/i, /^yes$/i], { timeout: 45000 });
    if (!confirmed) warn('no confirm dialog appeared, assuming publish went through');

    await sleep(3000);
    await this.dismissOptionalModal();

    const bodyText = (await this.page.locator('body').innerText().catch(() => '')) ?? '';
    const blocked = /please\s+(complete|fill|set)|can'?t\s+publish|not allowed|too\s+(fast|often)|reached\s+(the\s+)?(daily|limit)|forbidden/i.test(
      bodyText,
    );
    if (blocked) {
      await shoot(this.page, `publish-blocked-${chapter.index}`);
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

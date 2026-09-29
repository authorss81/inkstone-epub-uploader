# inkstone-epub-uploader

Publishes a chapter range from an EPUB to a **Webnovel Inkstone** book, fully automatically. No
copy/paste, no clicking through a UI 3600 times. Each run uploads a batch, remembers where it got
to, and carries on until the range is finished.

## Two ways to run it

| | How | Best for |
| --- | --- | --- |
| **Local** (recommended) | `npm run signin` once, then `npm run publish:all` on your own PC | Google/social accounts, and anything long-running |
| **GitHub Actions** | the workflow in this repo | password-based accounts |

Most Inkstone accounts are created through Google, Facebook or LINE, and Webnovel's password-reset
service reports those as "Account does not exist" — there is no password to script. The local mode
sidesteps that by signing in once through a real browser window and reusing that profile forever,
so no password is ever needed.

## Local mode (recommended)

```powershell
git clone https://github.com/authorss81/inkstone-epub-uploader.git
cd inkstone-epub-uploader
npm install
npx playwright install chromium          # or set BROWSER_CHANNEL=msedge / chrome
```

**1. Seal the EPUB** (only if you have not already):

```powershell
$env:VAULT_PASSPHRASE = Read-Host "vault passphrase"
node src/vault.mjs seal "C:\path\to\book.epub" vault/book.epub.enc
Remove-Item Env:\VAULT_PASSPHRASE
```

**2. Sign in, once, by hand:**

```powershell
$env:INKSTONE_BOOK_ID = "12345678"      # from inkstone.webnovel.com/novels/view/<id>
npm run signin
```

A Chrome window opens on the Inkstone login page. Sign in however you normally do. The script
watches for the session to appear, tells you how many chapters the book already has, and exits.
The profile lives in `.profile/` and is reused from then on.

**3. Publish:**

```powershell
$env:INKSTONE_BOOK_ID = "12345678"
$env:MAX_CHAPTERS = 50
$env:DELAY_SECONDS = 45
npm run publish:all
```

`publish:all` loops in batches of `MAX_CHAPTERS` until the range is finished, so you can leave it
running. `npm run publish` does a single batch and exits, which is the safer way to test.

Start small: `MAX_CHAPTERS=2`, `DELAY_SECONDS=90`, plain `npm run publish`. Check the result on
Inkstone, then switch to `publish:all`.

## How it works

1. `node src/vault.mjs unpack` decrypts `vault/` into `work/` using the `VAULT_PASSPHRASE`.
2. Reads `META-INF/container.xml` -> OPF -> spine, so chapters are ordered the way the EPUB defines
   them rather than by filename. Front matter (`cover.xhtml`, title pages, nav, ...) is skipped.
3. Converts each chapter XHTML into clean `<p>` HTML plus a title, stripping the redundant
   `Chapter N` prefix so Inkstone does not render "Chapter 12 Chapter 12 …".
4. Signs in once, stores the session in `.profile/`, and reuses it on later runs.
5. For each chapter: opens `/novels/chapter/create/<bookId>`, fills the title input, writes the body
   via `tinymce.activeEditor.setContent()`, clicks **Save**, then **Publish**, then **Confirm**.
6. Saves the resume point after every chapter.
7. Restarts the browser every `RESTART_EVERY` chapters and clears the SPA's draft-autosave
   `localStorage` before each one, so chapter 3000 is as quick as chapter 1 instead of the run
   degrading over hours.
8. Resume is kept in three independent places, so an interrupted run never republishes:
   - the chapter count Inkstone itself reports, re-read on every run (authoritative),
   - `state/state.json`,
   - the chapter range the run was given.

If the resume point cannot be determined the run stops and asks, rather than guessing chapter 1 and
duplicating your existing chapters.

## How it signs in

Inkstone accounts are usually created through Google, Facebook or LINE. Those accounts have **no
password** — Webnovel's reset service reports them as "Account does not exist" — so no script can
log in with one. Two supported ways around that:

**A. Upload from your own PC, no password needed (simplest).** Sign in once through a real browser
window; the profile is reused forever.

```powershell
$env:BROWSER_CHANNEL = "msedge"        # or chrome; skips the Chromium download
$env:INKSTONE_BOOK_ID = "12345678"
npm run signin                          # sign in with Google by hand, then it just works
$env:MAX_CHAPTERS = 50
npm run publish:all                     # loops in batches until the book is finished
```

**B. Cookie injection, so the uploading itself runs on GitHub Actions.** You spend a couple of
minutes on your PC exporting the session; the workflow then does the rest unattended.

Google refuses to let Google accounts sign in from an automated browser, so `npm run signin` and
`npm run grab` will both stop at "This browser or app may not be secure". A real, human-driven
browser export is the way around it:

1. Install **Cookie Editor** (or EditThisCookie) in your normal browser.
2. Sign in at <https://inkstone.webnovel.com>, go to your book's editor so the session is live.
3. With the extension, export the cookies for `webnovel.com` as JSON and save it, say,
   `cookies.json`.
4. Seal them:

```powershell
Set-Location "C:\path\to\inkstone-epub-uploader"
$env:VAULT_PASSPHRASE = Read-Host "vault passphrase"
$env:VAULT_DIR = "vault"
node src/import-cookies.mjs "C:\path\to\cookies.json"
Remove-Item Env:\VAULT_PASSPHRASE
git add vault
git commit -m "chore: refresh inkstone session"
git push
```

`import-cookies` filters to `*.webnovel.com`, converts the extension's format to a Playwright
`storageState`, never writes the plaintext inside the repo, and reports the token's real lifetime.
It also accepts a raw Playwright `storageState` JSON if you have one.

Then run the workflow as usual.

### Why the session survives longer than an hour

`inkstone_auth_token` is a **JWT with a 60 minute server-side expiry**, so a stored copy does
become unusable after an hour. What saves it is that Inkstone hands back a **freshly signed token in
the `Authorization` header of every response** — its own SPA overwrites its cookie the same way. The
uploader therefore:

- uses whatever token the server last signed, not the one it started with,
- pings `/tauthorweb/login/penname` every 4 minutes to hold the underlying session open, and
- writes the newest token back into `vault/session/storage-state.json.enc` at the end of a run.

Because each run inherits a token that was signed minutes ago rather than hours ago, a chain of runs
keeps itself alive indefinitely. You only need to re-export cookies after a long idle gap, or if a
run reports the session expired. The logs say `auth token rotated by the server` the first time a
rotation happens and `session persisted (N token rotation(s) folded in)` at the end.

If the keepalive ever reports failure mid-run, the run stops with a clear message rather than
failing chapter by chapter. Re-export the cookies and it continues from where it stopped.

## GitHub Actions setup

| Secret | Value |
| --- | --- |
| `VAULT_PASSPHRASE` | 20+ random characters |
| `INKSTONE_BOOK_ID` | numeric book id |
| `INKSTONE_EMAIL` / `INKSTONE_PASSWORD` | only if the account genuinely has a password |

Because the workflow runs in a public repo its runner minutes are unmetered, while the book and the
session stay encrypted in `vault/`. See [`vault/README.md`](vault/README.md).

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `INKSTONE_BOOK_ID` | — | required, the numeric book id |
| `PROFILE_DIR` | — | enables profile mode; `npm run signin` defaults it to `.profile` |
| `MAX_CHAPTERS` | `50` | chapters per batch |
| `DELAY_SECONDS` | `45` | pause between chapters |
| `START_CHAPTER` / `END_CHAPTER` | `0` | `0` means auto-detect / end of book |
| `HEADLESS` | `1` | set `0` to watch the browser work |
| `BROWSER_CHANNEL` | — | `chrome` or `msedge` to use an installed browser |
| `BROWSER_EXECUTABLE_PATH` | — | full path to a browser binary |
| `TITLE_STRIP_NUMBER` | `1` | set `0` to keep the `Chapter N` prefix |
| `COMMIT_EVERY` | `5` | chapters between progress saves in Actions mode |
| `RESTART_EVERY` | `25` | chapters between browser restarts; set `0` to disable |
| `MAX_FAILURES` | `3` | consecutive chapter failures before stopping |

## Maintenance helpers

```bash
node src/inspect.mjs ./book.epub 1      # chapter parser on a local file
node src/probe-login.mjs                # are Inkstone's selectors still valid?
```

## Limits worth knowing

- Inkstone has no public API, so this drives the real editor. A redesign means updating the
  selectors in `src/lib/inkstone.mjs`; failure screenshots land in `artifacts/`.
- `saveChapter` and `publishChapter` are rate limited. If Inkstone refuses, the run stops after
  `MAX_FAILURES`, keeps its progress, and the next run continues.
- A Google session can expire. If a run reports the profile is not signed in, re-run
  `npm run signin`.
- Review Webnovel's terms before automating bulk publication.

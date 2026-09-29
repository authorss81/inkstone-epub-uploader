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
7. Resume is kept in three independent places, so an interrupted run never republishes:
   - the chapter count Inkstone itself reports, re-read on every run (authoritative),
   - `state/state.json`,
   - the chapter range the run was given.

If the resume point cannot be determined the run stops and asks, rather than guessing chapter 1 and
duplicating your existing chapters.

## GitHub Actions mode

Only for accounts that have a real password. The workflow unpacks the vault, publishes, seals
progress back into `vault/`, and dispatches itself with `gh workflow run` until done.

| Secret | Value |
| --- | --- |
| `VAULT_PASSPHRASE` | 20+ random characters |
| `INKSTONE_BOOK_ID` | numeric book id |
| `INKSTONE_EMAIL` | only for password-based accounts |
| `INKSTONE_PASSWORD` | only for password-based accounts |

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

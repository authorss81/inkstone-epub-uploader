# inkstone-epub-uploader

Publishes a chapter range from an EPUB to a **Webnovel Inkstone** book, fully automatically, from
GitHub Actions. No browser, no copy/paste. Each run uploads a batch, records how far it got, and
dispatches the next run until the range is finished.

Because the workflow runs here, in a **public** repo, the runner minutes are unmetered rather than
capped at the 2,000/month that private repos get. The novel text and the Inkstone session cookie
are still protected: both live in [`vault/`](vault/README.md) encrypted with AES-256-GCM, and
plaintext only ever exists in the git-ignored `work/` directory while a run is in progress.

## How it works

1. `node src/vault.mjs unpack` decrypts `vault/` into `work/` using the `VAULT_PASSPHRASE` secret.
2. Reads `META-INF/container.xml` -> OPF -> spine, so chapters are ordered the way the EPUB defines
   them rather than by filename. Front matter (`cover.xhtml`, title pages, nav, ...) is skipped.
3. Converts each chapter XHTML into clean `<p>` HTML plus a title, stripping the redundant
   `Chapter N` prefix so Inkstone does not render "Chapter 12 Chapter 12 …".
4. Logs into Inkstone with Playwright once, stores the cookie jar in the vault, and reuses it on
   later runs, logging in again if the session expired.
5. For each chapter: opens `/novels/chapter/create/<bookId>`, fills the title input, writes the body
   via `tinymce.activeEditor.setContent()`, clicks **Save**, then **Publish**, then **Confirm**.
6. Every `COMMIT_EVERY` chapters, and again at the end of the run, `scripts/seal-and-push.sh`
   re-encrypts `work/` back into `vault/` and commits it with the repo's own `GITHUB_TOKEN`.
7. Resume is kept in three independent places, so a killed runner never republishes:
   - the chapter count Inkstone itself reports, re-read on every run (authoritative),
   - `vault/state/state.json.enc`,
   - the chapter range the run was given.
8. Writes a `finished` output and dispatches itself with `gh workflow run` while work remains.
   `workflow_dispatch` is the one event a `GITHUB_TOKEN` may trigger, so self-handoff works.

## Setup

### 1. Add the secrets

| Secret | Value |
| --- | --- |
| `VAULT_PASSPHRASE` | 20+ random characters. Only thing protecting the encrypted files. |
| `INKSTONE_EMAIL` | Inkstone / Webnovel account email |
| `INKSTONE_PASSWORD` | account password |
| `INKSTONE_BOOK_ID` | numeric id from the URL `/novels/view/<bookId>` |

```powershell
gh secret set VAULT_PASSPHRASE   --repo authorss81/inkstone-epub-uploader
gh secret set INKSTONE_EMAIL     --repo authorss81/inkstone-epub-uploader
gh secret set INKSTONE_PASSWORD --repo authorss81/inkstone-epub-uploader
gh secret set INKSTONE_BOOK_ID  --repo authorss81/inkstone-epub-uploader
```

### 2. Seal the book

Do this on a machine that has the EPUB, so the passphrase never leaves it:

```powershell
$env:VAULT_PASSPHRASE = Read-Host "vault passphrase"
node src/vault.mjs seal "C:\path\to\book.epub" vault/book.epub.enc
Remove-Item Env:\VAULT_PASSPHRASE
git add vault/book.epub.enc && git commit -m "feat: add encrypted book" && git push
```

### 3. Run it

Actions -> **Publish EPUB chapters to Inkstone** -> Run workflow.

| Input | Default | Meaning |
| --- | --- | --- |
| `book_id` | empty | overrides the secret |
| `start_chapter` | `0` | `0` resumes automatically from wherever the book already is |
| `end_chapter` | `0` | `0` means end of book |
| `max_chapters` | `50` | chapters per run, then hand off |
| `delay_seconds` | `45` | pause between chapters |
| `dry_run` | `false` | unpack and print a preview, upload nothing |

Start small: `max_chapters=2`, `delay_seconds=90`. Confirm on Inkstone that the chapters landed,
then let it chain.

## Local use

```bash
npm install
npx playwright install chromium

node src/inspect.mjs ./book.epub 1     # chapter parser
node src/probe-login.mjs               # are Inkstone's selectors still valid?

DRY_RUN=1 EPUB_PATH=./book.epub node src/publish.mjs

# for real, with a vault
VAULT_PASSPHRASE=... npm run vault:unpack
VAULT_PASSPHRASE=... INKSTONE_BOOK_ID=123 INKSTONE_EMAIL=... INKSTONE_PASSWORD=... \
  MAX_CHAPTERS=1 node src/publish.mjs
```

Useful environment variables: `TITLE_STRIP_NUMBER=0` keeps the `Chapter N` prefix, `COMMIT_EVERY`,
`MAX_FAILURES`, `HEADLESS=0` watches the browser work, `BROWSER_EXECUTABLE_PATH` uses a Chrome or
Edge you already have instead of Playwright's bundled Chromium.

## The vault

AES-256-GCM with a per-file random salt and IV, key derived by scrypt (N=32768). One flipped byte
anywhere in a file makes it fail to decrypt rather than hand back garbage. Files:

| Vault file | Written by | Contents |
| --- | --- | --- |
| `book.epub.enc` | you, once | the source EPUB |
| `state/state.json.enc` | the workflow | resume pointer and recent publish log |
| `session/storage-state.json.enc` | the workflow | Playwright cookie jar for Inkstone |

`work/` is git-ignored, and the workflow only ever runs `git add vault`, so plaintext cannot be
committed. Rotating `VAULT_PASSPHRASE` means re-sealing every file with the new one.

## Limits worth knowing

- Inkstone has no public API, so the workflow drives the real editor. A breaking Inkstone redesign
  means updating the selectors in `src/lib/inkstone.mjs`; failure screenshots are uploaded as
  artifacts so you can see what changed.
- `saveChapter` and `publishChapter` are rate limited. If Inkstone refuses, the run stops after
  `MAX_FAILURES`, keeps its progress, and the next run continues from there.
- Some accounts must clear a captcha or device check once. If that happens the first run fails with
  a screenshot; sign in manually once in a normal browser and later runs reuse the stored session.
- If a run times out or the runner dies, GitHub never reaches the hand-off step and the chain stops.
  Everything up to that point is sealed into the vault, so re-running resumes correctly.
- Review Webnovel's terms before automating bulk publication.

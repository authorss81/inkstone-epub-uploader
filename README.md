# inkstone-epub-uploader

Publishes a chapter range from an EPUB to a **Webnovel Inkstone** book, fully automatically, from
GitHub Actions. No browser, no copy/paste. Each run uploads a batch, records how far it got, and
dispatches the next run until the range is finished.

This repo is **code only**. It is a public library so the automation is auditable and forkable.

```
inkstone-epub-uploader   (public)   src/, package.json, workflow-template/
inkstone-epub-assets     (private)  book.epub, state/, session/, .github/workflows/publish.yml
```

The workflow lives in the private repo, so it can read the EPUB and commit progress using its own
`GITHUB_TOKEN`. No cross-repo token, no deploy key, nothing to rotate.

## How it works

1. Reads `META-INF/container.xml` -> OPF -> spine, so chapters are ordered the way the EPUB defines
   them rather than by filename. Front matter (`cover.xhtml`, title pages, nav, ...) is skipped.
2. Converts each chapter XHTML into clean `<p>` HTML plus a title, stripping the redundant
   `Chapter N` prefix so Inkstone does not render "Chapter 12 Chapter 12 …".
3. Logs into Inkstone with Playwright once, stores the cookie jar in the private repo and reuses it
   on later runs, logging in again if the session expired.
4. For each chapter: opens `/novels/chapter/create/<bookId>`, fills the title input, writes the body
   via `tinymce.activeEditor.setContent()`, clicks **Save**, then **Publish**, then **Confirm**.
5. Keeps the resume point in three independent places, so a killed runner never republishes:
   - the chapter count Inkstone itself reports, re-read on every run (authoritative),
   - `state/state.json`, committed back to the private repo every few chapters,
   - the chapter range the run was given.
6. Writes a `finished` output and the workflow dispatches itself with `gh workflow run` while work
   remains. `workflow_dispatch` is the one event a `GITHUB_TOKEN` may trigger, so self-handoff works.

## Set it up

Create a **private** repo with this layout and copy
[`workflow-template/publish.yml`](workflow-template/publish.yml) into its `.github/workflows/`:

```
book/book.epub                 source EPUB
state/state.json               resume pointer
session/storage-state.json     Playwright cookie jar
```

Then add three secrets to that private repo:

| Secret | Value |
| --- | --- |
| `INKSTONE_EMAIL` | Inkstone / Webnovel account email |
| `INKSTONE_PASSWORD` | account password |
| `INKSTONE_BOOK_ID` | numeric id from the URL `/novels/view/<bookId>` |

Finally point the `Check out uploader code` step at your fork of this repo and run the workflow.

### Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `book_id` | empty | overrides the secret |
| `start_chapter` | `0` | `0` resumes automatically from wherever the book already is |
| `end_chapter` | `0` | `0` means end of book |
| `max_chapters` | `50` | chapters per run, then hand off |
| `delay_seconds` | `45` | pause between chapters |
| `dry_run` | `false` | parse the EPUB and print a preview, upload nothing |

Start small: `max_chapters=2`, `delay_seconds=90`. Confirm the output, then let it chain.

## Local use

```bash
npm install
npx playwright install chromium

node src/inspect.mjs ./book/book.epub 1

DRY_RUN=1 EPUB_PATH=./book/book.epub node src/publish.mjs

# for real
ASSETS_DIR=./assets INKSTONE_BOOK_ID=123456 INKSTONE_EMAIL=... INKSTONE_PASSWORD=... \
  MAX_CHAPTERS=1 node src/publish.mjs
```

Useful environment variables beyond the workflow inputs:
`TITLE_STRIP_NUMBER=0` keeps the `Chapter N` prefix, `COMMIT_EVERY`, `MAX_FAILURES`, `HEADLESS=0`
watches the browser work.

## Limits worth knowing

- Inkstone has no public API, so the workflow drives the real editor. A breaking Inkstone redesign
  means updating the selectors in `src/lib/inkstone.mjs`; failure screenshots are uploaded as
  artifacts so you can see what changed.
- `saveChapter` and `publishChapter` are rate limited. If Inkstone refuses, the run stops after
  `MAX_FAILURES`, keeps its progress, and the next run continues from there.
- Some accounts must clear a captcha or device check once. If that happens the first run fails with
  a screenshot; sign in manually once in a normal browser and later runs reuse the stored session.
- Review Webnovel's terms before automating bulk publication.

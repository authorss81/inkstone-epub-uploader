# vault/

Everything in this directory is encrypted with AES-256-GCM using `VAULT_PASSPHRASE` from the repo
secrets. Without that passphrase the files are noise. Plaintext is written to `work/` during a run
and sealed back here afterwards; `work/` is git-ignored and never committed.

| File | Written by | Contents |
| --- | --- | --- |
| `book.epub.enc` | you, once | the source EPUB |
| `state/state.json.enc` | the workflow | resume pointer and recent publish log |
| `session/storage-state.json.enc` | the workflow | Playwright cookie jar for Inkstone |

Add the book yourself, from a machine that has it, so the passphrase never leaves it:

```powershell
$env:VAULT_PASSPHRASE = Read-Host "vault passphrase"
node src/vault.mjs seal "C:\path\to\book.epub" vault/book.epub.enc
Remove-Item Env:\VAULT_PASSPHRASE
git add vault/book.epub.enc
git commit -m "feat: add encrypted book"
git push
```

Re-sealing an existing book for a second novel:

```powershell
$env:VAULT_PASSPHRASE = Read-Host "vault passphrase"
node src/vault.mjs seal "C:\path\to\book2.epub" vault/book.epub.enc
git rm --cached vault/state/state.json.enc vault/session/storage-state.json.enc -q
Remove-Item Env:\VAULT_PASSPHRASE
```

Rotating the passphrase means re-sealing every file with the new one.

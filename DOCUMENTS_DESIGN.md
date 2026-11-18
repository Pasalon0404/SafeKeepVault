# Design note: documents in the vault

Status: **approved** (Nov 18, 2026). Nothing is built yet.

Owner's decisions (Nov 18):
- the vault partition grows to 900 MB;
- 100 MB per document;
- "Remove it from the Transfer Drive after importing" is checked by
  default;
- a Documents tab on the Encrypted Notes page;
- no Word (`.docx`) previews: save it as PDF first. Word files are stored
  and exported like any other file.

## The idea

Encrypted Notes holds short notes typed into SafeKeep's editor. This adds
**Documents**: files brought in from the Transfer Drive and kept inside the
encrypted vault, such as a letter of instruction for heirs, a will, recovery
steps, account records or scans. SafeKeep shows the common types itself, so
they can be read on the offline computer without copying them anywhere.

| Type | In SafeKeep |
|---|---|
| Text (`.txt`, `.md`, `.csv`) | shown as plain text |
| Images (PNG, JPEG, GIF, WebP) | shown |
| PDF | shown page by page (pdf.js) |
| Word (`.docx`), LibreOffice (`.odt`) and anything else | stored and exported, no preview |

Word and LibreOffice files can be saved as PDF before importing, which
gives an exact preview.

## 1. A larger vault: 900 MB

The vault partition grows from **300 MB to 900 MB**. Inside the encrypted
vault that is about **750 MB** usable, against about 200 MB today.

**Why 900, not 1,000.** The image has to fit the smallest real "8 GB" flash
drives, about 7,400 MB usable (`build.sh`). Today's image is 6,704 MB, which
leaves about 700 MB:

| | Today | Proposed |
|---|---|---|
| Boot partitions | 259 MB | 259 MB |
| OS (two slots) | 3,584 MB | 3,584 MB |
| Vault | 300 MB | **900 MB** |
| Transfer Drive | 2,560 MB | 2,560 MB |
| Image | 6,704 MB | **7,304 MB** |
| Left on the smallest 8 GB drive | about 700 MB | about 100 MB |

1,000 MB would leave no margin. The OS and Transfer Drive keep their size:
the OS needs both update slots, and the Transfer Drive must hold an update
file (about 1.3 GB). The 8 GB minimum stays.

**What changes:**
- `build.sh`: `DATA_SIZE_MB=900`. Vault setup already makes the vault fill
  its partition (`setup-vault.sh`, partition space minus 50 MB), so nothing
  else changes there.
- First setup writes the larger vault file once (zeros, about 850 MB). On a
  typical flash drive that adds roughly half a minute to two minutes, and
  the progress text should say so.
- The image file becomes about 7.3 GB; the release zip stays about the same
  size, because the empty vault partition compresses away.
- Size comments in `setup-vault.sh`, `safekeep-harden.sh` (which also still
  says the Transfer Drive is 300 MB), the README and `UPDATER_DESIGN.md`.
- `test-os-slots.mjs`: check that the partitions add up to no more than
  7,400 MB.

**Existing flash drives keep their 300 MB vault.** The in-place updater only
writes the OS partition. A larger vault needs an Encrypted Backup, a new
flash and a restore, which the release notes and website explain. Documents
work on a 300 MB vault too, just with less room.

**Backups still fit.** An Encrypted Backup is one `.7z` on the Transfer
Drive: a full 750 MB vault fits next to an update file. Restore unpacks into
memory (`/tmp/reliquary`), so restoring a full vault needs about 1 GB of
free RAM. To check on a 4 GB laptop before release.

## 2. Storing documents

**Where.** A new vault folder, `documents/`, next to `codex/`. Each document
is two files:
- `<id>.doc`: the file's bytes, unchanged;
- `<id>.meta.json`: its name, detected type, size, SHA-256 and the date
  it was added.

`<id>` is 16 random hex characters. The original file name is kept only in
the metadata, so odd characters in a name never reach the file system.

**Saving** works like notes. The app downloads `SKDOC-<id>.doc` and
`SKDOC-<id>.meta.json`; Chromium drops them in `seeds/`; the watcher in
`safekeep-boot.sh` checks the names against a fixed pattern and moves them
to `documents/`. After the move, the app reads the file back and checks
its SHA-256 before saying "Saved".

**Listing.** At boot, `safekeep-boot.sh` writes
`documents/.documents-index.json` with each document's metadata (not its
contents) and the vault's free space. The app keeps the list up to date
itself after that, as it does for notes. Documents are read only when
opened, with `fetch(file://…)`.

**Rename** writes a new `meta.json`. **Delete** is a request the watcher
carries out with fixed logic (the app can't delete files itself): it removes
both files.

**Limits.**
- 100 MB per document, and never more than the vault's free space minus
  20 MB. SafeKeep says how much room is left before importing.
- The Documents list shows the space used and left.

**Not in a Temporary Session.** There is no vault to save into, so
Documents is hidden there, as saving notes is today.

## 3. Importing and exporting

**Import from the Transfer Drive.** Documents uses the Transfer Drive
bridge the app already has (`transfer-drive.js`): list the files, pick one,
read its bytes.
- The type is detected from the file's first bytes, not its extension. A
  `.pdf` that isn't a PDF is stored as "other".
- A checkbox, checked by default: **Remove it from the Transfer Drive
  after importing.** The Transfer Drive isn't encrypted, so leaving a copy
  there undoes the point. The text says plainly that deleting from a flash
  drive isn't a secure erase. Anything truly sensitive should be copied
  onto the Transfer Drive from a computer you trust, and its copy on that
  computer deleted too.

**Export to the Transfer Drive** is a deliberate action, with a warning that
the copy there isn't encrypted. It uses the bridge's write operation.

## 4. Viewing safely

Documents are **outside content**: a file someone else made, read by the
app. PROJECT_NOTES open item 4 names this as the case for looking at the
Chromium sandbox again. The design keeps document parsing away from the
vault in three ways:

1. **No browser-native viewers.** Chromium's own PDF viewer (PDFium, C++)
   would run in the root, unsandboxed browser. SafeKeep never navigates to
   a document; PDFs are drawn by pdf.js, which is written in JavaScript.
2. **A sealed viewer frame.** Every preview runs in an `<iframe
   sandbox="allow-scripts">` without `allow-same-origin`. Its origin is
   opaque, so even a viewer bug triggered by a malicious file can't read the
   vault (`file://` fetches), the app's memory, or start a download. The app
   sends the file's bytes to the frame by `postMessage`; the frame sends
   nothing back except "page 3 of 12" style status.
   **Checked Nov 18** in the pinned ungoogled-chromium 155 with the
   kiosk's `--allow-file-access-from-files`: the app page could read a
   file next to it, while from inside such a frame `fetch` and
   `XMLHttpRequest` of the same file were blocked, `parent.document` and
   the app's variables threw `SecurityError`, and a download it clicked
   didn't start (no `allow-downloads`). Messages from it arrive with origin
   `null`.
   **Still to check when building:** pdf.js's worker starting inside the
   frame (a worker from a `blob:` URL in an opaque origin). If it can't,
   pdf.js runs without a worker inside the frame: slower on long PDFs, just
   as sealed.
3. **Strict viewer settings.**
   - Text is shown with `textContent`, never as HTML, and only the first
     5 MB.
   - Images: PNG, JPEG, GIF and WebP only, by their first bytes. SVG can
     carry script, so it is stored but not shown.
   - PDF: pdf.js with `isEvalSupported: false` (fonts can't run code; the
     fix for CVE-2024-4367), no PDF scripting (the `pdf.sandbox` module
     isn't bundled), no forms or XFA, and links shown but not clickable.

**Libraries.** Pinned exact versions in `package-lock.json`, choosing
releases at least two weeks old, bundled into `boot.html` like everything
else:

| Library | Size in the app |
|---|---|
| pdf.js (`pdfjs-dist`, Apache-2.0): main module and worker | about 1.8 MB |

The app grows from about 4.6 MB to about 6.4 MB. pdf.js's extra
font files (standard fonts, CMaps for Chinese, Japanese and Korean) aren't
bundled at first: PDFs that rely on them may show substitute fonts.

## 5. Backup, restore and wipe

- **Encrypted Backup** adds `documents` to `BACKUP_DIRS` in
  `safekeep-boot.sh`, and Restore offers it like Notes and the Passphrase
  Library.
- **Wipe** adds `documents` to the folders it deletes.
- **Health** mentions documents in the "what an Encrypted Backup covers"
  text.

## 6. Where it appears

A **Documents** tab on the Encrypted Notes page, next to the notes, with:
- the list (name, type, size, date added) and the space meter;
- **Import from Transfer Drive**;
- for each document: **Open**, **Rename**, **Export to Transfer Drive**,
  **Delete** (with a confirmation).

Opening a document shows it in the sealed viewer, with page buttons and
zoom for PDFs.

## 7. Tests

- **Storage:** import and read back each type, rename, delete, the
  100 MB and free-space limits, the boot index, and names the watcher must
  refuse.
- **Viewers:** a sample of each type renders; a malformed PDF, a PDF with
  JavaScript and a PDF with a font exploit sample render or fail without
  running code.
- **Sealed frame:** from inside the viewer frame, `fetch` of a vault file
  and access to `parent` both fail.
- **Backup, restore, wipe** include `documents/`.
- **Layout:** the image fits 7,400 MB; a 900 MB vault is created at setup.
- On a flash drive: import a few real documents, back up, restore onto a
  fresh drive.

## 8. Scope

- **Built in one go:** the 900 MB vault, Documents with text, images and
  PDF, import, export, rename, delete, backup, restore and wipe.
- Not planned: `.docx` or `.odt` previews (save as PDF first), editing
  documents, or searching inside them.

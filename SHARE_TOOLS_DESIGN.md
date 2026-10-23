# Design note: one guided flow for Seed XOR and Shamir Backup

Status: **All four parts built, tested on Dave's stick and released in v1.52** (Oct 23, 2026).
- Part 1: `shared/share-flow.js`, `shared/word-boxes.js`,
  `shared/share-flow-ui.js`, `shared/slip39-wordlist.js`, exposed as
  `window.ShareFlow`; `test-share-flow.mjs`.
- Part 2: Seed XOR uses the flow. Its Merge tab, manual seed entry, Copy,
  share cards and Reconstruction Drill are gone; the final check rebuilds
  the seed from the typed shares (`_xorVerifyTyped`). "Leave anyway"
  discards unchecked shares. `test-seed-xor-vectors.mjs` covers the new
  functions.
- Added to Part 2 at the owner's request: **Check shares I already have**
  (see below), shared as `ShareFlow.check` so Shamir gets it in Part 3.
- Part 3: Shamir Backup uses the flow and the checker. Its share cards,
  Copy, Dry Run and extra exit buttons are gone. The "leave without
  checking?" warning is shared by both tools (`_SHARD_TOOLS`). If a share
  passphrase was set, the final check asks for it again
  (`finalField`); the checker has a passphrase box (`extraField`).
  `test-slip39-vectors.mjs` drives the tool's own functions.
- Learned in Part 3: shamir-mnemonic-ts combines **exactly** M shares;
  more than M is an error. The final check therefore combines every run
  of M consecutive shares (wrapping round), so every share takes part,
  and the checker's messages say how many shares the set needs. The
  welcome screen's Recover Shamir Backup has the same limit (Part 4).
- Owner's decision (Oct 23): the share passphrase is only what the user
  types under Advanced. It is no longer filled in and locked from the
  Dashboard's BIP-39 passphrase; when one is active, the done screen
  says to back it up separately, since the shares hold only the seed
  words.
- Part 4: both welcome-screen restore panels use the shared word boxes.
  Restore via Seed XOR keeps its share count and 12/24 choice, with Scan
  QR per share; a bad checksum names the share. Recover Shamir Backup
  replaces its text box with 20/33 SLIP-39 word boxes; each share is
  checked when added (checksum, same set, not a duplicate) using
  `SLIP39.shareInfo` (`Share.fromMnemonic`), and the status says how many
  shares the set needs. More shares than needed now work: every run of M
  consecutive shares is combined and they must agree. Typed shares are
  wiped when leaving either panel.

## The problem

Seed XOR (`state-seedxor`) and Shamir Backup (`state-slip39`) both split
the vault's seed into shares written on paper. They were among the first
tools built. They do the same job in different ways, and both feel
cluttered:

- After a split, each tool shows every share at once, with Copy, Show QR
  and Print on each, followed by the check, all on one page. A 3-share
  XOR split is about six laptop screens long; a 2-of-3 Shamir split about
  five. Almost all of XOR's page is in red warning style.
- Checking the paper copy works differently in each tool (table below).
  XOR makes you retype every word of every share at the end (72 words for
  3 × 24). Shamir's check is optional, uses plain text boxes with no word
  help, and only tests any M shares, so a typo in another share goes
  unnoticed.
- Some buttons don't fit an offline device. Copy puts share words, or
  the whole recovered seed in XOR's Merge tab, on a clipboard nothing can
  read. The Merge tab can also show the recovered seed as a QR code.

## Facts the design rests on

| | Seed XOR | Shamir Backup |
|---|---|---|
| Share format | BIP-39 phrases, same length as the seed (12 or 24 words) | SLIP-39 shares, 20 words (12-word seed) or 33 words (24-word seed), own 1024-word list |
| Scheme | N of N (2, 3 or 4); all needed | M of N (2 of 3, 3 of 5, 4 of 7, custom up to 16) |
| Which seed | Vault seed, or a typed or scanned one ("Clear & Enter Different Seed") | Vault seed only |
| Check your copy | Required: "Reconstruction Drill" retypes all N shares in word boxes with autocomplete (`xvg_*`), compares fingerprints. Leaving early shows the "leave anyway" warning (`_shardSoftIntercept`) | Optional: "Verify Physical Backup" hides the shares and asks for any M in plain text boxes (`s39v_*`) |
| Per-share actions | Copy, Show QR (the phrase), Print | Copy, Show QR (the share, uppercase), Print |
| Recovery | Merge tab in the tool (shows the seed, with Copy and Show QR), and Welcome → Restore via Seed XOR (`xrr_*`, word boxes) | Welcome → Recover Shamir Backup only (`s39r_*`, one text box, shares added one at a time) |
| Extras | Fingerprint stamped on each share and print page | Optional SLIP-39 passphrase under "Advanced" |
| Exits | Reset Tool | Cancel, Abort, Reset Tool |

- Both print pages already carry the share, its number, the scheme and
  the seed's fingerprint. **Shamir's print page also prints the seed's
  last word** ("Checksum Word") on every share. That word carries part of
  the seed (3 of its 8 bits are seed data for a 24-word seed, 7 of 11 for
  a 12-word seed), so one share gives away a little of the seed, which
  Shamir is meant to prevent. XOR's print page doesn't do this. The
  fingerprint alone identifies the seed. **Fixed Oct 23:** the Shamir
  print page no longer shows it (`test-review-regressions.mjs`, section 6).
- `shamir-mnemonic-ts` exposes the SLIP-39 word list through
  `wordsFromIndices`, so the SLIP-39 word boxes can autocomplete like the
  BIP-39 ones.
- SLIP-39 shares carry their own checksum, so a mistyped Shamir share is
  usually caught as soon as it is typed. XOR shares are BIP-39 phrases, so
  their last word is a checksum too.

## Decisions (confirmed by the owner, Oct 23)

1. **Checking each share is required in both tools**, with the existing
   "leave anyway" warning as the way out. Shamir tolerates a lost share,
   but a typo found years later is still a lost share.
2. **Both tools split only the vault seed.** XOR's "Clear & Enter
   Different Seed" and its seed QR scan go away.
3. **Shamir's share passphrase stays, still under "Advanced"**, and the
   check asks for it once if it was set.

## The design: one flow, four steps

Both tools use the same screens and the same code for the steps, with a
small description of each scheme (word list, share length, how to split,
how to check).

### Step 1: Choose

- The seed: the vault seed, shown as now (last word and fingerprint).
- The scheme in plain words:
  - XOR: "All 2 / 3 / 4 shares needed". One line: "Shares look like
    ordinary 12/24-word seeds. Losing any one share loses the seed."
  - Shamir: "Any 2 of 3 / 3 of 5 / 4 of 7 / Custom". One line: "You can
    lose N−M shares and still recover. Shares use their own word list."
- Shamir only: "Advanced: share passphrase", as today.
- One button: "Make shares".

### Step 2: Write down share k of N (one screen per share)

- Heading "Share k of N", the scheme ("all 3 needed" or "any 2 of 3") and
  the seed's fingerprint.
- The words, large, in a numbered grid. No hover-to-reveal: this screen
  exists to be read.
- Print and Show QR are offered here. No Copy.
- Button: "I've written it down — check it".

### Step 3: Check share k

- Word boxes with autocomplete from the right word list (BIP-39 or
  SLIP-39), the same component in both tools. A "Scan QR" button fills
  the boxes from the share's QR code.
- SafeKeep compares the typed share with the share it made, word by
  word, and marks the wrong words. Nothing else is revealed.
- Correct: "Share k checked", then on to share k+1 (step 2).
  Wrong: fix the marked words, or go back to step 2 to look again.
- After the last share, both tools also recombine the typed shares and
  confirm the fingerprint matches the vault seed. This checks the maths,
  not just the typing.

### Step 4: Done

- A summary: N shares, how many are needed to recover, the fingerprint,
  and "Store each share in a different place."
- How to recover: Welcome → Restore via Seed XOR / Recover Shamir Backup.
- "Back to Dashboard". The shares are wiped from the screen and memory.

### Check shares I already have

Removing XOR's Merge tab left no way, with a seed in the vault, to test
shares made months ago. Each tool's setup card therefore has a second
button, **Check Shares I Already Have**: the user types in (or scans) the
shares, and SafeKeep says whether they rebuild the vault seed, naming
both fingerprints if not. Nothing is loaded.

**Show the seed words** (added after v1.52, at the owner's request: the
words are the point of combining shares). Below the result, a button
shows the rebuilt seed's words, hidden until pressed, with no Copy or QR
code. They are labelled either "These are your vault seed's words" or
"This is NOT your vault seed" with its fingerprint, so a different
wallet can't be mistaken for the user's own. Editing any share or the
passphrase clears them, and leaving the tool wipes them. A check that
fails outright (a wrong word, a share entered twice, too few shares)
offers no words.

**Either share length.** Since Check Shares can show another wallet's
words, its share length is a choice, not fixed by the vault seed: Seed
XOR offers 12 or 24 words, Shamir 20 or 33 (a 12- or 24-word seed). The
vault seed's length is the default, and scanning a share of the other
length switches to it.

### Leaving early

Leaving before every share is checked shows the existing "leave anyway"
warning in both tools. One "Cancel" in every step replaces Cancel, Abort
and Reset Tool.

### What goes away

- Copy, on every share and on the recovered seed.
- XOR's Merge tab, including its seed QR code. Recovery happens in one
  place, the welcome screen's Restore.
- XOR's "Clear & Enter Different Seed" and seed QR scan (decision 2).
- The seed's last word on Shamir's print page (already removed, Oct 23).
- The red warning style on everything. One warning stays where it
  matters: XOR's "all N needed" on step 1 and on each share.

## Restore screens

The welcome screen's two restore panels get the same word boxes:

- **Restore via Seed XOR** (`xrr_*`) already uses word boxes; it gets
  the shared component and a Scan QR per share.
- **Recover Shamir Backup** (`s39r_*`) replaces its single text box with
  SLIP-39 word boxes (20 or 33, picked from the first share), keeping
  Scan QR and the add-one-share-at-a-time list.

## Parts

1. **Shared flow and word boxes.** The four-step screens and a word-box
   component that takes a word list and a length, used by both tools.
   Tests: the flow's state (next, back, wrong word, leave early) with
   both schemes; autocomplete with both word lists.
2. **Seed XOR on the new flow.** Remove Merge, Copy and manual seed entry.
   Tests: split and recombine vectors (existing), per-share check, the
   fingerprint check, the leave warning.
3. **Shamir Backup on the new flow.** Same, plus the passphrase. Tests:
   SLIP-39 vectors (existing), per-share check, a passphrase split.
4. **Restore screens** use the shared word boxes. Tests: restore from
   typed and scanned shares for both schemes; a share from the wrong
   scheme is refused with a clear message.

Each part: browser check at laptop size (1366×900 and 1920×1080), then a
quick update on a stick. Docs and the website's tool pages are updated at
release time.

## Out of scope

- Changing the share formats. Existing shares stay readable: XOR is plain
  BIP-39 and the Shamir shares are standard SLIP-39 holding the seed's
  entropy.
- Shamir groups (SLIP-39's two-level groups). Single group only, as now.
- Opening Trezor-made SLIP-39 wallets (a separate, known limitation).

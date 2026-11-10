# SafeKeep Vault — Project Notes

> **Start with the "Current state" section below (updated Nov 9, 2026).**
> Everything after the line marked *"Historical notes (May 2026)"* is the
> original pickup guide. It is still useful for architecture and gotchas,
> but parts of it are out of date. Where the two disagree, trust the
> Current state section. `CLAUDE.md` holds the standing rules for AI
> sessions (desktop/laptop only, no version bump until the owner asks).

---

## Since v1.65 (on the branch, not released)

- **Trezor passphrase wallets** (PSBT Signer → co-signing card): a
  *Use a passphrase on the Trezor* box under the Trezor button (typed
  twice, from the Passphrase Library, or the passphrase applied on the
  Dashboard). In a normal session it is also offered when the paired
  Trezor isn't one of the wallet's keys but some unsigned keys are
  unnamed. Helper `safekeep-trezor.py` `sign` takes an optional
  `passphrase` (NFKD, at most 50 bytes, no control characters): the
  pairing is checked on the standard wallet first, then a fresh session
  with the passphrase (HWI's `TrezorClient(password=…)`; a Trezor One asks
  the computer) must be one of the fingerprints the PSBT's inputs name,
  or nothing is sent (`wrong_passphrase`). Refused if passphrase
  protection is off (`passphrase_off`). The request is overwritten before
  deletion. Not yet tried on a real Trezor One. Tests
  `test-trezor-passphrase.mjs`, `usbbootdrive/tests/test-trezor-helper.py`.
- **Hardware signing for single-sig** (PSBT Signer → co-signing card): the
  card used to need an m-of-n multisig (`_psbtMultisigStatus`). Now
  `_psbtSigningStatus` falls back to `_psbtSingleSigStatus` (every input
  one key with a named origin, BIP-32 or Taproot; a 1-of-1), so the
  Trezor (with or without a passphrase) and the Coldcard can sign
  single-sig transactions too, in a normal or a Temporary Session. The
  helpers never had a multisig limit. A single-sig spend SafeKeep signed
  itself still shows no card. In hardware-only mode with a Trezor
  passphrase, the Trezor's standard fingerprint needn't be a key: the
  helper checks the passphrase wallet.
- **Trezor settings without Trezor Suite** (Device Options → Trezor, and
  *Trezor Tools* on the welcome screen in a Temporary Session, which has no
  Dashboard): *Passphrase Protection* (on/off), *Erase This Trezor*
  (checkbox + type ERASE; only the Trezor whose fingerprint was read after
  unlocking), *Recover from Words* (any session; the Trezor must have no
  seed; 12/18/24 words, optional passphrase protection; new PIN). Default
  method "advanced" (trezorlib `RecoveryDeviceType.Matrix`): per word the
  Trezor shows 3 grids of letter ranges, then up to 6 words (2 columns);
  the app shows a blank number-pad grid and only the position (or "back")
  goes back, as a `matrix` dialog question (layout 9/6, word, level 0-3).
  Words from paper always use it. For a Seed Vault seed there is also
  "Quicker" (method "words", scrambled words + decoys): the seed's words are
  shown numbered to click, decoys typed. The Trezor One refuses the words
  method for 12/18 words while its safety checks are Strict ("Advanced
  recovery must be used", legacy/firmware/recovery.c), so the helper first
  sets `safety_checks=PromptTemporarily` (confirmed on the Trezor; kept in
  its RAM only, Strict again after a restart) and the app says to unplug it
  afterwards.
  Helper actions `passphrase_setting`, `wipe`, `recover` use trezorlib's
  `apply_settings` / `wipe` / `recover` (ScrambledWords) with a `DialogUI`:
  each question (`button`, `pin` new_first/new_second/current, `word`)
  goes to `$SIGNAL_DIR/TREZOR_DIALOG.json`; the app answers with
  `TREZOR_REPLY.json` (request id + question number; overwritten and
  deleted by the helper, shredded by the watcher). The Trezor One asks for
  words in a scrambled order with decoys, shown on its screen. The PIN grid
  has an ask mode (`_tzPinAsk`); its z-index is now above full-screen
  overlays. The pairing is removed after a wipe or a recovery. Not yet
  tried on a real Trezor One. Tests `test-trezor-tools.mjs`,
  `usbbootdrive/tests/test-trezor-helper.py`.
- **File router bug (in v1.65):** the router moves any downloaded `.json`
  containing `"passphrase"` into the Passphrase Library folder, and didn't
  skip `COLDCARD_*` / `TREZOR_*`. So a *Send a Passphrase to the Coldcard*
  request could be taken before the Coldcard Watcher read it (a 1 s vs 2 s
  race): the passphrase stored in `passphrases/` as `COLDCARD_REQUEST`, and
  the send never reaching the Coldcard. Fixed by skipping both prefixes.

## Current state (Nov 9, 2026) — v1.65

**v1.65** (Nov 9) — tested on Dave's flash drive and his COLDCARD Mk4 as
quick updates from the branch (#115, #116). OS files changed
(`safekeep-boot.sh`: the Seed Vault Watcher; `safekeep-coldcard.py`: the
`passphrase` and `seed` actions), so the release needs the full build.

- **Seed Vault**: other seeds kept beside the master seed (a family
  member's wallet, a second multisig key, an old wallet), at most 20.
  Managed in Seed Management (card `#sv-card`: Add a Seed by words or
  SeedQR scan, Keep the Temporary Seed Here, Rename, Show words, Delete);
  switched to from the Dashboard's *Seed Vault ▾* button. A stored seed
  in use is the session seed labelled `Seed Vault: <name>` (not
  `default`), with a banner and *Back to Master Seed*
  (`SafeKeepOS.reloadMasterSeed`). Switching clears any applied
  passphrase. Notes, saved wallets and Encrypted Backup stay allowed:
  they belong to the vault. Stored by the Seed Vault Watcher as
  `seeds/seed-vault.json` (mode 600; the app downloads `SEED_VAULT.json`),
  so Encrypted Backup's seed option, restore and factory reset cover it.
  Off in a Temporary Session and on a flash drive that doesn't keep the
  seed (the Seed Storage Watcher and the boot cleanup delete it). COLDCARD
  backups: ticked Seed Vault entries are kept on import and restore (a
  clashing name gets " (COLDCARD)"). Code: `sv_*` in `boot.html`;
  tests `test-seed-vault.mjs`, `usbbootdrive/tests/test-seed-vault-watcher.py`
  (the real watcher block).
- **Send a Passphrase to the Coldcard** (Device Options → Coldcard): type
  a BIP-39 passphrase on the computer (twice) or pick one from the
  Passphrase Library (read only; the library itself has no Coldcard
  button, by the owner's choice), and send it over USB: helper action
  `passphrase` in `safekeep-coldcard.py` (Coinkite's `ckcc pass`:
  authenticity check, `bip39_passphrase`, poll `get_passphrase_done`).
  Firmware rules (read in Coinkite's source, `shared/usb.py` / `auth.py` /
  `seed.py`): encrypted link only, 1–99 printable ASCII; the Coldcard
  shows the length, `2` shows the passphrase, OK switches; with its Seed
  Vault on it then offers `1` to keep that wallet. It adds the passphrase
  to whichever wallet the Coldcard is on. SafeKeep works out the expected
  fingerprint from its own seed and checks it when the Coldcard was on
  that seed. The helper overwrites the request before deleting it; the
  passphrase is never in the result. Optional: also save it in the
  Passphrase Library. Works on Dave's Mk4. Code `ccpp_*`; tests
  `test-coldcard-passphrase.mjs`, `usbbootdrive/tests/test-coldcard-helper.py`.
- **Send a Seed to the Coldcard** (Device Options → Coldcard): a seed from
  SafeKeep's Seed Vault, or 12/24 words typed or scanned, loaded on the
  Coldcard as a TEMPORARY seed so it can be kept in its Seed Vault. There
  is no USB command for "add to Seed Vault": the helper action `seed`
  sends a one-seed plaintext backup (`raw_secret` + `chain` only, in the
  firmware's format) with `restore_backup(plaintext=True, tmp=True)`
  (`ckcc restore -t` of a .txt), so no backup password is typed. Firmware
  (`auth.RemoteRestoreBackup`, `backups.restore_tmp_from_dict_ll`): asks
  to restore as a temporary seed, shows its fingerprint, then
  `set_ephemeral_seed` offers Seed Vault (1). A Coldcard with no seed is
  refused. 12, 18 or 24 words only (the Coldcard's storage format). The
  restore reports nothing back, so *Check the Coldcard* runs `detect` and
  compares fingerprints. Coinkite's library marks the plaintext flag
  "(dev)"; the firmware path has no dev-only check, but this is untried on
  a real Mk4. Code `ccsd_*`; test `test-coldcard-seed.mjs`.
- **Device Options order**: every Coldcard feature together (pair,
  passphrase, seed, Import from a COLDCARD backup), then Trezor.
- **Connect a wallet app audit** (checked against each app's import code):
  Sparrow multisig now gets *Hardware Wallet JSON* (`formatMulti`), scanned
  with Airgapped Hardware Wallet → Passport. Sparrow's multisig keystore
  import (Passport/Keystone Multisig → `ColdcardMultisig` →
  `ColdcardSinglesig`) reads the text as a COLDCARD export and finds the
  `bip48_N` section; the crypto-account of a lone cosigner key, `wsh(key)`,
  failed for Dave. Sparrow single-sig keeps `ur:crypto-account` (matched
  by script type in `FileImportPane.getScannedKeystore`). Nunchuk:
  COLDCARD JSON as animated ur:bytes (libnunchuk `passport.hpp` reads
  bip84 / bip48_2 and more). Blue Wallet: single-sig descriptor. Specter:
  `[fp/path]xpub`. Electrum: SLIP-132 key (Zpub for multisig) via the
  Courier; the signer reconciles Electrum's dummy fingerprints.
- **BBQr in Output Descriptor**: Sparrow showed a 2-of-3 as BBQr
  (`B$ZU0100…`: zlib, Unicode text, 1 part) and the import didn't know it.
  `_bbqrDecode` (H / 2 / Z, one or many parts, base-36 part numbers) now
  runs first on pasted or Courier-relayed text (`_descImportUnwrapBbqr`),
  and the tool's camera collects animated BBQr parts. The PSBT Signer read
  BBQr part numbers as hex, which broke codes of 16+ parts; now base 36.
- **UR text in Output Descriptor**: Sparrow's 2-of-3 relayed through the
  Courier arrived as text `UR:CRYPTO-OUTPUT/…` (811 characters). Only the
  camera decoded UR; text went straight to the descriptor reader. Now
  `_descImportUnwrap` sends `UR:` text (one or more parts, any case) to
  `_descImportFromUrText`, which uses the camera's decoder
  (`descv_decodeCryptoOutput`) for crypto-output / crypto-account and
  reads ur:bytes as text. Test `test-bbqr.mjs` (section 4).
- **Multisig from Seed Vault keys** (Output Descriptor → multisig): each
  cosigner slot has a *Seed Vault* button (when the Seed Vault is on) that
  fills in a stored seed's BIP-48 key (`_descLocalKeyOrigin`, no
  passphrase); the seed in use (Key 1) isn't offered, and picked keys
  follow the address type. `_descMsCustody` warns at the top of the result
  when this vault holds M or more of the keys (Key 1 plus any key whose
  fingerprint is a Seed Vault seed, picked or pasted): this flash drive
  alone can spend, so it is no safer than single-sig. Save Wallet / Show
  QR as before. Signing with several Seed Vault keys at once was left out
  on purpose. Test `test-multisig-seed-vault.mjs`.
- **Coldcard Seed Vault names**: the firmware names entries "[fingerprint]"
  (`add_seed_to_vault`), and neither `pass` nor a restore carries a name.
  It offers Rename (40 characters) for the entry in use, so both Coldcard
  panels now say how, suggesting the SafeKeep name (Seed Vault name or
  Passphrase Library nickname).

## Earlier: v1.64 (Nov 7, `v1.64 · build 510 · a880b0f`)

**v1.64** (Nov 7) — tested on Dave's flash drive as quick updates from
the branch (#111, #112). One OS file changed (`safekeep-print.py`), so
the release needs the full build.
- **Cutting line for printed SeedQRs** (#112): Print → *Print a square
  line around it to cut along*, with *White space inside the line*
  (0.5–30 mm, 3 mm to start) and a live close-up of the square to cut
  out. The space goes above the code, at its sides and below the
  fingerprint; the fingerprint sits at most 3 mm under the code. The
  square shrinks its space to fit the paper (190 mm). Under two squares
  of the code a note suggests checking with Scan to Verify. Helper
  fields `cut_box` and `box_margin_mm`; the line is 0.25 mm of PCL
  rectangle fills. Settings: `cutBox` and `boxMargin` in
  `safekeepSeedQrPrint`. Printed, cut and scanned on Dave's M2070.
- **Online demo** (#111): no printing (the panel says it works only on
  the offline vault), no COLDCARD backup screens (hidden, and refuse if
  opened), and the banner says "USB flash drive". The release's three
  "…running from its USB stick" errors in `shared/boot.js` now say
  "USB flash drive". `test-demo-mode.mjs` checks all of it.

## Earlier: v1.63 (Nov 7, `v1.63 · build 501 · 620fea9`)

**v1.63** (Nov 7) — tested on Dave's flash drive (a 2012 15" Retina
MacBook Pro) as quick updates from `main` (#106–#109). OS files changed
(`safekeep-boot.sh`, new `safekeep-brightness.sh` and `safekeep-print.py`),
so the release needs the full build.
- **Draw my SeedQR** (SeedQR tool, #106–#108; `shared/qr-draw.js`):
  *Trace It on the Screen* shows the code full-screen on white at the
  blank template's real size (85.68 mm for 21×21, 87.88 mm for 25×25) to
  trace through the paper; the Size shows as a % (100 % = 96 px per inch),
  moves with + / − and the arrow keys (Shift for 1 %), and *Remember as
  Default* keeps it (`safekeepSeedQrSize`, a Device Options key). *Copy It
  Square by Square* goes one 7×7 block at a time with the dark squares of
  each row listed. Both end at Scan to Verify. (A bank-card measuring step
  was tried and removed: lining up the template is enough.)
- **Print my SeedQR on a USB laser printer** (#109): no print system. The
  printer ban in `safekeep-harden.sh` stays (CUPS, Ghostscript, usblp, lp,
  parport). `usbbootdrive/safekeep-print.py`, run by the Print Watcher
  with the Python in `/opt/safekeep-hwi` (libusb1, already there for the
  Trezor), opens only a USB printer-class interface, draws the code alone
  in PCL 5 at 600 dpi at the size asked (10–150 mm, exact to the dot),
  optionally with the seed fingerprint under it, and sends it with a bulk
  transfer. No job name. The panel warns when printing puts a seed the
  vault shouldn't hold into the vault (a vault that doesn't keep the seed,
  or a SeedQR that isn't the vault's seed) and suggests a Temporary
  Session. Tested on a Samsung Xpress M2070 (doesn't list PCL in its
  Device ID, prints it fine): 14 mm still scans with a laptop camera.
  Settings: `safekeepSeedQrPrint`.
- **Screen Brightness** (#107, #108): Device Options slider (30–100 %) and
  a ☀ slider in the light box. Software dimming (`xrandr --brightness` on
  every connected screen) through the Brightness Watcher and
  `usbbootdrive/safekeep-brightness.sh`, because hardware backlight
  control differs by machine (it did nothing on Dave's MacBook Pro) and
  desktop monitors have none. The light box opens at 100 % and asks for
  the hardware backlight at full (best effort, restored on close); the
  brightness keys step the hardware backlight (best effort). Saved as
  `safekeepBrightness`.
- **SeedQR word entry** (#107): Clear & Enter Different Seed now uses the
  standard word boxes (`ShareFlow.createWordBoxes`); its own grid never
  showed its suggestions.
- Tests: `test-qr-draw.mjs`, `test-brightness.mjs` (runs the real
  Brightness Watcher block), `test-print.mjs`,
  `usbbootdrive/tests/test-print-helper.py` (PCL parsed back square by
  square, a fake printer, the real Print Watcher block).

## Earlier: v1.62 (Nov 6, `v1.62 · build 484 · 503a850`)

**v1.62** (Nov 6) — tested on Dave's flash drive as quick updates from
`main` (#98–#102, #104); one OS file changed (the Coldcard helper), so
the release needs the full build. (A v1.61 tag was pushed for #98–#102,
then withdrawn before its image was published, so v1.62 follows v1.60.)
- **Restore from a COLDCARD backup** (welcome → I already have a backup →
  COLDCARD backup). `shared/coldcard-backup.js` ports COLDCARD's 7z reader
  (compat7z.py: unencrypted header, 7z SHA-256 key stretching, AES-256-CBC
  via WebCrypto with one extra block for its zero padding, CRC-32 for a
  wrong password) and reads the backup text: the words (checked against
  raw_secret, xprv, old setting.xfp), multisig wallets (setting.multisig →
  descriptors), Secure Notes (setting.notes) and Seed Vault
  (setting.seeds, SecretStash encoding). A backup made with a passphrase
  holds only that wallet's xprv: no restore, said plainly.
- **Three ways in:** over USB (new `backup` action in
  `usbbootdrive/safekeep-coldcard.py`, Coinkite's `ckcc backup` steps: the
  COLDCARD makes a fresh backup, shows a new 12-word password and waits
  for confirmation; it can't send older SD-card files), the Courier (kept
  in memory), or a file. Tested over USB on Dave's Mk4.
- **Review:** choose the main wallet or a Seed Vault entry to restore,
  tick multisig wallets (saved wallets) and notes (SafeKeep notes; a
  clashing title gets " (COLDCARD)"), Show words for Seed Vault entries.
- **Import into this vault:** Device Options → Import from a COLDCARD
  backup moves the same panel into an overlay; never touches the seed.
- **SafeKeep's own file picker** (`skfp_*`): on the flash drive every file
  input opens a Transfer-Drive-only list instead of the GTK dialog (which
  offered Home and Other Locations). All four file inputs. The Transfer
  screen's drive list now escapes file names.
- **No dead ends from the welcome screen** (#100, #104): the Entropy
  Generator's setup wizard has Back to Welcome (it hid the sidebar); in a
  Temporary Session the "write down your words" screen has Leave Without
  Keeping This Seed (asks, clears the words, runs Lock); with no seed the
  sidebar link reads Back to Welcome (`sidebar_goHome`), covering
  Encrypted backup and Sign with Hardware Wallet. Banner text: Lock, not
  "power off and reboot", is the way back. `test-session-exits.mjs`
  checks the way back from all nine welcome paths.
- Tests: `test-coldcard-backup.mjs` (117, incl. COLDCARD's two sample
  backups and a cross-check with the 7z tool), `test-file-picker.mjs`,
  `usbbootdrive/tests/test-coldcard-helper.py` (fake COLDCARD).

## Earlier: v1.60 (Nov 4, `v1.60 · build 466 · 207ddc3`)

**v1.60** (Nov 4) — app-only, tested on Dave's flash drive as a quick
update from `main` (#95, #96):
- **Draw Your Own Words** (Entropy Generator → Advanced, a third mode next
  to Mixed and Verifiable Dice): the user draws 11 / 23 words by hand and
  flips a coin 7 / 3 times; the seed's entropy is the words' 11-bit indices
  then the flips (Heads = 1), and the last word's remaining bits are the
  checksum. Nothing is mixed in. Same as SeedSigner's Tools → Calc
  12th/24th word → Coin flip entropy. Guardrails: draw-don't-choose
  instructions, `drawnWordsGate` refuses a word three times, four list
  neighbours in a row or alphabetical order, and a confirmation box that
  any change unticks. Code: `finalWordEntropy` / `drawnWordsGate` in
  `shared/entropy-sources.js`. Tests: `test-entropy-sources.mjs` §8,
  `test-entropy-built.mjs` §7.
- **LICENSE**: the MIT license is now a file in the repo (#95).

## Earlier: v1.59 (Nov 3, `v1.59 · build 460 · 069d482`)

**v1.59** (Nov 3) — app-only changes, tested on Dave's flash drive as
quick updates from `main` (#91–#93):
- **Live QR sliders**: Density and Speed apply while a QR is running, in
  the Courier (Transfer) and the PSBT Signer. Speed is read every frame;
  Density re-cuts the file (Courier, 300 ms debounce) or re-encodes (PSBT,
  200 ms) and starts from the first piece.
- **Courier receiving across a density change**: every piece but the last
  is exactly the density in bytes. `QRParser.createCourierCollector()`
  (`shared/qr-parser.js`) starts over on a middle piece of another size or
  a changed total/name, takes the last piece only once the size is known,
  and finishes only after a confirming middle piece (`needConfirm`), so two
  cuts are never joined (500+500 vs 550+450). The Transfer screen's
  receiver now uses this collector too. The web Courier Tool got the same
  rules (safekeep-companion #8, cache `skv-courier-v11`); v1.58 and older
  flash drives lack them. Test: `test-courier-frames.mjs`.
- **Show an address**: this seed's Silent Payment address (BIP-352, scan
  `m/352'/0'/0'/1'/0`, spend `m/352'/0'/0'/0'/0`), one reusable `sp1q…`
  with no New address or number box; the number box updates the address
  as you type (no Show button). Test: `test-receive-sp.mjs`.
- **Seed Management**: after Download JSON, "Saved to the Transfer Drive"
  offers Send with the Courier. Test: `test-export-courier.mjs`.
- **Dashboard**: Health is filled in at start-up (`transitionToDashboard`
  now renders it); the nickname is labelled "Your wallet · seed nickname",
  in quotes, with a note that it isn't part of the recovery words; the
  wallet card and Health are the same width; tiles are Sign, Show an
  address, Connect a wallet app, Transfer files, Back up; the title is
  28px and the nickname 22px; the wallet card has the plain card border.
  Test: `test-dashboard-health.mjs`.

## Earlier: v1.58 (Nov 2, `v1.58 · build 445 · 934ec90`)

**v1.58** (Nov 2) — tested on Dave's flash drive as builds from the branch:
- **Seed storage** (Device Options): a flash drive can stop keeping the
  master seed. The vault still opens (passphrases, saved wallets, notes,
  settings); the welcome screen asks for the seed (Scan my SeedQR / Type my
  recovery words) and it stays in RAM until lock or shutdown. Before the
  seed is deleted, a scanned SeedQR or typed words must match the loaded
  seed. App: `SafeKeepOS.isSeedKept()` / `setKeepSeed()` in
  `shared/boot.js`; `boot()` skips `master-seed.json`, generate/restore
  don't write it (`ramOnly`). OS: the Seed Storage Watcher takes
  `SEED_STORAGE.json { keepSeed }`, keeps `settings/seed-storage.json`,
  deletes `master-seed*.json` and any that appears; the boot probe deletes
  a stored seed first. Backups leave the seed out; Health says so. Dev:
  `?devMode=seedfree`. Test: `test-seed-storage.mjs`.
- **Wallet card**: with a passphrase on, the title names the passphrase
  wallet (its Library name, or "Passphrase wallet") and the seed's three
  words show as "Seed: …" (they come from the seed words alone). Picking a
  Library passphrase on the Dashboard applies it (no Apply); typed ones
  still need Apply and typing twice. Saved wallets left the Dashboard (they
  stay in Output Descriptor); Seed Management is back under All tools; the
  small Seed Nickname chip shows only on tool screens.
- **UI fixes**: Show words / Hide words button on every seed display; the
  Sign tile no longer stays lit; the sidebar highlights the PSBT Signer
  (cards can name their screen in `data-state`); balanced tile text.
- **Temporary Session**: "Unlock my vault instead" (runs Lock). Boot
  fixes behind it: a Temporary Session chosen right after a Lock was shown
  by a Chromium the boot script wasn't waiting on (ours returned in 3-4 s;
  the fast-fail check then halted the script: blank screen, later the
  downloads page). Now every session gets a fresh `--user-data-dir` in
  `/tmp/safekeep-chromium/`, the script waits for a previous Chromium before
  launch and for a still-running one after a fast return, and logs/saves
  the Chromium process list. `--disable-web-security` is removed (Chromium
  ignored it without a user-data-dir; keeping it would have turned web
  security off). Test: `test-chromium-wait.mjs`.
- **Specter**: Connect a wallet app gives Specter `[fingerprint/path]xpub`
  (new Seed Management Key Format "Key with origin"), which Specter's Add
  device → Scan QR code takes as is. Its UR:CRYPTO-ACCOUNT path needs
  `crypto.subtle`, missing when Specter is opened over plain http on the
  LAN (Dave's node at 192.168.1.124:25441) — keys silently didn't fill.
  Output Descriptor's QR has "For Specter" ({"label","descriptor"}, keys
  /0/*, checked with embit). Test: `test-specter-import.mjs`.
- **Output Descriptor Import** (was Verify): checks on paste too, and saves
  the wallet from the result (shared `_descSaveAs`).
- **Wording**: "flash drive", never "stick", in anything users read
  (`CLAUDE.md`).

v1.57 (Nov 1, `v1.57 · build 429 · b8e931d`) is the redesign release (#87, #88):
- **Welcome**: "Create a new wallet" and "I already have a backup" (four
  option cards for the restore paths).
- **Status bar**: one "Offline · Protected" badge; the separate lights open
  from it as details.
- **Dashboard**: a wallet card (LifeHash, fingerprint, nickname), a Health
  list, five task tiles (Sign, Show an address, Back up, Connect a wallet app,
  Transfer), Saved wallets, then All tools. The full sidebar stays.
- **Health remembers the last backup**: the OS backup watcher writes
  `vault/.last-backup.json` ({date, filename, items}) when it makes a backup.
- **Tool screens**: compact left-aligned headers ("More about this tool"),
  numbered PSBT steps, rounded corners, a Device Options visual pass.
- **Show an address** (`state-receive`): the next receive address of this
  seed's wallets or a saved wallet as a large QR. The next index per wallet is
  kept on the stick in `settings/receive-index.json` (Receive Watcher).
- **Connect a wallet app** (`state-connect`): guided steps for Blue Wallet,
  Electrum, Nunchuk, Sparrow, Specter and Another wallet, which open Seed
  Management with the right export format.
Tested in dev; the two OS parts (backup record, receive index) need a full
`build.sh`.

v1.56 (Oct 28, `v1.56 · build 411 · 91ccb58`) fixes opening a saved wallet in Output Descriptor (#83):
the form is set to the wallet. A multisig gets its M-of-N and address type,
and Keys 2..N are filled from its other keys when this seed's key (at
m/48'/0'/0'/<type>', with the Key 1 passphrase) is one of them, so Generate
Descriptor rebuilds the same wallet; otherwise they are left empty with the
reason. A single-sig wallet switches to Single-Sig and its address type.
Keys from a wallet opened before are always cleared. Tested on Dave's stick
with his 2-of-3 and a single-sig wallet.

v1.55 (Oct 28, `v1.55 · build 406 · d2e4c40`) is the backup release. Tested on Dave's sticks before
release (a freshly flashed spare stick for the first item):
- **Courier restore on the Welcome screen**: Unlock .7z Backup → "Receive a
  Backup with the Courier" scans a Courier loop (online Courier Tool on a
  phone or computer), checks the 7-Zip signature, saves the file to the
  Transfer Drive and selects it, so a new stick never touches another
  computer. The "Vault Created" dialog (`setup-vault.sh`) points to it. The
  restore list also reads the Transfer Drive's current listing
  (`rlq_mergeDriveListing`): `.backups-index.json` is only rebuilt at boot
  and after making a backup.
- **"Send with the Courier"** on the "Backup saved" card plays the new
  backup's Courier loop for a phone (`_xfrOpenWithFile`, shared with the
  Transfer Hub's TRANSMIT), scrolled into view.
- **"Check a Backup"**: opens a backup with its password (typed or scanned)
  and shows what it holds and whether its seed is the loaded one, restoring
  nothing. The Restore Watcher's `RESTORE_CHECK` unpacks into a private
  folder in `/tmp`, compares the seed against a SHA-256 the app sends,
  deletes the folder and answers yes/no and counts only.
- An inspected backup whose Restore is never clicked is now deleted from
  `/tmp/reliquary` (seed and password file included) after the watcher's
  120 s wait; Restore re-extracts from the archive.

v1.54 (Oct 27, `v1.54 · build 396 · 26c9069`) boots with Secure Boot on (`SECURE_BOOT.md`): the stick's
UEFI boot loader is Ubuntu's signed shim (Microsoft UEFI CA 2011) and GRUB
(Canonical), pinned by version and SHA-256 in `build.sh`; the BIOS GRUB is
unchanged. Tested on the HP ZBook with Secure Boot on (normal and Safe Mode)
and off, and on a 2012 MacBook Pro; the previous unsigned build is refused with
Secure Boot on. **Only newly flashed sticks get it**: updates never write the
boot partition, so updated sticks keep the old loader (Secure Boot off, as
before). Legacy BIOS boot on that HP fails with old and new sticks alike
(a separate item).

v1.53 (Oct 27, `v1.53 · build 389 · afa0a32`) made keys easier to get into
wallets: Nunchuk and Sparrow add the key by scanning (animated BC-UR JSON,
the fixed BC-UR Account format), dense QR codes play animated, Seed
Management confirms a typed passphrase and gives a real BIP-380 descriptor,
BIP-85 uses the Dashboard passphrase, things scroll into view, and the Mac
boot menu shows "SafeKeep".

v1.52 (Oct 23, `v1.52 · build 358 · af4f5c6`) was the share tools release
(`SHARE_TOOLS_DESIGN.md`): Seed XOR and Shamir Backup on one guided flow,
Check Shares I Already Have, the shared word boxes on the restore panels.

v1.51 (Oct 22, `v1.51 · build 339 · ff93141`) was the Master Passphrase
release (`PASSPHRASE_STRENGTH_DESIGN.md`): weak passphrases refused,
Generate One for Me, Change Master Passphrase.

v1.50 (Oct 21, `v1.50 · build 315 · ff1e6c3`) made seed generation safer
(see "Seed entropy" below). v1.47 and later sticks install each release in
place from Device Options → Update SafeKeep. `seed-xor-tool/VERSION` says
1.58: features merge to `main` without a bump, and builds from `main` are
for the owner's own use until the owner says it's release time (see
`CLAUDE.md`).

Release notes for v1.55:
- **The backup list and the Transfer Drive can disagree.**
  `SafeKeepOS.listBackups()` reads `.backups-index.json`, which
  `safekeep-boot.sh` writes at boot and the backup watcher rewrites after a
  backup; the Transfer Watcher (Courier, Transfer Hub) never does. Merge
  the drive's own listing in (`rlq_mergeDriveListing`) rather than trusting
  the index alone.
- **The Restore Watcher's commit doesn't need the inspect leftovers**: it
  re-extracts when `/tmp/reliquary` is gone and re-detects the probe root.
  Tested on a stick by waiting more than 2 minutes between Unlock & Inspect
  and Restore.
- **Compare secrets by hash across the app/OS boundary.** Check a Backup
  sends a SHA-256 of the loaded seed's words (NFKD, lowercase, single
  spaces), so the backup's words never travel back to the app;
  `test-restore-check.mjs` checks both sides normalize the same way.

Release notes for v1.53:
- **Nunchuk reads a scanned signer only as `ur:bytes` holding JSON**
  (libnunchuk `ParsePassportSigners` → `ParsePassportSignerConfig`):
  Coldcard-style (`xfp` + `bipNN`/`bip48_N` blocks with `xpub`/`deriv`),
  minimal (`xfp` + `xpub`/`path`), or an Electrum-Coldcard `keystore`. It
  rejects `ur:crypto-account`, which Sparrow takes.
- **A BC-UR sequence header (`/1-1/`) promises a fountain-coded part.**
  The old crypto-account export put one on a plain part, and no standard
  decoder could read it (`test-bcur-account.mjs`).
- **SafeKeep can't run from an internal disk**: `safekeep-harden.sh`
  deletes the NVMe/AHCI/eMMC drivers on purpose, so the live system can't
  find an OS partition on one ("unable to find a medium containing a live
  file system"). Tried on Dave's 2016 MacBook Pro and undone.
- **The Mac boot name lives on the boot partition**, which updates never
  write: sticks updated in place keep "EFI Boot". The label files were made
  once with `bless --label SafeKeep`, macOS only.
- **macOS mounts an EFI-type partition only with `sudo`**
  (`sudo diskutil mount diskNs2`); without it, "failed to mount".

Release notes for v1.52:
- **shamir-mnemonic-ts combines exactly M shares**; more is an error.
  The share tools combine every run of M consecutive shares instead.
- **Chromium has no flag or policy for its kiosk "Download started"
  message**; an unpacked extension (`usbbootdrive/quiet-downloads/`,
  `chrome.downloads.setUiOptions`) hides it. Checked on
  ungoogled-chromium 155 with the stick's flags and policy.

Release notes for v1.51:
- **v1.51 adds an OS package, `qrencode`** (`chroot-setup.sh`), so the
  image needs the full `build.sh`; the update file carries it like the rest
  of the OS. A quick update of a stick built before it skips the QR code
  (Generate One for Me then shows the words only).
- **Setup and unlock dialogs run at `GDK_SCALE=2`.** On a 1920×1080 screen
  they get 960×540. Check new dialogs by rendering them that way (Xvfb +
  the real zenity 4.0.1 + `import`), not at normal size. zenity doesn't
  wrap the text above a `--list`: break it by hand (`test-pwcheck.mjs`
  checks line lengths and list heights).
- **zenity refuses non-ASCII text in a C locale** ("This option is not
  available"); the QR code dialog runs with `LC_ALL=C.UTF-8`.
- **The Courier Tool reads the setup QR code** (Receive → Copy to
  clipboard, and Transmit shows it again for the scan-back): checked with
  its own `html5-qrcode` on a rendered screen.
- **Part 4 (a fixed minimum Argon2 cost) was skipped** by Dave; vaults
  keep cryptsetup's per-computer default (1 GiB on any recent machine).

Release notes for v1.50:
- **Version numbers are two whole numbers.** The updater compares
  (major, minor, build), so 1.5 is *older* than 1.49. After 1.49 comes
  1.50; never drop the trailing zero.
- **The release workflow runs `test-entropy-built.mjs` after the build**
  (it needs `dist/boot.html`), with the runner's Google Chrome.
- **Where make-update.sh writes:** the `.tar` goes in
  `/home/safekeep-build/` and `manifest.json` in `workspace/update/`.
  For v1.50 the tar was first fetched from the wrong folder, so
  `tar -rf` made a 2.5 KB signature-only file and that got uploaded; it
  was replaced the same day. Check the tar is about 1.3 GB before
  uploading.

### Working with Dave (the owner)

- Dave is not very technical. Give him copy-paste commands with a plain
  explanation, say which machine each runs on ("On your Mac" / "On the
  ZBook"), and ask him to paste back the output.
- Don't put `#` comments inside commands. zsh on his Mac chokes on them,
  especially comments that contain apostrophes.
- Don't guess when he pastes an error. Read the actual output first. Two
  past incidents came from running commands on the wrong machine.
- Check the build stamp he pastes against `origin/main`: a build from a
  feature branch shows the branch commit instead of the merge commit.

### Machines

Personal values (`<PROJECT_FOLDER>`, `<ZBOOK_USER>`, `<ZBOOK_IP>`, `<HOME_LAN>`, `<MAC_USER>`) are kept out of this public repo; the real ones are in `PRIVATE_NOTES.md` next to this file (git-ignored).

| Machine | Role | Access |
|---|---|---|
| Dave's Mac | Source of truth (git repo, `npm run dev`, `npm run build`) | Local |
| HP ZBook 15u G3 | Builds the OS image and writes the USB | `ssh <ZBOOK_USER>@<ZBOOK_IP>`, build folder `/home/safekeep-build` |
| Patriot USB stick | The vault itself | Shows up as `/dev/sdb` (TRAN=usb) on the ZBook. `sda` is the ZBook's internal drive, NEVER write to it |

- ufw on the ZBook allows SSH from <HOME_LAN> only (Tailscale is not
  installed).
- The ZBook's build uses the top-level scripts in `/home/safekeep-build/`.
  A past bug came from copying scripts into a nested folder by mistake.
  Always use the rsync commands below exactly.

### Build and deploy (the normal loop, ~5 minutes)

On the Mac:
```
cd "<PROJECT_FOLDER>"
git checkout main && git pull
cd seed-xor-tool
npm run build
cd ..
rsync -av --delete --exclude '* (1)*' seed-xor-tool/dist/ <ZBOOK_USER>@<ZBOOK_IP>:/home/safekeep-build/src/dist/
rsync -av --exclude 'workspace/' --exclude '*.img' --exclude '* (1)*' --exclude '.DS_Store' usbbootdrive/ <ZBOOK_USER>@<ZBOOK_IP>:/home/safekeep-build/
```
The second rsync is only needed when something in `usbbootdrive/` changed
(e.g. `safekeep-boot.sh`). `npm run build` is `node build-offline.mjs`.

If the build prints `⚠ shallow git clone` (the stamp then ends in
`+ shallow clone`), the Mac's clone is missing history, so the build number
is wrong and the file can't match a release. Fix it once with
`git fetch --unshallow`. Releases are built by `.github/workflows/release.yml`
from a `vX.Y` tag; see `VERIFYING.md` for checking and signing them.

`build.sh` stops right away if `src/dist/boot.html` is missing. Someone
building from a fresh clone on one Linux machine runs `bash prepare-app.sh`
(no sudo) in `usbbootdrive/` instead of the first rsync: it runs `npm ci` +
`npm run build` and copies the result into `usbbootdrive/src/dist/`.
`seed-xor-tool/.npmrc` sets `legacy-peer-deps=true` because
`vite-plugin-node-polyfills@0.25.0` doesn't declare Vite 8 support yet;
without it a clean `npm ci` fails. Don't run `npm audit fix --force`.

On the ZBook:
```
cd /home/safekeep-build
lsblk -o NAME,SIZE,TRAN,MODEL
sudo bash quick-update.sh --usb /dev/sdb
```
- `quick-update.sh` reuses the last full build's chroot, drops in the new
  app and scripts (including `safekeep-boot.sh`), re-squashes, and rewrites
  ONLY the OS partition. **The vault and transfer data are preserved.** It
  asks you to type YES. On a two-slot stick it writes the slot that isn't
  booted, checks it and switches (`os-slots.sh`); the previous OS stays as
  GRUB's "previous version". Older sticks get their `casper/` replaced.
- It refuses to run (and tells you to run the full `build.sh`, ~20 min)
  if `chroot-setup.sh` or `safekeep-harden.sh` changed, or if the last full
  build didn't finish (`workspace/.chroot-complete` marker).

Users who download the release image update by reflashing, which erases
the vault: the website's Docs page ("Updating to a New Version") walks
them through Encrypted Backup → copy the `.7z` off → flash → restore.
That is only needed once, for sticks set up with v1.46 or earlier: from
v1.47 the stick updates in place from a signed update file
(`UPDATER_DESIGN.md`; release steps in `VERIFYING.md`).

### Testing an update on a stick (in place)

How every change to the boot scripts or the OS was tested on Oct 20
(builds 303 → 307). Give Dave each command to paste.

1. **Commit first.** The stick installs only an update whose build
   number (the commit count) is higher than what it runs; uncommitted
   changes don't raise it.
2. On the Mac: `npm run build`, then both rsync commands above.
3. On the ZBook: the full `sudo bash build.sh` if `chroot-setup.sh` or
   `safekeep-harden.sh` changed, otherwise `sudo bash quick-update.sh`
   (no `--usb`). Then **`sudo bash make-update.sh`** and check that it
   prints the new build number. Once a stale update file was copied
   because this step was skipped.
4. On the Mac, in a new folder (a clean build's file has the same name as
   the release file, `SafeKeep-Update-v1.48.tar`): `scp` the `.tar` and
   `manifest.json` from `/home/safekeep-build/`, check
   `grep -o '"build": "[^"]*"' manifest.json`, then sign:
   `gpg --local-user A333EB826F70A79A736F09948EA7DD8CEDBA86C2 --armor --detach-sign manifest.json && tar -rf SafeKeep-Update-v1.48.tar manifest.json.asc`
   (`tar -rf` may not change the file size: the signature fits in the
   archive's end padding).
5. Plug the stick into the Mac (click Ignore, never Initialize, on the
   "can't read this disk" prompts), `cp` the `.tar` to `/Volumes/TRANSFER/`,
   then `diskutil eject $(diskutil info /Volumes/TRANSFER | awk '/Part of Whole/{print $4}')`.
6. On the laptop: Device Options → Update SafeKeep → Check for update →
   Install → Restart now. The restart is done by the **old** OS, so a
   shutdown fix only shows on the update after the one that adds it.

### Dev testing (no USB)

- On the Mac: `cd seed-xor-tool && npm run dev`, then open
  `http://localhost:5173/boot.html?devMode=seeded`
  (also `normal`, `ephemeral`, `amnesia`). In seeded mode the vault holds
  the 24-word `abandon … art` seed (fingerprint `5436d724`). The Dev Drawer
  switches modes. In dev mode `window.SafeKeepOS` is an in-memory mock
  (Transfer Drive, saved wallets, passphrases and notes all live in memory).
- The Vite dev server and `npm run build` also work in a Linux cloud
  sandbox after `npm ci` (the old "rolldown binding missing" problem is
  gone). Playwright with the preinstalled Chromium can drive the dev server
  for screenshots at laptop size (1366×900).
- Tests: `node <file>` for each `seed-xor-tool/test-*.mjs` — **53 files**,
  all passing on Linux (Oct 28; `test-restore-check.mjs` needs `7z`
  (p7zip-full) for its archive cases and says SKIP without it; `test-entropy-built.mjs` needs
  `CHROMIUM_BINARY=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`). `test-change-passphrase.mjs`
  needs `cryptsetup` for its LUKS checks and says SKIP without it. On macOS three always fail
  because they need Linux tools: `test-auto-off.mjs`, `test-os-lockdown.mjs`
  (GNU `sed`) and `test-updater.mjs` (`gpgv`). Nothing runs tests on push —
  only the release workflow, after the tag is pushed — so before tagging,
  run them on the ZBook (Node 22): clone the repo into `/tmp`, `npm ci` in
  `seed-xor-tool`, then run each file. They extract real functions from `boot.html` (or
  `shared/boot.js`) into a Node VM and check them against official vectors
  and real PSBTs built with `@scure/btc-signer`. Some also run the Python
  embedded in `safekeep-boot.sh` (Settings and Wallets watchers).
  `test-transfer-bridge.mjs` runs the real Transfer Watcher bash code and
  needs GNU coreutils, so it skips itself on macOS. Hardware helper tests
  live in `usbbootdrive/tests/` (Coldcard, Trezor).
- When a change adds a helper that an extracted function now calls, the
  tests that extract that function need the helper added to their list,
  or they fail with `ReferenceError`.

### Git rules

- Commit **source only**. Never stage `seed-xor-tool/dist/`.
- The repo sits on a slow mount and sometimes leaves stale lock files:
  `rm -f .git/index.lock .git/HEAD.lock`, then add/commit.
- A broken duplicate ref `.git/refs/heads/main (1)` makes `git log --all`
  print "fatal: bad object". It's safe to delete: `rm ".git/refs/heads/main (1)"`.
- The folders contain stray `* (1).*` download duplicates (e.g.
  `boot (1).html`, `safekeep-boot (1).sh`). They are untracked junk and
  can be deleted. The rsync commands exclude them.
- Cloud sessions work on a branch, open a PR when asked, and Dave merges
  it on GitHub. After a merge, the next piece of work starts the branch
  again from `origin/main`.

### Safety rules (non-negotiable)

- Confirm the USB device with `lsblk` before any `dd` or quick-update.
- Never invent or choose passwords for Dave. Never bake secrets into the
  installer.
- The vault OS stays air-gapped: no network listeners (netcat/socat were
  proposed once and declined), no network features.
- **Lock must never power off or reboot.** It returns to the native unlock
  screen.
- Don't weaken crypto. Verify changes against official test vectors, with
  a mutation check where practical (break the check, confirm a test fails).
- UI polish is secondary. Never break function for looks.
- Never write the JSON key `"passphrase"` (or the 2FA marker
  `"safekeep-2fa-backup"`) into a JSON download that isn't a passphrase or
  2FA file: the File Router in `safekeep-boot.sh` moves any JSON in
  `seeds/` that contains them.

### How key subsystems work now

**Master Passphrase** (`PASSPHRASE_STRENGTH_DESIGN.md`). One strength
estimator in two copies: `shared/pwcheck.js` (the app's bars) and
`usbbootdrive/safekeep-pwcheck.py` (enforcement on the stick), kept equal
by `test-pwcheck.mjs`; word lists in `usbbootdrive/pwcheck-lists.json`.
Setup's passphrase screens live in `passphrase-dialogs.sh`, sourced by
`setup-vault.sh` and `change-passphrase.sh`. Change Master Passphrase is the
power action `passphrase`: lock, then `change-passphrase` before the
unlock prompt, then `safekeep-passphrase.py` (`luksChangeKey`, passphrases
through pipes). `unlock-vault.sh` leaves only the rating in
`/tmp/safekeep-signals/PASSPHRASE_RATING.json`.

**Seed entropy** (reviewed after COLDCARD's 2026 weak-seed losses, whose
cause was a build change that quietly swapped the random generator).
Every seed draw goes through `drawCheckedRandom` in
`shared/entropy-harden.js`: it refuses a `getRandomValues` replaced by
script, and output that is zeros, constant, counting, uneven or a repeat
of the last draw. 1-click = SHA-256(device32 || background salt). Entropy
Generator Mixed = SHA-256("SafeKeepVault/entropy-mix/v1" || device32 ||
SHA-256(pool)), and the pool empties after each seed. The mouse earns 0.25
bits a sample and at most half the target. Verifiable dice (SHA-256 of the
rolls, nothing mixed in) refuses patterned rolls such as 123456123456…
and asks the user to confirm unusual ones (`shared/dice-fairness.js`).
`test-entropy-built.mjs` drives all of this in the built `dist/boot.html`
in Chrome: run it after `npm run build` whenever the seed code changes.

**Browser ↔ OS bridge.** Chromium runs as a kiosk on `file://` and can't
call the OS directly. The app "downloads" small trigger files. The
enterprise policy (written at launch by `safekeep-boot.sh`) routes them
silently into `/media/.safekeep-vault/seeds/` (normal boot) or
`/tmp/safekeep-signals/` (temporary session), where bash watchers in
`safekeep-boot.sh` act on them. The app reads results back with
`fetch(file://…)`. Every watcher treats its file as untrusted data and
runs nothing from it. Examples: POWER_ACTION, WIPE_TRIGGER, RELIQUARY_*
(backups), RESTORE_*, DEVICE_SETTINGS, SAVED_WALLETS, Codex notes,
passphrases, 2FA, COLDCARD_/TREZOR_ requests.
In kiosk mode Chromium shows "Download started. To see it, press Esc."
for each of these files, and no flag or policy turns that off (tried in
ungoogled-chromium 155: `DownloadBubbleEnabled`,
`--disable-features=DownloadBubble,DownloadBubbleV2`). The kiosk loads a
tiny extension, `usbbootdrive/quiet-downloads/` →
`/usr/local/lib/safekeep/quiet-downloads`, whose only code is
`chrome.downloads.setUiOptions({enabled:false})`. That hides the message;
the files are still written (`test-quiet-downloads.mjs`).

**Lock (true lock).** The dashboard Lock button calls `SafeKeepOS.lock()`,
which writes `POWER_ACTION.txt` = `lock` and closes the window. The daemon
defaults to `lock` if the signal file is missing, so it can never fall
through to poweroff. The lock branch kills the session's children,
unmounts, runs `cryptsetup close vault`, then
`exec /usr/local/bin/safekeep-boot` → native zenity unlock prompt.
Idle timers (Device Options): Auto-Lock, Display Sleep, and Auto-Off
(powers down after N idle minutes, also at the unlock prompt; 0 = stay on).

**Encrypted Backup (Reliquary).** The app sends a JSON request
(`RELIQUARY_TRIGGER.json`); the watcher validates it against a fixed list
and runs `7z` directly with an argument list (no shell, no command text
from the app). Categories map to vault folders: codex, settings,
passphrases, twofa, seeds. Restore ("Unlock .7z Backup") is on the
welcome screen and reads the `.7z` from the Transfer Drive.

**Transfer Drive.** The exFAT TRANSFER partition is mounted at boot at
`/media/safekeep-transfer`; `shared/transfer-drive.js` (window.SKTransfer)
gives tools a FileSystemDirectoryHandle look-alike. Writes, deletes and
renames go through the Transfer Watcher (between the
`SKX_TRANSFER_WATCHER_BEGIN/END` markers in `safekeep-boot.sh`), which
performs fixed operations only. In daily use on hardware. If it
misbehaves: `grep "Transfer Watcher" /tmp/safekeep-boot.log`.

**Settings in the vault.** Device Options are saved as
`settings/device-settings.json` (Settings Watcher, known keys only).
**Saved wallets** (below) are `settings/saved-wallets.json`. Both live in
`settings/`, so Encrypted Backup ("Application Settings"), restore and
factory reset cover them. Normal boots only.

**Saved wallets** (Output Descriptor tool → PSBT Signer). The user saves a
name + watch-only descriptor ("Save to Vault"; list with Open/Remove).
Storage: `SafeKeepOS.saveSavedWallets` downloads `SAVED_WALLETS.json`; the
Wallets Watcher (Python heredoc `SWPYEOF` in `safekeep-boot.sh`) accepts
≤ 256 KB, ≤ 50 wallets, names 1–64 printable characters, printable
descriptors ≤ 4 KB with no xprv/WIF, and writes the file atomically. The
signer's `_psbtSavedWalletCheck` matches inputs and outputs by deriving
the saved wallet's address at the (chain, index) a derivation path claims
and comparing it with the real script (never trusting the PSBT). It
names the spending wallet in a banner, and turns `unverified-change`
(e.g. BlueWallet "diet" multisig PSBTs) into `verified-change` when it is
a saved wallet's address. Hijacks stay blocked; payments to your own
saved wallets keep their checkbox. Tests: `test-saved-wallets.mjs`.

**PSBT Signer review screen.** Besides the existing output audit
(`_psbtAuditOutputs`: change proof, hijack detection, multisig binding
via global xpubs, Silent Payments, SIGHASH_ALL-only, 5% fee guard):
- Summary card: sending, fee, total leaving your wallet, change back,
  change still to check; collapsible list of inputs (amount, address,
  saved wallet, multisig signatures so far). `_psbtTxSummary` is pure.
- Lock time, BIP-68 relative locks (warning), replace-by-fee.
- Per destination, "Compare with the address the recipient gave you"
  (paste/scan; exact match or highlighted differences). It never ticks
  the "I have independently verified" checkbox.
- Legacy inputs: amounts come from `nonWitnessUtxo` only if it hashes to
  the input's txid (`_psbtPrevOut` / `_psbtNonWitnessTxidOk`).
  `@scure/btc-signer` skips that check for non-final previous
  transactions, so a forged one could hide fee. A mismatch blocks signing
  with no Force Sign override. Tests: `test-psbt-review-summary.mjs`,
  `test-psbt-legacy-inputs.mjs`.

**Passphrase entry.** A mistyped BIP-39 passphrase silently opens a
different wallet, so a *typed* passphrase must be typed twice (paste
blocked) before the Dashboard applies it or the Output Descriptor tool
uses it (single-sig, and multisig Key 1, which stays hidden until
confirmed). A passphrase loaded unchanged from the Passphrase Library
needs no retyping (`lib_pick` records it in `_ppFromLibrary`). The
Passphrase Library itself checks the written copy when saving. The Verify
tab's passphrase isn't confirmed: a typo there only shows MISMATCH.

**OS lock-down (v1.45).** No network/Wi-Fi/Bluetooth/NFC/USB-network
drivers in the image (the build fails if one is left), network services
masked, firewall drops everything, no compilers, a watchdog that switches
off any interface that appears and shows a red banner. Release builds
have no terminal or file manager (`SAFEKEEP_DEV_SHELL=1 bash build.sh`
adds them for troubleshooting only). The website tells users to turn off
Intel AMT/vPro and radios in the BIOS, and Secure Boot if the stick won't
start (the GRUB image isn't signed).

**Releases and verification.** The app (`boot.html`) is a reproducible
build: a `vX.Y` tag runs `.github/workflows/release.yml` (checksums,
GitHub attestation, OpenTimestamps; `ots-upgrade.yml` completes the
proof). The maintainer adds the GPG signature by hand. `npm run
verify-release` rebuilds a stamped commit and compares bytes. The OS
image is not reproducible. A start-up self-check runs published vectors
before the app accepts any input. An online demo (`npm run build:demo`,
demo.safekeepbitcoin.com) only accepts the public all-zero-entropy seeds.

**First boot and factory reset.** `setup-vault.sh` takes the master
passphrase by QR (30-second limit, then back to the choice) or typed
visibly twice, creates the LUKS file container (`.vault.luks`, sized from
the data partition's free space and shown as "Creating your 193 MB
encrypted vault"), writes `.setup_complete`, then offers **Continue now**
(exits 0; `safekeep-boot.sh` runs the normal unlock prompt) or **Shut down
to copy a backup onto the stick**. A vault file without the marker means
creation was interrupted: it is deleted and created again. Factory reset:
Phase 1 (in the session) deletes the vault's files, writes `.wipe_pending`
and restarts; Phase 2 (next boot) zeroes the LUKS header, deletes the
vault and the marker, then carries on into first-boot setup in the same
boot. On hardware: first boot (Continue now / Shut down) and backups were
tested Oct 19–20; factory reset (one restart, then straight into setup)
and the 30-second QR limit on Oct 20 (build 307). **Not yet tested on a
stick:** interrupted-setup recovery (it needs a power cut mid-setup).

**Text consoles (boot logo, shutdown screen).** Lessons from Oct 20, all
in `chroot-setup.sh` (so they need the full `build.sh`):
- X runs on **vt7**; text written to tty1 is invisible while X is up.
  The shutdown screen runs `chvt 1` first. The splash `safekeep-boot.sh`
  draws at start-up is hidden the same way (left alone: switching there
  would hide the unlock prompt).
- **casper.service is masked.** `casper-stop` ejects the boot USB at the
  end of every shutdown (`noprompt` only skips the prompt). Anything not
  already in RAM then fails to load: "sd [sda] access beyond end of
  device" / "SQUASHFS error" scrolling until the power button is held.
  It showed up on Restart now after an update, which pushes those pages
  out of memory.
- On the Linux console `ESC[90m` (dark grey) also turns on **bold**, and
  bold colour 3 is bright yellow. Use `ESC[22;33m` / `ESC[22;37m`.
- `ESC]P3F7931A` makes colour 3 Bitcoin orange. **setvtrgb.service** is
  masked (Ubuntu's palette has colour 3 yellow), and so are
  **console-setup.service** and its udev rule
  `/etc/udev/rules.d/90-console-setup.rules` → `/dev/null` (a font reload
  under the logo).
- When the graphics driver takes the console over, text already on screen
  loses its block and box characters ("?"). `safekeep-splash-redraw.service`
  waits for `systemd-udev-settle`, clears tty1 and draws the splash again.
- The logo lives in two places to keep in step: `skb_logo` in
  `safekeep-boot.sh` and `/etc/safekeep-splash.txt` written by
  `chroot-setup.sh`. Only CP437 characters, rows ≤ 80 columns.
  `test-os-lockdown.mjs` checks the masks and the colour codes.

**Seed Nickname, LifeHash, UI polish.** The status-bar Seed Nickname is
three words from SHA-256 of the mnemonic (a convenience label, not proof
the drive is genuine). LifeHash icons beside fingerprints match
Sparrow's. Styling lives in `<style id="skb-polish">` inside
`@media screen`, so print output is untouched.

### The website (separate repos)

- `Pasalon0404/Safekeep-Website` → **safekeepbitcoin.com** (CNAME). Pages:
  index, features, compare, docs (incl. "Updating to a New Version" and
  "Recovering Without SafeKeep"), download (image + GPG steps), courier,
  print-qr, release-notes, about, donate, `llms.txt`.
- `Pasalon0404/safekeep-companion` → the online Courier Tool (can be used
  on phones; the phone rule in `CLAUDE.md` doesn't apply to it).
- Update the website only at release time (`CLAUDE.md`). Prepare it on a
  branch with TODO hashes, fill them in from the published release, then
  open a PR for Dave to merge (as for v1.47–v1.50). The v1.50 website PR
  is Safekeep-Website #19 (branch `release-v1.50`).

### Updating Chromium

The image's browser is pinned in `usbbootdrive/chroot-setup.sh`
(`UC_PIN_TAG_DEFAULT` + `UC_EXPECTED_SHA256_DEFAULT`): every build downloads
that exact ungoogled-chromium AppImage and stops on any other file or
version, and `/etc/safekeep-chromium` records it (`make-update.sh` prints
it). A newer Chromium can drop or change what the kiosk uses (Chrome 137
dropped `--load-extension`, which `quiet-downloads` needs), so move only
deliberately:

1. Pick the release on ungoogled-chromium-portablelinux, download
   `ungoogled-chromium-<tag>-x86_64.AppImage`, and note its SHA-256.
2. On the ZBook: `sudo UC_PIN_TAG=<tag> UC_EXPECTED_SHA256=<sha256> bash build.sh`,
   then test the stick: boot, unlock, no "Download started" message,
   camera scanning, printing, the Transfer Drive.
3. Change the two defaults in a PR. Release builds then use them.

`UC_ALLOW_UNPINNED=1` builds with the latest release to try one out;
`make-update.sh` names such a build `-build<N>` and says NOT FOR A RELEASE.

Oct 27: 156.0.8078.47-1 was out, and Dave chose to stay on 155 for v1.53.
SafeKeep's browser is offline and only shows SafeKeep's own page, so a
newer one gains little and risks breaking something. Revisit once or
twice a year, or sooner for a specific reason (a known hole in how
Chromium reads images or files, or a bug that affects SafeKeep).

### Open items / next steps

1. **After v1.65:** update the website for v1.65 (download page, release
   notes; docs for the Seed Vault, sending a passphrase or a seed to a
   COLDCARD, multisig from Seed Vault keys, and BBQr / UR wallet imports),
   and install `SafeKeep-Update-v1.65.tar` on a flash drive from the
   release itself (it adds the Seed Vault Watcher and changes the COLDCARD
   helper). If the v1.63 or v1.64 website updates haven't merged yet, fold
   them in.
2. **Updater** — see `UPDATER_DESIGN.md`. Live since v1.48: Dave's stick
   went v1.47 → v1.48 → builds 303–307 in place (Oct 20).
   - **Part 1** is merged: two OS slots, 8 GB sticks, a 2.5 GB Transfer
     Drive, and the maintainer key + gpgv in the image. It ships in a
     release that everyone installs with one last reflash.
   - **Part 2** is merged: `make-update.sh`, `safekeep-update.py`, the Update
     Watcher, and Device Options → Update SafeKeep. Release steps are in
     `VERIFYING.md`, steps 4–6. Tested on sticks:
     - build 283 → 284 worked on a stick that had been quick-updated;
     - a freshly flashed new stick updated from `main` to the next build
       (slot A → B, Oct 18).

     One earlier try failed with "Input/output error" at the first write,
     before the update log existed. It hasn't come back. If it does,
     Device Options → Show update log records why.
3. **ZBook "restart required" (fixed Oct 20).** It wasn't a real update:
   `build.sh` bind-mounted the ZBook's `/run` into the build chroot, so
   installing the image's kernel there created the ZBook's own
   `/run/reboot-required` on every full build. The chroot now gets its own
   tmpfs `/run` (`test-os-lockdown.mjs` checks it); a full build after the
   change left no flag. The desktop's restart icon only clears on a restart.
4. **Second source for the GPG fingerprint** — publish it outside GitHub
   (e.g. X bio, keys.openpgp.org), then name it on the download page.
5. Chromium still runs with `--no-sandbox` and `--disable-web-security`
   (comments in `safekeep-boot.sh` explain why). Acceptable only because
   the machine is offline and runs only our page.
6. Not supported yet: Taproot script-path / miniscript signing, saving
   Silent Payment wallets, matching inputs whose PSBT has no derivation
   path.
7. Legacy inputs that carry only `witnessUtxo` (no `nonWitnessUtxo`) are
   still trusted for their amount; Bitcoin Core and most wallets send
   `nonWitnessUtxo` for legacy inputs.

Closed since the Sept 29 notes: the Reliquary watcher no longer runs
command text (fixed list + `7z` argument list); the Transfer Drive
auto-mount is in daily use on hardware.

### Recent work (newest first)

```
764f409 Change Master Passphrase: lock, change, unlock                                   (#53)
ae59ea2 Setup: make every dialog fit a 1080p screen at double size                       (#53)
ebf0e5b Generate One for Me: QR code and words together, check by scanning back          (#52)
31905b9 Generate One for Me: offer the words as a QR code (qrencode)                     (#51)
8852544 Setup: make the choice lists tall enough to show every choice                    (#50)
8dbce81 Setup: Generate One for Me, and no dead end on Cancel                            (#49)
9863b5c Refuse weak passwords: strength check at setup and on backups                    (#48)
846bed0 Entropy: refuse patterned dice, health-check the RNG, hash-mix the pool          (v1.50)
e86560c Boot splash: redraw it after the graphics driver takes over the console
eabb41a Boot logo: orange not bold yellow; no font reload under the early splash
9cb6de6 OS: keep the kernel console font and palette for the boot logo
dcf4382 Shutdown screen: switch to tty1 so it is actually seen
282818f Boot screens: new SAFEKEEP / VAULT logo in bold two-tone blocks
b676478 OS: mask casper.service so shutdown never ejects the USB stick
a3cc40b chore: bump version to v1.48                                                     (v1.48)
b3b2fe1 First boot: give the QR passphrase scan a 30-second limit
7854781 Factory reset: go straight into setup after the wipe, no second restart
271758f Backup: a QR-scanned password doesn't need scanning twice
7f4fef8 Backup: skip vault folders that don't exist yet
af828d1 First boot: continue straight to unlock instead of shutting down
12d7271 setup-vault: recreate a vault left without .setup_complete
035fc05 PSBT Signer: fee for legacy inputs, and refuse a forged previous transaction   (#40)
6e95938 Output Descriptor: type a passphrase twice before it is used                     (#39)
68fa6fa Dashboard passphrase: type it twice before it is applied                         (#38)
977cf5f PSBT review: spending summary, inputs, lock time, RBF, address compare           (#37)
f6f89bb Saved wallets: check PSBTs against the wallets you own                           (#36)
0af5eec Idle Timers: Auto-Off powers SafeKeep down after N idle minutes
c4f6822 SLIP-39 recovery: show both readings, never save a Trezor share set as a wrong wallet
0b53fdb / e0d6029 Verify tab: convert wallet exports to a descriptor before checking
2142c9a OS lock-down: no root shell, no network drivers, no compilers, network watchdog   (v1.45)
eaacdbb Output Descriptor: import a descriptor from another wallet (watch-only)
f011ef5 Output Descriptor: import a multisig cosigner's key from a Coldcard or Trezor     (v1.44)
851fe5f / 5bcb77b PSBT signer: take and give PSBT files via The Courier                   (v1.43)
fa85e2a Output Descriptor: show a receive address with QR, and check an address           (v1.42)
```
`git log --oneline` has the rest; v1.35–v1.41 added verifiable releases,
the self-check, LifeHash, Bitcoin Core export, dice fairness, playing
cards, Verifiable Dice, Standard SeedQR, the Wallet Record rewrite and
the online demo.

---
---

# Historical notes (May 2026)

*Original pickup guide, kept for architecture and lessons learned. Out of
date in places. Notably, power actions are now read from the vault's
seeds dir (not `/tmp/POWER_ACTION.txt`), Lock no longer powers off, and web
builds use `npm run build`.*


A pickup guide for resuming development. Written by Claude Opus at the
end of a long session that took the project through ~75 small fixes
across the boot stack, the Bitcoin tools, and the build pipeline.

---

## What this project is

SafeKeep Vault is an **air-gapped Bitcoin wallet operating system**
distributed as a bootable USB live image (`safekeep.img`). The user
flashes the image to an 8 GB+ USB drive, boots from it, and gets a
hardened Linux kiosk that auto-launches a Chromium browser pointing
at a fully self-contained `boot.html` containing the wallet tools.

Two distinct codebases live in this repo:

- **`seed-xor-tool/`** — the Vite-built single-page web app. All
  Bitcoin-related tools live in `boot.html` and its sibling files
  in `shared/`. This is what runs in the kiosk browser.
- **`usbbootdrive/`** — the OS image build pipeline. Bash scripts
  that produce the `.img` file containing a debootstrapped Ubuntu
  noble (24.04) chroot, hardened, with the web app baked in.

---

## Quick start

### Rebuild the OS image

```bash
cd usbbootdrive/
sudo bash build.sh
```

Produces `safekeep.img` (~6.7 GB, mostly empty space that zips away). Takes 10-20 minutes on a fresh
build, ~5 minutes on rebuilds (the debootstrap base is cached at
`workspace/base-chroot/`). The build is destructive — it nukes
`workspace/chroot/` and `workspace/staging/` each run.

### Rebuild just the web app (without re-rolling the OS)

```bash
cd seed-xor-tool/
node build-offline.mjs
```

Outputs to `seed-xor-tool/dist/`. Smoke-test the result by opening
`dist/boot.html` directly in a desktop browser; the dev mock at the
bottom of `shared/boot.js` simulates the SafeKeepOS bridge so the
tools work without a real LUKS vault.

### Flash to USB

```bash
sudo dd if=safekeep.img of=/dev/sdX bs=4M status=progress && sync
```

Or use Rufus (DD mode) / balenaEtcher on Windows/macOS.

### Test in dev mode (no USB needed)

Open `seed-xor-tool/boot.html` directly in Chromium. The DEV_MODE
auto-detection (top of `boot.html`, ~line 15) flips on when the
URL is `file://` and not on the boot drive, exposing a Dev Drawer
and a mock SafeKeepOS bridge with realistic dummy data. This lets
you iterate on UI without rebuilding the image.

---

## Architecture (high level)

```
┌─────────────────────────────────────────────────────────────────┐
│ USB layout (5 partitions, GPT)                                  │
│   1. BIOS Boot   (2 MB)        — GRUB core.img for legacy BIOS  │
│   2. EFI System  (256 MB FAT32)— shim + signed GRUB for UEFI    │
│   3. OS          (3.5 GB ext4) — slots casper-a/, casper-b/     │
│                                  (squashfs, kernel, initrd)     │
│                                  + slot.cfg                     │
│   4. Data        (300 MB ext4) — `.vault.luks` file container   │
│   5. Transfer    (2.5 GB exFAT)— Mac/Win-readable airlock       │
│   Sticks flashed before the two-slot layout: OS 2.9 GB with one │
│   casper/ folder, Transfer 300 MB.                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Boot flow                                                       │
│   GRUB → kernel → casper → systemd → safekeep-session.service   │
│   → startx → openbox → autostart → safekeep-boot                │
│                              │                                  │
│   safekeep-boot orchestrates:                                   │
│     • First boot only: setup-vault (visible passphrase typed    │
│       twice, create LUKS), then "Continue now" (default, goes   │
│       straight to unlock) or "Shut down" to copy a .7z backup   │
│       onto TRANSFER from another computer                       │
│     • Every boot: unlock-vault (zenity prompt for               │
│       LUKS passphrase) → mount → launch_browser                 │
│     • launch_browser: entropy gate → Chromium kiosk             │
│     • On Chromium exit: read /tmp/POWER_ACTION.txt → poweroff   │
│       or reboot per user choice in the dashboard                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Browser session                                                 │
│   Chromium --kiosk loads file:///opt/safekeep/boot.html         │
│   boot.html embeds every tool: BIP-39, Seed XOR, SLIP-39,       │
│   BIP-85, Passphrase Library, Encrypted Notes, Encrypted        │
│   Backup, Wallet Record, PSBT Signer, Descriptor, SeedQR        │
│   shared/boot.js exports window.SafeKeepOS — the bridge to      │
│   the underlying Linux for vault I/O, power actions, etc.       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Directory map

```
entire website folder/                  ← project root
├── PROJECT_NOTES.md                    ← this file
├── developer-pubkey.asc                ← maintainer's GPG public key
├── seed-xor-tool/                      ← the web app (Vite)
│   ├── boot.html                       ← THE single-file UI
│   ├── boot-entry.js                   ← Vite entry that gets inlined
│   ├── build-offline.mjs               ← custom Vite build (inlines everything)
│   ├── shared/
│   │   ├── boot.js                     ← SafeKeepOS bridge (vault, power, codex, etc.)
│   │   ├── seed-session.js             ← in-memory mnemonic state
│   │   ├── seed-manager.js             ← BIP-32/BIP-39 helpers
│   │   ├── seed-selector.js            ← active-seed UI logic
│   │   └── design-system.css           ← base CSS variables + tokens
│   ├── dist/                           ← build output (boot.html with everything inlined)
│   ├── architecture/, bip85/, descriptor/, dice/, entropy-tool/,
│   │   passphrase/, qr-transfer/, secure-note/, seedxor/,
│   │   signer/                         ← per-tool source modules
│   └── public/                         ← static assets
└── usbbootdrive/                       ← the OS image builder
    ├── build.sh                        ← Phase-by-phase build orchestrator
    ├── prepare-app.sh                  ← builds seed-xor-tool from source into src/dist (fresh-clone builds)
    ├── chroot-setup.sh                 ← runs INSIDE the chroot (apt, configs)
    ├── safekeep-boot.sh                ← runtime boot orchestrator (lives at /usr/local/bin/safekeep-boot)
    ├── safekeep-harden.sh              ← hardening sweep (module blacklists, polkit, dconf, masked services)
    ├── setup-vault.sh                  ← first-boot LUKS creation wizard
    ├── unlock-vault.sh                 ← every-boot LUKS unlock dialog
    ├── safekeep-session.service        ← systemd unit (replaces getty autologin)
    ├── post-flash-setup.sh, zero-usb.sh ← USB lifecycle helpers
    └── config/
        └── 99-hide-drives.rules        ← udev rule to hide internal disks
```

---

## Build pipeline (10 phases)

`build.sh` walks through:

1. **Host dependencies** — debootstrap, mksquashfs, sgdisk, grub, etc.
2. **Ubuntu chroot** — debootstrap noble (cached) into `workspace/chroot/`
3. **Inject + configure** — copy src/dist into chroot, bind-mount /dev/proc/sys, run `chroot-setup.sh` then `safekeep-harden.sh`
4. **squashfs compression** — compress the configured chroot
5. **Image creation** — 6.7 GB blank `.img`, attached as loop device
6. **Partitioning** — sgdisk creates the 5-partition GPT
7. **Format** — FAT32, ext4×2, exFAT
8. **Install OS content** — copy squashfs/kernel/initrd into slot A (`casper-a/`) and write `slot.cfg`; slot B is filled by the first update (`os-slots.sh`, `UPDATER_DESIGN.md`)
9. **GRUB install** — `grub.cfg` (boots the slot in `slot.cfg`) for UEFI (Ubuntu's signed shim + GRUB, pinned; config in `EFI/ubuntu/`; see `SECURE_BOOT.md`) + BIOS (`grub-install`)
10. **Finalize** — unmount everything, detach loop

The build is **idempotent** as long as the host network reaches
`archive.ubuntu.com` and `github.com`.

---

## Recent major changes (chronological)

This session covered ~75 tasks. The biggest themes:

### Web app / boot.html (most numerous changes)
- **Vault Identifier 3-word phrase** — the dashboard chip used to
  show 8 hex chars of SHA-256(mnemonic). *Architectural Pivot:* This
  now acts as an Anti-Evil Maid integrity check deterministically 
  derived from a hash of the **Master Seed**, *not* the underlying 
  LUKS container. This approach guarantees UX 
  continuity across OS updates (e.g., v1.23 to v1.24). If a user 
  boots the drive and sees an unfamiliar 3-word phrase, it serves 
  as an immediate, tamper-evident warning that either the passphrase 
  was entered incorrectly or the hardware/software was swapped.
- **Light-mode contrast fix** — the active seed fingerprint badge
  was invisible against the lightened light-theme background.
  Scoped CSS override under `[data-theme="light"]`.
- **SeedQR Create-tab cleanup** — removed the BIP-39 passphrase
  field (security mistake to encode it in QR), removed the "raw
  entropy bytes" caption, added 4-sided axis labels to the printable
  blank grid, added a flexbox-based "Fingerprint ___ / Seed Phrase
  final word ___" footer that prints with structural CSS borders
  instead of typed underscores so right edges align.
- **Ghost-grid print fix** — the print container's `display: block`
  toggle ran via JS right before `window.print()`, leaving a flash
  of the grid visible on the live UI behind the dialog. Replaced
  with pure-CSS `@media screen { display: none }` / `@media print
  { display: block }`. Same pattern applied to all per-tool print
  containers.
- **Wallet Record preview QR** — the on-screen QR overflowed the
  right edge of the white card and rendered rectangular at narrow
  viewports. Scoped `#wrec-preview canvas { box-sizing: border-box;
  max-width: 100%; aspect-ratio: 1/1; height: auto; }` (screen
  only — print path untouched per user constraint).
- **Master Seed checkbox saga** — six rounds of audits before we
  found that `rlq_init()` was setting `seedChk.disabled = true` at
  runtime, which on macOS/WebKit strips the native styling and
  produces a flat-gray box. Removed that line; click-prevention is
  now done purely via `event.preventDefault()` in `rlq_onSeedClick`.
- **Seed XOR target FP fix** — the Split UI's "Target Master
  Fingerprint" used SHA-256(mnemonic).slice(0,8), which never
  matched the dashboard's BIP-32 root fingerprint. Switched to
  `mnemonicToSeed → HDKey.fromMasterSeed → root.fingerprint` so
  the displayed value matches every BIP-32-aware wallet.
- **Seed XOR verification source-of-truth** — `xorv_testRecovery`
  was comparing reconstruction against `SeedSession.fingerprint`
  (the vault's master). Changed to derive the expected fingerprint
  from `xor_state.loadedSeed` so the drill works for shards built
  for someone else's temporary seed.
- **Encrypted Backup notes restore bug** — a critical data-loss
  bug. The bash file router rebuilt `.codex-index.json` by
  scanning `*.meta.json` sidecars, but the JS layer (Sprint 22)
  switched to embedding metadata in HTML comments inside the
  `.html` files. Index regeneration produced empty arrays →
  notes survived restore on disk but weren't visible. Fixed both
  the boot-time and mid-session index regenerators in
  `safekeep-boot.sh` to scan `.html` files and parse the embedded
  `<!--SAFEKEEP_META:{...}-->` header.
- **Configurable idle timers + display sleep watcher** — the
  Settings panel's "Display Sleep" minutes field now actually
  works. JS writes `DISPLAY_SLEEP_TRIGGER.json` to the seed
  download directory; a bash daemon in `safekeep-boot.sh` polls
  for it, exports `DISPLAY=:0 XAUTHORITY=/root/.Xauthority`, and
  runs `xset dpms`. The env exports were the missing piece —
  `xset` was silently failing on MacBook Pros without them.
- **Zenity Enter-key fix** — replaced `--list --radiolist` with
  plain `--list` in setup-vault.sh and unlock-vault.sh so Enter
  submits the highlighted row instead of toggling the radio.
- **Wallet Record builder** (older work) — full form-based
  designer for multisig wallet records, prints to single-page PDF.

### Build pipeline / OS hardening
- **Cross-mount deletion safety** — a previous build leaked a
  background process holding `/dev` open; the next build's
  `rm -rf $CHROOT_DIR` crossed the still-active bind mount and
  wiped the host's devtmpfs. Two layers of defense added: every
  `umount` in `build.sh` now uses `-l` (lazy detachment), and
  `rm -rf` uses `--one-file-system` so it mathematically refuses
  to traverse a filesystem boundary.
- **Diagnostic boot halt** — `safekeep-boot.sh`'s `launch_browser`
  used to unconditionally `sudo poweroff` after Chromium exited.
  Now it captures the exit code and elapsed time; if Chromium
  dies in < 5 seconds it suppresses the poweroff, paints a
  diagnostic on `/dev/tty1` with photo-friendly recovery
  instructions, copies `/tmp/safekeep-boot.log` to
  `/mnt/safekeep-data/safekeep-boot.log` (persistent partition),
  and `exec sleep infinity`. Pull the USB, mount safekeep-data
  on another machine, read the log.
- **GRUB `noprompt`** — added to both kernel command lines in
  `build.sh` Phase 9. Suppresses casper's "Please remove the
  installation medium, then press ENTER" prompt at intentional
  shutdowns. Pure cosmetic.
- **Chromium install path swap** — after a long saga (see lessons
  below), abandoned the xtradeb/apps PPA approach entirely.
  `chroot-setup.sh` now downloads the latest ungoogled-chromium
  AppImage from GitHub releases, extracts to `/opt/ungoogled-chromium`,
  installs Ubuntu shared libs (libnss3, libcups2t64, libdrm2 etc.)
  via apt, and writes a shell wrapper at `/usr/bin/ungoogled-chromium`
  that execs `/opt/ungoogled-chromium/AppRun --no-sandbox "$@"`.
  GitHub's CDN is essentially un-blockable; archive.ubuntu.com has
  worked through every network we've tested.

---

## Critical lessons (gotchas to remember)

### 1. Canonical's PPA infrastructure is unreliable on restricted networks
- `api.launchpad.net` (PPA metadata API) — IPv6-blackhole on cellular
- `keyserver.ubuntu.com:11371` (HKP) — port-blocked on hotspots
- `ppa.launchpadcontent.net:443` — IP-blocked or rate-limited on
  some mobile/corporate networks
- `archive.ubuntu.com` (CDN-fronted) — has always worked

**Default to GitHub releases for third-party software** instead of PPAs.
GitHub's CDN is essentially un-blockable.

### 2. Ubuntu's snap-transitional packages
On noble, `chromium-browser` is a snap shim — installs returns 0,
binary on PATH, but invocation errors with "requires the chromium
snap to be installed." Snapd is masked in our hardened chroot.
**Always add a `--version` runtime check after installing browsers
or other potentially-snap-shim'd packages**, not just `command -v`.

### 3. Chroot bind-mount cleanup
`umount` (without `-l`) silently fails when ANY process inside the
chroot still holds an open file handle. The next build's `rm -rf
$CHROOT_DIR` then crosses the live bind mount and wipes the host's
`/dev`/`/proc`/`/sys`. Two-layer defense:
- `umount -l` everywhere in `cleanup()` and Phase 3 unmount block
- `rm -rf --one-file-system` for `$CHROOT_DIR` and `$STAGING_DIR`

### 4. Persistent diagnostic logging
`/tmp/safekeep-boot.log` is tmpfs — gone on poweroff. Always copy
to `/mnt/safekeep-data/safekeep-boot.log` (the persistent ext4
partition) before any shutdown. The user can pull the USB and
read the log on another machine post-mortem.

### 5. dist/boot.html drift
The built distribution `seed-xor-tool/dist/boot.html` lags the
source until `node build-offline.mjs` runs. If the kiosk seems
to ignore your fix, you forgot to rebuild. Add this to your
verification routine: compare the fix's distinguishing string
in source vs `dist/`.

### 6. macOS/WebKit native input rendering
WebKit native checkbox styling is very sensitive to
- `disabled` attribute (renders flat-gray)
- `tabindex="-1"` (strips focus styling)
- `style="pointer-events: none"` (similar)

If you need a checkbox to "look normal" but be JS-controlled,
use `event.preventDefault()` in the click handler, never
disable/tabindex/pointer-events on the input.

### 7. Apt resolution pitfalls
- `apt install <name>` resolves through `Provides:` declarations,
  so asking for one name can install a different-named package.
- Pin priority needs **>1000** (not 990) to override version
  comparison and beat Canonical's epoch-bumped transitional packages.
- Pin file `Package:` list must match the package name actually
  shipped, not what you assume — verify with `apt-cache madison <name>`.

---

## Verification patterns I used (keep these in your build hygiene)

- **HTML parse**: `python3 -c "from html.parser import HTMLParser; ..."` on `boot.html`
- **JS syntax**: extract every inline `<script>` block via regex, run `node --check` on each in a temp file
- **Bash syntax**: `bash -n script.sh` on every shell script after edits
- **Grep audits**: confirm every reference to a renamed symbol is gone, or every reference to an old path is updated
- **Build sanity check**: post-install `command -v X && X --version` to refuse shipping a non-functional image

These caught real bugs every time and never produced false positives.
Worth keeping in any future LLM agent's verification loop.

---

## Common workflows

### Fix a UI bug in boot.html
1. Open `seed-xor-tool/boot.html` in a desktop browser
2. Reproduce the bug (DEV_MODE auto-enables for `file://`)
3. Edit, reload, test
4. `node build-offline.mjs` to roll the dist
5. Smoke-test `seed-xor-tool/dist/boot.html`
6. `cd usbbootdrive && sudo bash build.sh` to roll the OS
7. Flash, boot, verify

### Add a new tool to the kiosk
1. Add a new state container `<div id="state-newtool">` in `boot.html`
2. Wire it into the dashboard tool grid + sidebar
3. If the tool needs file I/O, add helpers to `shared/boot.js`'s
   SafeKeepOS bridge (see `saveNote`/`listNotes` as a model)
4. If the tool prints, follow the existing per-tool print pattern:
   `body.printing-newtool` class + `@media screen { display: none }`
   / `@media print { display: block }` for the print container
5. Don't forget the matching dev mock at the bottom of `shared/boot.js`

### Debug a boot failure
1. Boot up to the diagnostic halt screen (if Chromium died fast,
   the new fast-fail catches it)
2. Take a photo of `/dev/tty1`
3. Pull the USB, mount the partition labeled `safekeep-data` on
   another machine, copy `safekeep-boot.log`
4. Read the log — it has every echo'd phase from `safekeep-boot.sh`
   plus the chromium exit code

### Add a new system-trigger file (JS → bash daemon)
1. Add the prefix to `_SYSTEM_TRIGGER_PREFIXES` in `shared/boot.js`
2. Define a `_silentDownload`-based writer function (see
   `setDisplaySleep` for the reference implementation)
3. Add the prefix to the codex router's skip list in
   `safekeep-boot.sh` (search for `master-seed*|RELIQUARY_*`)
4. Add a watcher daemon subshell to `safekeep-boot.sh` that polls
   for the trigger, processes it, deletes the trigger file
5. Remember to `export DISPLAY=:0 XAUTHORITY=/root/.Xauthority`
   if the daemon does anything X11-related

---

## Pending / wishlist (nothing critical)

These came up in passing during the session but were never tackled:

- **Move kiosk Chromium to non-root user** with SUID-root chrome-sandbox
  (would let us drop `--no-sandbox`). Currently a Phase 2 task per
  comments in `safekeep-boot.sh`.
- **Replace `--disable-web-security`** with a tiny localhost HTTP
  server inside the kiosk so `boot.html`'s `fetch('file://...')`
  calls don't need the flag. Currently required for amnesia detection.
- **Update Chromium policy directory** if `ungoogled-chromium`
  reads policies from `/etc/ungoogled-chromium/policies/managed/`
  instead of `/etc/chromium/policies/managed/`. We currently
  write to `/etc/chromium/...` and assume convention. If download
  routing breaks at runtime, this is the first thing to check.
- **Vendor xtradeb chromium debs** as a fallback path in case
  GitHub releases ever get blocked the way Launchpad did. The
  detection scaffolding was sketched out in conversation but
  never implemented since the AppImage approach worked.
- **CLAUDE.md / agent docs** — this file is human-oriented;
  if you want a dedicated agent context file, run the `/init`
  Claude Code skill.

---

## Resuming with an LLM

If you start a fresh Claude/Cowork session to continue, paste the
top of this file as context (or just tell the model the path) and
remind it of:

1. The chroot bind-mount safety pattern (umount -l + rm --one-file-system)
2. The native checkbox styling sensitivity on WebKit
3. The build verification routine (HTML parse, node --check, bash -n, grep audit)
4. The CDN-vs-Canonical lesson — default to GitHub releases for third-party packages
5. The kiosk diagnostic halt at `safekeep-boot.sh:1845` — your friend for any future runtime regression

The codebase is heavily commented at every recently-modified site,
often referencing the task number that introduced the change.
A fresh agent can grep for a function/class/CSS-selector and find
the explanation inline.

Good luck, and have fun. The hard parts of the saga are behind you.

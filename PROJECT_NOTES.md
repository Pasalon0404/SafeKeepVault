# SafeKeep Vault — Project Notes

> **Start with the "Current state" section below (updated Oct 20, 2026).**
> Everything after the line marked *"Historical notes (May 2026)"* is the
> original pickup guide. It is still useful for architecture and gotchas,
> but parts of it are out of date. Where the two disagree, trust the
> Current state section. `CLAUDE.md` holds the standing rules for AI
> sessions (desktop/laptop only, no version bump until the owner asks).

---

## Current state (Oct 20, 2026) — v1.48 plus unreleased work on `main`

The last release is **v1.48** (Oct 20), the first with an update file:
v1.47 sticks install it in place from Device Options → Update SafeKeep.
`seed-xor-tool/VERSION` says 1.48: features merge to `main` without a bump,
and builds from `main` are for the owner's own use until the owner says
it's release time (see `CLAUDE.md`). The version stamp shows the exact
commit, e.g. `v1.48 · build 307 · e86560c`.

Unreleased on `main` (for v1.49): the new two-tone SAFEKEEP / VAULT boot
logo, a shutdown screen that is actually visible, and the shutdown fix
for Restart now after an update (see "Text consoles" below). All tested
on Dave's stick through in-place updates (builds 303–307).

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
- Tests: `node <file>` for each `seed-xor-tool/test-*.mjs` — **44 files**,
  all passing on Linux at `e86560c` (Oct 20). On macOS three always fail
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
tested Oct 19–20. **Not yet tested on a stick:** factory reset without
the second restart, the QR time limit, interrupted-setup recovery.

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
  open a PR for Dave to merge (as for v1.47 and v1.48). The live site is
  up to date with v1.48.

### Open items / next steps

1. **Before v1.49:**
   - Hardware-test the v1.48 changes nobody has run on a stick yet:
     factory reset (straight into setup), the first-boot QR time limit.
   - Flash the full image onto a spare stick and go through first boot
     once: the console masks and the splash redraw were only tested
     through in-place updates.
   - Check boot time (the redraw waits for `systemd-udev-settle`).
   - Run the tests on the ZBook before tagging.
   - Release notes: people updating from v1.48 may see the scrolling
     errors once on Restart now (v1.48 does that restart); holding the
     power button is safe. The download page's update notice needs the
     v1.49 file name, for v1.47 and v1.48 sticks.
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
3. **Second source for the GPG fingerprint** — publish it outside GitHub
   (e.g. X bio, keys.openpgp.org), then name it on the download page.
4. Chromium still runs with `--no-sandbox` and `--disable-web-security`
   (comments in `safekeep-boot.sh` explain why). Acceptable only because
   the machine is offline and runs only our page.
5. Not supported yet: Taproot script-path / miniscript signing, saving
   Silent Payment wallets, matching inputs whose PSBT has no derivation
   path.
6. Legacy inputs that carry only `witnessUtxo` (no `nonWitnessUtxo`) are
   still trusted for their amount; Bitcoin Core and most wallets send
   `nonWitnessUtxo` for legacy inputs.

Closed since the Sept 29 notes: the Reliquary watcher no longer runs
command text (fixed list + `7z` argument list); the Transfer Drive
auto-mount is in daily use on hardware.

### Recent work (newest first)

```
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
│   2. EFI System  (256 MB FAT32)— GRUB BOOTX64.EFI for UEFI      │
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
9. **GRUB install** — `grub.cfg` (boots the slot in `slot.cfg`) for UEFI (`grub-mkstandalone`) + BIOS (`grub-install`)
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

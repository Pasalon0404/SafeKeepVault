# SafeKeep Vault — Project Notes

> **Start with the "Current state" section below (updated Sept 29, 2026).**
> Everything after the line marked *"Historical notes (May 2026)"* is the
> original pickup guide. It is still useful for architecture and gotchas,
> but parts of it are out of date. Where the two disagree, trust the
> Current state section.

---

## Current state (Sept 29, 2026) — version v1.34

### Working with Dave (the owner)

- Dave is not very technical. Give him copy-paste commands with a plain
  explanation, say which machine each runs on ("On your Mac" / "On the
  ZBook"), and ask him to paste back the output.
- Don't put `#` comments inside commands. zsh on his Mac chokes on them,
  especially comments that contain apostrophes.
- Don't guess when he pastes an error. Read the actual output first. Two
  past incidents came from running commands on the wrong machine.

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
cd seed-xor-tool
npm run build
cd ..
rsync -av --delete --exclude '* (1)*' seed-xor-tool/dist/ <ZBOOK_USER>@<ZBOOK_IP>:/home/safekeep-build/src/dist/
rsync -av --exclude 'workspace/' --exclude '*.img' --exclude '* (1)*' --exclude '.DS_Store' usbbootdrive/ <ZBOOK_USER>@<ZBOOK_IP>:/home/safekeep-build/
```
The second rsync is only needed when something in `usbbootdrive/` changed.

If the build prints `⚠ shallow git clone` (the stamp then ends in
`+ shallow clone`), the Mac's clone is missing history, so the build number
is wrong and the file can't match a release. Fix it once with
`git fetch --unshallow`. Releases are built by `.github/workflows/release.yml`
from a `vX.Y` tag; see `VERIFYING.md` for checking and signing them.

`build.sh` stops right away if `src/dist/boot.html` is missing (it used to
skip the copy silently and produce an image with no app). Someone building
from a fresh clone on one Linux machine runs `bash prepare-app.sh` (no sudo)
in `usbbootdrive/` instead of the first rsync: it runs `npm ci` +
`npm run build` and copies the result into `usbbootdrive/src/dist/`.
`seed-xor-tool/.npmrc` sets `legacy-peer-deps=true` because
`vite-plugin-node-polyfills@0.25.0` doesn't declare Vite 8 support yet;
without it a clean `npm ci` fails.

On the ZBook:
```
cd /home/safekeep-build
lsblk -o NAME,SIZE,TRAN,MODEL
sudo bash quick-update.sh --usb /dev/sdb
```
- `quick-update.sh` reuses the last full build's chroot, drops in the new
  app and scripts, re-squashes, and rewrites ONLY the OS partition.
  **The vault and transfer data are preserved.** It asks you to type YES.
- It refuses to run (and tells you to run the full `build.sh`, ~20 min)
  if `chroot-setup.sh` or `safekeep-harden.sh` changed, or if the last full
  build didn't finish (`workspace/.chroot-complete` marker).
- `npm install` needs `--legacy-peer-deps`: vite 8 and
  vite-plugin-node-polyfills have a harmless peer-version mismatch. Don't
  run `npm audit fix --force`.
- The Vite build can't run in the Linux sandbox (the rolldown native
  binding is missing). Builds happen on the Mac.

### Dev testing (no USB)

- On the Mac: `cd seed-xor-tool && npm run dev`, then open
  `http://localhost:5173/boot.html?devMode=seeded`
  (also `normal`, `ephemeral`, `amnesia`). The Dev Drawer has
  "Load test seed" (abandon×23 art → nickname "Digital Wheat Crumble").
- In dev mode the Transfer Drive is an in-memory mock ("TRANSFER (dev mock)").
- Tests: `node <file>` for each `seed-xor-tool/test-*.mjs`, 19 files, all
  passing. They extract real functions from boot.html and check them
  against official vectors (BIP-39/32/44/49/84/86, BIP-85, Coldcard Seed
  XOR, all 45 SLIP-39 vectors, BIP-322, PSBT change audit, Silent
  Payments). `test-transfer-bridge.mjs` runs the real Transfer Watcher bash
  code end-to-end and needs GNU coreutils, so it skips itself on macOS.

### Git rules

- Commit **source only**. Never stage `seed-xor-tool/dist/`.
- The repo sits on a slow mount and sometimes leaves stale lock files:
  `rm -f .git/index.lock .git/HEAD.lock`, then add/commit.
- A broken duplicate ref `.git/refs/heads/main (1)` makes `git log --all`
  print "fatal: bad object". It's safe to delete: `rm ".git/refs/heads/main (1)"`.
- The folders contain stray `* (1).*` download duplicates (e.g.
  `boot (1).html`, `safekeep-boot (1).sh`). They are untracked junk and
  can be deleted. The rsync commands exclude them.

### Safety rules (non-negotiable)

- Confirm the USB device with `lsblk` before any `dd` or quick-update.
- Never invent or choose passwords for Dave. Never bake secrets into the
  installer.
- The vault OS stays air-gapped: no network listeners (netcat/socat were
  proposed once and declined), no network features.
- **Lock must never power off or reboot.** It returns to the native unlock
  screen.
- Don't weaken crypto. Verify changes against official test vectors, with
  a mutation check where practical.
- UI polish is secondary. Never break function for looks.

### How key subsystems work now

**Browser ↔ OS bridge.** Chromium runs as a kiosk on `file://` and can't
call the OS directly. The app "downloads" small trigger files. The
enterprise policy (written at launch by `safekeep-boot.sh`) routes them
silently into `/media/.safekeep-vault/seeds/` (normal boot) or
`/tmp/safekeep-signals/` (temporary session), where bash watchers in
`safekeep-boot.sh` act on them. The app reads results back with
`fetch(file://…)`. Examples: POWER_ACTION, WIPE_TRIGGER, RELIQUARY_*
(backups), RESTORE_*, Codex notes, passphrases, 2FA.

**Lock (true lock).** The dashboard Lock button calls `SafeKeepOS.lock()`,
which writes `POWER_ACTION.txt` = `lock` and closes the window. The daemon
defaults to `lock` if the signal file is missing, so it can never fall
through to poweroff. The lock branch kills the session's children,
unmounts, runs `cryptsetup close vault`, then
`exec /usr/local/bin/safekeep-boot` → native zenity unlock prompt.
Fallbacks: `systemctl --no-block restart`, then a zenity message plus
`sleep infinity`. The same mechanism powers "RETURN TO MASTER VAULT" from a
temporary session (Settings). Debug logs:
`/media/.safekeep-vault/power-debug.log` and
`/mnt/safekeep-data/safekeep-power-debug.log`.

**Transfer Drive (auto-mounted, no prompts — NEW, not yet hardware-tested).**
The exFAT TRANSFER partition is mounted at boot at
`/media/safekeep-transfer`. The app no longer uses showDirectoryPicker,
which caused a folder picker plus an "Allow this site to edit files?" prompt
every boot. `shared/transfer-drive.js` (window.SKTransfer) provides a
FileSystemDirectoryHandle look-alike, so every tool still uses
`window.vaultTransferDriveHandle` unchanged:
- reads: `fetch(file://<transfer>/<name>)`
- listing: `/tmp/safekeep-signals/xfer/index.txt`, kept current by the
  Transfer Watcher
- write/delete/rename: one download, `SKXFER-<W|D|M>-<id>[-<hexname>].skxfer`.
  The Transfer Watcher (between the `SKX_TRANSFER_WATCHER_BEGIN/END` markers
  in `safekeep-boot.sh`) performs FIXED operations only, re-validates names
  (no `/`, no leading `.`, no control characters), and acks via
  `/tmp/safekeep-signals/xfer/done-<id>.txt`.
- Auto-mount happens in `transitionToDashboard()` via
  `_transferAutoMount()`. If the watcher isn't running, the old Mount button
  and picker come back as a fallback.
- Chromium policy now also sets
  `AutomaticDownloadsAllowedForUrls: ["file://*","file:///*"]` and
  `DefaultAutomaticDownloadsSetting: 1` to stop the "download multiple
  files" prompt.
- If it misbehaves on hardware: `grep "Transfer Watcher" /tmp/safekeep-boot.log`

**Seed Nickname** (status bar, formerly "Vault Identifier"). Three BIP-39
words from SHA-256 of the normalized mnemonic (NFKD, lowercase, single
spaces), truncated to 32 bits. Same seed → same words on every
build and drive. The passphrase is not included. It is a convenience label
only. It does NOT prove the USB drive is genuine or untampered: it is
computed after unlock, and a cloned drive shows the same words. Decided
Sept 2026: keep it and label it honestly. Skipped pre-unlock anti-phishing
words (low value for a stick kept physically secure).

**UI polish layer.** Nearly all visual styling is in
`<style id="skb-polish">` near the end of boot.html, inside `@media screen`
so print output is untouched. It holds the design tokens (palette, radii,
type scale), buttons, the status-bar pills, and seed-word tiles that are
blurred until hovered. Fonts: Inter + JetBrains Mono from
`@fontsource-variable/*`, imported in `boot-entry.js` and inlined into the
single-file build. Dashboard icons are inline Lucide SVGs. Advanced tools
are grouped: Keys & Seeds / Backup & Recovery / Signing & Transfer /
Private Data. Version string: `id="dash-version"` in boot.html.

### Crypto review results (Sept 2026)

All core crypto passed official vectors. Fixed in that review:
- PSBT change-hijack holes: foreign-fingerprint and unknown-purpose outputs
  are now treated as destinations; multisig change is bound to the wallet
  via global xpubs.
- Fee sanity guard: error if fee < 0 or fee ≥ 5% of inputs.
- BIP-322 signatures use low-S.
- Passphrases are no longer `.trim()`-ed (spaces are significant in BIP-39).
- Seed XOR / SLIP-39 recovery shows the recovered fingerprint and asks for
  confirmation before replacing the vault seed.
- An XSS hole in restore file names was fixed.

Known SLIP-39 facts worth remembering: SafeKeep's SLIP-39 shares encode the
BIP-39 *entropy*, so restoring them on a Trezor gives a different wallet
(the UI says so). A wrong SLIP-39 passphrase silently yields a different
valid secret.

### Open items / next steps

1. **Hardware-test the Transfer Drive auto-mount** (v1.34 build): check the
   status bar shows MOUNTED, the Mount button is gone, save/rename/delete
   work, and no Chromium prompts appear.
2. **Security hardening, not urgent:** the Reliquary/backup watcher
   executes shell command text sent from the app, as root
   (`exportToTransfer` / `createReliquary` build a `command` string). Replace
   it with fixed operations like the Transfer Watcher uses.
3. Chromium runs with `--no-sandbox` and `--disable-web-security`. That's
   acceptable only because the machine is offline and runs only our page.
   Revisit if anything ever loads untrusted content.
4. Minor: the "Device Options" chevron is still a text glyph, not an SVG.

### Recent commits (newest first)

```
3380e5b feat(transfer): auto-mount transfer drive via watcher, no browser permission prompts
e8e7f0d ui(seed-nickname): rename Vault Identifier, honest tooltip, case-insensitive, clear on seed wipe
844b929 ui(polish): embedded fonts, icon set, grouped tools, refined palette, seed-word privacy blur
74ec864 build: quick-update.sh + completion marker so a cancelled build is never reused
82db373 feat(lock): return from a Temporary session to the master vault without rebooting
5d55949 fix: review round 2 - recovery confirmation, exact passphrases, input escaping, fee guard
7962f6e fix(security): close PSBT change-hijack holes; crypto vector review
```
(v1.34 is committed; the version string lives at `id="dash-version"` in boot.html.)

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
flashes the image to a 4 GB+ USB drive, boots from it, and gets a
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

Produces `safekeep.img` (~3.8 GB). Takes 10-20 minutes on a fresh
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
│   3. OS          (2.9 GB ext4) — squashfs + kernel + initrd     │
│   4. Data        (300 MB ext4) — `.vault.luks` file container   │
│   5. Transfer    (300 MB exFAT)— Mac/Win-readable airlock       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Boot flow                                                       │
│   GRUB → kernel → casper → systemd → safekeep-session.service   │
│   → startx → openbox → autostart → safekeep-boot                │
│                              │                                  │
│   safekeep-boot orchestrates:                                   │
│     • First boot only: setup-vault (create LUKS, harden OS,     │
│       poweroff to force user to pull-and-reseat the drive)      │
│     • Every subsequent boot: unlock-vault (zenity prompt for    │
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
│   │   passphrase/, qr-transfer/, secure-note/, seedqr/, seedxor/,
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
5. **Image creation** — 3.8 GB blank `.img`, attached as loop device
6. **Partitioning** — sgdisk creates the 5-partition GPT
7. **Format** — FAT32, ext4×2, exFAT
8. **Install OS content** — copy squashfs/kernel/initrd to OS partition
9. **GRUB install** — UEFI (`grub-mkstandalone`) + BIOS (`grub-install`)
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

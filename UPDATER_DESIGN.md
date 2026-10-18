# Design note: updating a SafeKeep stick in place

Status: **proposal, for the owner to approve.** Nothing here is built yet.

## The problem

Today a user updates by making an Encrypted Backup, copying it off the
stick, reflashing the whole stick and restoring. A user who skips the
backup loses the vault, and their bitcoin is then only as safe as their
paper seed backup.

`quick-update.sh --usb` already updates a stick without touching the vault,
but it needs the build machine. The goal is the same result from the stick
itself, with no build machine and nothing to trust except the
maintainer's signature.

## Facts the design rests on

- The OS partition (3, ext4, label `safekeep-os`, 2944 MB) holds only
  `casper/`: `filesystem.squashfs`, `vmlinuz`, `initrd` and
  `filesystem.size`. The vault (partition 4) and the Transfer Drive
  (partition 5) are separate partitions (`build.sh`).
- GRUB's config lives on the EFI partition. It finds the OS partition
  by its label and boots `/casper/vmlinuz` (`build.sh`, Phase 9).
- The v1.45 OS zips to about 1.3 GB. The squashfs is already xz-compressed,
  so an update file is about **1.3 GB**.
- The Transfer Drive is only **300 MB**, and the image is sized for
  4 GB sticks. **An update file does not fit on today's layout.**
  This is the main reason the first updater release needs one last reflash.
- Two copies of the OS (about 2.6 GB) just fit in the 2.9 GB OS
  partition. `quick-update.sh` already relies on that when it writes `.new`
  files and then renames them. The fit is tight, so Part 1 should also give
  the OS partition more room.

## Proposal

### Part 1: a new stick layout (one last reflash) — built

The owner approved 8 GB as the minimum stick size (Oct 18, 2026).

1. **Bigger partitions, fixed in the image.**

   | Partition | Before | Now |
   |---|---|---|
   | OS | 2,944 MB | 3,584 MB |
   | Transfer Drive | 300 MB | 2,560 MB |
   | Whole image | 3,800 MB | 6,704 MB |

   - **OS:** two slots of about 1.3 GB each, with room to grow by about
     35%.
   - **Transfer Drive:** room for an update file.
   - **Whole image:** fits the smallest real "8 GB" sticks, which hold about
     7,400 MB. The empty space zips away, so the release zip stays about
     1.3 GB.

   Nothing on the stick is ever resized. An earlier draft grew the
   Transfer Drive on first boot. That was dropped because a user may copy
   a backup onto the Transfer Drive right after flashing, and growing it
   would have meant reformatting it. Larger sticks keep their extra space
   unused, so the unencrypted Transfer Drive doesn't invite storing other
   files.

   `build.sh` stops if two copies of the OS no longer fit.
2. **Two OS slots.** The OS partition holds `casper-a/` and `casper-b/`,
   plus a one-line file `slot.cfg` (`set slot=a`).
   - **GRUB** (`usbbootdrive/grub.cfg`) reads `slot.cfg` and boots that
     slot with `live-media-path=casper-<slot>`. If the file is missing or
     that slot has no kernel, it falls back to the other slot. It lists the
     other slot as "previous version" when it has a kernel.
   - **Switching** means writing a new `slot.cfg` under a temporary name
     and renaming it over the old one. On ext4 that rename is atomic, so a
     power cut leaves either the old OS or the new one, never half of each.
   - **A new build** puts the OS in slot A. Slot B stays empty until the
     first update.
   - **`os-slots.sh`** holds the slot logic: which slot boots, writing a
     slot (to a temporary name, read back and checked, then renamed), and
     switching. `quick-update.sh` uses it already, and the updater will use
     it too.
3. **The maintainer's public key in the image**, as a `gpgv` keyring at
   `/usr/local/share/safekeep/maintainer.gpg`.
   - `build.sh` pins its fingerprint (A333 EB82 … EDBA 86C2) and stops if
     `usbbootdrive/config/maintainer-pubkey.asc` holds a different key, or
     if `gpgv` is missing from the image.
   - `test-os-slots.mjs` checks that the file is identical to
     `developer-pubkey.asc`.

### Part 2: the updater — built

**What a release adds:** `SafeKeep-Update-v1.NN.tar`, an uncompressed tar
made by `usbbootdrive/make-update.sh` right after the full build. It holds:
- `manifest.json`, first:
  - `format` and `kind`;
  - `version` and the build stamp;
  - `app_sha256`, the hash of the app read from inside the squashfs, which
    must match that release's `SHA256SUMS`;
  - `layout: "two-slot"`;
  - the size and SHA-256 of every OS file;
- `manifest.json.asc`: the maintainer's signature of the manifest, added
  on the Mac with `tar -rf`;
- the OS files: `filesystem.squashfs`, `vmlinuz` and `initrd`, plus
  `filesystem.size` and `filesystem.manifest`.

Release steps: `VERIFYING.md`, "For the maintainer", steps 4–6.

**What the user does:**
1. Download the update file on their online computer and copy it to the
   Transfer Drive.
2. On the unlocked vault, open **Device Options → Update SafeKeep → Check
   for update**.
3. Click **Install**, then **Restart now**.

**How it works:**
- The app (`SafeKeepOS.updateCheck` / `updateInstall` in `shared/boot.js`)
  saves `UPDATE_REQUEST.json`.
- The Update Watcher in `safekeep-boot.sh` runs
  `/usr/local/lib/safekeep/safekeep-update.py` as root, with `python3 -I`.
- The helper writes `UPDATE_RESULT.json` in RAM. While an install runs,
  that file holds "working" results with a percentage.

**What the helper checks:**
1. **The vault is unlocked.** A Temporary Session is refused. A stick with
   the older one-slot layout is told to reflash once.
2. **The signature.** Nothing else in the tar is read until
   `manifest.json` passes `gpgv` against the key built into the image, and
   the signing key's fingerprint is the pinned one. Each OS file must then
   be a plain file of the size in the signed manifest. Nothing is unpacked
   by name or path: the helper looks up the allowed member names and
   streams their bytes into files it names itself.
3. **No going backwards.** The update must have a higher version, or the
   same version with a higher build number. An older release with a known
   bug can't be put back. The build-number rule also lets the owner test
   updates between builds of the same version.
4. **What it found** is shown before anything is written: the version, the
   build stamp, and the app hash (to compare with the release's
   `SHA256SUMS`), and the size. Install sends back the manifest hash the
   user was shown. If the file has changed since, nothing is installed.
5. **Writing.** The new OS goes into the slot that isn't running, as
   `.casper-X.new`, and is hashed while it's written.
   - It is then read back from the stick and checked against the manifest.
   - Only then is it renamed into place and does `slot.cfg` switch.
   - If `slot.cfg` already names the spare slot (installed but not yet
     restarted), it is pointed back at the running slot first.
6. **Clean-up.** The update file is deleted from the Transfer Drive. The
   user restarts; the previous version stays in GRUB's menu until the next
   update.

The vault is never touched. Auto-Lock and Auto-Off are held off while an
install runs, though a power cut would be harmless anyway.

**When an install fails,** the error names the step it failed on.
**Show update log** in the same section then shows:
- the updater's log, which lives in RAM and is gone at power-off;
- how the system partition was mounted;
- the kernel's read-only flags for the stick;
- the kernel's recent messages.

On a normal build this is the only way to see why it failed, since there
is no terminal.

Tests: `test-updater.mjs` runs `make-update.sh` on a real squashfs, then
the helper on a fake OS partition with a throwaway signing key. It covers:
- a good update, and the next one going into the other slot;
- unsigned, other-key and pinned-fingerprint cases;
- not newer;
- a file changed after the check, or OS bytes that don't match;
- a symlink member;
- a temporary session, the old layout, and bad requests.

## Testing an update on a stick

An update only installs when it is newer, and the build number counts
commits, so a test needs two commits: the stick runs build N, and the
update carries build N+1.

1. **Stick on build N.** Build the image from the first commit with the
   full `sudo bash build.sh`. Flash a spare 8 GB+ stick and set up a test
   vault.
2. **Update file from build N+1.**
   - Build the app from the next commit and copy it to the build machine.
   - On the build machine, run `sudo bash quick-update.sh` (with no
     `--usb`) to compress the new OS, then `sudo bash make-update.sh`.
3. **Sign it on the Mac.** Copy the `.tar` and `manifest.json` over, then:
   ```sh
   gpg --local-user A333EB826F70A79A736F09948EA7DD8CEDBA86C2 --armor --detach-sign manifest.json
   tar -rf SafeKeep-Update-v….tar manifest.json.asc
   ```
4. **Put it on the stick.** Copy the `.tar` onto the stick's Transfer Drive.
5. **Install.** Boot the stick, unlock, and open **Device Options → Update
   SafeKeep → Check for update**.
   - It should show build N+1, with the app hash the Mac's build printed.
   - Click **Install**, then **Restart now**.
6. **Check the result.**
   - The dashboard shows build N+1.
   - GRUB lists "previous version", which still boots build N.
   - The update file is gone from the Transfer Drive.

## Proof-of-concept results (Oct 18, 2026)

On a developer build of v1.46, on a Patriot P210 128 GB stick, booted with
UEFI on the owner's laptop:

- **Room:** the OS is 1,258 MB, and two copies leave 146 MB free on the
  2.8 GB OS partition. They fit, but with little to spare.
- **Writing the idle slot while running works.** Remounting `/cdrom`
  read-write, copying, reading back and checking the hashes took 16 seconds.
- **Switching works.** After the switch the stick booted slot B
  (`live-media-path=casper-b`), and GRUB listed "previous version, slot a".
  The app ran normally from slot B.
- **A power cut while writing is harmless.** Pulling the stick mid-copy left
  slot A empty. The stick booted slot B normally with no "previous version"
  entry, and running the copy again completed cleanly.
- **Fallback works.** With `slot.cfg` naming a slot without a kernel, GRUB
  booted the other slot.
- **Not yet tested:** legacy BIOS boot, slower sticks.

## Risks and open questions

- **Writing the OS partition while it is in use.** Casper keeps the OS
  partition mounted read-only at `/cdrom`. The proof of concept showed that
  remounting it read-write to write the other slot works (see above).
- **Key compromise.** Anyone holding the maintainer's private key could
  ship a malicious update to every user who installs it. Today the same
  key signs the image, so the risk exists already, but an updater makes it
  easier to act on. Two possible mitigations:
  - show the update's build stamp and app hash, so careful users can
    compare them with the GitHub release and the attestation;
  - later, require two signatures.
- **Users on 4 GB sticks** can't install releases with the two-slot
  layout. They need a stick of 8 GB or more.
- **The hardening rules** must allow the updater to mount `safekeep-os`.
  Today a udev rule hides it from the desktop.

## Suggested order

1. **Proof of concept, on a stick from the ZBook — done** (results above):
   two slots, `slot.cfg`, and writing the idle slot while booted. The
   scripts and test steps are in `usbbootdrive/poc-updater/`. GRUB loads a
   slot with casper's `live-media-path=casper-a` option (casper 1.498,
   Ubuntu 24.04).
2. **Part 1 — built, to be tested on a stick, then released** (one last
   reflash for everyone).
3. **Part 2 — built.** Test on a stick: install an update made by
   `make-update.sh` and signed with the real key. It can ship in the same
   release as Part 1, but its first real use is updating *from* that
   release to the next one.

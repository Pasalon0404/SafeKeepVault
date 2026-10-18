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

### Part 1: a new stick layout (one last reflash)

1. **The Transfer Drive grows on first boot, to 4 GB or as much as the
   stick allows if that's less.** First-boot setup:
   - reads the stick's real size (`blockdev --getsize64` on the disk
     holding `safekeep-os`);
   - moves the backup partition table to the real end of the stick
     (`sgdisk -e`);
   - extends the Transfer Drive, the last partition, and re-creates its
     exFAT filesystem. That's safe because it is still empty on first boot.

   The rest of a large stick is left unused, because the Transfer Drive is
   unencrypted and shouldn't invite storing other files. The image stays
   3.8 GB, and a 4 GB stick still works without updates. An 8 GB stick
   gets about 3 GB, enough for an update file. So updating needs a stick of
   **8 GB or more**.
2. **Two OS slots.** The OS partition holds `casper-a/` and `casper-b/`,
   plus a one-line file `slot.cfg` (`set slot=a`). GRUB reads
   `slot.cfg` and boots the slot it names. If the file is missing or that
   slot has no kernel, GRUB falls back to the other slot.
   - Switching slots means writing a new `slot.cfg` to a temporary
     name and renaming it over the old one. On ext4 that rename is
     atomic, so a power cut leaves either the old OS or the new one,
     never half of each.
3. **The maintainer's public key in the image**, plus `gpgv` to check
   signatures with it. Neither depends on the network.

### Part 2: the updater (from the release after that)

**What a release adds:** `SafeKeep-Update-v1.NN.tar`, containing:
- the four `casper/` files;
- a `manifest.json`;
- `manifest.json.asc`, the maintainer's signature of the manifest.

The manifest holds:
- the version and build stamp;
- the SHA-256 of each file;
- the SHA-256 of the app (`boot.html`), which must match that release's
  `SHA256SUMS`;
- the oldest stick layout it can be installed on.

**What the user does:** download the update file on their online computer
and copy it to the Transfer Drive. Then, on the unlocked vault, open
**Device Options → Update SafeKeep**.

**What the stick does:**
1. **It requires an unlocked vault.** A Temporary Session can't update,
   and neither can someone who has the stick but not the password.
2. **It checks the signature.** `gpgv` checks the manifest signature
   against the key built into the stick, and stops on any failure. The
   tar file itself is treated as untrusted data: it is never run, and it
   is unpacked only as the four named files.
3. **It refuses to go backwards.** The version must be newer than the
   running one, so an old release with a known bug can't be installed.
4. **It shows what it found** before anything is written: the version,
   the build stamp and the app hash. It also recommends making an
   Encrypted Backup first.
5. **It writes the new OS into the slot that isn't running**, checks each
   file's SHA-256 after writing, and only then switches `slot.cfg`.
6. **It reboots into the new OS.**
   - If the new OS fails its start-up self-check, the user can choose the
     previous slot from the GRUB menu, which lists both versions.
   - The previous slot is kept until the next update.

The vault and the Transfer Drive are never written to, apart from deleting
the update file from the Transfer Drive at the end.

### Release steps that change

After `sudo bash build.sh`, a new script `make-update.sh` packs
`casper/` into the update file and writes the manifest. The maintainer
then:
- signs the manifest on the Mac, the same way as `SHA256SUMS.txt`;
- uploads the update file next to the zip.

The update file must come from the same full build as the image.

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
- **Users on 4 GB sticks** can't use the updater, and keep reflashing.
- **The hardening rules** must allow the updater to mount `safekeep-os`.
  Today a udev rule hides it from the desktop.

## Suggested order

1. **Proof of concept, on a stick from the ZBook:** two slots, `slot.cfg`,
   and writing the idle slot while booted. No signature yet. The scripts and
   test steps are in `usbbootdrive/poc-updater/`. GRUB loads a slot with
   casper's `live-media-path=casper-a` option (casper 1.498, Ubuntu 24.04).
2. **Part 1 in a release** (one last reflash for everyone).
3. **Part 2:**
   - the updater;
   - `make-update.sh`;
   - tests for the manifest checks;
   - docs for the website.

   It ships in the release after Part 1, so that its first real
   update can be tested.

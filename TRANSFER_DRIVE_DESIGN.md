# Design note: a Transfer Drive that fills larger flash drives

Status: **built** (Nov 19, 2026), on `main` once merged; not yet in a
release. `usbbootdrive/grow-transfer.sh`, run by `setup-vault.sh`; tests in
`usbbootdrive/tests/test-grow-transfer.py` (also run by
`test-os-lockdown.mjs` where `sgdisk` is installed). One addition to the
text below: after `sgdisk`, partition 5 is read back from the table rather
than trusting `sgdisk`'s exit code, since on the running boot drive it may
report that the kernel kept the old table even though it wrote the new one.

Owner's decisions (Nov 19):
- the vault stays at 900 MB on every drive; all unused space goes to the
  Transfer Drive;
- it happens automatically at first setup, with a line in the progress
  window (no question);
- the threshold is 1 GB of unused space;
- no Part 2: drives already set up aren't grown (a re-flash and first
  setup do it).

## The idea

SafeKeep's image is sized for the smallest 8 GB flash drives: 7.3 GB, with a
2.5 GB Transfer Drive. Written to a larger drive, the rest of the drive is
left unused, and no computer shows it. Most people now buy 16, 32 or 64 GB
flash drives, so most of their drive is wasted.

This grows the **Transfer Drive to fill the flash drive**. A Mac or PC then
shows one TRANSFER drive of nearly the whole drive's size, for update files,
Encrypted Backups, exported documents and anything else. It was chosen over
a separate STORAGE partition (discussed Nov 19): a general-purpose drive
would invite plugging the SafeKeep drive into everyday computers more often,
while a bigger Transfer Drive serves what the drive already does.

## When: at first setup, on a fresh drive

The flash drive is grown during **first setup**, before the vault is
created. That is the one moment it's certain the Transfer Drive is empty and
nothing on the drive is in use beyond the running system. It covers every
way of writing the image (balenaEtcher, Rufus, `dd`, `flash-new-stick.sh`),
since none of them can be relied on to do it.

It happens on its own, with one line in the setup progress window, for
example "Using the rest of this 64 GB flash drive for the Transfer Drive…",
when all of these hold:
- the drive has at least **1 GB** unused after the Transfer Drive;
- the Transfer Drive has **no files** (system folders that a Mac or Windows
  adds on their own, such as `.Spotlight-V100`, `.fseventsd`, `.Trashes`
  and `System Volume Information`, don't count). Someone who copied an
  Encrypted Backup onto it before first boot, to restore it, keeps it: the
  drive is left as it is, and setup says so in the log;
- the checks in "Safety" below pass.

If anything fails, setup carries on with the drive as it was. Growing the
Transfer Drive never stops a vault from being created.

## How

A small root helper, `usbbootdrive/grow-transfer.sh`, run by
`setup-vault.sh` just before the vault is created:

1. **Find the boot drive from what's mounted, never by label.** The data
   partition setup mounts (`safekeep-data`) gives the disk (`lsblk -no
   PKNAME`). On that disk, partition 3 must be labeled `safekeep-os`,
   partition 4 `safekeep-data` and partition 5 `TRANSFER` (exFAT, GPT type
   0700), and partition 5 must be the last partition. Otherwise: stop. This
   matters because the boot script finds the Transfer Drive by its label,
   and with two SafeKeep drives plugged in, `blkid -L TRANSFER` could name
   the other one.
2. **Measure the unused space** after partition 5 (the disk's size against
   the end of partition 5). Less than 1 GB: stop, nothing to do.
3. **Check partition 5 is empty**, with it mounted read-only somewhere
   private; then unmount it (and make sure nothing has it mounted).
4. **Rewrite only the GPT's last entry.** `sgdisk -e` moves the backup GPT
   header to the real end of the drive (the image put it at 7.3 GB). Then
   partition 5 is deleted and created again with the same start, the same
   partition GUID, type and name, ending at the end of the drive. Partitions
   1 to 4 aren't touched.
5. **Tell the kernel about the new size of partition 5 only**
   (`partx -u -n 5`), which works while partitions 3 and 4 are in use.
6. **Make a new exFAT file system** on it, labeled `TRANSFER`. The tools in
   the image can't resize exFAT in place, which is why this is only done
   while it's empty.
7. **Check:** the label, the size, and that it mounts.

**If it stops halfway**, the drive still works. Up to step 4 nothing has
changed. After step 4, the old, smaller exFAT is still valid inside the
bigger partition, so the Transfer Drive still mounts at 2.5 GB, and a log
line says the growth didn't finish.

The tools (`sgdisk`, `partx`, `mkfs.exfat`, `lsblk`) are already in the
image and protected from the hardening step's clean-up.

## What doesn't change

- **Updates.** The `.tar` updater and `quick-update.sh` write only the OS
  partition, so the Transfer Drive keeps its full size, and its files,
  through every update. A full re-flash lays the drive out again at 2.5 GB,
  and the next first setup grows it again.
- **Everything else on the drive:** the boot partitions, both OS slots, the
  vault, and how SafeKeep finds and mounts the Transfer Drive (by its label).
- **8 GB drives:** less than 1 GB is left over, so nothing happens.

## The vault's size on a large drive

This is the one choice to make first. The vault (partition 4) sits before
the Transfer Drive. At the same moment in first setup, before the vault file
exists, the vault partition could also grow (ext4 can be grown in place),
with the Transfer Drive moved to start after it. After first setup, with the
Transfer Drive filling the drive, the vault can't grow in place any more.

**Decided: keep the vault at 900 MB and give all the rest to the Transfer
Drive.** A bigger vault runs into two limits that are about the
rest of SafeKeep, not the drive:
- **An Encrypted Backup** has to fit on the Transfer Drive. With the
  Transfer Drive filling a large drive this stops being a limit, but it
  still is on 8 GB drives, which keep the same vault size.
- **Restoring a backup** unpacks it in memory (`/tmp/reliquary`). A 4 GB
  vault would need more than 4 GB of free memory to restore, which many
  laptops don't have.

About 750 MB of usable vault holds a great many documents at up to 100 MB
each. If a bigger vault is wanted later, the restore should first unpack to
disk instead of memory; then a design for "vault up to N GB on large
drives" can follow, done at the same first-setup moment.

## Not planned: drives already set up (was Part 2)

Decided against on Nov 19. What it would have been:

**Device Options → Transfer Drive → Use the rest of this flash drive**, shown
only when there is at least 1 GB unused and the Transfer Drive has no files.
Since the running session uses the Transfer Drive, it's done at the next
restart, before the Transfer Drive is mounted: the button sets a request,
the boot script runs the same helper, and the request is dropped either way.
This lets people with drives set up before this release use their space
after moving files off the Transfer Drive.

## Tests

- **The helper on disk images** (no real drive): an 8 GB image written into a
  sparse 16 GB file and set up on a loop device. Check:
  - partition 5 ends at the end of the disk, and the backup GPT has moved;
  - partitions 1 to 4 are byte for byte unchanged;
  - exFAT labeled `TRANSFER` fills it;
  - a second run does nothing.
- **Refusals:**
  - files on the Transfer Drive, while Mac/Windows system folders alone
    don't count;
  - less than 1 GB unused;
  - wrong labels, or partition 5 not last;
  - a disk that isn't the one holding the mounted data partition.
- **Halfway failures:** a failure after the partition change still leaves a
  mountable 2.5 GB Transfer Drive.
- **Wiring:** `setup-vault.sh` runs it before creating the vault and carries
  on whatever it returns.
- **On real drives:**
  - a 16 GB and a 64 GB flash drive, written with balenaEtcher;
  - first setup, then a Mac and Windows both showing one large TRANSFER;
  - a `.tar` update afterwards, with the size kept;
  - an 8 GB drive unchanged.

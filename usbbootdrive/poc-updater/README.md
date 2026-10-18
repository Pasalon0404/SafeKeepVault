# Updater proof of concept: two OS slots

This tests the riskiest part of [UPDATER_DESIGN.md](../../UPDATER_DESIGN.md):
writing a new OS onto the stick while SafeKeep is running from it, and
switching to it safely. There are no signatures or update files yet; the
"new" OS is just a copy of the running one.

**Use a spare stick.** The test changes how the stick boots. Your own stick
and its vault are never touched.

## What you need

- A spare USB stick of 8 GB or more.
- The ZBook, with this branch rsynced to `/home/safekeep-build` (the usual
  `usbbootdrive/` rsync from the Mac; this folder comes with it).

## 1. Build a developer image (ZBook)

The test needs a Terminal on the stick, which only a developer build has.

```sh
cd /home/safekeep-build
sudo SAFEKEEP_DEV_SHELL=1 bash build.sh
```

The build shows a "DEVELOPER BUILD" banner. That's expected here.

> **Afterwards, before you quick-update your own stick again**, run a normal
> `sudo bash build.sh`. A quick update reuses the last build's OS, and that
> would otherwise put the Terminal on your own stick.

Flash the spare stick with it. Check the device name first with `lsblk`:

```sh
sudo dd if=safekeep.img of=/dev/sdX bs=4M status=progress conv=fsync
```

Boot the stick once, set up a test vault (a throwaway password and seed),
then shut down.

## 2. Convert the stick to two slots (ZBook)

Plug the spare stick into the ZBook again:

```sh
cd /home/safekeep-build
lsblk -o NAME,SIZE,MODEL,LABEL
sudo bash poc-updater/ab-convert.sh --usb /dev/sdX
```

It shows the OS size and the free space. **Send me that output.** It tells
us whether two copies of the OS fit.

It also copies `ab-slot-test.sh` onto the stick's Transfer Drive.

## 3. Tests on the stick

Boot the spare stick, unlock the test vault, and press **Ctrl+Alt+T** for a
Terminal. Then go to the Transfer Drive:

```sh
ls /media
cd /media/safekeep-transfer      # or whichever folder `ls` shows for the Transfer Drive
bash ab-slot-test.sh status
```

`status` should say **Running slot: a**.

| Test | Commands | What should happen |
|---|---|---|
| A. Write the idle slot | `bash ab-slot-test.sh copy` | It says "Slot b written and checked", with the time taken. **This is the key test.** If it fails to remount read-write, send the output. |
| B. Switch | `bash ab-slot-test.sh switch`, then reboot, then `bash ab-slot-test.sh status` | Running slot: **b**. The GRUB menu, during its 3 seconds, also shows "previous version, slot a". |
| C. The app still works | Use SafeKeep normally on slot b | Unlocking, the dashboard and the PSBT Signer all behave as before. |
| D. Power cut while writing | `bash ab-slot-test.sh copy`, then pull the stick out about halfway through. The computer will freeze, since it's running from the stick: hold the power button to turn it off, put the stick back and boot. | It boots slot **b** normally. `status` shows slot a missing or incomplete. Run `copy` again to finish it. |
| E. Fallback | `bash ab-slot-test.sh fallback-test`, then reboot, then `status` | It boots the slot that has a kernel, even though `slot.cfg` names the other one. There's no "previous version" entry. Then run `bash ab-slot-test.sh fallback-undo`. |
| F. Both boot modes | Repeat B on a computer that boots in legacy BIOS mode, if you have one | Same result. UEFI and BIOS each have their own copy of the GRUB config. |

Send me the output of each test, especially A, and any errors.

## When you're done

Flash the spare stick again, or keep it for the next round. Then run a
normal `sudo bash build.sh` on the ZBook before your next quick update.

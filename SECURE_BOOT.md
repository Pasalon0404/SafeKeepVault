# Secure Boot: Ubuntu's signed boot chain on the stick

Status: **on branch `claude/secure-boot`, tested in QEMU, not yet on real
hardware, not merged.** See "Hardware checklist" below.

## Why

The stick used to carry an unsigned GRUB (`grub-mkstandalone`), so every
computer needed Secure Boot turned off first. That is friction for everyone,
impossible on many locked work laptops, and on Windows PCs with BitLocker
turning it off can trigger a recovery-key prompt the next time Windows starts.

What Secure Boot checks here is only the boot loader and the kernel. It does
not check the rest of the system on the stick (the squashfs, the app). So this
is mainly a usability change: the stick starts on more computers without
changing their settings. It is not a large security gain, and the docs should
not present it as one.

## What the stick carries now (UEFI)

| File on the EFI partition | What it is | Signed by |
|---|---|---|
| `EFI/BOOT/BOOTX64.EFI` | shim 15.8 (`shimx64.efi.signed.latest`) | Microsoft Corporation UEFI CA 2011 |
| `EFI/BOOT/grubx64.efi` | GRUB 2.12 (`grubx64.efi.signed`) | Canonical Ltd. Secure Boot Signing (2022 v1) |
| `EFI/BOOT/mmx64.efi` | MokManager; shim shows it if a check fails | Canonical (2022 v1) |
| `EFI/ubuntu/grub.cfg` | our `grub.cfg`, unchanged | — |
| `casper-a/vmlinuz` (OS partition) | Ubuntu's `linux-image-generic` kernel | Canonical (2022 v1) |

The firmware trusts Microsoft and starts shim; shim carries Canonical's key and
checks GRUB; GRUB asks shim to check the kernel. The initrd and the squashfs are
not checked by Secure Boot (that is how Ubuntu's own live USB works too).

- **Where the signed GRUB reads its config.** Its built-in prefix is
  `/EFI/ubuntu` (the string is in the binary), on the partition it started
  from, and it reads `<prefix>/grub.cfg`. Tested: config in `EFI/ubuntu/`
  boots; config only in `EFI/BOOT/` (next to the binary) also boots, through
  Ubuntu's fallback; no config at all stops at a `grub>` prompt. The build
  writes `EFI/ubuntu/grub.cfg`.
- **Modules.** The signed GRUB loads no modules from disk with Secure Boot
  on; everything is built in. Everything `grub.cfg` uses works under it
  (tested with the real `grub.cfg`): `search --label`, `source`, `test -f`,
  `configfile`, `linux`/`initrd`, menus. Its `insmod` lines are harmless.
- **Left out on purpose: `fbx64.efi`** (shim's "fallback"). On an installed
  system it repairs boot entries; on a stick it would add a boot entry to
  every computer the stick starts on.
- **BIOS / legacy** is unchanged: `grub-install --target=i386-pc` reading
  `boot/grub/grub.cfg` on the EFI partition.

### Pins (`build.sh`, top: "Ubuntu's signed UEFI boot chain, pinned")

| Package | Version | `.deb` SHA-256 |
|---|---|---|
| `shim-signed` | 1.58+15.8-0ubuntu1 (noble) | `ba9b5d80e5d886c30664f2bebfb5c2fcce3b9b40f16fc46cba49c19a91c8059c` |
| `grub-efi-amd64-signed` | 1.202.5+2.12-1ubuntu7.3 (noble-updates) | `8bd5cd99c3af82aab23af0f15f54c91799f343416412e122df661ef36a44a511` |

The EFI files inside them (the build prints these):

```
6fe6e1bcbe6cf6baec8e056d40361ca1aa715cc04ddcc2855351de060b84350b  BOOT/BOOTX64.EFI   (shim)
a831af01e4fb5e3c9457120e1d08ea13d98a0a47b62728c284b7f502d535965c  BOOT/grubx64.efi
d2fa8e52fddc99dad94a0009fee23cb2478c28373b777d50b2f784eb4e96f88e  BOOT/mmx64.efi
```

The build fetches both `.deb`s right after its dependency check (from
`archive.ubuntu.com`'s pool, falling back to Launchpad, which keeps every
version), checks the SHA-256 and stops on any other file. The kernel itself
is not pinned by this change: it comes from `linux-image-generic` as before.

## Secure Boot "lockdown" and what the stick does

With Secure Boot on, Ubuntu's kernel runs in lockdown mode **integrity**
(tested: `secureboot: Secure boot enabled`, `Kernel is locked down from EFI
Secure Boot mode`). In that mode it refuses unsigned kernel modules, `/dev/mem`
and raw I/O ports, unsigned kexec and hibernation. Going through what the stick
uses:

| Area | Under lockdown |
|---|---|
| Ubuntu's own kernel modules (USB, HID, sound, graphics, cameras, exFAT…) | load: all signed by Canonical. Tested with exFAT (the Transfer Drive). |
| Network / storage / Bluetooth driver removal (`safekeep-harden.sh`) | unaffected: deleting and blacklisting modules is not restricted |
| `options usbhid quirks=…` | allowed (lockdown only blocks hardware-address parameters) |
| Coldcard / Trezor over USB | userspace (hidraw / libusb); unaffected |
| Audio (ALSA, `amixer`) | unaffected |
| Hibernation, `/dev/mem`, I/O ports, kexec | the stick uses none of them (checked the OS scripts) |
| **`facetimehd`** (DKMS, built during the build) | **refused**: it is not signed by a key the kernel trusts. Only 2015–2017 MacBook Pros have that camera, and those Macs have no Secure Boot, so it still loads where it is needed. On a PC with Secure Boot on, the attempt just logs an error. |
| Safe Mode boot entry (`nomodeset`) | Xorg's VESA driver needs raw I/O ports, which lockdown blocks; the framebuffer driver should take over. **To check on hardware.** |

Tested in QEMU: an unsigned copy of the exFAT module is refused ("Loading of
unsigned module is rejected"), the signed one loads; with Secure Boot off both
load.

## shim writes `SbatLevel` to the computer

Every time shim runs (with Secure Boot on or off), it records its revocation
list in the computer's firmware if the stored one is older:
`sbat,1,2023012900 / shim,2 / grub,3 / grub.debian,4` (tested). From then on,
that computer refuses boot media with GRUB older than early 2023 when Secure
Boot is on. Windows Update has applied the same kind of list since 2024. The
stick changes no other firmware setting and adds no boot entry.

## Microsoft's certificates: 2011 and 2023

- **Every shim Ubuntu ships today is signed only with "Microsoft Corporation
  UEFI CA 2011"**: checked `shim-signed` 1.58 (24.04) and 1.59 (the newest in
  the archive, Oct 27, 2026). None carries a 2023 signature yet.
- **That CA's expiry does not stop it booting.** UEFI firmware does not check
  certificate dates (it has no trusted clock); what counts is whether the
  certificate is in the firmware's allowed list (`db`) and not revoked (`dbx`).
  The expiry means Microsoft signs nothing new with it.
- **PCs that trust the 2011 third-party CA** — most PCs sold 2012–2025 — boot
  the stick with Secure Boot on (tested in QEMU with Microsoft's keys).
- **Computers that don't trust it refuse the stick** (tested: the firmware
  answers "Access Denied" before shim starts):
  - new PCs whose firmware trusts only Microsoft's 2023 CAs;
  - "Secured-core" PCs that ship with Microsoft's third-party CA switched off
    (some have a firmware option like "Allow Microsoft 3rd Party UEFI CA");
  - **Intel Macs with the T2 chip** at the default Medium Security, which
    trust only Microsoft's Windows certificate. They need Startup Security
    Utility → "No Security", as before.
  These still need Secure Boot turned off (or the third-party CA allowed).
- **When Ubuntu ships a shim signed with the 2023 CA** (alone or dual-signed),
  move the pin; dual-signed would work on both kinds of computer.
- Macs without T2 (2017 and older) have no Secure Boot; shim simply starts GRUB.

## Existing sticks

Updates (`quick-update.sh`, the in-app updater) write only the OS partition,
never the EFI partition, so sticks flashed before this change keep the unsigned
boot loader. They still need Secure Boot off until they are reflashed.

## Testing

`usbbootdrive/tests/secure-boot/run-all.sh` builds small images with the
stick's layout and `build.sh`'s pinned files, boots them as a USB stick in QEMU
(OVMF with Microsoft's keys, OVMF without keys, SeaBIOS) and checks: boot with
Secure Boot on/off and on legacy BIOS; slot A, slot B and the fallback when
`slot.cfg` names a missing slot; where the config is read; the kernel's
lockdown state; unsigned vs signed modules; refusal on firmware without the
third-party CA; the `SbatLevel` write. It uses its own small initramfs, not
SafeKeep's, so it stops at "the kernel is running"; the full system is for the
hardware checklist.

### Hardware checklist (not done yet)

1. A recent PC with Secure Boot **on**: stick boots, vault unlocks, Transfer
   Drive mounts, a QR scan, a print, Coldcard/Trezor if at hand, sound.
   Then Windows starts normally afterwards (no BitLocker prompt).
2. The same or another PC with Secure Boot **off**: as before.
3. A legacy-BIOS machine (or CSM mode): as before.
4. Safe Mode boot entry with Secure Boot on: the desktop appears.
5. An Intel Mac (non-T2): Option → SafeKeep starts. A T2 Mac at Medium
   Security: expect refusal; at No Security: starts.

## Updating the signed boot files

1. Pick the new `shim-signed` / `grub-efi-amd64-signed` versions for 24.04
   (`apt-cache madison`), download the `.deb`s, note their SHA-256.
2. Change the four values in `build.sh` (`SHIM_DEB…`, `SIGNED_GRUB_DEB…`).
3. Run `usbbootdrive/tests/secure-boot/run-all.sh` on an Ubuntu 24.04 machine.
4. Full build, then the hardware checklist on at least one Secure Boot PC.

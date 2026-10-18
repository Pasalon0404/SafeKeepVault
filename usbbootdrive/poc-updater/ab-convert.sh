#!/bin/bash
# =====================================================================
#  ab-convert.sh — updater proof of concept, step 1 (run on the ZBook)
# =====================================================================
#
#  Converts a flashed SafeKeep stick to the two-slot layout from
#  UPDATER_DESIGN.md, so ab-slot-test.sh can then be tried on it:
#     casper/  →  casper-a/       (the OS that was on the stick)
#     slot.cfg    "set slot=a"
#     GRUB        grub-ab.cfg, for BIOS (EFI partition /boot/grub/grub.cfg)
#                 and UEFI (rebuilt EFI/BOOT/BOOTX64.EFI, which carries
#                 its own copy of grub.cfg)
#  It also copies ab-slot-test.sh onto the transfer drive (partition 5).
#  The vault (partition 4) is not touched.
#
#  FOR A SPARE TEST STICK ONLY. To undo, flash the stick again.
#
#  Usage (from /home/safekeep-build):
#     sudo bash poc-updater/ab-convert.sh --usb /dev/sdb
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GRUB_CFG="$HERE/grub-ab.cfg"
MNT_OS="workspace/mnt-ab-os"
MNT_EFI="workspace/mnt-ab-efi"
MNT_TR="workspace/mnt-ab-transfer"

die() { echo ""; echo "ERROR: $*" >&2; exit 1; }

TARGET_USB=""
if [ "${1:-}" = "--usb" ]; then
    TARGET_USB="${2:-}"
fi
[ -n "$TARGET_USB" ] || die "Usage: sudo bash poc-updater/ab-convert.sh --usb /dev/sdX"
[ "$(id -u)" -eq 0 ] || die "run with sudo."
[ -f build.sh ] || die "run this from the build folder (the one containing build.sh)."
[ -f "$GRUB_CFG" ] || die "$GRUB_CFG is missing."
command -v grub-mkstandalone >/dev/null || die "grub-mkstandalone is missing (it comes with the full build's tools)."

# --- Same USB target checks as quick-update.sh ---
[ -b "$TARGET_USB" ] || die "$TARGET_USB is not a block device."
DISK=$(lsblk -no PKNAME "$TARGET_USB" 2>/dev/null | head -1)
[ -z "$DISK" ] || die "$TARGET_USB is a partition — give the whole device, e.g. /dev/sdb (not /dev/sdb3)."
TRAN=$(lsblk -dno TRAN "$TARGET_USB" 2>/dev/null | tr -d ' ')
[ "$TRAN" = "usb" ] || die "$TARGET_USB is not a USB device (transport='$TRAN'). Refusing, to protect internal disks."
ROOTDISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE / 2>/dev/null)" 2>/dev/null | head -1 || true)
[ "/dev/$ROOTDISK" != "$TARGET_USB" ] || die "$TARGET_USB holds this computer's root filesystem. Refusing."
case "$TARGET_USB" in *[0-9]) P=p ;; *) P="" ;; esac
EFI_PART="${TARGET_USB}${P}2"
OS_PART="${TARGET_USB}${P}3"
[ "$(lsblk -no LABEL "$EFI_PART" 2>/dev/null)" = "SK-EFI" ] \
    || die "$EFI_PART is not labeled 'SK-EFI' — this does not look like a SafeKeep stick."
[ "$(lsblk -no LABEL "$OS_PART" 2>/dev/null)" = "safekeep-os" ] \
    || die "$OS_PART is not labeled 'safekeep-os' — this does not look like a SafeKeep stick."
[ "$(lsblk -no LABEL "${TARGET_USB}${P}4" 2>/dev/null)" = "safekeep-data" ] \
    || die "${TARGET_USB}${P}4 is not labeled 'safekeep-data' — unexpected layout. Refusing."

echo ""
lsblk -o NAME,SIZE,MODEL,TRAN,LABEL "$TARGET_USB"
echo ""
echo "Will convert the OS partition ($OS_PART) and boot loader ($EFI_PART)"
echo "to the two-slot layout. THIS IS A TEST: use a spare stick."
read -r -p "Type YES to continue: " ok
[ "$ok" = "YES" ] || die "canceled."

for p in $(lsblk -lno NAME "$TARGET_USB" | tail -n +2); do umount "/dev/$p" 2>/dev/null || true; done
mkdir -p "$MNT_OS" "$MNT_EFI" "$MNT_TR"
cleanup() { for m in "$MNT_OS" "$MNT_EFI" "$MNT_TR"; do umount "$m" 2>/dev/null || true; done; }
trap cleanup EXIT
mount "$OS_PART" "$MNT_OS"
mount "$EFI_PART" "$MNT_EFI"

[ ! -e "$MNT_OS/casper-a" ] || die "this stick already has casper-a/ — it is already converted."
[ -f "$MNT_OS/casper/vmlinuz" ] && [ -f "$MNT_OS/casper/filesystem.squashfs" ] \
    || die "no complete casper/ folder on the OS partition."

NEED_KB=$(du -sk "$MNT_OS/casper" | awk '{print $1}')
FREE_KB=$(df -Pk "$MNT_OS" | awk 'NR==2 {print $4}')
echo ""
echo "OS size: $(( NEED_KB / 1024 )) MB   free on the OS partition: $(( FREE_KB / 1024 )) MB"
[ "$FREE_KB" -gt $(( NEED_KB + 51200 )) ] \
    || die "not enough room for two copies of the OS. This is the main thing the test is meant to find out: please send this output."

echo ""
echo "[1/3] Copying casper/ to casper-a/ ..."
rm -rf "$MNT_OS/.casper-a.new"
cp -a "$MNT_OS/casper" "$MNT_OS/.casper-a.new"
sync
(cd "$MNT_OS/casper" && sha256sum filesystem.squashfs vmlinuz initrd) > /tmp/ab-src.sha
(cd "$MNT_OS/.casper-a.new" && sha256sum -c --quiet /tmp/ab-src.sha) || die "the copy does not match the original."
mv "$MNT_OS/.casper-a.new" "$MNT_OS/casper-a"
printf 'set slot=a\n' > "$MNT_OS/.slot.cfg.new"
sync
mv -f "$MNT_OS/.slot.cfg.new" "$MNT_OS/slot.cfg"
sync

echo "[2/3] Installing the two-slot GRUB config ..."
cp -n "$MNT_EFI/boot/grub/grub.cfg" "$MNT_EFI/boot/grub/grub.cfg.pre-ab" 2>/dev/null || true
cp -n "$MNT_EFI/EFI/BOOT/BOOTX64.EFI" "$MNT_EFI/EFI/BOOT/BOOTX64.EFI.pre-ab" 2>/dev/null || true
cp "$GRUB_CFG" "$MNT_EFI/boot/grub/grub.cfg"
mkdir -p "$MNT_OS/boot/grub"
cp "$GRUB_CFG" "$MNT_OS/boot/grub/grub.cfg"
grub-mkstandalone \
    --format=x86_64-efi \
    --output="$MNT_EFI/EFI/BOOT/BOOTX64.EFI" \
    --locales="" \
    --fonts="" \
    --modules="part_gpt ext2 fat search search_label normal linux gzio test configfile" \
    "boot/grub/grub.cfg=$GRUB_CFG"
sync

echo "[3/3] Removing the old casper/ folder ..."
rm -rf "$MNT_OS/casper"
sync

TR_PART="${TARGET_USB}${P}5"
if [ "$(lsblk -no LABEL "$TR_PART" 2>/dev/null)" = "TRANSFER" ] && mount "$TR_PART" "$MNT_TR"; then
    cp "$HERE/ab-slot-test.sh" "$MNT_TR/ab-slot-test.sh"
    sync
    umount "$MNT_TR"
    echo "      Copied ab-slot-test.sh to the transfer drive."
else
    echo "      WARNING: could not copy ab-slot-test.sh to the transfer drive ($TR_PART)."
fi

echo ""
echo "OS partition now holds:"
ls -la "$MNT_OS"
df -h "$MNT_OS" | tail -1
echo ""
echo "Done. Boot the stick: it should start normally from slot A."
echo "Then follow poc-updater/README.md, step 3."

#!/bin/bash
# Build a small disk image with the SafeKeep stick's partition layout and
# boot files placed as build.sh places them, for booting in QEMU.
#   make-test-image.sh <out.img> <slot.cfg: a|b> <casper slots: a|b|ab> [grub.cfg place: ubuntu|boot|both|none]
# Needs no mounts: FAT via mtools, ext4 via mkfs.ext4 -d.
set -euo pipefail
OUT=$1; SLOT=$2; SLOTS=$3; PLACE=${4:-ubuntu}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
CACHE=${SB_TEST_CACHE:-$HERE/.cache}
source "$CACHE/signed.env"             # SHIM_EFI, GRUB_EFI, MM_EFI from build.sh's pins
K=$CACHE/k
KVER=$(ls $K/lib/modules)
export MTOOLS_SKIP_CHECK=1

rm -f "$OUT"; truncate -s 400M "$OUT"
sgdisk -Z "$OUT" >/dev/null
sgdisk -n 1:2048:+2M -t 1:EF02 -c 1:"BIOS Boot"     "$OUT" >/dev/null
sgdisk -n 2:0:+64M   -t 2:EF00 -c 2:"EFI System"    "$OUT" >/dev/null
sgdisk -n 3:0:+200M  -t 3:8300 -c 3:"safekeep-os"   "$OUT" >/dev/null
sgdisk -n 4:0:+16M   -t 4:8300 -c 4:"safekeep-data" "$OUT" >/dev/null
sgdisk -n 5:0:0      -t 5:0700 -c 5:"TRANSFER"      "$OUT" >/dev/null
part() { sgdisk -i "$1" "$OUT" | awk -v w="$2" '$0 ~ w {print $3}'; }
first() { part "$1" "First sector"; }
nsec()  { echo $(( $(part "$1" "Last sector") - $(first "$1") + 1 )); }
put()   { dd if="$1" of="$OUT" bs=512 seek="$(first "$2")" conv=notrunc status=none; }

# The real grub.cfg, with the kernel console on the serial port so QEMU
# shows it (test only).
sed 's/ ---$/ console=ttyS0 ---/' "$REPO/grub.cfg" > /tmp/sk-grub.cfg

# --- EFI system partition (FAT32, label SK-EFI) ---
ESP=$(mktemp); truncate -s $(( $(nsec 2) * 512 )) "$ESP"
mkfs.fat -F 32 -n SK-EFI "$ESP" >/dev/null
mmd -i "$ESP" ::/EFI ::/EFI/BOOT ::/boot ::/boot/grub ::/boot/grub/i386-pc
mcopy -i "$ESP" "$SHIM_EFI" ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "$ESP" "$GRUB_EFI" ::/EFI/BOOT/grubx64.efi
mcopy -i "$ESP" "$MM_EFI"   ::/EFI/BOOT/mmx64.efi
case "$PLACE" in
  ubuntu) mmd -i "$ESP" ::/EFI/ubuntu; mcopy -i "$ESP" /tmp/sk-grub.cfg ::/EFI/ubuntu/grub.cfg ;;
  boot)   mcopy -i "$ESP" /tmp/sk-grub.cfg ::/EFI/BOOT/grub.cfg ;;
  both)   mmd -i "$ESP" ::/EFI/ubuntu; mcopy -i "$ESP" /tmp/sk-grub.cfg ::/EFI/ubuntu/grub.cfg
          mcopy -i "$ESP" /tmp/sk-grub.cfg ::/EFI/BOOT/grub.cfg ;;
  none)   ;;
esac
mcopy -i "$ESP" /tmp/sk-grub.cfg ::/boot/grub/grub.cfg     # the BIOS GRUB reads this one
mcopy -i "$ESP" "$REPO/.disk_label" "$REPO/.disk_label_2x" ::/EFI/BOOT/
printf 'SafeKeep' > /tmp/sk-cd; mcopy -i "$ESP" /tmp/sk-cd ::/EFI/BOOT/.contentDetails
mcopy -i "$ESP" /usr/lib/grub/i386-pc/*.mod /usr/lib/grub/i386-pc/*.lst ::/boot/grub/i386-pc/
ESP_SERIAL=$(blkid -o value -s UUID "$ESP")
put "$ESP" 2; rm -f "$ESP"

# --- OS partition (ext4, label safekeep-os): casper slots + slot.cfg ---
INITDIR=$(mktemp -d)
mkdir -p $INITDIR/bin $INITDIR/proc $INITDIR/sys $INITDIR/dev $INITDIR/m
cp "$CACHE/bb/usr/bin/busybox" $INITDIR/bin/busybox; cp "$CACHE/kmod-load" $INITDIR/bin/kmod-load
for a in sh cat mount insmod rmmod echo poweroff dmesg grep hexdump awk sed wc tail; do ln -s busybox $INITDIR/bin/$a; done
zstd -dq "$K/lib/modules/$KVER/kernel/fs/exfat/exfat.ko.zst" -o $INITDIR/m/exfat.ko
objcopy --strip-debug $INITDIR/m/exfat.ko $INITDIR/m/exfat-unsigned.ko   # drops the appended signature
cp "$HERE/init.sh" $INITDIR/init; chmod +x $INITDIR/init
INITRD=$(mktemp); (cd $INITDIR && find . | cpio -o -H newc 2>/dev/null | gzip -1) > "$INITRD"
ROOT=$(mktemp -d)
for s in $(echo "$SLOTS" | fold -w1); do
  mkdir -p "$ROOT/casper-$s"
  cp "$K/boot/vmlinuz-$KVER" "$ROOT/casper-$s/vmlinuz"
  cp "$INITRD" "$ROOT/casper-$s/initrd"
done
printf 'set slot=%s\n' "$SLOT" > "$ROOT/slot.cfg"
mkdir -p "$ROOT/boot/grub"; cp /tmp/sk-grub.cfg "$ROOT/boot/grub/grub.cfg"
OSIMG=$(mktemp); truncate -s $(( $(nsec 3) * 512 )) "$OSIMG"
mkfs.ext4 -q -F -L safekeep-os -d "$ROOT" "$OSIMG"
put "$OSIMG" 3; rm -rf "$OSIMG" "$ROOT" "$INITDIR" "$INITRD"

# --- Legacy BIOS GRUB: what build.sh's grub-install does, in two steps ---
# core.img searches for the EFI partition by its FAT serial number (as
# grub-install embeds it) and reads boot/grub/grub.cfg there.
printf 'search --no-floppy --fs-uuid --set=root %s\nset prefix=($root)/boot/grub\n' "$ESP_SERIAL" > /tmp/sk-early.cfg
grub-mkimage -O i386-pc -o /tmp/sk-core.img -c /tmp/sk-early.cfg -p /boot/grub \
    biosdisk part_gpt fat search search_fs_uuid ext2 normal linux gzio test configfile search_label
python3 "$HERE/bios-install.py" "$OUT" "$(first 1)"
echo "built $OUT (slot.cfg=$SLOT, slots=$SLOTS, grub.cfg in $PLACE)"

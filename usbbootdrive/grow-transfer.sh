#!/bin/bash
# =====================================================================
#  grow-transfer.sh — make the Transfer Drive fill a larger flash drive
# =====================================================================
#  TRANSFER_DRIVE_DESIGN.md. Run as root by setup-vault.sh at first setup,
#  just before the vault is created, while the Transfer Drive is still
#  empty. The image is laid out for 8 GB flash drives; on a larger drive
#  the rest is unused. This moves the GPT's backup header to the real end
#  of the drive, makes partition 5 (TRANSFER) end there, and puts a new
#  exFAT on it. Partitions 1 to 4 are never touched.
#
#  Usage
#     grow-transfer.sh --check DATA_PART   can it grow? prints the drive's
#                                          size in GB and exits 0 if so
#     grow-transfer.sh DATA_PART           grow it
#  DATA_PART is the data partition setup is using (label safekeep-data):
#  the boot drive is found from it, never from the TRANSFER label, which a
#  second SafeKeep drive plugged in would also have.
#
#  Exit codes: 0 grown (or, with --check, can grow); 1 nothing to do or not
#  safe to (the reason is printed); 2 it started but didn't finish (the
#  drive still works: the old, smaller exFAT is still valid).
# =====================================================================
set -uo pipefail

MIN_FREE=$((1024 * 1024 * 1024))     # 1 GB unused, or nothing is done
EXFAT_TYPE="EBD0A0A2-B9E5-4433-87C0-68B6B72699C7"   # GPT 0700, basic data

# Tests (usbbootdrive/tests/test-grow-transfer.py) run this on disk image
# files in a folder of their own instead of /dev; there, plain files stand
# in for the devices.
DEV_DIR="${GROW_TRANSFER_DEV_DIR:-/dev}"
is_dev() { if [ "$DEV_DIR" = /dev ]; then [ -b "$1" ]; else [ -e "$1" ]; fi; }

say() { echo "grow-transfer: $*"; }
no() { say "$*"; exit 1; }

CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then CHECK_ONLY=1; shift; fi
DATA_PART="${1:-}"
[ -n "$DATA_PART" ] && is_dev "$DATA_PART" || no "usage: grow-transfer.sh [--check] DATA_PART"

# ---- The boot drive, and its partitions ----
PARENT=$(lsblk -no PKNAME "$DATA_PART" 2>/dev/null | head -1)
[ -n "$PARENT" ] || no "can't tell which drive $DATA_PART is on"
DISK="$DEV_DIR/$PARENT"
is_dev "$DISK" || no "$DISK isn't a block device"
case "$DISK" in
    *[0-9]) PART_PREFIX="${DISK}p" ;;    # nvme0n1p5, mmcblk0p5
    *)      PART_PREFIX="$DISK" ;;       # sdb5
esac
part() { echo "${PART_PREFIX}$1"; }

[ "$DATA_PART" = "$(part 4)" ] || no "$DATA_PART isn't partition 4 of $DISK"
label() { lsblk -no LABEL "$1" 2>/dev/null | head -1; }
[ "$(label "$(part 3)")" = "safekeep-os" ] || no "partition 3 of $DISK isn't safekeep-os"
[ "$(label "$(part 4)")" = "safekeep-data" ] || no "partition 4 of $DISK isn't safekeep-data"
[ "$(label "$(part 5)")" = "TRANSFER" ] || no "partition 5 of $DISK isn't TRANSFER"
[ "$(lsblk -no FSTYPE "$(part 5)" 2>/dev/null | head -1)" = "exfat" ] || no "partition 5 of $DISK isn't exFAT"
# The running system's OS comes from partition 3 of this drive.
[ -n "$(findmnt -rno TARGET -S "$(part 3)" 2>/dev/null | head -1)" ] || no "$DISK isn't the drive SafeKeep is running from"

# ---- Partition 5: last, the right type, and where it ends ----
LAST_NUM=$(sgdisk -p "$DISK" 2>/dev/null | awk '/^ *[0-9]+ +[0-9]+ +[0-9]+/ {n=$1} END {print n}')
[ "$LAST_NUM" = "5" ] || no "partition 5 isn't the last partition on $DISK"
INFO=$(sgdisk -i 5 "$DISK" 2>/dev/null) || no "can't read partition 5 of $DISK"
P5_FIRST=$(sed -n 's/^First sector: \([0-9]*\).*/\1/p' <<<"$INFO")
P5_LAST=$(sed -n 's/^Last sector: \([0-9]*\).*/\1/p' <<<"$INFO")
P5_GUID=$(sed -n 's/^Partition unique GUID: \([0-9A-Fa-f-]*\).*/\1/p' <<<"$INFO")
P5_TYPE=$(sed -n 's/^Partition GUID code: \([0-9A-Fa-f-]*\).*/\1/p' <<<"$INFO")
[ -n "$P5_FIRST" ] && [ -n "$P5_LAST" ] && [ -n "$P5_GUID" ] || no "can't read partition 5's position on $DISK"
[ "${P5_TYPE^^}" = "$EXFAT_TYPE" ] || no "partition 5 of $DISK has an unexpected type ($P5_TYPE)"

# ---- Unused space after it ----
SECTOR=$(blockdev --getss "$DISK" 2>/dev/null) || no "can't read $DISK's sector size"
DISK_BYTES=$(blockdev --getsize64 "$DISK" 2>/dev/null) || no "can't read $DISK's size"
# The GPT keeps its backup copy in the last 33 sectors.
LAST_USABLE=$(( DISK_BYTES / SECTOR - 34 ))
FREE=$(( (LAST_USABLE - P5_LAST) * SECTOR ))
[ "$FREE" -ge "$MIN_FREE" ] || no "only $(( FREE / 1048576 )) MB unused on $DISK: nothing to do"

# ---- The Transfer Drive must hold no files ----
# Folders and files a Mac or Windows adds on their own, and anything
# hidden (a leading dot), don't count.
transfer_is_empty() {
    local dir=$1 n
    for n in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
        [ -e "$n" ] || continue
        case "$(basename "$n")" in
            .*|"System Volume Information"|'$RECYCLE.BIN') continue ;;
        esac
        say "the Transfer Drive holds \"$(basename "$n")\": it is left as it is"
        return 1
    done
    return 0
}
P5_DEV=$(part 5)
MOUNTED_AT=$(findmnt -rno TARGET -S "$P5_DEV" 2>/dev/null | head -1)
if [ -n "$MOUNTED_AT" ]; then
    transfer_is_empty "$MOUNTED_AT" || exit 1
else
    LOOK=$(mktemp -d /tmp/grow-transfer.XXXXXX)
    mount -t exfat -o ro "$P5_DEV" "$LOOK" 2>/dev/null || { rmdir "$LOOK"; no "can't look inside the Transfer Drive"; }
    EMPTY=0
    transfer_is_empty "$LOOK" && EMPTY=1
    umount "$LOOK"; rmdir "$LOOK"
    [ "$EMPTY" = 1 ] || exit 1
fi

DISK_GB=$(( (DISK_BYTES + 500000000) / 1000000000 ))
if [ "$CHECK_ONLY" = 1 ]; then
    echo "$DISK_GB"
    exit 0
fi

# ---- Grow it ----
say "growing the Transfer Drive on $DISK ($DISK_GB GB) by $(( FREE / 1048576 )) MB"
while read -r target; do
    [ -n "$target" ] || continue
    umount "$target" || no "the Transfer Drive is in use at $target"
done < <(findmnt -rno TARGET -S "$P5_DEV" 2>/dev/null)

# One sgdisk run: move the backup GPT to the end, then make partition 5
# again with the same start, GUID, type and name, ending at the end.
# On the running boot drive sgdisk can't make the kernel re-read the whole
# table (partitions 3 and 4 are in use) and may say so; what counts is what
# it wrote, so the table is read back rather than trusting its exit code.
SG_RC=0
sgdisk -e -d 5 -n "5:$P5_FIRST:0" -t 5:0700 -c 5:TRANSFER -u "5:$P5_GUID" "$DISK" || SG_RC=$?
NEW_LAST=$(sgdisk -i 5 "$DISK" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')
NEW_FIRST=$(sgdisk -i 5 "$DISK" 2>/dev/null | sed -n 's/^First sector: \([0-9]*\).*/\1/p')
if [ -z "$NEW_LAST" ] || [ "$NEW_FIRST" != "$P5_FIRST" ]; then
    say "partition 5 can't be read back after sgdisk (exit $SG_RC)"
    exit 2
fi
if [ "$NEW_LAST" -le "$P5_LAST" ]; then
    say "the partition table wasn't changed (sgdisk exit $SG_RC)"
    exit 1
fi
[ "$SG_RC" = 0 ] || say "sgdisk exit $SG_RC, but partition 5 now ends at sector $NEW_LAST: carrying on"

# Tell the kernel about partition 5's new size only (the others are in use).
partx -u -n 5 "$DISK" || { say "the kernel kept the old size of partition 5"; exit 2; }
udevadm settle --timeout=10 2>/dev/null || true
WANT=$(( (NEW_LAST - P5_FIRST + 1) * SECTOR ))
HAVE=$(blockdev --getsize64 "$P5_DEV" 2>/dev/null || echo 0)
[ "$HAVE" = "$WANT" ] || { say "partition 5 is $HAVE bytes to the kernel, not $WANT"; exit 2; }

mkfs.exfat -n TRANSFER "$P5_DEV" >/dev/null || { say "the new exFAT wasn't made"; exit 2; }
udevadm settle --timeout=10 2>/dev/null || true
[ "$(label "$P5_DEV")" = "TRANSFER" ] || { say "the new Transfer Drive has no TRANSFER label"; exit 2; }
say "done: the Transfer Drive is now $(( WANT / 1000000000 )) GB"
exit 0

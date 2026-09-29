#!/bin/bash
# =====================================================================
#  flash-new-stick.sh — safely write safekeep.img onto a USB stick
# =====================================================================
#
#  Use this for a NEW stick, or to completely re-image an existing one.
#  It ERASES the whole stick (including any vault on it). To update a
#  stick you already use and KEEP its vault, use quick-update.sh --usb.
#
#  What it does, in order:
#    1. Refuses anything that is not a whole USB disk, or that holds this
#       computer's own system (/, /boot), or that is too small.
#    2. Shows the stick and warns loudly if it already contains a vault.
#    3. Asks you to type the device name (e.g. sdb) to confirm.
#    4. Records the image's SHA-256 fingerprint, unmounts the stick,
#       and writes the image with dd.
#    5. Reads the stick back and checks it matches the image exactly.
#
#  Usage (from /home/safekeep-build):
#     sudo bash flash-new-stick.sh /dev/sdb
#     sudo bash flash-new-stick.sh /dev/sdb some-other.img
# =====================================================================
set -euo pipefail

die() { echo ""; echo "ERROR: $*" >&2; exit 1; }

TARGET="${1:-}"
IMG="${2:-safekeep.img}"

[ -n "$TARGET" ] || die "no stick given. Usage: sudo bash flash-new-stick.sh /dev/sdb"
[ "$(id -u)" -eq 0 ] || die "run with sudo."
[ -f "$IMG" ] || die "image '$IMG' not found. Run this from the build folder, after build.sh or quick-update.sh."

# ---------------------------------------------------------------------
# 1. Is the target a whole USB disk that is safe to erase?
# ---------------------------------------------------------------------
[ -b "$TARGET" ] || die "$TARGET is not a disk device. Check the name with: lsblk -o NAME,SIZE,TRAN,LABEL"

DTYPE=$(lsblk -dno TYPE "$TARGET" 2>/dev/null | tr -d ' ')
[ "$DTYPE" = "disk" ] || die "$TARGET is not a whole disk (type '$DTYPE'). Give the whole stick, e.g. /dev/sdb (not /dev/sdb3)."

TRAN=$(lsblk -dno TRAN "$TARGET" 2>/dev/null | tr -d ' ')
[ "$TRAN" = "usb" ] || die "$TARGET is not a USB device (connection type '$TRAN'). Refusing, to protect internal drives."

MOUNTS=$(lsblk -nro MOUNTPOINTS "$TARGET" 2>/dev/null || lsblk -nro MOUNTPOINT "$TARGET" 2>/dev/null || true)
while IFS= read -r m; do
    case "$m" in
        /|/boot|/boot/*|/usr|/var|/home|/home/*|\[SWAP\])
            die "$TARGET holds part of this computer's own system ($m). Refusing." ;;
    esac
done <<< "$MOUNTS"

IMG_SIZE=$(stat -c%s "$IMG")
DEV_SIZE=$(blockdev --getsize64 "$TARGET")
[ "$DEV_SIZE" -ge "$IMG_SIZE" ] || die "$TARGET is too small: $((DEV_SIZE / 1000000)) MB, image needs $((IMG_SIZE / 1000000)) MB."

# ---------------------------------------------------------------------
# 2. Show the stick; warn if it already holds a vault
# ---------------------------------------------------------------------
NAME=$(basename "$TARGET")
echo "========================================="
echo "  SafeKeep: flash a stick"
echo "========================================="
echo ""
lsblk -o NAME,SIZE,TRAN,MODEL,LABEL "$TARGET"
echo ""

HAS_VAULT=0
while IFS= read -r part; do
    [ -n "$part" ] || continue
    if [ "$(blkid -s TYPE -o value "/dev/$part" 2>/dev/null)" = "crypto_LUKS" ]; then
        HAS_VAULT=1
    fi
done <<< "$(lsblk -nro NAME "$TARGET" | tail -n +2)"

if [ "$HAS_VAULT" = "1" ]; then
    echo "  !!!  WARNING: this stick contains an ENCRYPTED VAULT.  !!!"
    echo "  !!!  Flashing will destroy it permanently.             !!!"
    echo "  !!!  Only continue if your seeds are backed up.        !!!"
    echo ""
fi

echo "Image : $IMG ($((IMG_SIZE / 1000000)) MB)"
echo "Target: $TARGET ($((DEV_SIZE / 1000000000)) GB, USB)"
echo ""
echo "EVERYTHING on $TARGET will be erased."
read -r -p "To continue, type the stick's name ($NAME): " ANSWER
[ "$ANSWER" = "$NAME" ] || die "you typed '$ANSWER', not '$NAME'. Nothing was changed."

# ---------------------------------------------------------------------
# 3. Fingerprint the image, then free the stick
# ---------------------------------------------------------------------
echo ""
echo "[1/4] Fingerprinting the image (SHA-256)..."
IMG_SHA=$(sha256sum "$IMG" | cut -d' ' -f1)
echo "$IMG_SHA  $(basename "$IMG")  $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$IMG.sha256"
echo "      $IMG_SHA"
echo "      (saved to $IMG.sha256)"

echo ""
echo "[2/4] Unmounting anything the computer opened on the stick..."
while IFS= read -r part; do
    [ -n "$part" ] || continue
    if findmnt -rno TARGET "/dev/$part" >/dev/null 2>&1; then
        umount "/dev/$part" || die "could not unmount /dev/$part. Close any window showing the stick and try again."
        echo "      unmounted /dev/$part"
    fi
done <<< "$(lsblk -nro NAME "$TARGET" | tail -n +2)"
TYPES=$(lsblk -nro TYPE "$TARGET")
if printf '%s\n' "$TYPES" | grep -qE '^(crypt|lvm)$'; then
    die "an encrypted volume on $TARGET is still open. Close it (or reboot the ZBook) and try again."
fi

# ---------------------------------------------------------------------
# 4. Write
# ---------------------------------------------------------------------
echo ""
echo "[3/4] Writing the image. Do NOT unplug the stick."
echo "      The counter may reach the end quickly and then pause for"
echo "      a few minutes while the stick catches up. That is normal."
dd if="$IMG" of="$TARGET" bs=4M status=progress conv=fsync
sync

# ---------------------------------------------------------------------
# 5. Verify by reading the stick back
# ---------------------------------------------------------------------
echo ""
echo "[4/4] Reading the stick back to verify (a minute or two)..."
blockdev --flushbufs "$TARGET" 2>/dev/null || true
echo 3 > /proc/sys/vm/drop_caches
DEV_SHA=$(head -c "$IMG_SIZE" "$TARGET" | sha256sum | cut -d' ' -f1)

partprobe "$TARGET" 2>/dev/null || true
udevadm settle 2>/dev/null || true

if [ "$DEV_SHA" != "$IMG_SHA" ]; then
    echo ""
    echo "  image: $IMG_SHA"
    echo "  stick: $DEV_SHA"
    die "VERIFY FAILED: the stick does not match the image. Do not use this stick. Try again, or try another stick."
fi

echo ""
lsblk -o NAME,SIZE,TRAN,LABEL "$TARGET"
echo ""
echo "========================================="
echo "  Done. The stick matches the image exactly."
echo "  SHA-256: $IMG_SHA"
echo "  Eject it and boot. On first boot you will"
echo "  set up the vault and choose its password."
echo "========================================="

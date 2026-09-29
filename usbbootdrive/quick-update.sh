#!/bin/bash
# =====================================================================
#  quick-update.sh — fast rebuild for app / daemon-script changes
# =====================================================================
#
#  A full `build.sh` takes ~20 minutes because it re-creates the whole
#  Ubuntu system (reinstalls every package, re-hardens it) and then
#  builds a brand-new disk image. For the changes we make most often —
#  the web app (src/dist) and the runtime scripts — none of that is
#  needed: those files are simply COPIED into the OS.
#
#  build.sh leaves the finished, hardened OS tree in workspace/chroot
#  (it is only wiped at the START of the next full build). This script
#  reuses it:
#     1. copies the new app + runtime scripts into workspace/chroot
#     2. re-compresses it into filesystem.squashfs   (the only slow step)
#     3. swaps the new OS into the target:
#          (default)      safekeep.img  — flash it as usual
#          --usb /dev/sdX the plugged-in SafeKeep stick, IN PLACE.
#                         Only the OS partition is touched: the encrypted
#                         vault and the transfer drive (your backups) are
#                         kept, so there is nothing to re-flash and no
#                         seed to restore.
#
#  Covered by a quick update:
#     src/dist/*            (boot.html, manifest.json, …)
#     safekeep-boot.sh, unlock-vault.sh, setup-vault.sh
#     safekeep-session.service, config/99-hide-drives.rules
#
#  NOT covered — run the full `sudo bash build.sh` instead:
#     chroot-setup.sh or safekeep-harden.sh changes (they RUN during the
#     full build to install packages / apply hardening; copying them does
#     nothing). This script detects that and refuses.
#
#  Usage (from /home/safekeep-build):
#     sudo bash quick-update.sh                 # update safekeep.img
#     sudo bash quick-update.sh --usb /dev/sdb  # update the stick in place
# =====================================================================
set -euo pipefail

WORKSPACE="workspace"
CHROOT_DIR="$WORKSPACE/chroot"
STAGING_DIR="$WORKSPACE/staging"
OUTPUT_IMG="safekeep.img"
OS_SIZE_MB=2944                 # must match build.sh
MNT="$WORKSPACE/mnt-quick"

die() { echo ""; echo "ERROR: $*" >&2; exit 1; }

TARGET_USB=""
if [ "${1:-}" = "--usb" ]; then
    TARGET_USB="${2:-}"
    [ -n "$TARGET_USB" ] || die "--usb needs a device, e.g. --usb /dev/sdb"
elif [ -n "${1:-}" ]; then
    die "unknown option '$1'. Usage: sudo bash quick-update.sh [--usb /dev/sdX]"
fi

[ "$(id -u)" -eq 0 ] || die "run with sudo."
[ -f build.sh ] || die "run this from the build folder (the one containing build.sh)."

START=$(date +%s)
echo "========================================="
echo "  SafeKeep QUICK update"
echo "========================================="

# ---------------------------------------------------------------------
# 1. Pre-flight: a complete, unmounted chroot from a previous full build
# ---------------------------------------------------------------------
[ -x "$CHROOT_DIR/usr/local/bin/safekeep-boot" ] && [ -d "$CHROOT_DIR/opt/safekeep" ] \
    || die "no finished OS in $CHROOT_DIR. Run the full 'sudo bash build.sh' once first."

# The chroot must come from a build that FINISHED. build.sh copies the app and
# scripts into the chroot BEFORE it installs packages and hardens the OS, so a
# cancelled build leaves a tree that looks complete but is not set up or
# hardened. Proof of completion: the marker build.sh writes after hardening,
# or (for builds made before the marker existed) safekeep.img — which build.sh
# deletes at the START of every build and only recreates at the very end.
if [ ! -f "$WORKSPACE/.chroot-complete" ] && [ ! -f "$OUTPUT_IMG" ]; then
    die "the last full build did not finish (cancelled or failed), so the OS tree is incomplete and unhardened. Run: sudo bash build.sh"
fi

for m in proc sys dev run var/cache/apt/archives var/lib/apt/lists; do
    if mountpoint -q "$CHROOT_DIR/$m" 2>/dev/null; then
        die "$CHROOT_DIR/$m is still mounted (a full build may be running or crashed). Reboot the ZBook or unmount it first."
    fi
done

# The OS-level scripts must be the ones this chroot was built with.
if ! cmp -s chroot-setup.sh "$CHROOT_DIR/chroot-setup.sh"; then
    die "chroot-setup.sh has changed since the last full build — it must RUN to take effect. Use: sudo bash build.sh"
fi
if ! cmp -s safekeep-harden.sh "$CHROOT_DIR/usr/local/bin/safekeep-harden"; then
    die "safekeep-harden.sh has changed since the last full build — it must RUN to take effect. Use: sudo bash build.sh"
fi

[ -f src/dist/boot.html ] || die "src/dist/boot.html missing — copy the compiled app over first."
command -v mksquashfs >/dev/null || die "mksquashfs not installed (sudo apt install squashfs-tools)."

# ---------------------------------------------------------------------
# 1b. USB target safety checks — BEFORE doing any slow work
# ---------------------------------------------------------------------
if [ -n "$TARGET_USB" ]; then
    [ -b "$TARGET_USB" ] || die "$TARGET_USB is not a block device."
    DISK=$(lsblk -no PKNAME "$TARGET_USB" 2>/dev/null | head -1)
    [ -z "$DISK" ] || die "$TARGET_USB is a partition — give the whole device, e.g. /dev/sdb (not /dev/sdb3)."
    TRAN=$(lsblk -dno TRAN "$TARGET_USB" 2>/dev/null | tr -d ' ')
    [ "$TRAN" = "usb" ] || die "$TARGET_USB is not a USB device (transport='$TRAN'). Refusing, to protect internal disks."
    ROOTDISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE / 2>/dev/null)" 2>/dev/null | head -1 || true)
    [ "/dev/$ROOTDISK" != "$TARGET_USB" ] || die "$TARGET_USB holds this computer's root filesystem. Refusing."
    case "$TARGET_USB" in *[0-9]) P=p ;; *) P="" ;; esac
    OS_PART="${TARGET_USB}${P}3"
    [ "$(lsblk -no LABEL "$OS_PART" 2>/dev/null)" = "safekeep-os" ] \
        || die "$OS_PART is not labelled 'safekeep-os' — this does not look like a SafeKeep stick. Flash it with the full image instead."
    [ "$(lsblk -no LABEL "${TARGET_USB}${P}4" 2>/dev/null)" = "safekeep-data" ] \
        || die "${TARGET_USB}${P}4 is not labelled 'safekeep-data' — unexpected layout. Refusing."
    echo ""
    lsblk -o NAME,SIZE,MODEL,TRAN,LABEL "$TARGET_USB"
    echo ""
    echo "Will REPLACE the operating system on $OS_PART (SafeKeep OS partition)."
    echo "The vault (partition 4) and transfer drive (partition 5) are NOT touched."
    read -r -p "Type YES to continue: " ok
    [ "$ok" = "YES" ] || die "cancelled."
fi

# ---------------------------------------------------------------------
# 2. Inject the updated files into the finished OS tree
#    (same destinations and modes as build.sh Phase 3)
# ---------------------------------------------------------------------
echo ""
echo "[1/3] Updating app + runtime scripts in the OS tree..."
rm -rf "${CHROOT_DIR:?}/opt/safekeep"
mkdir -p "$CHROOT_DIR/opt/safekeep"
cp -r src/dist/* "$CHROOT_DIR/opt/safekeep/"
install -m 755 safekeep-boot.sh "$CHROOT_DIR/usr/local/bin/safekeep-boot"
install -m 755 unlock-vault.sh  "$CHROOT_DIR/usr/local/bin/unlock-vault"
install -m 755 setup-vault.sh   "$CHROOT_DIR/usr/local/bin/setup-vault"
install -m 644 safekeep-session.service "$CHROOT_DIR/etc/systemd/system/safekeep-session.service"
[ -f config/99-hide-drives.rules ] && install -m 644 config/99-hide-drives.rules "$CHROOT_DIR/etc/udev/rules.d/99-hide-drives.rules"
echo "      app bundle : $(grep -o 'sha256=[0-9a-f]*' src/dist/manifest.json 2>/dev/null | head -1 | cut -c1-20)…"

# ---------------------------------------------------------------------
# 3. Re-compress (the only slow step, uses every CPU core)
# ---------------------------------------------------------------------
echo ""
echo "[2/3] Compressing the OS (a few minutes)..."
mkdir -p "$STAGING_DIR/casper"
rm -f "$STAGING_DIR/casper/filesystem.squashfs"
mksquashfs "$CHROOT_DIR" "$STAGING_DIR/casper/filesystem.squashfs" -comp xz -noappend
cp "$(ls "$CHROOT_DIR"/boot/vmlinuz-* | sort -V | tail -1)"    "$STAGING_DIR/casper/vmlinuz"
cp "$(ls "$CHROOT_DIR"/boot/initrd.img-* | sort -V | tail -1)" "$STAGING_DIR/casper/initrd"
printf "%s" "$(du -sx --block-size=1 "$CHROOT_DIR" | cut -f1)" > "$STAGING_DIR/casper/filesystem.size"
SQ_MB=$(du -sm "$STAGING_DIR/casper" | awk '{print $1}')
[ "$SQ_MB" -lt "$OS_SIZE_MB" ] || die "OS content ${SQ_MB}MB exceeds the ${OS_SIZE_MB}MB partition."

# ---------------------------------------------------------------------
# 4. Swap the new OS into the target's OS partition (partition 3)
# ---------------------------------------------------------------------
LOOP=""
cleanup() {
    umount -l "$MNT" 2>/dev/null || true
    [ -n "$LOOP" ] && losetup -d "$LOOP" 2>/dev/null || true
}
trap cleanup EXIT

if [ -n "$TARGET_USB" ]; then
    # Unmount anything the desktop auto-mounted from the stick.
    for p in $(lsblk -lno NAME "$TARGET_USB" | tail -n +2); do umount "/dev/$p" 2>/dev/null || true; done
    TARGET_PART="$OS_PART"
    WHAT="USB stick $TARGET_USB"
else
    [ -f "$OUTPUT_IMG" ] || die "$OUTPUT_IMG not found — run the full build once first."
    LOOP=$(losetup --find --show -P "$OUTPUT_IMG")
    TARGET_PART="${LOOP}p3"
    [ -b "$TARGET_PART" ] || die "could not see partition 3 inside $OUTPUT_IMG."
    [ "$(blkid -s LABEL -o value "$TARGET_PART" 2>/dev/null)" = "safekeep-os" ] || die "$OUTPUT_IMG partition 3 is not 'safekeep-os'."
    WHAT="$OUTPUT_IMG"
fi

echo ""
echo "[3/3] Writing the new OS into $WHAT ..."
mkdir -p "$MNT"
mount "$TARGET_PART" "$MNT"
[ -d "$MNT/casper" ] || die "no casper/ folder on the OS partition — not a SafeKeep OS partition."
# Preferred: write to temp names, then rename — a crash mid-copy never leaves
# a half-written OS. That needs room for old + new side by side; if the
# partition can't hold both, replace in place (if that is interrupted the
# stick won't boot until updated again — the vault partition is unaffected).
NEED_KB=$(du -sk "$STAGING_DIR/casper" | awk '{print $1}')
FREE_KB=$(df -Pk "$MNT" | awk 'NR==2 {print $4}')
if [ "$FREE_KB" -gt $(( NEED_KB + 51200 )) ]; then
    for f in filesystem.squashfs vmlinuz initrd filesystem.size; do
        cp "$STAGING_DIR/casper/$f" "$MNT/casper/.$f.new"
    done
    sync
    for f in filesystem.squashfs vmlinuz initrd filesystem.size; do
        mv -f "$MNT/casper/.$f.new" "$MNT/casper/$f"
    done
else
    echo "      (not enough room for old + new side by side — replacing in place; do not unplug)"
    for f in filesystem.squashfs vmlinuz initrd filesystem.size; do
        rm -f "$MNT/casper/$f"
        cp "$STAGING_DIR/casper/$f" "$MNT/casper/$f"
    done
fi
sync
umount "$MNT"

echo ""
echo "========================================="
echo "  Quick update complete in $(( ($(date +%s) - START) / 60 ))m $(( ($(date +%s) - START) % 60 ))s"
echo "========================================="
if [ -n "$TARGET_USB" ]; then
    echo "  The stick is updated. Your vault and backups were kept."
    echo "  Eject it and boot."
else
    echo "  $OUTPUT_IMG is updated. Flash it as usual:"
    echo "    sudo dd if=$OUTPUT_IMG of=/dev/sdX bs=4M status=progress conv=fsync"
fi

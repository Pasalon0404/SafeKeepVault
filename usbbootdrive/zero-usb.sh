#!/bin/bash
# =============================================================================
# zero-usb.sh — Zero free space inside SafeKeep OS writable filesystems
# =============================================================================
# Purpose
#   Reduce the size of the distributed safekeep.img.zip by ensuring every
#   unused block inside each writable filesystem on the build artifact is
#   a literal zero byte, so the outer zip stream can crush the
#   run-length-encoded zero regions to near-nothing.
#
# Run this AFTER build.sh produces safekeep.img, BEFORE:
#   zip -9 safekeep.img.zip safekeep.img
#
# Default mode (SAFE): operate on the safekeep.img file via loopback.
# Physical-device mode (DANGEROUS) is supported but gated behind checks.
#
# Partition map (from build.sh):
#   P1  BIOS Boot        raw GRUB core.img (2MB)  — SKIP, no filesystem
#   P2  EFI System       FAT32, label SK-EFI      — zero free space
#   P3  OS               ext4,  label safekeep-os — zero free space
#   P4  Data             ext4,  label safekeep-data — zero free space
#   P5  Transfer         exFAT, label TRANSFER    — zero free space
#
# IMPORTANT: Partition 4 is an ext4 filesystem that HOLDS the LUKS vault
# as a file (.vault.luks) created on first boot. It is NOT a raw LUKS
# partition. Overwriting its bytes would destroy the ext4 structure and
# the "safekeep-data" label, and first-boot setup-vault would fail with
# "No writable storage partition found". This script zeroes ONLY FREE
# BLOCKS via mount-then-dd-to-tmpfile, preserving all filesystem
# metadata, labels, and existing content.
#
# Usage
#   sudo bash zero-usb.sh                       # defaults to ./safekeep.img
#   sudo bash zero-usb.sh path/to/safekeep.img  # explicit image file
#   sudo bash zero-usb.sh /dev/sdX              # physical device (with guards)
# =============================================================================

set -euo pipefail

TARGET="${1:-safekeep.img}"
MNT_ROOT="$(mktemp -d /tmp/skb-zero.XXXXXX)"
LOOP_DEV=""
USED_KPARTX=0

# -----------------------------------------------------------------------------
# Cleanup trap — always run, preserves exit code
# -----------------------------------------------------------------------------
cleanup() {
    local code=$?
    for p in efi os data transfer; do
        umount "$MNT_ROOT/$p" 2>/dev/null || true
    done
    if [ -n "$LOOP_DEV" ] && [ -e "$LOOP_DEV" ]; then
        if [ "$USED_KPARTX" = "1" ]; then
            kpartx -d "$LOOP_DEV" 2>/dev/null || true
        fi
        losetup -d "$LOOP_DEV" 2>/dev/null || true
    fi
    rmdir "$MNT_ROOT"/{efi,os,data,transfer} 2>/dev/null || true
    rmdir "$MNT_ROOT" 2>/dev/null || true
    exit "$code"
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# Preflight checks
# -----------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: must be run as root (losetup, mount require privilege)."
    exit 1
fi

if [ ! -e "$TARGET" ]; then
    echo "ERROR: target not found: $TARGET"
    echo "Usage: sudo bash $0 [safekeep.img | /dev/sdX]"
    exit 1
fi

# -----------------------------------------------------------------------------
# Resolve TARGET to partition device paths.
# Two modes:
#   - regular file  → loopback mount with --partscan
#   - block device  → use partitions directly, with strict safety gates
# -----------------------------------------------------------------------------
if [ -b "$TARGET" ]; then
    # === PHYSICAL DEVICE MODE ===
    echo ""
    echo "============================================================"
    echo "  $TARGET is a physical block device."
    echo "  Extra safety checks apply."
    echo "============================================================"

    # Refuse the host's root or home disk (strip trailing partition digits)
    host_disk() {
        local src
        src=$(findmnt -n -o SOURCE "$1" 2>/dev/null || true)
        [ -z "$src" ] && return 0
        # Strip partition suffix: /dev/nvme0n1p2 → /dev/nvme0n1 ; /dev/sda2 → /dev/sda
        if [[ "$src" =~ ^(/dev/(nvme|mmcblk)[0-9]+n[0-9]+)p[0-9]+$ ]]; then
            echo "${BASH_REMATCH[1]}"
        elif [[ "$src" =~ ^(/dev/[a-z]+)[0-9]+$ ]]; then
            echo "${BASH_REMATCH[1]}"
        else
            echo "$src"
        fi
    }
    ROOT_DISK="$(host_disk /)"
    HOME_DISK="$(host_disk /home)"
    if [ "$TARGET" = "$ROOT_DISK" ] || [ "$TARGET" = "$HOME_DISK" ]; then
        echo "REFUSING: $TARGET is the host's root/home disk."
        exit 1
    fi

    # Size sanity: SafeKeep USBs are 4GB-64GB
    SIZE_BYTES="$(blockdev --getsize64 "$TARGET")"
    SIZE_GB=$(( SIZE_BYTES / 1024 / 1024 / 1024 ))
    if [ "$SIZE_GB" -lt 4 ] || [ "$SIZE_GB" -gt 64 ]; then
        echo "REFUSING: $TARGET is ${SIZE_GB}GB (expected 4-64GB)."
        exit 1
    fi

    # Any partitions currently mounted? Abort.
    if findmnt -n -S "$TARGET"? >/dev/null 2>&1 || \
       findmnt -n -S "${TARGET}p"? >/dev/null 2>&1; then
        echo "ERROR: partitions of $TARGET are currently mounted. Unmount first."
        exit 1
    fi

    # Show device details, require explicit YES
    echo ""
    lsblk -n -o NAME,SIZE,MODEL,SERIAL,LABEL,MOUNTPOINT "$TARGET" 2>/dev/null || true
    echo ""
    printf "Type YES (all caps) to continue zeroing free space on %s: " "$TARGET"
    read -r CONFIRM
    if [ "$CONFIRM" != "YES" ]; then
        echo "Aborted by user."
        exit 1
    fi

    # Partition device naming: /dev/sdX → /dev/sdX1, /dev/nvme0n1 → /dev/nvme0n1p1
    if [[ "$TARGET" =~ [0-9]$ ]]; then
        DEV_PREFIX="${TARGET}p"
    else
        DEV_PREFIX="$TARGET"
    fi
    P_EFI="${DEV_PREFIX}2"
    P_OS="${DEV_PREFIX}3"
    P_DATA="${DEV_PREFIX}4"
    P_TRANSFER="${DEV_PREFIX}5"

else
    # === LOOPBACK IMAGE MODE (default, safe) ===
    echo "Attaching $TARGET as loop device (partscan)..."
    LOOP_DEV="$(losetup --find --show --partscan "$TARGET")"
    sleep 1

    if [ -b "${LOOP_DEV}p1" ]; then
        P_EFI="${LOOP_DEV}p2"
        P_OS="${LOOP_DEV}p3"
        P_DATA="${LOOP_DEV}p4"
        P_TRANSFER="${LOOP_DEV}p5"
    else
        # Some kernels need kpartx to materialize partition device nodes
        command -v kpartx >/dev/null || {
            echo "ERROR: partition nodes not found and kpartx not installed."
            exit 1
        }
        kpartx -a "$LOOP_DEV"
        USED_KPARTX=1
        LOOP_NAME="$(basename "$LOOP_DEV")"
        P_EFI="/dev/mapper/${LOOP_NAME}p2"
        P_OS="/dev/mapper/${LOOP_NAME}p3"
        P_DATA="/dev/mapper/${LOOP_NAME}p4"
        P_TRANSFER="/dev/mapper/${LOOP_NAME}p5"
        sleep 1
    fi
fi

echo "EFI=$P_EFI  OS=$P_OS  DATA=$P_DATA  TRANSFER=$P_TRANSFER"

# -----------------------------------------------------------------------------
# Core primitive: mount → fill-with-zeros → rm → sync → unmount
# -----------------------------------------------------------------------------
# Safety notes on the filename (.ZEROFILL):
#   - Leading dot so it never collides with user-visible content.
#   - Single file. If ENOSPC on a filesystem that keeps reserved blocks,
#     dd bails with a partial write — that's the expected terminal state.
#   - We sync AFTER the delete so the filesystem journal flushes the
#     truncated allocation; without that, ext4 may leave the zeroed
#     extent map cached in the journal rather than on the backing disk.
# -----------------------------------------------------------------------------
zero_free() {
    local part="$1" name="$2" fstype="$3"
    local mnt="$MNT_ROOT/$name"
    local fill="$mnt/.ZEROFILL"

    echo ""
    echo "--- $name ($fstype) on $part ---"
    mkdir -p "$mnt"

    if ! mount "$part" "$mnt" 2>/dev/null; then
        echo "  SKIP: could not mount $part (not fatal; filesystem may be unrecognized)."
        return 0
    fi

    local avail_kb
    avail_kb="$(df --output=avail "$mnt" | tail -1)"
    echo "  Free before fill: ${avail_kb} KB"

    # Fill to ENOSPC. dd's nonzero exit on ENOSPC is expected, so || true.
    # conv=fdatasync forces actual disk writes rather than page-cache fiction.
    dd if=/dev/zero of="$fill" bs=4M status=none conv=fdatasync 2>/dev/null || true
    sync
    rm -f "$fill"
    sync

    # Quick sanity check: free should be approximately restored
    local after_kb
    after_kb="$(df --output=avail "$mnt" | tail -1)"
    echo "  Free after rm:    ${after_kb} KB"

    umount "$mnt"
}

# -----------------------------------------------------------------------------
# Run each writable filesystem. P1 (BIOS Boot, raw GRUB) is skipped on
# purpose — it has no filesystem, and its 2MB raw payload is intentional.
# -----------------------------------------------------------------------------
zero_free "$P_EFI"      "efi"      "FAT32"
zero_free "$P_OS"       "os"       "ext4"
zero_free "$P_DATA"     "data"     "ext4"
zero_free "$P_TRANSFER" "transfer" "exFAT"

echo ""
echo "============================================================"
echo "  Free-space zeroing complete."
echo ""
echo "  Next step:"
echo "    zip -9 safekeep.img.zip $TARGET"
echo ""
echo "  Expected improvement: modest (couple hundred MB). The bulk"
echo "  of safekeep.img.zip is the xz-compressed squashfs on P3,"
echo "  which cannot be compressed further."
echo "============================================================"

#!/bin/bash
set -e

# =============================================================================
# SafeKeep OS Build Script
# Produces a 3.8GB raw disk image (.img) sized for 4GB+ USB drives.
# Pre-baked partitions:
#   Partition 1: BIOS Boot (2MB)          — GRUB core.img for legacy PCs
#   Partition 2: EFI System (256MB, FAT32) — GRUB for UEFI boot
#   Partition 3: OS (2944MB, ext4)         — squashfs, kernel, initrd
#   Partition 4: Data (300MB, ext4)        — LUKS file-container vault
#   Partition 5: Transfer (300MB, exFAT)   — Airlock for Mac/Win file exchange
#
# The user flashes safekeep.img to any 4GB+ USB drive, boots, and runs
# The boot wrapper (safekeep-boot) auto-runs vault setup on first boot.
# =============================================================================

# Configuration
UBUNTU_RELEASE="noble"  # Ubuntu 24.04 LTS
WORKSPACE="workspace"
BASE_CHROOT="$WORKSPACE/base-chroot"
CHROOT_DIR="$WORKSPACE/chroot"
STAGING_DIR="$WORKSPACE/staging"
APT_CACHE="$WORKSPACE/apt-cache"
APT_LISTS="$WORKSPACE/apt-lists"
OUTPUT_IMG="safekeep.img"

# Partition sizes in MB
EFI_SIZE_MB=256
OS_SIZE_MB=2944       # ~2.9GB — room for squashfs + kernel + grub
DATA_SIZE_MB=300      # LUKS vault file container
TRANSFER_SIZE_MB=300  # exFAT airlock partition (Mac/Win readable)
TOTAL_SIZE_MB=3800    # Fits on 4GB USB drives

echo ""
echo "========================================="
echo "  SafeKeep OS Build (IMG Format)"
echo "========================================="
echo ""

# Emergency Cleanup Trap
#
# CRITICAL SAFETY NOTE — every umount in this trap uses `-l` (lazy
# detachment). A previous build leaked a background process in the
# chroot that held an open file handle to $CHROOT_DIR/dev. The
# regular `umount` failed silently (return code captured by `|| true`),
# so on the NEXT build, when Phase 2 ran `rm -rf "$CHROOT_DIR"`, rm
# crossed the still-active bind mount into the host's devtmpfs and
# wiped the host's /dev nodes — turning /dev/null into a regular
# file with restricted permissions and crashing apt-key.
#
# `umount -l` detaches the filesystem from the namespace immediately
# even if files are still open inside it; the kernel cleans up the
# underlying device when the last process exits. From the host's
# filesystem perspective the mount is gone instantly, so a follow-up
# rm cannot traverse into it. This is the right tool for cleanup-on-
# error: we don't care that a hung daemon is still using the mount,
# we just need it OFF the host's filesystem tree before any further
# disk operations.
cleanup() {
    echo "Cleaning up mounts..."
    # Unmount image partitions
    umount -l "$WORKSPACE/mnt-efi" 2>/dev/null || true
    umount -l "$WORKSPACE/mnt-os" 2>/dev/null || true
    umount -l "$WORKSPACE/mnt-data" 2>/dev/null || true
    umount -l "$WORKSPACE/mnt-transfer" 2>/dev/null || true
    # Detach loop devices
    if [ -n "${LOOP_DEV:-}" ]; then
        losetup -d "$LOOP_DEV" 2>/dev/null || true
    fi
    # Unmount chroot bind mounts (lazy — see CRITICAL SAFETY NOTE above)
    umount -l "$CHROOT_DIR/var/lib/apt/lists" 2>/dev/null || true
    umount -l "$CHROOT_DIR/var/cache/apt/archives" 2>/dev/null || true
    umount -l "$CHROOT_DIR/run" 2>/dev/null || true
    umount -l "$CHROOT_DIR/dev" 2>/dev/null || true
    umount -l "$CHROOT_DIR/proc" 2>/dev/null || true
    umount -l "$CHROOT_DIR/sys" 2>/dev/null || true
}
trap cleanup EXIT

# =====================================================================
# PHASE 1: HOST DEPENDENCIES
# =====================================================================
echo "Phase 1: Checking host dependencies..."
DEPS_NEEDED=""
command -v debootstrap >/dev/null || DEPS_NEEDED="$DEPS_NEEDED debootstrap"
command -v mksquashfs >/dev/null || DEPS_NEEDED="$DEPS_NEEDED squashfs-tools"
command -v sgdisk >/dev/null || DEPS_NEEDED="$DEPS_NEEDED gdisk"
command -v grub-install >/dev/null || DEPS_NEEDED="$DEPS_NEEDED grub-pc-bin grub-efi-amd64-bin"
command -v mkfs.fat >/dev/null || DEPS_NEEDED="$DEPS_NEEDED dosfstools"
command -v mkfs.ext4 >/dev/null || DEPS_NEEDED="$DEPS_NEEDED e2fsprogs"
command -v mtools >/dev/null || DEPS_NEEDED="$DEPS_NEEDED mtools"
command -v mkfs.exfat >/dev/null || DEPS_NEEDED="$DEPS_NEEDED exfatprogs"

if [ -n "$DEPS_NEEDED" ]; then
    echo "Installing missing dependencies:$DEPS_NEEDED"
    apt-get update
    apt-get install -y $DEPS_NEEDED
else
    echo "All dependencies present."
fi

# =====================================================================
# PHASE 2: BUILD THE UBUNTU CHROOT
# =====================================================================
echo ""
echo "Phase 2: Preparing Ubuntu base system..."

# Clean working directories (preserve base cache)
#
# DEFENSIVE UNFREEZE — safekeep-harden.sh (Section 6: File Chooser Jail)
# applies `chattr +i` to several config files inside the chroot to prevent
# runtime tampering (user-dirs.dirs, GTK bookmarks, recently-used.xbel).
# Those immutable flags survive the build artifacts — when a subsequent
# `build.sh` run tries to `rm -rf workspace/chroot`, rm fails with
# "Operation not permitted" and the entire build halts in Phase 2.
#
# We recursively clear the immutable bit on the chroot + staging trees
# BEFORE rm. This affects only the host-side build artifacts; the
# `chattr +i` calls in safekeep-harden.sh still fire inside the chroot
# on the next build, so the live OS image ships with the files frozen.
#
# The `2>/dev/null || true` guards against:
#   - a fresh clone where workspace/ doesn't exist yet
#   - filesystems that don't support extended attrs (unlikely on ext4)
#   - chattr not being on the host's PATH (very unlikely; it's in e2fsprogs)
sudo chattr -R -i "$CHROOT_DIR" 2>/dev/null || true
sudo chattr -R -i "$STAGING_DIR" 2>/dev/null || true

# CRITICAL SAFETY: --one-file-system causes rm to refuse to descend
# into any directory on a different filesystem from the starting path.
# This is a hard mathematical failsafe against the cross-mount
# deletion bug that wiped the host's /dev nodes on a previous run:
# even if the cleanup() trap completely failed and a chroot bind
# mount of /dev (devtmpfs) is still active inside $CHROOT_DIR, rm
# will detect the filesystem boundary and stop at it instead of
# crossing into the host's devtmpfs. Combined with the umount -l
# safety in cleanup(), this gives two independent layers of
# protection — the trap eagerly detaches, and rm refuses to cross
# even if the trap fails.
rm -rf --one-file-system "$CHROOT_DIR"
rm -rf --one-file-system "$STAGING_DIR"
rm -f "$OUTPUT_IMG"
mkdir -p "$STAGING_DIR"
mkdir -p "$APT_CACHE"
mkdir -p "$APT_LISTS"

# Download base OS (cached after first run)
if [ ! -d "$BASE_CHROOT" ]; then
    echo "Downloading Ubuntu base ($UBUNTU_RELEASE)... This only happens once."
    mkdir -p "$BASE_CHROOT"
    debootstrap --arch=amd64 "$UBUNTU_RELEASE" "$BASE_CHROOT" http://archive.ubuntu.com/ubuntu/
else
    echo "Found cached Ubuntu base. Skipping download."
fi

# Clone pristine base into working directory
echo "Cloning base system..."
cp -a "$BASE_CHROOT" "$CHROOT_DIR"

# =====================================================================
# PHASE 3: INJECT FILES AND CONFIGURE IN CHROOT
# =====================================================================
echo ""
echo "Phase 3: Configuring the OS..."

# Copy SafeKeep web tools (Vite single-file build — fully inlined HTML)
mkdir -p "$CHROOT_DIR/opt/safekeep"
cp -r src/dist/* "$CHROOT_DIR/opt/safekeep/" || true

# Copy chroot setup script
cp chroot-setup.sh "$CHROOT_DIR/"
chmod +x "$CHROOT_DIR/chroot-setup.sh"

# Copy udev rules
mkdir -p "$CHROOT_DIR/etc/udev/rules.d/"
cp config/99-hide-drives.rules "$CHROOT_DIR/etc/udev/rules.d/" || true

# Inject vault setup & unlock scripts
mkdir -p "$CHROOT_DIR/usr/local/bin"
cp setup-vault.sh "$CHROOT_DIR/usr/local/bin/setup-vault"
chmod +x "$CHROOT_DIR/usr/local/bin/setup-vault"
cp unlock-vault.sh "$CHROOT_DIR/usr/local/bin/unlock-vault"
chmod +x "$CHROOT_DIR/usr/local/bin/unlock-vault"
cp safekeep-boot.sh "$CHROOT_DIR/usr/local/bin/safekeep-boot"
chmod +x "$CHROOT_DIR/usr/local/bin/safekeep-boot"
cp safekeep-harden.sh "$CHROOT_DIR/usr/local/bin/safekeep-harden"
chmod +x "$CHROOT_DIR/usr/local/bin/safekeep-harden"

# ---------------------------------------------------------------------------
# Install safekeep-session.service — the permanent replacement for the
# getty@tty1-autologin → .profile → startx chain. Must land in the chroot
# BEFORE chroot-setup.sh runs, because chroot-setup.sh does the
# `systemctl enable safekeep-session.service` that creates the wants/
# symlink. Enabling a unit whose file doesn't exist is a silent no-op, so
# order matters here.
# ---------------------------------------------------------------------------
install -m 644 -o root -g root \
    safekeep-session.service \
    "$CHROOT_DIR/etc/systemd/system/safekeep-session.service"

# Chromium Enterprise Policy — build-time fallback.
# This policy is OVERWRITTEN at runtime by safekeep-boot.sh with the actual
# mount path of the TRANSFER partition. The baked version here is a sensible
# default that routes downloads to TRANSFER with a save prompt enabled.
# Enterprise policies override user Preferences and cannot be changed in chrome://settings.
POLICY_DIR="$CHROOT_DIR/etc/chromium/policies/managed"
mkdir -p "$POLICY_DIR"
cat > "$POLICY_DIR/safekeep.json" << 'POLICY_EOF'
{
    "DownloadDirectory": "/media/transfer",
    "DefaultDownloadDirectory": "/media/transfer",
    "PromptForDownloadLocation": true,
    "AutomaticDownloadsAllowedForUrls": ["file://*"]
}
POLICY_EOF
echo "Chromium enterprise policy installed at /etc/chromium/policies/managed/safekeep.json"

# Bind-mount host systems for chroot
mount --bind /dev "$CHROOT_DIR/dev"
mount --bind /run "$CHROOT_DIR/run"
mount -t proc proc "$CHROOT_DIR/proc"
mount -t sysfs sysfs "$CHROOT_DIR/sys"

# Bind-mount APT caches for speed
mkdir -p "$CHROOT_DIR/var/cache/apt/archives"
mkdir -p "$CHROOT_DIR/var/lib/apt/lists"
mount --bind "$APT_CACHE" "$CHROOT_DIR/var/cache/apt/archives"
mount --bind "$APT_LISTS" "$CHROOT_DIR/var/lib/apt/lists"

# DNS resolution for package downloads
rm -f "$CHROOT_DIR/etc/resolv.conf"
cp -L /etc/resolv.conf "$CHROOT_DIR/etc/resolv.conf"

# Run the chroot configuration script
chroot "$CHROOT_DIR" /bin/bash -c "/chroot-setup.sh"

# Run OS hardening inside the chroot.
# This bakes module blacklists (/etc/modprobe.d/), udev rules, polkit/dconf
# lockdowns, and systemd service masks into the filesystem BEFORE it's
# compressed into squashfs. It also rebuilds the initramfs so the kernel
# blocks blacklisted modules from the earliest boot stage (before root mount).
#
# CRITICAL: This must run BEFORE the squashfs compression (Phase 4) so the
# configs land in the read-only lower layer. Casper overlay resets on every
# boot, but the squashfs layer persists — hardening is always active.
echo "Running OS hardening in chroot..."
chroot "$CHROOT_DIR" /bin/bash -c "safekeep-harden"

# Unmount chroot bind mounts BEFORE compression. Using `-l` (lazy)
# for the same reason cleanup() does: chroot-setup.sh and
# safekeep-harden.sh might leak a background process holding an
# open file handle in /dev or /proc, and a regular umount silently
# failing here would leave a live bind mount that the next build's
# `rm -rf` could traverse into the host's devtmpfs. Lazy detachment
# guarantees the mount is OFF the host's filesystem tree before
# anything else runs, even if a process is still using it.
umount -l "$CHROOT_DIR/var/lib/apt/lists" 2>/dev/null || true
umount -l "$CHROOT_DIR/var/cache/apt/archives" 2>/dev/null || true
umount -l "$CHROOT_DIR/run" 2>/dev/null || true
umount -l "$CHROOT_DIR/dev" 2>/dev/null || true
umount -l "$CHROOT_DIR/proc" 2>/dev/null || true
umount -l "$CHROOT_DIR/sys" 2>/dev/null || true

echo "Chroot configuration complete."

# =====================================================================
# PHASE 4: COMPRESS THE OS INTO SQUASHFS
# =====================================================================
echo ""
echo "Phase 4: Compressing the filesystem..."

mkdir -p "$STAGING_DIR/casper"

# Compress the entire chroot into a squashfs
mksquashfs "$CHROOT_DIR" "$STAGING_DIR/casper/filesystem.squashfs" -comp xz

# Extract kernel and initramfs
cp "$(ls "$CHROOT_DIR"/boot/vmlinuz-* | sort -V | tail -1)" "$STAGING_DIR/casper/vmlinuz"
cp "$(ls "$CHROOT_DIR"/boot/initrd.img-* | sort -V | tail -1)" "$STAGING_DIR/casper/initrd"

# Filesystem manifest and size
chroot "$CHROOT_DIR" dpkg-query -W --showformat='${Package} ${Version}\n' > "$STAGING_DIR/casper/filesystem.manifest" 2>/dev/null || true
printf "%s" "$(du -sx --block-size=1 "$CHROOT_DIR" | cut -f1)" > "$STAGING_DIR/casper/filesystem.size"

# Check that the OS fits in the OS partition
OS_CONTENT_SIZE=$(du -sm "$STAGING_DIR" | awk '{print $1}')
echo "OS content size: ${OS_CONTENT_SIZE}MB (partition: ${OS_SIZE_MB}MB)"
if [ "$OS_CONTENT_SIZE" -gt "$OS_SIZE_MB" ]; then
    echo "ERROR: OS content (${OS_CONTENT_SIZE}MB) exceeds partition size (${OS_SIZE_MB}MB)!"
    echo "Increase OS_SIZE_MB in build.sh."
    exit 1
fi

# =====================================================================
# PHASE 5: CREATE THE RAW DISK IMAGE
# =====================================================================
echo ""
echo "Phase 5: Building the ${TOTAL_SIZE_MB}MB disk image..."

# Create a blank image file
dd if=/dev/zero of="$OUTPUT_IMG" bs=1M count="$TOTAL_SIZE_MB" status=progress

# Attach to a loop device
LOOP_DEV=$(losetup --find --show "$OUTPUT_IMG")
echo "Loop device: $LOOP_DEV"

# =====================================================================
# PHASE 6: PARTITION THE IMAGE
# =====================================================================
echo ""
echo "Phase 6: Creating partition table..."

# Create GPT partition table
sgdisk -Z "$LOOP_DEV"  # Zap any existing table

# Partition 1: BIOS Boot Partition (2MB, required for GRUB on GPT disks)
# GRUB embeds its core.img here — no filesystem, just raw data
sgdisk -n 1:2048:+2M -t 1:EF02 -c 1:"BIOS Boot" "$LOOP_DEV"

# Partition 2: EFI System Partition (FAT32, for UEFI boot)
sgdisk -n 2:0:+${EFI_SIZE_MB}M -t 2:EF00 -c 2:"EFI System" "$LOOP_DEV"

# Partition 3: OS Partition (ext4, holds squashfs + kernel + grub.cfg)
sgdisk -n 3:0:+${OS_SIZE_MB}M -t 3:8300 -c 3:"safekeep-os" "$LOOP_DEV"

# Partition 4: Data Partition (ext4, for the LUKS file container)
sgdisk -n 4:0:+${DATA_SIZE_MB}M -t 4:8300 -c 4:"safekeep-data" "$LOOP_DEV"

# Partition 5: Transfer Partition (exFAT, Mac/Win-readable airlock)
sgdisk -n 5:0:0 -t 5:0700 -c 5:"TRANSFER" "$LOOP_DEV"

echo "Partition layout:"
sgdisk -p "$LOOP_DEV"

# Re-read partition table
partprobe "$LOOP_DEV"
sleep 2

# Determine partition device paths
# Loop partitions are either /dev/loop0p1 or need kpartx
if [ -b "${LOOP_DEV}p1" ]; then
    BIOS_PART="${LOOP_DEV}p1"
    EFI_PART="${LOOP_DEV}p2"
    OS_PART="${LOOP_DEV}p3"
    DATA_PART="${LOOP_DEV}p4"
    TRANSFER_PART="${LOOP_DEV}p5"
else
    # Some systems need kpartx to create partition mappings
    apt-get install -y kpartx 2>/dev/null || true
    kpartx -a "$LOOP_DEV"
    LOOP_NAME=$(basename "$LOOP_DEV")
    BIOS_PART="/dev/mapper/${LOOP_NAME}p1"
    EFI_PART="/dev/mapper/${LOOP_NAME}p2"
    OS_PART="/dev/mapper/${LOOP_NAME}p3"
    DATA_PART="/dev/mapper/${LOOP_NAME}p4"
    TRANSFER_PART="/dev/mapper/${LOOP_NAME}p5"
    sleep 1
fi

echo "BIOS: $BIOS_PART  EFI: $EFI_PART  OS: $OS_PART  Data: $DATA_PART  Transfer: $TRANSFER_PART"

# =====================================================================
# PHASE 7: FORMAT PARTITIONS
# =====================================================================
echo ""
echo "Phase 7: Formatting partitions..."

mkfs.fat -F 32 -n "SK-EFI" "$EFI_PART"
mkfs.ext4 -F -L "safekeep-os" "$OS_PART"
mkfs.ext4 -F -L "safekeep-data" "$DATA_PART"
mkfs.exfat -n "TRANSFER" "$TRANSFER_PART"

# =====================================================================
# PHASE 8: INSTALL BOOT FILES AND OS CONTENT
# =====================================================================
echo ""
echo "Phase 8: Installing boot files and OS content..."

# Mount partitions
mkdir -p "$WORKSPACE/mnt-efi" "$WORKSPACE/mnt-os" "$WORKSPACE/mnt-data"
mount "$EFI_PART" "$WORKSPACE/mnt-efi"
mount "$OS_PART" "$WORKSPACE/mnt-os"

# Copy OS content (squashfs, kernel, initrd, manifest)
mkdir -p "$WORKSPACE/mnt-os/casper"
cp "$STAGING_DIR/casper/filesystem.squashfs" "$WORKSPACE/mnt-os/casper/"
cp "$STAGING_DIR/casper/vmlinuz" "$WORKSPACE/mnt-os/casper/"
cp "$STAGING_DIR/casper/initrd" "$WORKSPACE/mnt-os/casper/"
cp "$STAGING_DIR/casper/filesystem.manifest" "$WORKSPACE/mnt-os/casper/" 2>/dev/null || true
cp "$STAGING_DIR/casper/filesystem.size" "$WORKSPACE/mnt-os/casper/" 2>/dev/null || true

# =====================================================================
# PHASE 9: INSTALL GRUB (UEFI + BIOS)
# =====================================================================
echo ""
echo "Phase 9: Installing GRUB bootloader..."

# --- UEFI GRUB ---
mkdir -p "$WORKSPACE/mnt-efi/EFI/BOOT"
mkdir -p "$WORKSPACE/mnt-efi/boot/grub"

# Create GRUB config
# Uses search-by-label so it works regardless of partition numbering
cat > "$WORKSPACE/mnt-efi/boot/grub/grub.cfg" << 'EOF'
# Load modules needed to find partitions
insmod part_gpt
insmod ext2
insmod fat
insmod search_label
insmod linux
insmod gzio

set timeout=3
set default=0

# Search for the OS partition by label
search --no-floppy --label --set=ospart safekeep-os

# Fallback: if search failed, try common partition paths
if [ -z "$ospart" ]; then
    # On most systems, OS partition is the 3rd GPT partition
    set ospart=hd0,gpt3
fi

set root=${ospart}

menuentry "SafeKeepVault" {
    set root=${ospart}
    # noprompt — suppresses casper's "Please remove the installation medium,
    # then press ENTER" prompt at shutdown. SafeKeep poweroffs are deliberate
    # (dashboard Power Options modal calls sudo poweroff), so the "are you
    # sure?" prompt is not useful — it just leaves a wall of kernel I/O
    # warnings sitting on the screen during the casper eject sequence.
    linux /casper/vmlinuz boot=casper nopersistent noprompt quiet splash ---
    initrd /casper/initrd
}

menuentry "SafeKeepVault (Safe Mode)" {
    set root=${ospart}
    linux /casper/vmlinuz boot=casper nopersistent noprompt nomodeset ---
    initrd /casper/initrd
}
EOF

# Also put a copy of grub.cfg on the OS partition for redundancy
mkdir -p "$WORKSPACE/mnt-os/boot/grub"
cp "$WORKSPACE/mnt-efi/boot/grub/grub.cfg" "$WORKSPACE/mnt-os/boot/grub/grub.cfg"

# Build the UEFI GRUB binary (standalone, no dependency on installed GRUB)
# Explicitly include modules needed to find partitions and boot Linux
grub-mkstandalone \
    --format=x86_64-efi \
    --output="$WORKSPACE/mnt-efi/EFI/BOOT/BOOTX64.EFI" \
    --locales="" \
    --fonts="" \
    --modules="part_gpt ext2 fat search search_label normal linux gzio" \
    "boot/grub/grub.cfg=$WORKSPACE/mnt-efi/boot/grub/grub.cfg"

# --- BIOS GRUB ---
# Install GRUB for BIOS/legacy boot to the loop device's MBR
# grub-install embeds the FAT32 volume serial number in core.img so it can
# find /boot/grub/grub.cfg on the EFI partition after flashing — this survives
# dd since the serial number is baked into the filesystem.
grub-install \
    --target=i386-pc \
    --boot-directory="$WORKSPACE/mnt-efi/boot" \
    --recheck \
    --modules="part_gpt ext2 fat search search_label normal linux gzio" \
    "$LOOP_DEV"

echo "GRUB installed for both UEFI and BIOS boot."

# =====================================================================
# PHASE 10: FINALIZE
# =====================================================================
echo ""
echo "Phase 10: Finalizing image..."

# Unmount everything. Lazy detachment for the same defense-in-depth
# reason as cleanup() and the Phase 3 unmounts: if any process is
# still holding a file handle on the EFI or OS partition (e.g. a
# stray child of grub-install that didn't reap), a regular umount
# would fail with EBUSY and the subsequent `losetup -d` would also
# fail, leaving a dangling loop device on the host.
umount -l "$WORKSPACE/mnt-efi" 2>/dev/null || true
umount -l "$WORKSPACE/mnt-os" 2>/dev/null || true

# Clean up kpartx mappings if used
if [ -f /dev/mapper/"$(basename "$LOOP_DEV")p1" ]; then
    kpartx -d "$LOOP_DEV" 2>/dev/null || true
fi

# Detach loop device
losetup -d "$LOOP_DEV"
unset LOOP_DEV  # Prevent cleanup trap from trying again

echo ""
echo "========================================="
echo "  Build Complete!"
echo "========================================="
echo ""
echo "  Output: $OUTPUT_IMG ($(du -h "$OUTPUT_IMG" | awk '{print $1}'))"
echo ""
echo "  Partition layout:"
echo "    1. BIOS Boot   (2MB)                      — GRUB for legacy PCs"
echo "    2. EFI System  (${EFI_SIZE_MB}MB, FAT32)  — GRUB for UEFI PCs/Macs"
echo "    3. OS          (${OS_SIZE_MB}MB, ext4)     — SafeKeep Linux"
echo "    4. Data        (${DATA_SIZE_MB}MB, ext4)   — LUKS vault container"
echo "    5. Transfer    (${TRANSFER_SIZE_MB}MB, exFAT) — Airlock (Mac/Win readable)"
echo ""
echo "  To flash to USB (4GB+ drive):"
echo "    Linux/Mac:  sudo dd if=$OUTPUT_IMG of=/dev/sdX bs=4M status=progress && sync"
echo "    Windows:    Use Rufus (DD mode) or balenaEtcher"
echo ""
echo "  After flashing, just boot — the setup wizard runs automatically on first boot."
echo "  No post-flash scripts needed!"

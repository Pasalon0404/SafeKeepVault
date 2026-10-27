#!/bin/bash
set -e

# =============================================================================
# SafeKeep OS Build Script
# Produces a 6.7GB raw disk image (.img) sized for 8GB+ USB drives.
# Pre-baked partitions:
#   Partition 1: BIOS Boot (2MB)          — GRUB core.img for legacy PCs
#   Partition 2: EFI System (256MB, FAT32) — GRUB for UEFI boot
#   Partition 3: OS (3584MB, ext4)         — two OS slots, casper-a/ and
#                                            casper-b/ (squashfs, kernel,
#                                            initrd), and slot.cfg
#   Partition 4: Data (300MB, ext4)        — LUKS file-container vault
#   Partition 5: Transfer (2560MB, exFAT)  — Airlock for Mac/Win file exchange
#
# The OS goes into slot A; slot B stays empty until the first update
# (UPDATER_DESIGN.md). The Transfer Drive is big enough to carry an update
# file. The image's empty space compresses away, so the release zip stays
# about the size of the OS.
#
# The user flashes safekeep.img to any 8GB+ USB drive and boots.
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
OS_SIZE_MB=3584       # two OS slots (~1.3GB each today) with room to grow
DATA_SIZE_MB=300      # LUKS vault file container
TRANSFER_SIZE_MB=2560 # exFAT airlock partition (Mac/Win readable); holds an update file
# 1MB before partition 1 + the partitions + 1MB for the backup GPT.
# 6704MB fits the smallest real "8GB" sticks (about 7,400MB usable).
TOTAL_SIZE_MB=$(( 1 + 2 + EFI_SIZE_MB + OS_SIZE_MB + DATA_SIZE_MB + TRANSFER_SIZE_MB + 1 ))

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

# The maintainer's public key goes into the image, so the stick can check
# signed updates (UPDATER_DESIGN.md). Pinned here: a different key in
# config/ stops the build.
MAINTAINER_FPR="A333EB826F70A79A736F09948EA7DD8CEDBA86C2"
MAINTAINER_KEY="config/maintainer-pubkey.asc"
for f in grub.cfg .disk_label .disk_label_2x "$MAINTAINER_KEY" safekeep-pwcheck.py pwcheck-lists.json passphrase-dialogs.sh safekeep-passphrase.py change-passphrase.sh quiet-downloads/manifest.json quiet-downloads/background.js; do
    [ -s "$f" ] || { echo "ERROR: $f is missing (rsync the whole usbbootdrive folder)." >&2; exit 1; }
done

# The compiled web app must be in src/dist before anything slow happens —
# rsync'd from the Mac, or produced by prepare-app.sh from a repo checkout.
# Without this check, a missing app only showed up after booting the image.
if [ ! -s src/dist/boot.html ]; then
    echo "ERROR: src/dist/boot.html missing — the image would have no app." >&2
    echo "       Copy the compiled app into src/dist/, or run (without sudo):" >&2
    echo "       bash prepare-app.sh" >&2
    exit 1
fi

# =====================================================================
# PHASE 1: HOST DEPENDENCIES
# =====================================================================
echo "Phase 1: Checking host dependencies..."
DEPS_NEEDED=""
command -v debootstrap >/dev/null || DEPS_NEEDED="$DEPS_NEEDED debootstrap"
command -v mksquashfs >/dev/null || DEPS_NEEDED="$DEPS_NEEDED squashfs-tools"
command -v sgdisk >/dev/null || DEPS_NEEDED="$DEPS_NEEDED gdisk"
command -v gpg >/dev/null || DEPS_NEEDED="$DEPS_NEEDED gnupg"
command -v grub-install >/dev/null || DEPS_NEEDED="$DEPS_NEEDED grub-pc-bin grub-efi-amd64-bin"
command -v mkfs.fat >/dev/null || DEPS_NEEDED="$DEPS_NEEDED dosfstools"
command -v mkfs.ext4 >/dev/null || DEPS_NEEDED="$DEPS_NEEDED e2fsprogs"
command -v mtools >/dev/null || DEPS_NEEDED="$DEPS_NEEDED mtools"
command -v mkfs.exfat >/dev/null || DEPS_NEEDED="$DEPS_NEEDED exfatprogs"
command -v curl >/dev/null || DEPS_NEEDED="$DEPS_NEEDED curl"

if [ -n "$DEPS_NEEDED" ]; then
    echo "Installing missing dependencies:$DEPS_NEEDED"
    apt-get update
    apt-get install -y $DEPS_NEEDED
else
    echo "All dependencies present."
fi

# --- Ubuntu's signed UEFI boot chain, pinned (SECURE_BOOT.md) ---
# shim (signed by Microsoft) starts GRUB (signed by Canonical), which starts
# Ubuntu's kernel (signed by Canonical), so the stick boots with Secure Boot
# on. Both packages are pinned by version and SHA-256, like Chromium; any
# other file stops the build. Fetched now so a problem shows up in the first
# minute, not after the 20-minute build. To move to newer ones: change the
# four values below in a PR (SECURE_BOOT.md, "Updating the signed boot files").
SHIM_DEB="shim-signed_1.58+15.8-0ubuntu1_amd64.deb"
SHIM_DEB_SHA256="ba9b5d80e5d886c30664f2bebfb5c2fcce3b9b40f16fc46cba49c19a91c8059c"
SIGNED_GRUB_DEB="grub-efi-amd64-signed_1.202.5+2.12-1ubuntu7.3_amd64.deb"
SIGNED_GRUB_DEB_SHA256="8bd5cd99c3af82aab23af0f15f54c91799f343416412e122df661ef36a44a511"
SIGNED_BOOT="$WORKSPACE/signed-boot"
fetch_pinned_deb() {   # <pool path> <file> <sha256>
    local dest="$SIGNED_BOOT/$2" url
    if [ -f "$dest" ] && [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$3" ]; then return 0; fi
    # The archive drops superseded update versions after a while; Launchpad
    # keeps every version. The pinned hash makes either source safe.
    for url in "http://archive.ubuntu.com/ubuntu/pool/main/$1/$2" \
               "https://launchpad.net/ubuntu/+archive/primary/+files/$2"; do
        if curl -fsSL -o "$dest" "$url" && [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$3" ]; then
            return 0
        fi
    done
    rm -f "$dest"
    echo "ERROR: could not fetch $2 with SHA-256 $3." >&2
    exit 1
}
echo "Fetching the pinned signed boot files..."
mkdir -p "$SIGNED_BOOT"
fetch_pinned_deb s/shim-signed "$SHIM_DEB" "$SHIM_DEB_SHA256"
fetch_pinned_deb g/grub2-signed "$SIGNED_GRUB_DEB" "$SIGNED_GRUB_DEB_SHA256"
rm -rf "$SIGNED_BOOT/x"
dpkg-deb -x "$SIGNED_BOOT/$SHIM_DEB" "$SIGNED_BOOT/x"
dpkg-deb -x "$SIGNED_BOOT/$SIGNED_GRUB_DEB" "$SIGNED_BOOT/x"
SHIM_EFI="$SIGNED_BOOT/x/usr/lib/shim/shimx64.efi.signed.latest"
MM_EFI="$SIGNED_BOOT/x/usr/lib/shim/mmx64.efi"
GRUB_EFI="$SIGNED_BOOT/x/usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed"
for f in "$SHIM_EFI" "$MM_EFI" "$GRUB_EFI"; do
    [ -s "$f" ] || { echo "ERROR: $f missing from the pinned packages." >&2; exit 1; }
done
echo "  OK: $SHIM_DEB, $SIGNED_GRUB_DEB (SHA-256 match)."

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
# The chroot is about to be rebuilt — it is no longer "complete" until the
# marker below is re-written after hardening (quick-update.sh relies on this).
# Remove the completion proofs FIRST, then the trees — so a build canceled
# mid-deletion can never leave "proof" next to a half-deleted chroot.
rm -f "$WORKSPACE/.chroot-complete"
rm -f "$OUTPUT_IMG"
rm -rf --one-file-system "$CHROOT_DIR"
rm -rf --one-file-system "$STAGING_DIR"
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
cp -r src/dist/* "$CHROOT_DIR/opt/safekeep/"

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
cp change-passphrase.sh "$CHROOT_DIR/usr/local/bin/change-passphrase"
chmod +x "$CHROOT_DIR/usr/local/bin/change-passphrase"
cp safekeep-boot.sh "$CHROOT_DIR/usr/local/bin/safekeep-boot"
chmod +x "$CHROOT_DIR/usr/local/bin/safekeep-boot"
cp safekeep-harden.sh "$CHROOT_DIR/usr/local/bin/safekeep-harden"
chmod +x "$CHROOT_DIR/usr/local/bin/safekeep-harden"

# Coldcard USB signing: helper + hash-pinned library lists. chroot-setup.sh
# installs the library from these lists, then deletes them.
mkdir -p "$CHROOT_DIR/usr/local/lib/safekeep"
install -m 755 safekeep-coldcard.py "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-coldcard.py"
install -m 644 config/ckcc-requirements.txt "$CHROOT_DIR/ckcc-requirements.txt"
install -m 644 config/ckcc-build-requirements.txt "$CHROOT_DIR/ckcc-build-requirements.txt"
# Trezor USB signing: helper + hash-pinned HWI list (same pattern as above).
install -m 755 safekeep-trezor.py "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-trezor.py"
install -m 644 config/hwi-requirements.txt "$CHROOT_DIR/hwi-requirements.txt"
# Updater: installs a signed update into the spare OS slot (UPDATER_DESIGN.md).
install -m 755 safekeep-update.py "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-update.py"
# Password strength check: setup-vault.sh and the backup watcher refuse a
# Weak password (PASSPHRASE_STRENGTH_DESIGN.md).
install -m 755 safekeep-pwcheck.py "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-pwcheck.py"
mkdir -p "$CHROOT_DIR/usr/local/share/safekeep"
install -m 644 pwcheck-lists.json "$CHROOT_DIR/usr/local/share/safekeep/pwcheck-lists.json"
# The passphrase screens shared by setup-vault and change-passphrase, and
# the root helper that checks or changes the Master Passphrase.
install -m 644 passphrase-dialogs.sh "$CHROOT_DIR/usr/local/lib/safekeep/passphrase-dialogs.sh"
install -m 755 safekeep-passphrase.py "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-passphrase.py"
# Chromium extension that hides "Download started" for the app's request
# files (safekeep-boot.sh loads it with --load-extension).
install -d -m 755 "$CHROOT_DIR/usr/local/lib/safekeep/quiet-downloads"
install -m 644 quiet-downloads/manifest.json quiet-downloads/background.js "$CHROOT_DIR/usr/local/lib/safekeep/quiet-downloads/"

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
    "AutomaticDownloadsAllowedForUrls": ["file://*", "file:///*"],
    "DefaultAutomaticDownloadsSetting": 1
}
POLICY_EOF
echo "Chromium enterprise policy installed at /etc/chromium/policies/managed/safekeep.json"

# Bind-mount host systems for chroot
mount --bind /dev "$CHROOT_DIR/dev"
# The chroot gets its own empty /run, NOT the build machine's. With the
# host's /run bound in, package scripts inside the chroot wrote to the
# host: installing the image's kernel created the build machine's own
# /run/reboot-required, so it asked to be restarted after every full
# build. DNS doesn't need the host's /run (resolv.conf is copied below).
mount -t tmpfs -o mode=0755,size=64M tmpfs "$CHROOT_DIR/run"
mkdir -p "$CHROOT_DIR/run/lock"
chmod 1777 "$CHROOT_DIR/run/lock"
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
# SAFEKEEP_DEV_SHELL=1 adds the Terminal and File Explorer (troubleshooting
# only — a release image must never have them). Anything else means off.
SAFEKEEP_DEV_SHELL="${SAFEKEEP_DEV_SHELL:-0}"
[ "$SAFEKEEP_DEV_SHELL" = "1" ] || SAFEKEEP_DEV_SHELL=0
if [ "$SAFEKEEP_DEV_SHELL" = "1" ]; then
    echo ""
    echo "!!! DEVELOPER BUILD: Terminal (Ctrl+Alt+T) and File Explorer enabled — NOT for release !!!"
    echo ""
fi
# UC_*: Chromium pin overrides (chroot-setup.sh); empty means its defaults.
chroot "$CHROOT_DIR" /usr/bin/env SAFEKEEP_DEV_SHELL="$SAFEKEEP_DEV_SHELL" \
    UC_PIN_TAG="${UC_PIN_TAG:-}" UC_EXPECTED_SHA256="${UC_EXPECTED_SHA256:-}" UC_ALLOW_UNPINNED="${UC_ALLOW_UNPINNED:-}" \
    /bin/bash -c "/chroot-setup.sh"

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

# Maintainer key for checking signed updates, as a binary keyring for gpgv.
KEY_FPR=$(GNUPGHOME=$(mktemp -d) gpg --batch --with-colons --show-keys "$MAINTAINER_KEY" 2>/dev/null \
    | awk -F: '$1=="fpr" {print $10; exit}')
if [ "$KEY_FPR" != "$MAINTAINER_FPR" ]; then
    echo "ERROR: $MAINTAINER_KEY has fingerprint '$KEY_FPR', expected $MAINTAINER_FPR." >&2
    exit 1
fi
mkdir -p "$CHROOT_DIR/usr/local/share/safekeep"
GNUPGHOME=$(mktemp -d) gpg --batch --yes --dearmor -o "$CHROOT_DIR/usr/local/share/safekeep/maintainer.gpg" "$MAINTAINER_KEY"
chmod 644 "$CHROOT_DIR/usr/local/share/safekeep/maintainer.gpg"
chroot "$CHROOT_DIR" gpgv --version >/dev/null 2>&1 \
    || { echo "ERROR: gpgv is missing from the image; the stick could not check signed updates." >&2; exit 1; }
echo "Maintainer key installed ($MAINTAINER_FPR); gpgv present."

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
# Mark the chroot as fully set up AND hardened — quick-update.sh refuses to
# reuse a chroot without this (a canceled build leaves a half-configured tree).
date -u +%Y-%m-%dT%H:%M:%SZ > "$WORKSPACE/.chroot-complete"

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

# Check that TWO copies of the OS fit in the OS partition: an update writes
# the new OS into the idle slot while the running one stays (UPDATER_DESIGN.md).
# The 160MB margin covers ext4's own overhead (journal, reserved blocks).
OS_CONTENT_SIZE=$(du -sm "$STAGING_DIR" | awk '{print $1}')
echo "OS content size: ${OS_CONTENT_SIZE}MB per slot (partition: ${OS_SIZE_MB}MB for two slots)"
if [ $(( OS_CONTENT_SIZE * 2 + 160 )) -gt "$OS_SIZE_MB" ]; then
    echo "ERROR: two copies of the OS (2 x ${OS_CONTENT_SIZE}MB) don't fit the ${OS_SIZE_MB}MB OS partition."
    echo "Increase OS_SIZE_MB in build.sh (and TOTAL_SIZE_MB follows)."
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

# Partition 3: OS Partition (ext4, holds the two OS slots + slot.cfg)
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

# Copy OS content (squashfs, kernel, initrd, manifest) into slot A, and
# point slot.cfg at it. casper-b/ is created by the first update.
mkdir -p "$WORKSPACE/mnt-os/casper-a"
cp "$STAGING_DIR/casper/filesystem.squashfs" "$WORKSPACE/mnt-os/casper-a/"
cp "$STAGING_DIR/casper/vmlinuz" "$WORKSPACE/mnt-os/casper-a/"
cp "$STAGING_DIR/casper/initrd" "$WORKSPACE/mnt-os/casper-a/"
cp "$STAGING_DIR/casper/filesystem.manifest" "$WORKSPACE/mnt-os/casper-a/" 2>/dev/null || true
cp "$STAGING_DIR/casper/filesystem.size" "$WORKSPACE/mnt-os/casper-a/" 2>/dev/null || true
printf 'set slot=a\n' > "$WORKSPACE/mnt-os/slot.cfg"

# =====================================================================
# PHASE 9: INSTALL GRUB (UEFI + BIOS)
# =====================================================================
echo ""
echo "Phase 9: Installing GRUB bootloader..."

# --- UEFI GRUB ---
mkdir -p "$WORKSPACE/mnt-efi/EFI/BOOT"
mkdir -p "$WORKSPACE/mnt-efi/boot/grub"

# GRUB config: grub.cfg (next to this script) finds the OS partition by
# label, reads slot.cfg and boots that slot, falling back to the other slot
# if the named one has no kernel.
[ -s grub.cfg ] || { echo "ERROR: grub.cfg is missing (it sits next to build.sh)."; exit 1; }
cp grub.cfg "$WORKSPACE/mnt-efi/boot/grub/grub.cfg"

# Also put a copy of grub.cfg on the OS partition for redundancy
mkdir -p "$WORKSPACE/mnt-os/boot/grub"
cp "$WORKSPACE/mnt-efi/boot/grub/grub.cfg" "$WORKSPACE/mnt-os/boot/grub/grub.cfg"

# UEFI: Ubuntu's signed chain, so the stick boots with Secure Boot on.
#   EFI/BOOT/BOOTX64.EFI  shim, signed by Microsoft; the firmware starts it
#                         from removable media. It checks and starts:
#   EFI/BOOT/grubx64.efi  GRUB, signed by Canonical. It has its modules built
#                         in and reads its config from its prefix, /EFI/ubuntu:
#   EFI/ubuntu/grub.cfg   the same grub.cfg as the BIOS GRUB uses.
#   EFI/BOOT/mmx64.efi    MokManager, which shim shows if a check fails.
# shim's fbx64.efi is left out on purpose: on a stick it would add boot
# entries to every computer it starts on. shim does record its revocation
# list (SbatLevel) in each computer's firmware, as Windows Update does.
cp "$SHIM_EFI" "$WORKSPACE/mnt-efi/EFI/BOOT/BOOTX64.EFI"
cp "$GRUB_EFI" "$WORKSPACE/mnt-efi/EFI/BOOT/grubx64.efi"
cp "$MM_EFI"   "$WORKSPACE/mnt-efi/EFI/BOOT/mmx64.efi"
mkdir -p "$WORKSPACE/mnt-efi/EFI/ubuntu"
cp grub.cfg "$WORKSPACE/mnt-efi/EFI/ubuntu/grub.cfg"
echo "  Signed boot files (SHA-256):"
(cd "$WORKSPACE/mnt-efi/EFI" && sha256sum BOOT/BOOTX64.EFI BOOT/grubx64.efi BOOT/mmx64.efi | sed 's/^/    /')

# Name the stick in Mac boot menus: "SafeKeep" instead of "EFI Boot".
# Apple's Option-key menu shows .disk_label (_2x on Retina screens), a small
# picture of the name made once on a Mac with `bless --label SafeKeep`.
# OpenCore's menu shows the plain-text .contentDetails. PC boot menus name
# the stick after its hardware, which nothing on the stick can change.
cp .disk_label .disk_label_2x "$WORKSPACE/mnt-efi/EFI/BOOT/"
printf 'SafeKeep' > "$WORKSPACE/mnt-efi/EFI/BOOT/.contentDetails"

# --- BIOS GRUB ---
# Install GRUB for BIOS/legacy boot to the loop device's MBR
# grub-install embeds the FAT32 volume serial number in core.img so it can
# find /boot/grub/grub.cfg on the EFI partition after flashing — this survives
# dd since the serial number is baked into the filesystem.
grub-install \
    --target=i386-pc \
    --boot-directory="$WORKSPACE/mnt-efi/boot" \
    --recheck \
    --modules="part_gpt ext2 fat search search_label normal linux gzio test configfile" \
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
echo "    3. OS          (${OS_SIZE_MB}MB, ext4)     — SafeKeep Linux, slots A and B"
echo "    4. Data        (${DATA_SIZE_MB}MB, ext4)   — LUKS vault container"
echo "    5. Transfer    (${TRANSFER_SIZE_MB}MB, exFAT) — Airlock (Mac/Win readable)"
echo ""
echo "  To flash to USB (8GB+ drive):"
echo "    Linux/Mac:  sudo dd if=$OUTPUT_IMG of=/dev/sdX bs=4M status=progress && sync"
echo "    Windows:    Use Rufus (DD mode) or balenaEtcher"
echo ""
echo "  After flashing, just boot — the setup wizard runs automatically on first boot."
echo "  No post-flash scripts needed!"

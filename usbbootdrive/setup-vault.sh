#!/bin/bash
# ============================================================================
# setup-vault — First-Boot Initialization & OS Hardening for SafeKeep
# ============================================================================
#
# This script runs ONCE on the very first boot. It performs two operations
# in sequence:
#
#   PHASE 1: Create the encrypted LUKS vault (user password setup)
#   PHASE 2: Scorched-earth OS hardening (network kill, host storage
#            blacklist, printer purge, automount firewall, BadUSB defense)
#
# After both phases complete, it writes a persistent state marker
# (.setup_complete) to the data partition and triggers a mandatory
# reboot so the initramfs-baked module blacklists take effect.
#
# STATE LOCK:
#   The marker file lives at /mnt/safekeep-data/.setup_complete on the
#   ext4 data partition (Partition 4, label "safekeep-data"). This
#   partition is persistent across reboots — unlike the casper overlay
#   (which resets on each boot), files on safekeep-data survive forever.
#
#   safekeep-boot.sh checks for this marker BEFORE calling setup-vault.
#   If the marker exists, setup-vault is never invoked. The heavy
#   initialization (LUKS format, module blacklists, initramfs rebuild,
#   package purge) runs exactly once in the device's lifetime.
#
# EXECUTION:
#   Called automatically by safekeep-boot.sh on first boot.
#   Can also be invoked manually via Ctrl+Alt+S (Openbox keybind).
#
# USB PARTITION MAP (for reference):
#   Partition 1: BIOS Boot   (1MB, raw)
#   Partition 2: EFI System  (100MB, FAT32, label "SK-EFI")
#   Partition 3: OS          (ext4, label "safekeep-os")
#   Partition 4: Data        (300MB, ext4, label "safekeep-data")
#   Partition 5: Transfer    (300MB, exFAT, label "TRANSFER")
#
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# GTK UI SCALING — double zenity dialog size for readability on HiDPI and
# small-screen laptops. GDK_SCALE is an integer widget-scale factor that
# uniformly doubles every GTK element (text, radio buttons, padding, window
# chrome, window bounds). GDK_DPI_SCALE is pinned to 1.0 to prevent compounding:
# if left unset the user's environment might supply a font-DPI scale that
# would multiply on top of GDK_SCALE's widget scale, producing over-large
# text inside normally-sized buttons. Applied only to zenity/GTK — Chromium
# honors its own --force-device-scale-factor flag and is unaffected.
# ----------------------------------------------------------------------------
export GDK_SCALE=2
export GDK_DPI_SCALE=1.0

DATA_LABEL="safekeep-data"
DATA_MOUNT="/mnt/safekeep-data"
VAULT_FILE=".vault.luks"
VAULT_MOUNT="/media/.safekeep-vault"
MAPPER_NAME="vault"
SETUP_MARKER=".setup_complete"

# ===================================================================
# PHASE 0: PRE-FLIGHT CHECKS
# ===================================================================

# --- Find the writable data partition ---
DATA_PART=$(blkid -L "$DATA_LABEL" 2>/dev/null || true)

if [ -z "$DATA_PART" ]; then
    zenity --error --title="Setup Error" --width=450 \
        --text="No writable storage partition found (label: $DATA_LABEL).\n\nThe USB drive needs to be prepared with the post-flash setup script first.\n\nOn your build machine after flashing:\n  sudo bash post-flash-setup.sh /dev/sdX"
    exit 1
fi

# --- Mount the data partition ---
sudo mkdir -p "$DATA_MOUNT"
if ! mountpoint -q "$DATA_MOUNT"; then
    sudo mount "$DATA_PART" "$DATA_MOUNT"
fi

# --- State Lock: Has first-boot already completed? ---
# If the marker exists, BOTH the vault AND the OS hardening are done.
# This is the primary gate that prevents the script from running twice.
if [ -f "$DATA_MOUNT/$SETUP_MARKER" ]; then
    # Vault already exists too — just tell the user
    if [ -f "$DATA_MOUNT/$VAULT_FILE" ]; then
        sudo umount "$DATA_MOUNT" 2>/dev/null || true
        zenity --info --title="Already Initialized" --width=400 \
            --text="SafeKeep has already been initialized on this device.\n\nYour encrypted vault is set up and the OS is hardened.\n\nUse 'Unlock Vault' (Ctrl+Alt+U) to access your data."
        exit 0
    fi
fi

# --- Check if vault file already exists (without the state marker) ---
# This handles the edge case where setup-vault was interrupted AFTER
# creating the vault but BEFORE the hardening phase completed.
# In this case we skip vault creation and jump to hardening.
SKIP_VAULT=false
if [ -f "$DATA_MOUNT/$VAULT_FILE" ]; then
    SKIP_VAULT=true
fi

# ===================================================================
# PHASE 1: ENCRYPTED VAULT CREATION
# ===================================================================
# Creates a LUKS-encrypted file container on the data partition.
# Uses a loop device (virtual block device) so we don't need raw
# partition access, which the kernel locks on the boot device.
# ===================================================================

if [ "$SKIP_VAULT" = false ]; then

    # --- Calculate available space ---
    AVAIL_KB=$(df -k "$DATA_MOUNT" | tail -1 | awk '{print $4}')
    AVAIL_MB=$((AVAIL_KB / 1024))
    VAULT_MB=$((AVAIL_MB - 50))  # Reserve 50MB for filesystem overhead

    if [ "$VAULT_MB" -lt 50 ]; then
        sudo umount "$DATA_MOUNT"
        zenity --error --title="Not Enough Space" --width=400 \
            --text="Only ${AVAIL_MB}MB available on the data partition.\nNeed at least 100MB for the encrypted vault."
        exit 1
    fi

    # --- Welcome dialog ---
    zenity --question --title="SafeKeepVault — First Boot Setup" --width=450 \
        --text="Welcome to SafeKeepVault!\n\nThis one-time setup will:\n\n  1. Create an encrypted vault for your seed words, passphrases, encrypted notes and other data\n  2. Lock down the OS (disable networks, block host drives)\n  3. Reboot to apply kernel-level protections\n\nThis takes about 60 seconds. Continue?" \
        --ok-label="Begin Setup" \
        --cancel-label="Cancel"

    # --- Get the master passphrase ---
    # KEYBOARD UX (Enter-to-submit, no mouse required):
    #   We deliberately use plain `--list` instead of `--list --radiolist`
    #   here. The radiolist widget intercepts Enter to toggle the radio
    #   selection state, forcing the user to mouse-click OK (or Tab to OK
    #   then press Enter) to submit. With a plain single-column `--list`,
    #   the first row is auto-highlighted on dialog open, arrow keys move
    #   the highlight, and pressing Enter on the highlighted row activates
    #   it — which IS the submit action for `--list`. Result: a user
    #   running through first-boot setup in QR mode just presses Enter
    #   immediately to accept "Scan QR Code" with zero mouse interaction.
    #
    #   --hide-header drops the column header for a cleaner look since the
    #   column name ("Method") is redundant given the --text label above.
    if ls /dev/video* 1>/dev/null 2>&1; then
        INPUT_METHOD=$(zenity --list --title="Lock Your Vault" \
            --text="How would you like to set your Master Passphrase?" \
            --column="Method" --hide-header \
            "Scan QR Code" "Type Manually")
        if [ -z "$INPUT_METHOD" ]; then
            sudo umount "$DATA_MOUNT"
            exit 1
        fi
    else
        INPUT_METHOD="Type Manually"
    fi

    if [ "$INPUT_METHOD" = "Scan QR Code" ]; then
        zenity --info --title="Scan QR" --width=350 \
            --text="Hold your SafeKeep QR code up to the camera.\nThe window will close automatically once read."
        PASSWORD=$(zbarcam -1 --raw -Sdisable -Sqr.enable)
    else
        # KEYBOARD UX: zenity --password places focus on the entry field
        # by default; the OK button is the default action, so Enter from
        # the entry field submits without a mouse click. --ok-label makes
        # the action verb explicit so it's obvious what Enter will do.
        PASSWORD=$(zenity --password --title="Lock Your Vault" \
            --text="Enter your Master Passphrase:" \
            --ok-label="Set Passphrase")
    fi

    if [ -z "$PASSWORD" ]; then
        sudo umount "$DATA_MOUNT"
        zenity --error --text="No passphrase received. Setup aborted."
        exit 1
    fi

    # --- Create the LUKS vault ---
    (
    echo "5"; echo "# Creating vault container (${VAULT_MB}MB)..."
    sudo dd if=/dev/zero of="$DATA_MOUNT/$VAULT_FILE" bs=1M count="$VAULT_MB" status=none

    echo "20"; echo "# Attaching loop device..."
    LOOP_DEV=$(sudo losetup --find --show "$DATA_MOUNT/$VAULT_FILE")

    echo "35"; echo "# Encrypting vault with LUKS..."
    printf '%s' "$PASSWORD" | sudo cryptsetup luksFormat -q "$LOOP_DEV" --key-file=-

    echo "50"; echo "# Opening encrypted vault..."
    printf '%s' "$PASSWORD" | sudo cryptsetup open "$LOOP_DEV" "$MAPPER_NAME" --key-file=-
    udevadm settle --timeout=10

    echo "65"; echo "# Formatting vault filesystem..."
    sudo mkfs.ext4 -F -L safekeep-vault /dev/mapper/"$MAPPER_NAME"

    # Clean up the vault (remove lost+found, create seeds dir)
    sudo mkdir -p "$VAULT_MOUNT"
    sudo mount /dev/mapper/"$MAPPER_NAME" "$VAULT_MOUNT"
    sudo rm -rf "$VAULT_MOUNT/lost+found"
    sudo umount "$VAULT_MOUNT"

    echo "80"; echo "# Sealing vault..."
    sudo cryptsetup close "$MAPPER_NAME"
    sudo losetup -d "$LOOP_DEV"

    echo "95"; echo "# Writing state marker..."

    # Write the state lock marker to the persistent data partition.
    # This tells safekeep-boot.sh that first-boot initialization is complete.
    # On all future boots, the system skips straight to vault unlock.
    cat > "$DATA_MOUNT/$SETUP_MARKER" << MARKEREOF
# SafeKeep First-Boot Initialization Complete
# This file prevents setup-vault from running again.
# Delete this file ONLY if you need to re-create the vault.
timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
vault_created=true
hardening=build-time
MARKEREOF

    echo "100"; echo "# Vault created successfully!"
    ) | zenity --progress --title="SafeKeep — Creating Encrypted Vault" \
        --auto-close --no-cancel --width=450

    # Clear password from memory (best effort — bash doesn't guarantee this)
    unset PASSWORD

fi  # end SKIP_VAULT


# ===================================================================
# NOTE: OS Hardening is applied at BUILD TIME by safekeep-harden.sh.
# ===================================================================
# Module blacklists, udev rules, polkit/dconf lockdowns, systemd
# service masks, CUPS removal, and the initramfs rebuild are all
# performed inside the chroot during `build.sh`. These configs are
# baked into the squashfs and persist across every boot — the casper
# overlay resets, but the read-only lower layer never changes.
#
# This replaces the previous Phase 2 (runtime hardening), which wrote
# to the volatile casper overlay and was lost on every reboot — meaning
# the OS was unhardened on every boot after the first.
# ===================================================================


# ===================================================================
# PHASE 2: MANDATORY SHUTDOWN
# ===================================================================
# A full shutdown (rather than a reboot) after vault creation gives
# the user a clean window to physically remove the USB, plug it into
# another machine, and pre-stage an existing .7z backup onto the
# transfer partition BEFORE powering the vault back on for restore.
# This was impossible with a reboot — the drive stayed hot and the
# user was forced straight into the unlock prompt.
#
# All hardening (module blacklists, dconf, etc.) is baked into the
# squashfs/initramfs at build time and is already active, so no
# second boot is required to enforce security — shutdown is safe.
#
# After the user powers the machine back on:
#   - safekeep-boot.sh runs again
#   - Sees .setup_complete marker → skips setup-vault entirely
#   - Sees .vault.luks exists → runs unlock-vault
#   - User enters passphrase → Chromium launches
# ===================================================================

# Unmount the data partition cleanly before shutdown
sudo umount "$DATA_MOUNT" 2>/dev/null || true

zenity --info --title="SafeKeepVault — Setup Complete" --width=450 \
    --text="Your SafeKeep device is initialized!\n\n  ✓ Encrypted vault created and locked\n  ✓ All networks permanently disabled (build-time)\n  ✓ Host machine drives blocked (build-time)\n  ✓ USB automount firewall active (build-time)\n  ✓ BadUSB defense enabled (build-time)\n\nThe system will now shut down.\n\nOnce the machine is fully powered off, it is safe\nto remove the USB. If you have an existing .7z\nbackup, plug the USB into another computer and\ncopy the backup onto the TRANSFER partition. Then\nreturn the USB to this machine and power on to\nunlock your vault.\n\nClick OK to shut down now."

sync

# -------------------------------------------------------------------
# SHUTDOWN FENCE — prevents first-boot race condition
# -------------------------------------------------------------------
# `sudo poweroff` returns exit 0 the INSTANT it signals systemd, but
# the OS takes ~10 seconds to actually tear the system down. Without
# a fence, this script returns to its caller (safekeep-boot.sh),
# which falls through to the unlock-vault block and flashes the
# "Unlock Vault" dialog at the user during the shutdown window.
#
# We issue the poweroff request, then `exec sleep infinity` so this
# process is REPLACED with sleep and can never return. When systemd
# brings the system down, sleep is killed cleanly as part of shutdown.
#
# `systemctl poweroff` is tried first (more reliable under set -e
# because it integrates with the unit manager); `sudo poweroff` is
# the fallback. Either way, we fence afterwards — the race condition
# applies to shutdowns exactly as it did to reboots.
# -------------------------------------------------------------------
sudo systemctl poweroff 2>/dev/null || sudo poweroff || true
exec sleep infinity

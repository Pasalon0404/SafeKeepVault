#!/bin/bash
# ============================================================================
# setup-vault — First-Boot Initialization & OS Hardening for SafeKeep
# ============================================================================
#
# This script runs ONCE on the very first boot:
#
#   PHASE 1: Create the encrypted LUKS vault (user password setup).
#            The passphrase is typed visibly and twice, so a typo is
#            caught before the vault is locked with it.
#   PHASE 2: Ask the user what to do next:
#              - Continue now (default): exit 0. safekeep-boot.sh goes
#                straight to the normal unlock prompt, where the user
#                proves the new passphrase works and the session starts.
#              - Shut down: power off so the user can copy a .7z backup
#                onto the TRANSFER partition from another computer.
#
# OS hardening is NOT done here — it is baked into the image at build
# time by safekeep-harden.sh, so no reboot is needed to apply it.
#
# Vault creation writes a persistent state marker (.setup_complete) to
# the data partition.
#
# STATE LOCK:
#   The marker file lives at /mnt/safekeep-data/.setup_complete on the
#   ext4 data partition (Partition 4, label "safekeep-data"). This
#   partition is persistent across reboots — unlike the casper overlay
#   (which resets on each boot), files on safekeep-data survive forever.
#
#   safekeep-boot.sh checks for this marker BEFORE calling setup-vault.
#   If the marker exists, setup-vault is never invoked, so the LUKS
#   format runs once per vault (again only after a factory reset).
#
# EXECUTION:
#   Called automatically by safekeep-boot.sh on first boot.
#   Can also be invoked manually via Ctrl+Alt+S (Openbox keybind).
#
# USB PARTITION MAP (for reference):
#   (sizes are set in build.sh)
#   Partition 1: BIOS Boot   (2MB, raw)
#   Partition 2: EFI System  (256MB, FAT32, label "SK-EFI")
#   Partition 3: OS          (3584MB, ext4, label "safekeep-os", two OS slots)
#   Partition 4: Data        (300MB, ext4, label "safekeep-data")
#   Partition 5: Transfer    (2560MB, exFAT, label "TRANSFER")
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

# --- Vault file without the state marker = interrupted creation ---
# The marker is written only inside the vault-creation block below,
# after luksFormat and mkfs succeed. Nothing else creates the vault
# file (factory reset deletes the vault BEFORE it removes the marker),
# so a vault file with no marker means creation was cut off — power
# lost mid-dd, before luksFormat, or before the marker was written.
# Such a file may have no valid LUKS header, and it was never unlocked,
# so it holds no user data. Keeping it would send the user to
# unlock-vault against a broken header ("Incorrect password" forever),
# so delete it and create the vault again from scratch.
if [ -f "$DATA_MOUNT/$VAULT_FILE" ]; then
    echo "setup-vault: vault file found without $SETUP_MARKER — previous setup was interrupted. Recreating."
    zenity --info --title="SafeKeepVault — Setup Was Interrupted" --width=450 \
        --text="The last vault setup didn't finish, so the vault it started is unusable.\n\nIt held no data. SafeKeepVault will delete it and start the setup again." || true

    # Release anything a failed run in this same boot may have left open.
    sudo umount -l "$VAULT_MOUNT" 2>/dev/null || true
    sudo cryptsetup close "$MAPPER_NAME" 2>/dev/null || true
    STALE_LOOP=$(losetup -j "$DATA_MOUNT/$VAULT_FILE" 2>/dev/null | awk -F: '{print $1}' | head -1 || true)
    if [ -n "$STALE_LOOP" ]; then
        sudo losetup -d "$STALE_LOOP" 2>/dev/null || true
    fi

    sudo rm -f "$DATA_MOUNT/$VAULT_FILE"
fi

# ===================================================================
# PHASE 1: ENCRYPTED VAULT CREATION
# ===================================================================
# Creates a LUKS-encrypted file container on the data partition.
# Uses a loop device (virtual block device) so we don't need raw
# partition access, which the kernel locks on the boot device.
# ===================================================================

if [ ! -f "$DATA_MOUNT/$VAULT_FILE" ]; then

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

    # --- Cancel never leaves a dead end ---
    # SafeKeepVault can't start without a vault, so cancelling any step
    # of setup asks: go back, or shut down (setup starts again at the next
    # power-on). Closing this dialog also goes back. Before, a Cancel
    # aborted setup and left a black screen.
    setup_not_finished() {
        local choice
        choice=$(zenity --list --title="Setup Isn't Finished" --width=450 --height=360 \
            --text="SafeKeepVault can't start until your encrypted vault is set up.\n\nGo back to finish setup now, or shut down and finish it\nthe next time you start the computer from this stick." \
            --column="Choice" --hide-header \
            "Go back to setup" "Shut down") || true
        if [ "$choice" = "Shut down" ]; then
            sudo umount "$DATA_MOUNT" 2>/dev/null || true
            sync
            # Fenced like the shutdown at the end of this script.
            sudo systemctl poweroff 2>/dev/null || sudo poweroff || true
            exec sleep infinity
        fi
    }

    # --- Welcome dialog ---
    until zenity --question --title="SafeKeepVault — First Boot Setup" --width=450 \
        --text="Welcome to SafeKeepVault!\n\nThis one-time setup will:\n\n  1. Set your Master Passphrase\n  2. Create an encrypted vault for your seed words, passphrases, encrypted notes and other data\n  3. Unlock the new vault and start SafeKeepVault\n\nNetworks and the computer's own drives are already blocked.\n\nThis takes about 60 seconds. Continue?" \
        --ok-label="Begin Setup" \
        --cancel-label="Cancel"; do
        setup_not_finished
    done

    # --- Choose the Master Passphrase (passphrase-dialogs.sh) ---
    # The same screens as Device Options → Change Master Passphrase:
    # Scan QR Code, Type Password (twice), or Generate One for Me, with the
    # strength check. Closing the method choice asks setup_not_finished.
    # shellcheck source=passphrase-dialogs.sh
    source /usr/local/lib/safekeep/passphrase-dialogs.sh
    choose_new_passphrase setup_not_finished || true

    if [ -z "$PASSWORD" ]; then
        sudo umount "$DATA_MOUNT"
        zenity --error --text="No passphrase received. Setup aborted."
        exit 1
    fi

    # --- Create the LUKS vault ---
    (
    echo "5"; echo "# Creating your ${VAULT_MB} MB encrypted vault..."
    sudo dd if=/dev/zero of="$DATA_MOUNT/$VAULT_FILE" bs=1M count="$VAULT_MB" status=none

    echo "20"; echo "# Preparing the vault..."
    LOOP_DEV=$(sudo losetup --find --show "$DATA_MOUNT/$VAULT_FILE")

    echo "35"; echo "# Locking the vault with your Master Passphrase..."
    printf '%s' "$PASSWORD" | sudo cryptsetup luksFormat -q "$LOOP_DEV" --key-file=-

    echo "50"; echo "# Opening the vault to set it up..."
    printf '%s' "$PASSWORD" | sudo cryptsetup open "$LOOP_DEV" "$MAPPER_NAME" --key-file=-
    udevadm settle --timeout=10

    echo "65"; echo "# Setting up storage inside the vault..."
    sudo mkfs.ext4 -F -L safekeep-vault /dev/mapper/"$MAPPER_NAME"

    # Clean up the vault (remove lost+found, create seeds dir)
    sudo mkdir -p "$VAULT_MOUNT"
    sudo mount /dev/mapper/"$MAPPER_NAME" "$VAULT_MOUNT"
    sudo rm -rf "$VAULT_MOUNT/lost+found"
    sudo umount "$VAULT_MOUNT"

    echo "80"; echo "# Locking the vault..."
    sudo cryptsetup close "$MAPPER_NAME"
    sudo losetup -d "$LOOP_DEV"

    echo "95"; echo "# Saving setup..."

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

    echo "100"; echo "# Your ${VAULT_MB} MB encrypted vault is ready."
    ) | zenity --progress --title="SafeKeepVault — Creating Your Encrypted Vault" \
        --auto-close --no-cancel --width=450

    # Clear password from memory (best effort — bash doesn't guarantee this)
    unset PASSWORD

fi  # end vault creation


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
# PHASE 2: CONTINUE NOW, OR SHUT DOWN TO COPY A BACKUP
# ===================================================================
# All hardening (module blacklists, dconf, etc.) is baked into the
# squashfs/initramfs at build time and is already active, so no second
# boot is needed to enforce security. The only reason to stop here is
# a user restoring from a .7z backup: the backup must be on the TRANSFER
# partition, and the stick has to be unplugged and copied to from
# another computer while this machine is off.
#
#   Continue now (default) → exit 0. safekeep-boot.sh sees the marker
#     and exit 0, and runs the normal unlock-vault prompt. Entering the
#     passphrase there proves it works before any data goes in.
#   Shut down → power off (fenced below). On the next power-on,
#     safekeep-boot.sh sees the marker and runs unlock-vault as usual.
#
# KEYBOARD UX: plain --list (see the Method dialog above), so Enter on
# the pre-highlighted first row picks "Continue now". Closing the dialog
# also continues — the user can still power off from the menu later.
# ===================================================================

sudo umount "$DATA_MOUNT" 2>/dev/null || true
sync

# VAULT_MB is only set when this run created the vault (it is measured
# from the data partition's free space above).
VAULT_DESC="encrypted vault"
if [ -n "${VAULT_MB:-}" ]; then
    VAULT_DESC="${VAULT_MB} MB encrypted vault"
fi

NEXT_STEP=$(zenity --list --title="SafeKeepVault — Vault Created" --width=520 --height=420 \
    --text="Your ${VAULT_DESC} is created and locked.\n\nNext, unlock it with the Master Passphrase you just set.\n\nRestoring from a .7z backup? It must be on the stick's TRANSFER\ndrive first. Choose \"Shut down\", copy the backup onto TRANSFER\nfrom another computer, then put the stick back and power on." \
    --column="Next step" --hide-header \
    "Continue now" \
    "Shut down to copy a backup onto the stick") || true

if [ "$NEXT_STEP" != "Shut down to copy a backup onto the stick" ]; then
    echo "setup-vault: vault created — continuing to unlock without a restart."
    exit 0
fi

zenity --info --title="SafeKeepVault — Shutting Down" --width=450 \
    --text="SafeKeepVault will now shut down.\n\nOnce the machine is fully powered off, remove the USB stick and plug it into another computer. Copy your .7z backup onto the TRANSFER drive.\n\nThen put the stick back in this machine and power on to unlock your vault.\n\nClick OK to shut down now." || true

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

#!/bin/bash
# ============================================================================
# setup-vault — First-Boot Initialization & OS Hardening for SafeKeep
# ============================================================================
#
# This script runs ONCE on the very first boot:
#
#   PHASE 1: Create the encrypted LUKS vault. First the user chooses how
#            it unlocks (SECURITY_KEY_DESIGN.md): a Master Passphrase (the
#            default), a passphrase or a security key, or a security key
#            only. A passphrase is typed visibly and twice, so a typo is
#            caught before the vault is locked with it. A security key is
#            added and checked before setup counts as finished.
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
# Overridable for test-security-key.mjs only.
DATA_MOUNT="${SAFEKEEP_DATA_MOUNT:-/mnt/safekeep-data}"
VAULT_FILE=".vault.luks"
VAULT_MOUNT="${SAFEKEEP_VAULT_MOUNT:-/media/.safekeep-vault}"
FIDO2_HELPER="${FIDO2_HELPER:-/usr/local/lib/safekeep/safekeep-fido2.py}"
SK_DIALOGS="${SAFEKEEP_SECURITY_KEY_DIALOGS:-/usr/local/lib/safekeep/security-key-dialogs.sh}"
PP_DIALOGS="${SAFEKEEP_PASSPHRASE_DIALOGS:-/usr/local/lib/safekeep/passphrase-dialogs.sh}"
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
    VAULT_MB=${SAFEKEEP_TEST_VAULT_MB:-$VAULT_MB}

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
            --text="SafeKeepVault can't start until your encrypted vault is set up.\n\nGo back to finish setup now, or shut down and finish it\nthe next time you start the computer from this flash drive." \
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
        --text="Welcome to SafeKeepVault!\n\nThis one-time setup will:\n\n  1. Choose how your vault unlocks: a Master Passphrase,\n      a security key, or either\n  2. Create an encrypted vault for your seed words, passphrases, encrypted notes and other data\n  3. Unlock the new vault and start SafeKeepVault\n\nNetworks and the computer's own drives are already blocked.\n\nThis takes about 60 seconds. Continue?" \
        --ok-label="Begin Setup" \
        --cancel-label="Cancel"; do
        setup_not_finished
    done

    # --- How this vault unlocks (SECURITY_KEY_DESIGN.md) ---
    # Offered only when the security key library is in the image. The
    # Master Passphrase stays first and recommended; the same choices can
    # be made later in Device Options → Security Keys.
    UNLOCK_CHOICE="passphrase"
    if [ -f "$FIDO2_HELPER" ] && [ -f "$SK_DIALOGS" ] && python3 -I -c 'import fido2.ctap2' 2>/dev/null; then
        while true; do
            CHOICE=$(zenity --list --title="SafeKeepVault — How Your Vault Unlocks" --width=520 --height=460 \
                --text="How should this vault unlock?\n\nA security key is a YubiKey or another FIDO2 key. It unlocks the\nvault with its PIN and a touch. You can change this later\nin Device Options." \
                --column="Choice" --hide-header \
                "Master Passphrase (recommended)" \
                "Passphrase or security key" \
                "Security key only") || true
            case "$CHOICE" in
                "Master Passphrase"*) UNLOCK_CHOICE="passphrase"; break ;;
                "Passphrase or security key") UNLOCK_CHOICE="either"; break ;;
                "Security key only")
                    # The same warning as Device Options (wrapped by hand:
                    # zenity doesn't wrap the text above a list).
                    UNDERSTOOD=$(zenity --list --checklist --title="Security Key Only" --width=560 --height=500 \
                        --text="$(printf '%b' "Your vault won't have a Master Passphrase. Only your security key will open it, with its PIN and a touch.\n\nIf you lose your security key (or every security key you add), or its PIN is blocked, this vault can't be opened. Your seed backup still restores your wallet. Saved wallets, the Passphrase Library and notes come back only from an Encrypted Backup.\n\nA spare security key, kept somewhere else, protects you if one is lost or broken: setup offers to add one." | fold -s -w 62)" \
                        --column="" --column="" --hide-header \
                        FALSE "I understand, and want a security key only") || true
                    if [ "$UNDERSTOOD" = "I understand, and want a security key only" ]; then
                        UNLOCK_CHOICE="key"
                        break
                    fi ;;
                *) setup_not_finished ;;
            esac
        done
        SK_TITLE="SafeKeepVault — Security Key"
        # shellcheck source=security-key-dialogs.sh
        source "$SK_DIALOGS"
    fi

    # --- Choose the Master Passphrase (passphrase-dialogs.sh) ---
    # The same screens as Device Options → Change Master Passphrase:
    # Scan QR Code, Type Password (twice), or Generate One for Me, with the
    # strength check. Closing the method choice asks setup_not_finished.
    # shellcheck source=passphrase-dialogs.sh
    source "$PP_DIALOGS"
    if [ "$UNLOCK_CHOICE" = "key" ]; then
        # Security key only: the vault is made with a random key nobody
        # sees, the security key is added and checked, then the random
        # key's slot is removed. Until then setup isn't finished: if it
        # stops here, the next start sees an unfinished vault (no marker)
        # and starts again.
        PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -d '\n=')
    else
        choose_new_passphrase setup_not_finished || true
    fi

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

    echo "100"; echo "# Your ${VAULT_MB} MB encrypted vault is ready."
    ) | zenity --progress --title="SafeKeepVault — Creating Your Encrypted Vault" \
        --auto-close --no-cancel --width=450

    # --- Security keys (SECURITY_KEY_DESIGN.md) ---
    if [ "$UNLOCK_CHOICE" != "passphrase" ]; then
        LOOP_DEV=$(sudo losetup --find --show "$DATA_MOUNT/$VAULT_FILE")
        KEY_SECRET=""

        # Add the plugged-in key, unlocking with $1 (what opens the vault
        # now), named $2. Returns 0 once it's added (and tested by the helper).
        setup_enroll_key() {
            local existing=$1 name=$2
            sk_wait_for_key "Plug in your security key." || return 1
            if [ "$(sk_probe_value pin)" = "set" ]; then
                sk_ask_pin "Type this security key's PIN." || return 1
            else
                sk_set_new_pin || return 1
            fi
            SETUP_EXISTING=$existing
            SETUP_KEY_NAME=$name
            if sk_run "Touch your security key when it blinks: twice, once to add it and once more to check it." \
                'printf "%s\0%s\0%s" "$SETUP_EXISTING" "$SK_PIN" "$SETUP_KEY_NAME"' enroll "$LOOP_DEV"; then
                SETUP_EXISTING=""
                return 0
            fi
            SETUP_EXISTING=""
            SK_PIN=""
            sk_error "$SK_RC"
            return 1
        }

        # The first key. With a passphrase too, it can be skipped and added
        # later; with a key only, setup can't finish without it.
        while ! setup_enroll_key "$PASSWORD" "Security key 1"; do
            if [ "$UNLOCK_CHOICE" = "either" ]; then
                SKIP=$(zenity --list --title="SafeKeepVault — Security Key" --width=500 --height=340 \
                    --text="The security key wasn't added.\n\nTry again, or finish setup with your Master Passphrase\nand add a security key later in Device Options." \
                    --column="Choice" --hide-header "Try again" "Add a security key later") || true
                if [ "$SKIP" = "Add a security key later" ]; then
                    UNLOCK_CHOICE="passphrase"
                    break
                fi
            else
                setup_not_finished
            fi
        done

        if [ "$UNLOCK_CHOICE" = "key" ]; then
            # Check the key opens the vault (one more touch), and keep its
            # slot key to finish with.
            while true; do
                if [ -n "$SK_PIN" ] && sk_run "Touch your security key once more, to check it opens your vault." \
                    'printf "%s" "$SK_PIN"' secret "$LOOP_DEV"; then
                    KEY_SECRET=$(printf '%s\n' "$SK_OUT" | sed -n 2p)
                    SK_OUT=""
                    [ -n "$KEY_SECRET" ] && break
                fi
                [ -n "$SK_PIN" ] && sk_error "$SK_RC"
                sk_wait_for_key "Plug in your security key." || { setup_not_finished; continue; }
                sk_ask_pin "Type this security key's PIN." || { setup_not_finished; continue; }
            done
        fi
        SK_PIN=""

        # A spare, kept somewhere else (recommended, not required).
        SPARES=0
        while [ "$UNLOCK_CHOICE" != "passphrase" ] && [ "$SPARES" -lt 3 ]; do
            SPARE=$(zenity --list --title="SafeKeepVault — A Spare Security Key" --width=520 --height=380 \
                --text="Your security key is added.\n\nA spare, kept somewhere else, protects you if this one is lost\nor broken. You can also add one later in Device Options." \
                --column="Choice" --hide-header "Add a spare security key now" "Continue") || true
            [ "$SPARE" = "Add a spare security key now" ] || break
            zenity --info --title="SafeKeepVault — A Spare Security Key" --width=460 \
                --text="Unplug the security key you just added, and plug in the spare." || true
            if setup_enroll_key "${KEY_SECRET:-$PASSWORD}" "Spare$([ "$SPARES" -gt 0 ] && echo " $((SPARES + 1))")"; then
                SPARES=$((SPARES + 1))
                SK_PIN=""
            fi
        done

        if [ "$UNLOCK_CHOICE" = "key" ]; then
            # Remove the random key's slot: from now on, only the security
            # keys open the vault. If this fails, setup isn't finished and
            # starts again at the next power-on.
            until sk_run "Finishing your vault..." 'printf "%s" "$KEY_SECRET"' remove-passphrase "$LOOP_DEV"; do
                sk_error "$SK_RC"
                setup_not_finished
            done
        fi
        KEY_SECRET=""
        sudo losetup -d "$LOOP_DEV" 2>/dev/null || true
    fi

    # Write the state lock marker to the persistent data partition.
    # This tells safekeep-boot.sh that first-boot initialization is complete.
    # On all future boots, the system skips straight to vault unlock.
    # (Only now: a vault that is still waiting for its security key is
    # treated as an interrupted setup and made again.)
    cat > "$DATA_MOUNT/$SETUP_MARKER" << MARKEREOF
# SafeKeep First-Boot Initialization Complete
# This file prevents setup-vault from running again.
# Delete this file ONLY if you need to re-create the vault.
timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
vault_created=true
hardening=build-time
MARKEREOF

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

# How to unlock it next, for the choice made above.
NEXT_UNLOCK="Next, unlock it with the Master Passphrase you just set."
case "${UNLOCK_CHOICE:-passphrase}" in
    key) NEXT_UNLOCK="Next, unlock it with your security key:\nchoose Use a Security Key." ;;
    either) NEXT_UNLOCK="Next, unlock it with your Master Passphrase or your\nsecurity key." ;;
esac

NEXT_STEP=$(zenity --list --title="SafeKeepVault — Vault Created" --width=520 --height=470 \
    --text="Your ${VAULT_DESC} is created and locked.\n\n${NEXT_UNLOCK}\n\nRestoring from a .7z backup? Choose \"Continue now\", then\n\"Unlock .7z Backup\" and \"Receive a Backup with the Courier\":\nsend it from the Courier Tool on a phone or another computer.\n\nNo camera on this computer? Choose \"Shut down\", copy the backup\nonto the flash drive's TRANSFER drive from another computer, then\nput the flash drive back and power on." \
    --column="Next step" --hide-header \
    "Continue now" \
    "Shut down to copy a backup onto the flash drive") || true

if [ "$NEXT_STEP" != "Shut down to copy a backup onto the flash drive" ]; then
    echo "setup-vault: vault created — continuing to unlock without a restart."
    exit 0
fi

zenity --info --title="SafeKeepVault — Shutting Down" --width=450 \
    --text="SafeKeepVault will now shut down.\n\nOnce the machine is fully powered off, remove the USB flash drive and plug it into another computer. Copy your .7z backup onto the TRANSFER drive.\n\nThen put the flash drive back in this machine and power on to unlock your vault.\n\nClick OK to shut down now." || true

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

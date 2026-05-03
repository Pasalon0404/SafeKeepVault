#!/bin/bash
# unlock-vault: Decrypt and mount the SafeKeep vault from its file container.
#
# Exit codes:
#   0 = vault successfully unlocked and mounted at VAULT_MOUNT
#   1 = fatal error (no partition, no vault file)
#   2 = user cancelled or all attempts exhausted (non-fatal, caller can retry)
#   3 = user chose "Boot Temporary Session (RAM Only)" — skip the vault entirely.
#       Parent (safekeep-boot.sh) must bypass mountpoint checks and launch
#       Chromium with ?ephemeral=true appended to the boot.html URL.

# NOTE: We intentionally do NOT use `set -e` here. The unlock flow involves
# many commands that legitimately return non-zero (zbarcam timeout, zenity
# cancel, failed decrypt attempts). We handle every error path explicitly.
set -uo pipefail

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

# -------------------------------------------------------------------
# 1. CHECK IF ALREADY UNLOCKED
# -------------------------------------------------------------------
if mountpoint -q "$VAULT_MOUNT" 2>/dev/null; then
    zenity --info --title="Vault Status" \
        --text="The SafeKeep Vault is already unlocked and mounted at:\n$VAULT_MOUNT" 2>/dev/null
    exit 0
fi

# -------------------------------------------------------------------
# 2. FIND THE VAULT
# -------------------------------------------------------------------
DATA_PART=$(blkid -L "$DATA_LABEL" 2>/dev/null || true)

if [ -z "$DATA_PART" ]; then
    zenity --error --title="No Storage Found" \
        --text="Cannot find the storage partition (label: $DATA_LABEL).\n\nPlease run the Setup Wizard first (Ctrl+Alt+S)." 2>/dev/null
    exit 1
fi

# Mount the data partition
sudo mkdir -p "$DATA_MOUNT"
if ! mountpoint -q "$DATA_MOUNT"; then
    sudo mount "$DATA_PART" "$DATA_MOUNT" || {
        zenity --error --text="Failed to mount data partition." 2>/dev/null
        exit 1
    }
fi

if [ ! -f "$DATA_MOUNT/$VAULT_FILE" ]; then
    sudo umount "$DATA_MOUNT" 2>/dev/null || true
    zenity --error --title="No Vault Found" \
        --text="The storage partition exists but no vault has been created.\n\nPlease run the Setup Wizard first (Ctrl+Alt+S)." 2>/dev/null
    exit 1
fi

# -------------------------------------------------------------------
# 3. GET PASSPHRASE (with retry loop)
# -------------------------------------------------------------------
# The user can try scan or type, and if they cancel or fail, they
# loop back to the choice dialog. Exiting the choice dialog itself
# (clicking X) exits cleanly with code 2 so the parent can handle it.

# Helper: scan QR passphrase with a live camera preview window.
scan_qr_passphrase() {
    local SCAN_TIMEOUT=30
    local TMPFILE
    TMPFILE=$(mktemp /tmp/safekeep-qr-XXXXXX)

    # Launch zbarcam with the live X11 preview window.
    # stdout → temp file (captures decoded QR text)
    # stderr → /dev/null (suppresses debug noise)
    # NOT backgrounded — we run it in the foreground so the video
    # window stays open naturally until scan completes or we kill it.
    #
    # We use `timeout` from coreutils to handle the 30-second limit.
    # This is far more reliable than background subshell + kill patterns,
    # which interact badly with bash job control and set -e.
    timeout "$SCAN_TIMEOUT" zbarcam -1 --raw \
        -Sdisable -Sqr.enable /dev/video0 \
        > "$TMPFILE" 2>/dev/null
    local EXIT_CODE=$?

    local SCAN_RESULT
    SCAN_RESULT=$(cat "$TMPFILE" 2>/dev/null | tr -d '\n')
    rm -f "$TMPFILE"

    if [ -n "$SCAN_RESULT" ]; then
        echo "$SCAN_RESULT"
        return 0
    else
        # Exit code 124 = timeout killed it, anything else = zbarcam error
        return 1
    fi
}

HAS_CAMERA=false
if ls /dev/video* 1>/dev/null 2>&1; then
    HAS_CAMERA=true
fi

PASSWORD=""

while true; do
    # --- Choose input method ---
    # NOTE: Option ordering and default selection mirror setup-vault.sh
    # (First-Boot) — "Scan QR Code" appears first and is pre-selected
    # so a user's muscle memory from initial setup carries over
    # seamlessly to every subsequent unlock.
    # KEYBOARD UX (Enter-to-submit, no mouse required):
    #   Plain `--list` (NOT `--list --radiolist`) — see the matching
    #   comment in setup-vault.sh for the full rationale. Short version:
    #   --radiolist makes Enter toggle the radio state instead of
    #   submitting, forcing a mouse click on OK. Plain --list activates
    #   the highlighted row on Enter, which IS the submit action. The
    #   first row is auto-highlighted, so a user with QR muscle memory
    #   just presses Enter and they're scanning their code.
    if [ "$HAS_CAMERA" = true ]; then
        INPUT_METHOD=$(zenity --list --title="Unlock Vault" \
            --text="How would you like to enter your Master Passphrase?" \
            --column="Method" --hide-header \
            "Scan QR Code" \
            "Type Password" \
            "Boot Temporary Session (RAM Only)" 2>/dev/null) || true

        if [ -z "$INPUT_METHOD" ]; then
            # User clicked X / Cancel on the choice dialog → clean exit
            sudo umount "$DATA_MOUNT" 2>/dev/null || true
            exit 2
        fi
    else
        # No camera: visible typing only (plus ephemeral bypass)
        INPUT_METHOD=$(zenity --list --title="Unlock Vault" \
            --text="How would you like to enter your Master Passphrase?" \
            --column="Method" --hide-header \
            "Type Password" \
            "Boot Temporary Session (RAM Only)" 2>/dev/null) || true

        if [ -z "$INPUT_METHOD" ]; then
            sudo umount "$DATA_MOUNT" 2>/dev/null || true
            exit 2
        fi
    fi

    # --- Intercept ephemeral bypass BEFORE any decrypt attempt ---
    # The user has chosen to skip the encrypted vault entirely and boot
    # into a RAM-only session. We clean up the data partition mount (so
    # nothing touches disk) and exit 3. The parent script (safekeep-boot.sh)
    # catches exit 3, bypasses the mountpoint safety checks, and launches
    # Chromium with #ephemeral=true appended to boot.html (hash fragment,
    # not query string — query strings on file:/// URIs trigger
    # ERR_FILE_NOT_FOUND in Chromium).
    if [ "$INPUT_METHOD" = "Boot Temporary Session (RAM Only)" ]; then
        sudo umount "$DATA_MOUNT" 2>/dev/null || true
        echo "SafeKeep: User selected temporary session boot — signalling parent (exit 3)"
        exit 3
    fi

    # --- Execute chosen method ---
    # Only two input methods remain after the ephemeral interceptor above:
    # QR scan (camera-equipped rigs only) and visible typing.
    if [ "$INPUT_METHOD" = "Scan QR Code" ]; then
        PASSWORD=$(scan_qr_passphrase) || true
        if [ -z "$PASSWORD" ]; then
            zenity --warning --title="Scan Failed" \
                --text="QR scan did not return a result.\nReturning to method selection." 2>/dev/null || true
            continue  # Loop back to choice dialog
        fi
    elif [ "$INPUT_METHOD" = "Type Password" ]; then
        # Visible entry — user can see what they're typing (for high-entropy strings).
        #
        # KEYBOARD UX (Enter-to-submit, no mouse required):
        #   zenity --entry opens with focus on the text field; the OK
        #   button is the default action, so pressing Enter from the
        #   text field submits the entry directly — no Tab to OK, no
        #   mouse click. --ok-label makes the action verb explicit so
        #   the user can see at a glance what Enter will do. We do NOT
        #   pass --modal or --attach which would push focus elsewhere.
        PASSWORD=$(zenity --entry --title="Unlock Vault" \
            --text="Enter your Master Passphrase (visible):" \
            --ok-label="Unlock" \
            --width=450 2>/dev/null) || true
        if [ -z "$PASSWORD" ]; then
            continue  # Loop back to choice dialog
        fi
    else
        # Shouldn't happen — zenity output didn't match any known option.
        # Loop back to the method dialog rather than silently continuing
        # with an empty password.
        echo "SafeKeep: unexpected INPUT_METHOD value: '$INPUT_METHOD' — returning to method selection."
        continue
    fi

    # If we got a password, attempt decryption immediately (no break — loop on failure)
    if [ -n "$PASSWORD" ]; then

        # --- ATTACH LOOP DEVICE ---
        LOOP_DEV=$(losetup -j "$DATA_MOUNT/$VAULT_FILE" 2>/dev/null | awk -F: '{print $1}' | head -1 || true)

        if [ -z "$LOOP_DEV" ]; then
            LOOP_DEV=$(sudo losetup --find --show "$DATA_MOUNT/$VAULT_FILE") || {
                sudo umount "$DATA_MOUNT" 2>/dev/null || true
                zenity --error --text="Failed to attach loop device." 2>/dev/null
                exit 1
            }
        fi

        # --- ATTEMPT DECRYPTION ---
        if printf '%s' "$PASSWORD" | sudo cryptsetup open "$LOOP_DEV" "$MAPPER_NAME" --key-file=-; then
            # Success — clear password and break out to mount
            PASSWORD=""
            break
        else
            # Wrong password — detach loop, clear password, show error, loop back
            sudo losetup -d "$LOOP_DEV" 2>/dev/null || true
            PASSWORD=""
            zenity --warning --title="Decryption Failed" --width=400 \
                --text="Incorrect password.\n\nPlease try again. You have unlimited attempts." 2>/dev/null || true
            continue
        fi
    fi
done

# -------------------------------------------------------------------
# 4. MOUNT THE DECRYPTED FILESYSTEM
# -------------------------------------------------------------------

# Clear password from memory (best-effort — bash doesn't guarantee this)
PASSWORD=""

sudo mkdir -p "$VAULT_MOUNT"
sudo mount /dev/mapper/"$MAPPER_NAME" "$VAULT_MOUNT" || {
    zenity --error --text="LUKS decrypted but filesystem mount failed." 2>/dev/null
    exit 1
}
sudo chmod 700 "$VAULT_MOUNT"

# Success — no blocking dialog. The parent script (safekeep-boot.sh)
# will detect the mount and launch Chromium immediately.
echo "SafeKeep: Vault unlocked and mounted at $VAULT_MOUNT"
exit 0

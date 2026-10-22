#!/bin/bash
# =====================================================================
#  change-passphrase — Device Options → Change Master Passphrase
# =====================================================================
#  PASSPHRASE_STRENGTH_DESIGN.md, Part 3. The app asks for this with the
#  power action "passphrase": safekeep-boot.sh locks the vault exactly as
#  Lock does (Chromium closed, vault unmounted, LUKS key evicted), then runs
#  this script before the normal unlock prompt. So the passphrases are only
#  ever typed or scanned into these native dialogs: they never pass through
#  the browser or onto a disk.
#
#  1. Ask for the current Master Passphrase (scan or type) and check it
#     opens the vault.
#  2. Choose the new one with the same screens as first-boot setup
#     (passphrase-dialogs.sh): scan, type twice, or Generate One for Me,
#     with the strength check.
#  3. safekeep-passphrase.py runs cryptsetup luksChangeKey, which replaces
#     the key slot; the vault's contents are not touched.
#  Then safekeep-boot.sh shows the normal unlock prompt, where the new
#  passphrase opens the vault, which proves it works.
#
#  Exit codes: 0 = changed, 2 = not changed (the user kept the current
#  one), 1 = failed (the current passphrase still opens the vault).
# =====================================================================
set -uo pipefail

# Same dialog scaling as setup-vault.sh and unlock-vault.sh.
export GDK_SCALE=2
export GDK_DPI_SCALE=1.0

DATA_LABEL="safekeep-data"
# Overridable for test-change-passphrase.mjs only.
DATA_MOUNT="${SAFEKEEP_DATA_MOUNT:-/mnt/safekeep-data}"
VAULT_FILE=".vault.luks"
HELPER="${SAFEKEEP_PASSPHRASE_HELPER:-/usr/local/lib/safekeep/safekeep-passphrase.py}"
TITLE="Change Master Passphrase"

PP_NOUN="new Master Passphrase"
PP_TITLE="$TITLE"
# shellcheck source=passphrase-dialogs.sh
source "${SAFEKEEP_PASSPHRASE_DIALOGS:-/usr/local/lib/safekeep/passphrase-dialogs.sh}"

LOOP_DEV=""
LOOP_ATTACHED=false
DATA_MOUNTED=false
CURRENT=""
PASSWORD=""

cleanup() {
    CURRENT=""
    PASSWORD=""
    if [ "$LOOP_ATTACHED" = true ] && [ -n "$LOOP_DEV" ]; then
        sudo losetup -d "$LOOP_DEV" 2>/dev/null || true
    fi
    if [ "$DATA_MOUNTED" = true ]; then
        sudo umount "$DATA_MOUNT" 2>/dev/null || true
    fi
}

not_changed() {
    cleanup
    zenity --info --title="$TITLE" --width=450 \
        --text="Your Master Passphrase was not changed.\n\nUnlock your vault with your current passphrase." || true
    exit 2
}

failed() {
    cleanup
    zenity --error --title="$TITLE" --width=450 \
        --text="SafeKeepVault couldn't change your Master Passphrase.\n\n$1\n\nUnlock your vault with your current passphrase." || true
    exit 1
}

# Closing the new-passphrase choice: go back, or keep the current one.
# Closing this dialog also goes back. Returns 0 to go back, 1 to stop.
keep_current_or_go_back() {
    local choice
    choice=$(zenity --list --title="$TITLE" --width=450 --height=360 \
        --text="Your Master Passphrase hasn't been changed yet.\n\nGo back to choose a new one, or keep your current one." \
        --column="Choice" --hide-header \
        "Go back and choose a new passphrase" "Keep my current passphrase") || true
    [ "$choice" != "Keep my current passphrase" ]
}

# --- 1. Explain ---
zenity --question --title="$TITLE" --width=450 \
    --ok-label="Continue" --cancel-label="Keep Current Passphrase" \
    --text="Your vault is locked.\n\nTo change its Master Passphrase, first enter your current one, then choose a new one. Your vault's contents are not changed.\n\nAfterwards, unlock your vault with the new passphrase." \
    || not_changed

# --- 2. Find the vault ---
DATA_PART=$(blkid -L "$DATA_LABEL" 2>/dev/null || true)
[ -n "$DATA_PART" ] || failed "The storage partition wasn't found."
sudo mkdir -p "$DATA_MOUNT"
if ! mountpoint -q "$DATA_MOUNT"; then
    sudo mount "$DATA_PART" "$DATA_MOUNT" || failed "The storage partition couldn't be mounted."
    DATA_MOUNTED=true
fi
[ -f "$DATA_MOUNT/$VAULT_FILE" ] || failed "No vault was found on this stick."
LOOP_DEV=$(losetup -j "$DATA_MOUNT/$VAULT_FILE" 2>/dev/null | awk -F: '{print $1}' | head -1 || true)
if [ -z "$LOOP_DEV" ]; then
    LOOP_DEV=$(sudo losetup --find --show "$DATA_MOUNT/$VAULT_FILE") || failed "The vault couldn't be opened."
    LOOP_ATTACHED=true
fi

# --- 3. The current passphrase ---
CURRENT_METHODS=("Type Password")
if [ "$HAS_CAMERA" = true ]; then
    CURRENT_METHODS=("Scan QR Code" "Type Password")
fi
while true; do
    METHOD=$(zenity --list --title="$TITLE" --width=450 --height=360 \
        --text="First, your current Master Passphrase.\n\nHow would you like to enter it?" \
        --column="Method" --hide-header \
        "${CURRENT_METHODS[@]}") || true
    [ -n "$METHOD" ] || not_changed
    if [ "$METHOD" = "Scan QR Code" ]; then
        zenity --info --title="Scan QR" --width=350 \
            --text="Hold the QR code of your current passphrase up to the camera.\nThe window will close automatically once read (or after ${QR_SCAN_TIMEOUT} seconds)." || true
        CURRENT=$(timeout "$QR_SCAN_TIMEOUT" zbarcam -1 --raw \
            -Sdisable -Sqr.enable /dev/video0 2>/dev/null | tr -d '\n') || true
        if [ -z "$CURRENT" ]; then
            zenity --warning --title="Scan Failed" --width=400 \
                --text="QR scan did not return a result.\nReturning to method selection." || true
            continue
        fi
    else
        CURRENT=$(zenity --entry --title="$TITLE" --width=450 \
            --text="Enter your current Master Passphrase (visible):" \
            --ok-label="Next") || true
        [ -n "$CURRENT" ] || continue
    fi
    if printf '%s' "$CURRENT" | sudo python3 -I "$HELPER" verify "$LOOP_DEV" 2>/dev/null; then
        break
    fi
    CURRENT=""
    zenity --warning --title="Not Your Current Passphrase" --width=400 \
        --text="That passphrase doesn't open your vault.\n\nPlease try again." || true
done

# --- 4. The new passphrase ---
while true; do
    choose_new_passphrase keep_current_or_go_back || not_changed
    if [ "$PASSWORD" = "$CURRENT" ]; then
        zenity --warning --title="That's Your Current Passphrase" --width=420 \
            --text="The new passphrase is the same as your current one.\n\nChoose a different one, or close the choice to keep your current one." || true
        continue
    fi
    break
done

# --- 5. Change it ---
# luksChangeKey takes a few seconds (it derives the key twice), and the
# helper then checks the new passphrase opens the vault and the old one
# doesn't. Errors go to a file in RAM; it never holds a passphrase.
ERR_FILE=$(mktemp /tmp/safekeep-passphrase-XXXXXX)
printf '%s\0%s' "$CURRENT" "$PASSWORD" | sudo python3 -I "$HELPER" change "$LOOP_DEV" 2>"$ERR_FILE" &
HELPER_PID=$!
(
    while kill -0 "$HELPER_PID" 2>/dev/null; do
        echo "# Changing your Master Passphrase..."
        sleep 1
    done
) | zenity --progress --pulsate --auto-close --no-cancel --title="$TITLE" --width=450 \
    --text="Changing your Master Passphrase..." || true
wait "$HELPER_PID"
RC=$?
ERROR=$(head -c 300 "$ERR_FILE" 2>/dev/null || true)
rm -f "$ERR_FILE"

case "$RC" in
    0)
        cleanup
        zenity --info --title="Master Passphrase Changed" --width=450 \
            --text="Your Master Passphrase is changed.\n\nUnlock your vault with the new passphrase now. Your old passphrase no longer opens it." || true
        exit 0
        ;;
    2)
        failed "Your current passphrase wasn't accepted."
        ;;
    *)
        echo "change-passphrase: helper failed ($RC): $ERROR" >&2
        failed "Something went wrong while changing it."
        ;;
esac

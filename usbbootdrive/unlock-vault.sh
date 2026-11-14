#!/bin/bash
# unlock-vault: Decrypt and mount the SafeKeep vault from its file container.
#
# Exit codes:
#   0 = vault successfully unlocked and mounted at VAULT_MOUNT
#   1 = fatal error (no partition, no vault file)
#   2 = user canceled or all attempts exhausted (non-fatal, caller can retry)
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
# Overridable for test-security-key.mjs only.
DATA_MOUNT="${SAFEKEEP_DATA_MOUNT:-/mnt/safekeep-data}"
VAULT_FILE=".vault.luks"
VAULT_MOUNT="${SAFEKEEP_VAULT_MOUNT:-/media/.safekeep-vault}"
MAPPER_NAME="vault"

# -------------------------------------------------------------------
# PASSPHRASE RATING FOR THE APP (PASSPHRASE_STRENGTH_DESIGN.md, Part 3)
# -------------------------------------------------------------------
# After a successful unlock, the passphrase is rated with the same check as
# setup, and only the result ({"band", "bits"}) is left in RAM for the app:
# Device Options shows it, and the dashboard warns when it is Weak (vaults
# set up before the check existed). Cleared on every run, so a temporary
# session never sees an earlier session's result.
SIGNALS="${SAFEKEEP_SIGNALS:-/tmp/safekeep-signals}"
RATING_FILE="$SIGNALS/PASSPHRASE_RATING.json"
rm -f "$RATING_FILE" 2>/dev/null || true

# -------------------------------------------------------------------
# SECURITY KEYS (SECURITY_KEY_DESIGN.md, Part 1)
# -------------------------------------------------------------------
# A vault can also open with a FIDO2 security key, or only with one.
# safekeep-fido2.py reads which from the vault's header (no key needed),
# and after unlocking only a summary is left in RAM for the app: how it
# was unlocked, whether there is a passphrase, and each key's name and
# date. Cleared on every run, like the rating.
FIDO2_HELPER="${FIDO2_HELPER:-/usr/local/lib/safekeep/safekeep-fido2.py}"
UNLOCK_SUMMARY_FILE="$SIGNALS/UNLOCK_METHODS.json"
rm -f "$UNLOCK_SUMMARY_FILE" 2>/dev/null || true
VAULT_STATUS=""
VAULT_HAS_PASSPHRASE=true
VAULT_KEY_COUNT=0
UNLOCKED_WITH="passphrase"

record_unlock_summary() {
    [ -n "$VAULT_STATUS" ] || return 0
    mkdir -p "$SIGNALS"
    printf '%s' "$VAULT_STATUS" | python3 -I -c 'import json, sys
s = json.load(sys.stdin)
out = {"method": sys.argv[1], "passphrase": bool(s.get("passphrase")),
       "keys": [{"name": str(k.get("name", ""))[:40], "added": str(k.get("added", ""))[:10]} for k in s.get("keys", [])][:4]}
print(json.dumps(out))' "$UNLOCKED_WITH" > "$UNLOCK_SUMMARY_FILE" 2>/dev/null || true
}

record_passphrase_rating() {
    local result band bits
    result=$(printf '%s' "$PASSWORD" | python3 -I "${PWCHECK:-/usr/local/lib/safekeep/safekeep-pwcheck.py}" --lines vault 2>/dev/null) || result=""
    { read -r band; read -r bits; } <<< "$result"
    case "$band" in
        weak|fair|strong)
            mkdir -p "$SIGNALS"
            printf '{"band":"%s","bits":%d}\n' "$band" "${bits:-0}" > "$RATING_FILE" 2>/dev/null || true
            ;;
    esac
}

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

if [ -z "${HAS_CAMERA:-}" ]; then
    HAS_CAMERA=false
    if ls /dev/video* 1>/dev/null 2>&1; then
        HAS_CAMERA=true
    fi
fi

# --- Auto-Off at the password prompt ---
# Settings → Idle Timers → Auto-Off (minutes, 0 = stay on). The app runs
# its own timer; here, with the browser closed (at boot or after a lock),
# the prompts time out instead. The value is kept as a plain number next
# to the vault (written by safekeep-boot.sh's Settings Watcher) so it can
# be read while the vault is still locked. No file yet → 30 minutes.
# A prompt that times out makes this script exit 4: the parent powers off.
AUTO_OFF_MIN=30
AUTO_OFF_FILE="$DATA_MOUNT/auto-off-minutes"
if [ -f "$AUTO_OFF_FILE" ]; then
    AUTO_OFF_RAW=$(head -c 8 "$AUTO_OFF_FILE" 2>/dev/null | tr -d '[:space:]')
    if [[ "$AUTO_OFF_RAW" =~ ^[0-9]{1,3}$ ]] && [ "$AUTO_OFF_RAW" -le 240 ]; then
        AUTO_OFF_MIN=$((10#$AUTO_OFF_RAW))
    fi
fi
AUTO_OFF_ARGS=()
if [ "$AUTO_OFF_MIN" -gt 0 ]; then
    AUTO_OFF_ARGS=(--timeout="$((AUTO_OFF_MIN * 60))")
fi
ZENITY_TIMEOUT=5    # zenity's exit status when --timeout runs out

idle_power_off() {
    echo "SafeKeep: no activity at the unlock prompt for ${AUTO_OFF_MIN} min — Auto-Off (exit 4)"
    sudo umount "$DATA_MOUNT" 2>/dev/null || true
    exit 4
}

PASSWORD=""

# The vault's loop device (reused if it's already attached).
attach_loop() {
    LOOP_DEV=$(losetup -j "$DATA_MOUNT/$VAULT_FILE" 2>/dev/null | awk -F: '{print $1}' | head -1 || true)
    if [ -z "$LOOP_DEV" ]; then
        LOOP_DEV=$(sudo losetup --find --show "$DATA_MOUNT/$VAULT_FILE") || {
            sudo umount "$DATA_MOUNT" 2>/dev/null || true
            zenity --error --text="Failed to attach loop device." 2>/dev/null
            exit 1
        }
    fi
}

# How this vault unlocks: passphrase, security keys, or both. If the
# helper is missing or fails, the vault is treated as passphrase-only,
# which is how every vault starts.
if [ -f "$FIDO2_HELPER" ]; then
    attach_loop
    if VAULT_STATUS=$(sudo python3 -I "$FIDO2_HELPER" status "$LOOP_DEV" 2>/dev/null); then
        VAULT_KEY_COUNT=$(printf '%s' "$VAULT_STATUS" | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin).get("keys", [])))' 2>/dev/null || echo 0)
        if printf '%s' "$VAULT_STATUS" | python3 -I -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("passphrase") else 1)' 2>/dev/null; then
            VAULT_HAS_PASSPHRASE=true
        else
            VAULT_HAS_PASSPHRASE=false
        fi
    else
        VAULT_STATUS=""
    fi
    # Let the vault file go again until it's opened (attach_loop below),
    # so cancelling or a Temporary Session leaves the data partition free.
    sudo losetup -d "$LOOP_DEV" 2>/dev/null || true
    LOOP_DEV=""
    [[ "$VAULT_KEY_COUNT" =~ ^[0-9]+$ ]] || VAULT_KEY_COUNT=0
    # A vault with neither can't happen; fall back to the passphrase.
    if [ "$VAULT_HAS_PASSPHRASE" = false ] && [ "$VAULT_KEY_COUNT" -eq 0 ]; then
        VAULT_HAS_PASSPHRASE=true
    fi
fi

SK_TITLE="Unlock Vault"
SK_ZENITY_ARGS=("${AUTO_OFF_ARGS[@]}")
sk_timed_out() { idle_power_off; }
# shellcheck source=security-key-dialogs.sh
source "${SAFEKEEP_SECURITY_KEY_DIALOGS:-/usr/local/lib/safekeep/security-key-dialogs.sh}"

# Unlock with a security key: plug it in, its PIN, a touch. Returns 0
# once the vault is open, 1 to go back to the method choice.
unlock_with_key() {
    sk_wait_for_key "Plug in your security key." || return 1
    if [ "$(sk_probe_value pin)" != "set" ]; then
        sk_zenity --warning --title="$SK_TITLE" --width=460 \
            --text="This security key has no PIN, so it isn't one of this vault's keys." 2>/dev/null || true
        return 1
    fi
    sk_ask_pin "Type your security key's PIN.\n\nThen touch the key when it blinks." || return 1
    attach_loop
    sk_run "Touch your security key now..." 'printf "%s" "$SK_PIN"' open "$LOOP_DEV" "$MAPPER_NAME"
    local rc=$?
    SK_PIN=""
    if [ "$rc" -eq 0 ]; then
        UNLOCKED_WITH="key"
        return 0
    fi
    sk_error "$rc"
    return 1
}

# The choices on the first screen, for this vault.
METHODS=()
METHOD_TEXT="How would you like to enter your Master Passphrase?"
if [ "$VAULT_KEY_COUNT" -gt 0 ]; then
    METHODS+=("Use a Security Key")
    if [ "$VAULT_HAS_PASSPHRASE" = true ]; then
        METHOD_TEXT="How would you like to unlock your vault?"
    else
        METHOD_TEXT="This vault unlocks with a security key."
    fi
fi
if [ "$VAULT_HAS_PASSPHRASE" = true ]; then
    if [ "$HAS_CAMERA" = true ]; then
        METHODS+=("Scan QR Code")
    fi
    METHODS+=("Type Password")
fi
METHODS+=("Boot Temporary Session (RAM Only)")

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
    # (No camera: no "Scan QR Code". A vault with a security key lists
    # "Use a Security Key" first; one with no passphrase lists only that.)
    INPUT_METHOD=$(zenity --list --title="Unlock Vault" "${AUTO_OFF_ARGS[@]}" \
        --text="$METHOD_TEXT" \
        --column="Method" --hide-header \
        "${METHODS[@]}" 2>/dev/null)
    ZENITY_RC=$?
    [ "$ZENITY_RC" -eq "$ZENITY_TIMEOUT" ] && idle_power_off

    if [ -z "$INPUT_METHOD" ]; then
        # User clicked X / Cancel on the choice dialog → clean exit
        sudo umount "$DATA_MOUNT" 2>/dev/null || true
        exit 2
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
        echo "SafeKeep: User selected temporary session boot — signaling parent (exit 3)"
        exit 3
    fi

    # --- Execute chosen method ---
    # After the ephemeral interceptor above: a security key, a QR scan
    # (camera-equipped rigs only) or visible typing.
    if [ "$INPUT_METHOD" = "Use a Security Key" ] && [ "$VAULT_KEY_COUNT" -gt 0 ]; then
        if unlock_with_key; then
            break
        fi
        continue
    elif [ "$INPUT_METHOD" = "Scan QR Code" ] && [ "$VAULT_HAS_PASSPHRASE" = true ]; then
        PASSWORD=$(scan_qr_passphrase) || true
        if [ -z "$PASSWORD" ]; then
            zenity --warning "${AUTO_OFF_ARGS[@]}" --title="Scan Failed" \
                --text="QR scan did not return a result.\nReturning to method selection." 2>/dev/null || true
            continue  # Loop back to choice dialog
        fi
    elif [ "$INPUT_METHOD" = "Type Password" ] && [ "$VAULT_HAS_PASSPHRASE" = true ]; then
        # Visible entry — user can see what they're typing (for high-entropy strings).
        #
        # KEYBOARD UX (Enter-to-submit, no mouse required):
        #   zenity --entry opens with focus on the text field; the OK
        #   button is the default action, so pressing Enter from the
        #   text field submits the entry directly — no Tab to OK, no
        #   mouse click. --ok-label makes the action verb explicit so
        #   the user can see at a glance what Enter will do. We do NOT
        #   pass --modal or --attach which would push focus elsewhere.
        PASSWORD=$(zenity --entry --title="Unlock Vault" "${AUTO_OFF_ARGS[@]}" \
            --text="Enter your Master Passphrase (visible):" \
            --ok-label="Unlock" \
            --width=450 2>/dev/null)
        ZENITY_RC=$?
        [ "$ZENITY_RC" -eq "$ZENITY_TIMEOUT" ] && idle_power_off
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
        attach_loop

        # --- ATTEMPT DECRYPTION ---
        if printf '%s' "$PASSWORD" | sudo cryptsetup open "$LOOP_DEV" "$MAPPER_NAME" --key-file=-; then
            # Success — rate it for the app, clear it and break out to mount
            record_passphrase_rating
            PASSWORD=""
            break
        else
            # Wrong password — detach loop, clear password, show error, loop back
            sudo losetup -d "$LOOP_DEV" 2>/dev/null || true
            PASSWORD=""
            zenity --warning "${AUTO_OFF_ARGS[@]}" --title="Decryption Failed" --width=400 \
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
record_unlock_summary

# Success — no blocking dialog. The parent script (safekeep-boot.sh)
# will detect the mount and launch Chromium immediately.
echo "SafeKeep: Vault unlocked and mounted at $VAULT_MOUNT"
exit 0

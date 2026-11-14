#!/bin/bash
# =====================================================================
#  manage-security-key — Device Options → Security Keys
# =====================================================================
#  SECURITY_KEY_DESIGN.md, Part 1. Like Change Master Passphrase: the app
#  asks for this with the power action "securitykey", safekeep-boot.sh
#  locks the vault exactly as Lock does (Chromium closed, vault unmounted,
#  LUKS key evicted), then runs this script before the normal unlock
#  prompt. So passphrases, PINs and key secrets only ever pass through
#  these native dialogs and safekeep-fido2.py, never the browser or a disk.
#
#  1. Confirm the vault with whatever opens it now: the Master Passphrase
#     (scan or type) or a security key.
#  2. A menu, refreshed after each change:
#       Add a security key (at most 4)
#       Rename / Remove a security key
#       Use security keys only (removes the Master Passphrase): every key
#         must open the vault here first, and the risk is spelled out with
#         a box to check
#       Add a Master Passphrase (a vault with security keys only)
#  Every change is made by the helper, under a header backup in RAM, and
#  never removes the last way in. Then the normal unlock prompt follows.
#
#  Exit codes: 0 = done (changed or not), 1 = failed before the menu.
# =====================================================================
set -uo pipefail

export GDK_SCALE=2
export GDK_DPI_SCALE=1.0

DATA_LABEL="safekeep-data"
# Overridable for test-security-key.mjs only.
DATA_MOUNT="${SAFEKEEP_DATA_MOUNT:-/mnt/safekeep-data}"
VAULT_FILE=".vault.luks"
PASSPHRASE_HELPER="${SAFEKEEP_PASSPHRASE_HELPER:-/usr/local/lib/safekeep/safekeep-passphrase.py}"
FIDO2_HELPER="${FIDO2_HELPER:-/usr/local/lib/safekeep/safekeep-fido2.py}"
TITLE="Security Keys"

SK_TITLE="$TITLE"
# shellcheck source=security-key-dialogs.sh
source "${SAFEKEEP_SECURITY_KEY_DIALOGS:-/usr/local/lib/safekeep/security-key-dialogs.sh}"
PP_NOUN="Master Passphrase"
PP_TITLE="Add a Master Passphrase"
# shellcheck source=passphrase-dialogs.sh
source "${SAFEKEEP_PASSPHRASE_DIALOGS:-/usr/local/lib/safekeep/passphrase-dialogs.sh}"

LOOP_DEV=""
LOOP_ATTACHED=false
DATA_MOUNTED=false
EXISTING=""          # opens the vault now: the passphrase, or a key's slot key
EXISTING_SLOT=""     # the key slot EXISTING belongs to, if it's a key's
KEY_SECRET=""        # a security key's slot key, once one has opened the vault here
VERIFIED=" "         # key slots that have opened the vault in this run
LAST_KEY_SLOT=""     # the slot KEY_SECRET opens
CHANGED=false
STATUS=""

cleanup() {
    EXISTING=""
    KEY_SECRET=""
    PASSWORD=""
    SK_PIN=""
    if [ "$LOOP_ATTACHED" = true ] && [ -n "$LOOP_DEV" ]; then
        sudo losetup -d "$LOOP_DEV" 2>/dev/null || true
    fi
    if [ "$DATA_MOUNTED" = true ]; then
        sudo umount "$DATA_MOUNT" 2>/dev/null || true
    fi
}

finish() {
    cleanup
    if [ "$CHANGED" = true ]; then
        zenity --info --title="$TITLE" --width=460 \
            --text="Your changes are saved.\n\nUnlock your vault now. $(unlock_hint)" 2>/dev/null || true
    else
        zenity --info --title="$TITLE" --width=460 \
            --text="Nothing was changed.\n\nUnlock your vault as before." 2>/dev/null || true
    fi
    exit 0
}

failed() {
    cleanup
    zenity --error --title="$TITLE" --width=460 \
        --text="SafeKeepVault couldn't open the security key settings.\n\n$1\n\nUnlock your vault as before." 2>/dev/null || true
    exit 1
}

# --- The vault's state, from the helper (no key needed) ---
refresh() {
    STATUS=$(sudo python3 -I "$FIDO2_HELPER" status "$LOOP_DEV" 2>/dev/null) || STATUS=""
    [ -n "$STATUS" ] || failed "The vault's header couldn't be read."
}
st() {
    printf '%s' "$STATUS" | python3 -I -c 'import json, sys
s = json.load(sys.stdin)
q = sys.argv[1]
if q == "passphrase": print("yes" if s["passphrase"] else "no")
elif q == "count": print(len(s["keys"]))
elif q == "list":
    for k in s["keys"]: print("%d\t%s\t%s" % (k["slot"], k["name"], k["added"]))
elif q == "name":
    print(next((k["name"] for k in s["keys"] if str(k["slot"]) == sys.argv[2]), ""))' "$@" 2>/dev/null
}
mode_text() {
    if [ "$(st passphrase)" = no ]; then
        echo "Security key only"
    elif [ "$(st count)" -gt 0 ]; then
        echo "Passphrase or security key"
    else
        echo "Master Passphrase"
    fi
}
unlock_hint() {
    case "$(mode_text)" in
        "Security key only") echo "Choose Use a Security Key: this vault no longer has a Master Passphrase." ;;
        "Passphrase or security key") echo "Your Master Passphrase or a security key opens it." ;;
        *) echo "Your Master Passphrase opens it." ;;
    esac
}

# --- Opening the vault with a security key (any of its keys) ---
# Sets KEY_SECRET and adds the key's slot to VERIFIED. $1: what to say.
key_secret() {
    sk_wait_for_key "$1" || return 1
    if [ "$(sk_probe_value pin)" != "set" ]; then
        sk_error 17
        return 1
    fi
    sk_ask_pin "Type this security key's PIN.\n\nThen touch the key when it blinks." || return 1
    if ! sk_run "Touch your security key now..." 'printf "%s" "$SK_PIN"' secret "$LOOP_DEV"; then
        SK_PIN=""
        sk_error "$SK_RC"
        return 1
    fi
    SK_PIN=""
    local slot
    slot=$(printf '%s\n' "$SK_OUT" | sed -n 1p)
    KEY_SECRET=$(printf '%s\n' "$SK_OUT" | sed -n 2p)
    SK_OUT=""
    VERIFIED="$VERIFIED$slot "
    LAST_KEY_SLOT=$slot
    return 0
}

# --- 1. Explain ---
zenity --question --title="$TITLE" --width=480 \
    --ok-label="Continue" --cancel-label="Cancel" \
    --text="Your vault is locked.\n\nA security key (a YubiKey or another FIDO2 key) can unlock this vault instead of, or as well as, your Master Passphrase. First, unlock to make changes." \
    2>/dev/null || { cleanup; exit 0; }

# --- 2. Find the vault ---
DATA_PART=$(blkid -L "$DATA_LABEL" 2>/dev/null || true)
[ -n "$DATA_PART" ] || failed "The storage partition wasn't found."
sudo mkdir -p "$DATA_MOUNT"
if ! mountpoint -q "$DATA_MOUNT"; then
    sudo mount "$DATA_PART" "$DATA_MOUNT" || failed "The storage partition couldn't be mounted."
    DATA_MOUNTED=true
fi
[ -f "$DATA_MOUNT/$VAULT_FILE" ] || failed "No vault was found on this flash drive."
LOOP_DEV=$(losetup -j "$DATA_MOUNT/$VAULT_FILE" 2>/dev/null | awk -F: '{print $1}' | head -1 || true)
if [ -z "$LOOP_DEV" ]; then
    LOOP_DEV=$(sudo losetup --find --show "$DATA_MOUNT/$VAULT_FILE") || failed "The vault couldn't be opened."
    LOOP_ATTACHED=true
fi
refresh

# --- 3. Confirm the vault ---
# The Master Passphrase (scan or type) or a security key.
confirm_vault() {
    local methods=() method
    [ "$(st count)" -gt 0 ] && methods+=("Use a Security Key")
    if [ "$(st passphrase)" = yes ]; then
        [ "$HAS_CAMERA" = true ] && methods+=("Scan QR Code")
        methods+=("Type Password")
    fi
    while true; do
        method=$(zenity --list --title="$TITLE" --width=460 --height=360 \
            --text="Unlock to make changes. How would you like to unlock?" \
            --column="Method" --hide-header "${methods[@]}" 2>/dev/null) || true
        [ -n "$method" ] || return 1
        case "$method" in
            "Use a Security Key")
                if key_secret "Plug in one of this vault's security keys."; then
                    EXISTING=$KEY_SECRET
                    EXISTING_SLOT=$LAST_KEY_SLOT
                    return 0
                fi ;;
            "Scan QR Code")
                zenity --info --title="Scan QR" --width=350 \
                    --text="Hold the QR code of your Master Passphrase up to the camera.\nThe window will close automatically once read (or after ${QR_SCAN_TIMEOUT} seconds)." 2>/dev/null || true
                EXISTING=$(timeout "$QR_SCAN_TIMEOUT" zbarcam -1 --raw -Sdisable -Sqr.enable /dev/video0 2>/dev/null | tr -d '\n') || true
                if [ -z "$EXISTING" ]; then
                    zenity --warning --title="Scan Failed" --width=400 --text="QR scan did not return a result." 2>/dev/null || true
                    continue
                fi ;;
            *)
                EXISTING=$(zenity --entry --title="$TITLE" --width=460 \
                    --text="Enter your Master Passphrase (visible):" --ok-label="Next" 2>/dev/null) || true
                [ -n "$EXISTING" ] || continue ;;
        esac
        if [ "$method" != "Use a Security Key" ]; then
            if printf '%s' "$EXISTING" | sudo python3 -I "$PASSPHRASE_HELPER" verify "$LOOP_DEV" 2>/dev/null; then
                EXISTING_SLOT=""
                return 0
            fi
            EXISTING=""
            zenity --warning --title="Not Your Master Passphrase" --width=400 \
                --text="That passphrase doesn't open your vault.\n\nPlease try again." 2>/dev/null || true
        fi
    done
}
confirm_vault || finish

# --- 4. The actions ---
pick_key() {   # $1: the question. Prints the chosen slot.
    local rows=() slot name added
    while IFS=$'\t' read -r slot name added; do
        [ -n "$slot" ] && rows+=("$slot" "$name" "${added:-}")
    done < <(st list)
    zenity --list --title="$TITLE" --width=520 --height=400 --text="$1" \
        --column="Slot" --column="Security key" --column="Added" --hide-column=1 --print-column=1 \
        "${rows[@]}" 2>/dev/null
}

add_key() {
    local name default
    if [ "$(st count)" -ge 4 ]; then
        sk_error 20
        return
    fi
    sk_wait_for_key "Plug in the security key to add, and unplug any other security key." || return
    if [ "$(sk_probe_value pin)" = "set" ]; then
        sk_ask_pin "Type this security key's PIN." || return
    else
        sk_set_new_pin || return
    fi
    default="Security key $(( $(st count) + 1 ))"
    name=$(zenity --entry --title="$TITLE" --width=460 --ok-label="Add Security Key" \
        --text="A name for this security key, so you can tell your keys apart (for example \"Blue YubiKey\" or \"Spare\"):" \
        --entry-text="$default" 2>/dev/null) || { SK_PIN=""; return; }
    if sk_run "Touch your security key when it blinks: twice, once to add it and once more to check it." \
        'printf "%s\0%s\0%s" "$EXISTING" "$SK_PIN" "$name"' enroll "$LOOP_DEV"; then
        SK_PIN=""
        CHANGED=true
        refresh
        zenity --info --title="Security Key Added" --width=460 \
            --text="\"$name\" can now unlock this vault, with its PIN and a touch.$( [ "$(st count)" -eq 1 ] && printf '%s' '\n\nA spare security key, kept somewhere else, protects you if this one is lost or broken. You can add one here at any time.')" 2>/dev/null || true
    else
        SK_PIN=""
        sk_error "$SK_RC"
    fi
}

rename_key() {
    local slot name
    slot=$(pick_key "Which security key would you like to rename?") || return
    [ -n "$slot" ] || return
    name=$(zenity --entry --title="$TITLE" --width=460 --ok-label="Rename" \
        --text="New name:" --entry-text="$(st name "$slot")" 2>/dev/null) || return
    [ -n "$name" ] || return
    if sk_run "Renaming..." 'printf "%s" "$name"' rename "$LOOP_DEV" "$slot"; then
        CHANGED=true
        refresh
    else
        sk_error "$SK_RC"
    fi
}

remove_key() {
    local slot name other=""
    slot=$(pick_key "Which security key would you like to remove? It will no longer unlock this vault.") || return
    [ -n "$slot" ] || return
    name=$(st name "$slot")
    if [ "$(st passphrase)" = no ] && [ "$(st count)" -le 1 ]; then
        sk_error 21
        return
    fi
    zenity --question --title="Remove \"$name\"?" --width=460 --ok-label="Remove" --cancel-label="Keep It" \
        --text="\"$name\" will no longer unlock this vault." 2>/dev/null || return
    other=$EXISTING
    if [ "$EXISTING_SLOT" = "$slot" ]; then
        # The key being removed is the one that unlocked: unlock another way.
        zenity --info --title="$TITLE" --width=460 \
            --text="You unlocked with \"$name\". To remove it, unlock once more another way: your Master Passphrase or another security key." 2>/dev/null || true
        local saved=$EXISTING saved_slot=$EXISTING_SLOT
        if ! confirm_vault; then
            EXISTING=$saved
            EXISTING_SLOT=$saved_slot
            return
        fi
        if [ "$EXISTING_SLOT" = "$slot" ]; then
            sk_zenity --warning --title="$TITLE" --width=460 \
                --text="That was \"$name\" again. Use another way to unlock." 2>/dev/null || true
            return
        fi
        other=$EXISTING
    fi
    if sk_run "Removing \"$name\"..." 'printf "%s" "$other"' remove "$LOOP_DEV" "$slot"; then
        CHANGED=true
        VERIFIED=${VERIFIED// $slot / }
        if [ "$LAST_KEY_SLOT" = "$slot" ]; then
            KEY_SECRET=""
            LAST_KEY_SLOT=""
        fi
        refresh
        zenity --info --title="Security Key Removed" --width=460 \
            --text="\"$name\" no longer unlocks this vault." 2>/dev/null || true
    else
        sk_error "$SK_RC"
    fi
}

keys_only() {
    local slot name added untested=() choice understood
    # Every key must have opened the vault in this run.
    while true; do
        untested=()
        while IFS=$'\t' read -r slot name added; do
            [ -n "$slot" ] || continue
            case "$VERIFIED" in *" $slot "*) ;; *) untested+=("$slot") ;; esac
        done < <(st list)
        [ "${#untested[@]}" -eq 0 ] && [ -n "$KEY_SECRET" ] && break
        if [ "${#untested[@]}" -eq 0 ]; then
            untested=("$(st list | head -n1 | cut -f1)")
        fi
        slot=${untested[0]}
        name=$(st name "$slot")
        choice=$(zenity --list --title="Use Security Keys Only" --width=500 --height=380 \
            --text="Before the Master Passphrase is removed, each security key must open this vault once, so a forgotten PIN or a faulty key is caught now.\n\nNext: \"$name\"." \
            --column="Choice" --hide-header "Test \"$name\" now" "Remove \"$name\" instead" 2>/dev/null) || return
        case "$choice" in
            Test*)
                key_secret "Plug in \"$name\", and unplug any other security key." || continue
                case "$VERIFIED" in
                    *" $slot "*) ;;
                    *) sk_zenity --warning --title="$TITLE" --width=460 \
                        --text="That was a different security key. Plug in \"$name\"." 2>/dev/null ;;
                esac ;;
            Remove*)
                remove_key ;;
            *) return ;;
        esac
        [ "$(st count)" -gt 0 ] || return
    done
    local count warning
    count=$(st count)
    warning="Your vault will no longer have a Master Passphrase. Only your security key$([ "$count" -gt 1 ] && echo s) will open it, each with its PIN and a touch.\n\nIf you lose your security key (or every security key you add), or its PIN is blocked, this vault can't be opened. Your seed backup still restores your wallet. Saved wallets, the Passphrase Library and notes come back only from an Encrypted Backup: if you haven't made one recently, cancel, unlock, and make one first."
    if [ "$count" -eq 1 ]; then
        warning="$warning\n\nOnly one security key can open this vault. A spare kept somewhere else protects you if it's lost or broken."
    fi
    understood=$(zenity --list --checklist --title="Use Security Keys Only" --width=560 --height=560 \
        --text="$warning" --column="" --column="" --hide-header \
        FALSE "I understand, and want security keys only" 2>/dev/null) || return
    [ "$understood" = "I understand, and want security keys only" ] || return
    if sk_run "Removing the Master Passphrase..." 'printf "%s" "$KEY_SECRET"' remove-passphrase "$LOOP_DEV"; then
        CHANGED=true
        EXISTING=$KEY_SECRET
        EXISTING_SLOT=$LAST_KEY_SLOT
        refresh
        zenity --info --title="Security Keys Only" --width=460 \
            --text="This vault now unlocks with a security key only. Your Master Passphrase no longer opens it." 2>/dev/null || true
    else
        sk_error "$SK_RC"
    fi
}

add_passphrase() {
    keep_or_back() { return 1; }
    if [ -z "$KEY_SECRET" ]; then
        key_secret "Plug in one of this vault's security keys." || return
    fi
    PASSWORD=""
    choose_new_passphrase keep_or_back || return
    if sk_run "Adding the Master Passphrase..." 'printf "%s\0%s" "$KEY_SECRET" "$PASSWORD"' add-passphrase "$LOOP_DEV"; then
        PASSWORD=""
        CHANGED=true
        refresh
        zenity --info --title="Master Passphrase Added" --width=460 \
            --text="Your Master Passphrase or a security key now opens this vault." 2>/dev/null || true
    else
        PASSWORD=""
        sk_error "$SK_RC"
    fi
}

while true; do
    OPTIONS=()
    [ "$(st count)" -lt 4 ] && OPTIONS+=("Add a security key")
    if [ "$(st count)" -gt 0 ]; then
        OPTIONS+=("Rename a security key" "Remove a security key")
        if [ "$(st passphrase)" = yes ]; then
            OPTIONS+=("Use security keys only (remove the Master Passphrase)")
        fi
    fi
    [ "$(st passphrase)" = no ] && OPTIONS+=("Add a Master Passphrase")
    OPTIONS+=("Done")
    KEYS_TEXT=$(st list | awk -F'\t' '{ printf "\\n  •  %s (added %s)", $2, $3 }')
    CHOICE=$(zenity --list --title="$TITLE" --width=560 --height=560 \
        --text="This vault unlocks with: $(mode_text)${KEYS_TEXT:+\n\nSecurity keys:$KEYS_TEXT}" \
        --column="Action" --hide-header "${OPTIONS[@]}" 2>/dev/null) || true
    case "$CHOICE" in
        "Add a security key") add_key ;;
        "Rename a security key") rename_key ;;
        "Remove a security key") remove_key ;;
        "Use security keys only"*) keys_only ;;
        "Add a Master Passphrase") add_passphrase ;;
        *) finish ;;
    esac
done

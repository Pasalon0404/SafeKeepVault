#!/bin/bash
# =====================================================================
#  security-key-dialogs.sh — the security key screens (sourced)
# =====================================================================
#  SECURITY_KEY_DESIGN.md, Part 1. Shared by unlock-vault.sh (unlocking
#  with a security key) and manage-security-key.sh (Device Options →
#  Security Keys). Installed at /usr/local/lib/safekeep/.
#
#  Callers set before sourcing (all optional):
#    FIDO2_HELPER   the root helper (safekeep-fido2.py)
#    SK_ZENITY_ARGS array of extra zenity arguments (the Auto-Off timeout)
#  Callers may define sk_timed_out, run when a dialog times out.
#
#  A PIN is typed into a hidden zenity entry and goes to the helper on
#  stdin. The helper's stderr only ever holds a message and "retries=N".
# =====================================================================

FIDO2_HELPER=${FIDO2_HELPER:-/usr/local/lib/safekeep/safekeep-fido2.py}
if ! declare -p SK_ZENITY_ARGS >/dev/null 2>&1; then
    SK_ZENITY_ARGS=()
fi
SK_TITLE=${SK_TITLE:-Security Key}
SK_OUT=""          # the helper's stdout from the last sk_run
SK_ERR=""          # its stderr (a message; never a secret)
SK_RC=0
SK_PIN=""
SK_PROBE=""        # the last probe's JSON

# zenity, with the caller's extra arguments; a timeout calls sk_timed_out.
sk_zenity() {
    local rc
    zenity "${SK_ZENITY_ARGS[@]}" "$@"
    rc=$?
    if [ "$rc" -eq 5 ] && declare -F sk_timed_out >/dev/null; then
        sk_timed_out
    fi
    return "$rc"
}

# A value from the last probe's JSON.
sk_probe_value() {
    printf '%s' "$SK_PROBE" | python3 -I -c 'import json,sys
v = json.load(sys.stdin).get(sys.argv[1])
print("" if v is None else str(v).lower() if isinstance(v, bool) else v)' "$1" 2>/dev/null
}

# Run the helper as root: sk_run "Message while it runs" INPUT ARGS...
# INPUT is written to its stdin as is (use printf '%s\0%s' for several
# values: bash variables can't hold NUL, so callers pass a command).
# A pulsing progress window shows the message while it runs, since a
# security key waits for a touch.
sk_run() {
    local message=$1 input_cmd=$2
    shift 2
    local err_file zpid
    err_file=$(mktemp /tmp/safekeep-sk-XXXXXX)
    ( while :; do echo "# $message"; sleep 1; done ) |
        zenity --progress --pulsate --no-cancel --auto-close --title="$SK_TITLE" --width=460 \
            --text="$message" 2>/dev/null &
    zpid=$!
    SK_OUT=$(eval "$input_cmd" | sudo python3 -I "$FIDO2_HELPER" "$@" 2>"$err_file")
    SK_RC=$?
    kill "$zpid" 2>/dev/null || true
    wait "$zpid" 2>/dev/null || true
    SK_ERR=$(head -c 400 "$err_file" 2>/dev/null || true)
    rm -f "$err_file"
    return "$SK_RC"
}

# The tries left, from the helper's "retries=N" line.
sk_retries() {
    printf '%s\n' "$SK_ERR" | sed -n 's/^retries=\([0-9]*\)$/\1/p' | head -n1
}

# Plain words for the helper's exit codes (see safekeep-fido2.py).
sk_explain() {
    local left
    case "$1" in
        2)  echo "That doesn't open this vault." ;;
        10) echo "No security key was found. Plug it in, then try again." ;;
        11) echo "More than one security key is plugged in. A Trezor can count as one too. Unplug all but one, then try again." ;;
        12) echo "This isn't a FIDO2 security key with the hmac-secret feature, so it can't unlock a vault. Most current keys have it (YubiKey 5, Security Key by Yubico, Nitrokey 3, SoloKey 2, Google Titan)." ;;
        13) left=$(sk_retries)
            echo "Wrong PIN.${left:+ $left tries left before this security key locks for good.}" ;;
        14) echo "This security key's PIN is blocked after too many wrong PINs. It can't open this vault again.\n\nUnlock another way: your Master Passphrase or another security key, if this vault has one." ;;
        15) echo "Too many wrong PINs in a row. Unplug the security key, plug it back in, then try again." ;;
        16) echo "The security key wasn't touched in time. Try again, and touch it when it blinks." ;;
        17) echo "This security key isn't one of this vault's keys." ;;
        18) echo "This security key has no PIN yet." ;;
        19) echo "The security key refused that PIN. Use at least 6 characters." ;;
        20) echo "This vault already has 4 security keys. Remove one first." ;;
        21) echo "That would leave no way to open this vault, so it wasn't done." ;;
        22) echo "This security key is already one of this vault's keys." ;;
        *)  echo "Something went wrong with the security key." ;;
    esac
}

sk_error() {
    sk_zenity --warning --title="$SK_TITLE" --width=460 --text="$(sk_explain "$1")" 2>/dev/null || true
}

# Wait for exactly one FIDO2 key. $1: what to say. Returns 0 with
# SK_PROBE set, 1 if the user goes back.
sk_wait_for_key() {
    local text=$1
    while true; do
        if sk_run "Looking for your security key..." "printf ''" probe; then
            SK_PROBE=$SK_OUT
            if [ "$(sk_probe_value hmac)" != "true" ]; then
                sk_error 12
                sk_zenity --question --title="$SK_TITLE" --width=460 --ok-label="Try Again" --cancel-label="Go Back" \
                    --text="Plug in a different security key, then click Try Again." 2>/dev/null || return 1
                continue
            fi
            return 0
        fi
        case "$SK_RC" in
            10|11)
                sk_zenity --question --title="$SK_TITLE" --width=460 --ok-label="Continue" --cancel-label="Go Back" \
                    --text="$text\n\n$(sk_explain "$SK_RC")" 2>/dev/null || return 1 ;;
            *)
                sk_error "$SK_RC"
                return 1 ;;
        esac
    done
}

# Ask for the PIN of the key just probed. Returns 0 with SK_PIN set.
sk_ask_pin() {
    local text=$1 left
    left=$(sk_probe_value retries)
    SK_PIN=$(sk_zenity --entry --hide-text --title="$SK_TITLE" --width=460 --ok-label="Continue" \
        --text="$text${left:+\n\n($left tries left before this security key locks for good)}" 2>/dev/null) || return 1
    [ -n "$SK_PIN" ]
}

# Set a PIN on a key that has none: the warning, then the PIN twice.
# Returns 0 with SK_PIN set.
sk_set_new_pin() {
    local first second
    sk_zenity --question --title="Set a PIN for This Security Key" --width=480 --ok-label="Set a PIN" --cancel-label="Go Back" \
        --text="This security key has no PIN yet. SafeKeep needs one, so the key is no use to anyone who finds it without the PIN.\n\nChoose a PIN of at least 6 characters, and keep it somewhere safe.\n\nAfter 8 wrong PINs, the key locks for good and can never open this vault again." 2>/dev/null || return 1
    while true; do
        first=$(sk_zenity --entry --hide-text --title="Set a PIN for This Security Key" --width=460 --ok-label="Next" \
            --text="New PIN (at least 6 characters):" 2>/dev/null) || return 1
        if [ "${#first}" -lt 6 ]; then
            sk_zenity --warning --title="PIN Too Short" --width=420 --text="Use at least 6 characters." 2>/dev/null || true
            continue
        fi
        second=$(sk_zenity --entry --hide-text --title="Set a PIN for This Security Key" --width=460 --ok-label="Set PIN" \
            --text="Type the new PIN again:" 2>/dev/null) || return 1
        if [ "$first" != "$second" ]; then
            sk_zenity --warning --title="PINs Don't Match" --width=420 --text="The two PINs are different. Please try again." 2>/dev/null || true
            continue
        fi
        SK_PIN=$first
        if sk_run "Setting the PIN..." 'printf "%s" "$SK_PIN"' set-pin; then
            return 0
        fi
        sk_error "$SK_RC"
        [ "$SK_RC" -eq 19 ] || return 1
    done
}

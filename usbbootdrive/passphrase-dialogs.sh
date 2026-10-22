#!/bin/bash
# =====================================================================
#  passphrase-dialogs.sh — choosing a Master Passphrase (sourced)
# =====================================================================
#  The screens for choosing a new Master Passphrase, shared by first-boot
#  setup (setup-vault.sh) and Device Options → Change Master Passphrase
#  (change-passphrase.sh), so both offer the same choices and the same
#  checks (PASSPHRASE_STRENGTH_DESIGN.md). Installed at
#  /usr/local/lib/safekeep/passphrase-dialogs.sh.
#
#  Callers can set before sourcing: HAS_CAMERA (true/false; detected if
#  unset), QR_SCAN_TIMEOUT, PWCHECK (the strength checker), PP_NOUN and
#  PP_TITLE (wording). Entry point: choose_new_passphrase.
# =====================================================================

# --- Choosing a Master Passphrase ---
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
#
# A failed or timed-out QR scan returns to this method choice (as in
# unlock-vault) instead of leaving the user stuck at the camera, and
# so does Cancel in a typed entry or in Generate One for Me.
# Closing the choice itself calls the caller's on_close function.
if [ -z "${HAS_CAMERA:-}" ]; then
    HAS_CAMERA=false
    if ls /dev/video* 1>/dev/null 2>&1; then
        HAS_CAMERA=true
    fi
fi
QR_SCAN_TIMEOUT=${QR_SCAN_TIMEOUT:-30}
PWCHECK=${PWCHECK:-/usr/local/lib/safekeep/safekeep-pwcheck.py}
# What the screens call the passphrase being chosen, and their title.
PP_NOUN=${PP_NOUN:-Master Passphrase}
PP_TITLE=${PP_TITLE:-Lock Your Vault}

# STRENGTH CHECK (PASSPHRASE_STRENGTH_DESIGN.md):
#   Someone who finds the stick can copy the vault and guess offline,
#   so a Weak passphrase is refused and a Fair one needs "Use Anyway".
#   The same check runs for a typed and a scanned passphrase. The
#   passphrase goes to the checker on stdin and is never shown.
#   If the checker itself fails (it can't on a correct build), the
#   dialog says so and continues rather than leaving the stick unusable.
# Returns 0 to accept PASSWORD, 1 to choose another.
passphrase_ok() {
    local result band bits message
    result=$(printf '%s' "$PASSWORD" | python3 -I "$PWCHECK" --lines vault 2>/dev/null) || result=""
    { read -r band; read -r bits; read -r message; } <<< "$result"
    case "$band" in
        strong)
            return 0 ;;
        weak)
            zenity --warning --title="Passphrase Too Easy to Guess" --width=450 \
                --ok-label="Choose Another" \
                --text="Strength: Weak (about ${bits} bits)\n\nThis Master Passphrase is too easy to guess. ${message}\n\nAnyone who finds this stick can copy the vault and try likely passwords on their own computers, as fast as they can.\n\nUse a long random password from a password manager (as a QR code), or 6 or more random words." || true
            return 1 ;;
        fair)
            # zenity doesn't wrap the text above a list, and at GDK_SCALE=2
            # a long line runs off a 1920-pixel screen: break lines by hand.
            message=$(printf '%s' "$message" | fold -s -w 60)
            # Plain --list (see the Method dialog below): Enter picks the
            # highlighted first row, and closing the dialog also means
            # "Choose another", so only a deliberate pick keeps it.
            local choice
            choice=$(zenity --list --title="Passphrase Could Be Stronger" --width=450 --height=480 \
                --text="Strength: Fair (about ${bits} bits)\n\nThis Master Passphrase would take a determined attacker\na long time to guess, but not forever.\n${message}\n\nFor a vault that protects your bitcoin, we recommend a long\nrandom password from a password manager (as a QR code),\nor 6 or more random words." \
                --column="Choice" --hide-header \
                "Choose another passphrase" "Use this one anyway") || true
            [ "$choice" = "Use this one anyway" ]
            return ;;
        *)
            zenity --warning --title="Strength Check Unavailable" --width=450 \
                --text="SafeKeepVault couldn't check how strong this passphrase is.\n\nMake sure it is a long random password from a password manager, or 6 or more random words." || true
            return 0 ;;
    esac
}

# GENERATE ONE FOR ME (PASSPHRASE_STRENGTH_DESIGN.md, Part 2):
#   6 random BIP39 words (about 66 bits) from the kernel's random
#   number generator. One screen shows them as a QR code, for a phone's
#   password manager, and as numbered words, for paper: the user saves
#   it one way or both. Then the copy is checked before the vault is
#   locked with it: scanned back from the phone, or typed back from the
#   paper. Nobody has to write the words down if they use the QR code.
#   The passphrase is exactly the words: lowercase, one space between
#   them, as they are typed at unlock; the QR code holds the same text,
#   so Scan QR Code at unlock works with it too.
#   The QR code is drawn with qrencode in block characters and is never
#   written anywhere. Without qrencode (a stick built before it was
#   added) the screen shows the words only and the check is typing.
#   LC_ALL=C.UTF-8: zenity refuses non-ASCII text in a C locale.
# Returns 0 with PASSWORD set, 1 to go back to the method choice.
generate_passphrase() {
    local words shown qr intro body check typed scanned
    local -a checks
    words=$(python3 -I "$PWCHECK" --generate 6 2>/dev/null) || words=""
    if [ "$(printf '%s' "$words" | wc -w)" -ne 6 ]; then
        zenity --warning --title="Can't Generate a Passphrase" --width=400 \
            --text="SafeKeepVault couldn't generate a passphrase.\n\nChoose another way to set your Master Passphrase." || true
        return 1
    fi
    shown=$(printf '%s\n' $words | awk '{ printf "%d. %-10s", NR, $0; if (NR % 3 == 0 && NR < 6) printf "\\n" }')
    qr=""
    if command -v qrencode >/dev/null 2>&1; then
        qr=$(printf '%s' "$words" | qrencode -t UTF8i -m 2 2>/dev/null) || qr=""
    fi

    checks=()
    if [ -n "$qr" ]; then
        intro="Save it one way or both: scan the QR code into your phone's password manager, or write down the words."
        body="<span font_family='DejaVu Sans Mono, monospace' size='small' line_height='0.85'>${qr}</span>\n\n"
        [ "$HAS_CAMERA" = true ] && checks+=("Scan it back from my phone")
    else
        intro="Write these 6 words on paper now, in this order. Together they are your Master Passphrase. Keep the paper with your seed backup, or somewhere separate."
        body=""
    fi
    checks+=("Type the words" "Show the passphrase again")

    while true; do
        LC_ALL=C.UTF-8 zenity --info --title="Your Master Passphrase" --width=560 \
            --ok-label="Next: Check Your Copy" \
            --text="${intro}\n\n${body}<span font_family='monospace' size='large'><b>${shown}</b></span>\n\nNext you'll check your copy. It can't be shown again after setup." || return 1
        while true; do
            # Plain --list (see the Method dialog below). Closing it
            # shows the passphrase again rather than losing it.
            check=$(zenity --list --title="Check Your Copy" --width=450 --height=380 \
                --text="Before your vault is locked with this passphrase,\ncheck that your copy is right.\n\nTo unlock the vault, you will scan the QR code, or type the\nwords in lowercase with one space between each word." \
                --column="Check" --hide-header \
                "${checks[@]}") || check=""
            case "$check" in
                "Scan it back from my phone")
                    zenity --info --title="Scan It Back" --width=400 \
                        --text="Open the QR code you saved on your phone and hold it up to the camera.\nThe window will close automatically once read (or after ${QR_SCAN_TIMEOUT} seconds)." || true
                    scanned=$(timeout "$QR_SCAN_TIMEOUT" zbarcam -1 --raw \
                        -Sdisable -Sqr.enable /dev/video0 2>/dev/null | tr -d '\n') || scanned=""
                    if [ "$scanned" = "$words" ]; then
                        PASSWORD="$words"
                        return 0
                    fi
                    if [ -z "$scanned" ]; then
                        zenity --warning --title="Nothing Was Scanned" --width=420 \
                            --text="No QR code was read.\n\nTry again, or choose another way to check your copy." || true
                    else
                        zenity --warning --title="That Doesn't Match" --width=420 \
                            --text="That QR code isn't this passphrase.\n\nCheck you saved the QR code shown on the previous screen. You can show it again." || true
                    fi
                    ;;
                "Type the words")
                    typed=$(zenity --entry --title="Check Your Paper" --width=500 \
                        --text="Type the 6 words from your paper, in lowercase with one space between each word:" \
                        --ok-label="Set Passphrase" --cancel-label="Back") || continue
                    if [ "$typed" = "$words" ]; then
                        PASSWORD="$words"
                        return 0
                    fi
                    zenity --warning --title="That Doesn't Match" --width=420 \
                        --text="What you typed doesn't match the 6 words.\n\nCheck the spelling and the order on your paper, and use one space between words." || true
                    ;;
                *)
                    break
                    ;;
            esac
        done
    done
}

# Ask for a new passphrase until one is accepted: scanned, typed twice, or
# generated (QR code and words, then a checked copy). Weak ones are refused,
# Fair ones need "Use this one anyway". Sets PASSWORD and returns 0.
# $1: function to call when the method choice is closed. It returns 0 to
#     show the choice again, or 1 to give up: then PASSWORD is empty and this
#     returns 1. (setup-vault.sh's asks "go back, or shut down?";
#     change-passphrase.sh's asks whether to keep the current passphrase.)
choose_new_passphrase() {
    local on_close=$1
    local INPUT_METHOD PASSWORD_CONFIRM
    local -a METHODS
    METHODS=("Type Password" "Generate One for Me")
    if [ "$HAS_CAMERA" = true ]; then
        METHODS=("Scan QR Code" "${METHODS[@]}")
    fi

    PASSWORD=""
    while true; do
        INPUT_METHOD=$(zenity --list --title="$PP_TITLE" --width=450 --height=380 \
            --text="How would you like to set your ${PP_NOUN}?\n\nNo password manager? Choose Generate One for Me:\nSafeKeepVault makes a strong passphrase of 6 words for you." \
            --column="Method" --hide-header \
            "${METHODS[@]}") || true
        if [ -z "$INPUT_METHOD" ]; then
            "$on_close" && continue
            PASSWORD=""
            return 1
        fi

        if [ "$INPUT_METHOD" = "Generate One for Me" ]; then
            generate_passphrase && break
            PASSWORD=""
            continue
        fi

        if [ "$INPUT_METHOD" = "Scan QR Code" ]; then
            zenity --info --title="Scan QR" --width=350 \
                --text="Hold your SafeKeep QR code up to the camera.\nThe window will close automatically once read (or after ${QR_SCAN_TIMEOUT} seconds)." || true
            # Same scan as unlock-vault's scan_qr_passphrase(): time limit,
            # /dev/video0, newlines stripped — so the passphrase set here is
            # byte-for-byte the one unlock will send. Captured straight into
            # the variable (no temp file holding the passphrase).
            PASSWORD=$(timeout "$QR_SCAN_TIMEOUT" zbarcam -1 --raw \
                -Sdisable -Sqr.enable /dev/video0 2>/dev/null | tr -d '\n') || true
            if [ -n "$PASSWORD" ]; then
                passphrase_ok && break
                PASSWORD=""
                continue
            fi
            zenity --warning --title="Scan Failed" --width=400 \
                --text="QR scan did not return a result.\nReturning to method selection." || true
            continue
        fi

        # VISIBLE, CONFIRMED ENTRY:
        #   The passphrase is shown as it is typed (matching unlock-vault's
        #   visible entry) and asked for twice. A typo here would lock the
        #   vault with a passphrase the user does not know, and an empty
        #   vault cannot be factory-reset without unlocking it first — the
        #   only way out would be reflashing the stick.
        #
        # KEYBOARD UX: zenity --entry places focus on the text field and
        # OK is the default action, so Enter submits without a mouse
        # click. --ok-label makes the action verb explicit.
        while true; do
            PASSWORD=$(zenity --entry --title="$PP_TITLE" --width=450 \
                --text="Enter your ${PP_NOUN} (visible):" \
                --ok-label="Next") || true
            if [ -z "$PASSWORD" ]; then
                break
            fi
            # Checked before the confirmation, so a Weak one isn't typed twice.
            if ! passphrase_ok; then
                PASSWORD=""
                continue
            fi

            PASSWORD_CONFIRM=$(zenity --entry --title="$PP_TITLE" --width=450 \
                --text="Type your ${PP_NOUN} again to confirm:" \
                --ok-label="Set Passphrase") || true
            if [ -z "$PASSWORD_CONFIRM" ]; then
                unset PASSWORD_CONFIRM
                PASSWORD=""
                break
            fi

            if [ "$PASSWORD" = "$PASSWORD_CONFIRM" ]; then
                unset PASSWORD_CONFIRM
                break
            fi

            unset PASSWORD_CONFIRM
            PASSWORD=""
            zenity --warning --title="Passphrases Don't Match" --width=400 \
                --text="The two passphrases you typed are different.\n\nPlease type it again." || true
        done
        # Cancel in either typed entry goes back to the method choice.
        [ -n "$PASSWORD" ] && break
    done
    return 0
}

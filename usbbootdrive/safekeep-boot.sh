#!/bin/bash
# safekeep-boot.sh — Master boot wrapper for SafeKeep OS.
#
# Ensures the encrypted vault is set up and unlocked BEFORE
# Chromium ever launches, so boot.html can read master-seed.json.
#
# Boot sequence:
#   1. If vault already mounted (Chromium relaunch) → launch browser
#   2. Mount data partition, check for .setup_complete state marker
#   3. If marker MISSING (first boot):
#      → run setup-vault (vault creation + OS hardening + reboot)
#      → system reboots, this script never reaches step 4
#   4. If marker EXISTS (subsequent boots):
#      → run unlock-vault (passphrase prompt → decrypt → mount)
#   5. Launch Chromium with boot.html
#
# Called from: /etc/xdg/openbox/autostart

# NOTE: We intentionally do NOT use `set -e`. Child scripts (unlock-vault,
# setup-vault) return non-zero on user cancellation and wrong passwords,
# which are normal flow — not fatal errors. We handle every exit path
# explicitly with if/then checks.
set -uo pipefail

# ----------------------------------------------------------------------------
# GTK UI SCALING — double zenity dialog size for readability on HiDPI and
# small-screen laptops. GDK_SCALE is an integer widget-scale factor that
# uniformly doubles every GTK element (text, radio buttons, padding, window
# chrome, window bounds). GDK_DPI_SCALE is pinned to 1.0 to prevent compounding:
# if left unset the user's environment might supply a font-DPI scale that
# would multiply on top of GDK_SCALE's widget scale, producing over-large
# text inside normally-sized buttons. Applied only to zenity/GTK — Chromium
# honors its own --force-device-scale-factor flag and is unaffected. These
# exports are inherited by unlock-vault and setup-vault when invoked below,
# so dialogs stay uniformly 2x across the entire boot chain.
# ----------------------------------------------------------------------------
export GDK_SCALE=2
export GDK_DPI_SCALE=1.0

# Log startup for debugging (output captured by autostart redirect to
# /tmp/safekeep-boot.log). This is the ONLY diagnostic trace available
# if the script fails — it runs backgrounded with no controlling terminal.
echo ""
echo "========================================"
echo "safekeep-boot started at $(date)"
echo "PID=$$  DISPLAY=${DISPLAY:-unset}  USER=$(whoami)"
echo "========================================"
echo ""

# ------------------------------------------------------------------
# tty1 BOOT SPLASH — FIGlet slant "SafeKeepVault" logo + taglines
# ------------------------------------------------------------------
# Rendered to /dev/tty1 so the user sees a branded splash while the
# boot script runs (AMNESIA → INTEGRITY → vault unlock → Chromium).
#
# STRICT single-quoted heredoc: bash performs ZERO expansion on the
# body, so every backslash / backtick / dollar sign is passed through
# literally. Do NOT convert to double quotes or `echo -e` — that will
# break the ASCII art on real hardware.
#
# RAW-TTY SAFE: Each line is emitted through `printf '%s\r\n'` so the
# output contains an explicit Carriage Return + Line Feed on every
# row. On a raw Linux console where `stty onlcr` is disabled, a plain
# "\n" from `cat` only advances the cursor down one line without
# returning it to column 0 — the classic "staircase effect" that made
# the previous rendering look like `SafeKeepVaul?` because each line
# was offset a few columns to the right of the one above, chopping
# off the right edge of the logo.
#
# Width: every row is ≤80 cols so it does NOT wrap on a standard VGA
# text-mode tty1. This is the SAME slant-font art the systemd
# safekeep-splash.service writes at early boot from
# /etc/safekeep-splash.txt, for visual consistency across the two
# splash stages.
# ------------------------------------------------------------------
if [ -w /dev/tty1 ]; then
    {
        # ANSI reset + clear screen + cursor home. Does not depend on
        # TERM being set, unlike `clear`.
        printf '\033[2J\033[H\r'
        while IFS= read -r _skb_line; do
            printf '%s\r\n' "$_skb_line"
        done << 'SKB_LOGO_EOF'


          _____        ____      __ __                 __    __           ____
         / ___/____ _ / __/___  / //_/___   ___   ____ | |  / /____ _ __ / / /_
         \__ \/ __ `// /_ / _ \/ ,<  / _ \ / _ \ / __ \| | / // __ `// // / __/
        ___/ / /_/ // __//  __/ /| |/  __//  __// /_/ /| |/ // /_/ // // / /_
       /____/\__,_//_/   \___/_/ |_|\___/ \___// .___/ |___/ \__,_/ \__/\__/
                                              /_/

                         don't trust, verify.


SKB_LOGO_EOF
    } > /dev/tty1 2>/dev/null || true
fi

# ------------------------------------------------------------------
# ABSOLUTE AMNESIA — runtime swap disablement and attestation
# ------------------------------------------------------------------
# Even though GRUB passes `noswap` and sysctl sets vm.swappiness=0,
# we still call `swapoff -a` unconditionally at boot entry as a
# runtime belt-and-braces. This handles the pathological case where
# a swap device is activated after kernel boot (e.g. via udev rule
# or a user action) — by the time Chromium launches, we've
# guaranteed zero active swap devices for the signing session.
#
# The resulting state is then written to /run/safekeep-amnesia.json
# (tmpfs, RAM-only) so boot.html can fetch it and render the
# "RAM-only mode verified" badge on the welcome screen. /run is
# tmpfs on every modern systemd distro, so this file never touches
# a physical disk.
# ------------------------------------------------------------------
echo "[TEMP SESSION] Disabling all swap devices..."
swapoff -a 2>&1 || echo "[TEMP SESSION] swapoff -a returned non-zero (may already be disabled)"

SWAP_COUNT="$(swapon --show --noheadings 2>/dev/null | wc -l || echo 0)"
SWAP_COUNT="${SWAP_COUNT//[[:space:]]/}"
: "${SWAP_COUNT:=0}"

if [ "${SWAP_COUNT}" = "0" ]; then
    AMNESIA_STATUS="ok"
    AMNESIA_MSG="RAM-only mode verified: 0 swap devices active"
else
    AMNESIA_STATUS="fail"
    AMNESIA_MSG="WARNING: ${SWAP_COUNT} swap device(s) still active — RAM-only guarantee is broken"
fi

echo "[TEMP SESSION] ${AMNESIA_MSG}"

# Print the attestation to tty1 (the splash TTY) so the user sees it
# at boot time even before Chromium launches. Fails silently if tty1
# is unavailable (e.g. running under a nested X session for testing).
{
    echo ""
    echo "    ${AMNESIA_MSG}"
    echo ""
} > /dev/tty1 2>/dev/null || true

# Write the status file for boot.html to fetch. /run is tmpfs by
# default on every modern systemd distro, so this never hits disk.
mkdir -p /run 2>/dev/null || true
cat > /run/safekeep-amnesia.json 2>/dev/null << AMNEOF || true
{
  "status": "${AMNESIA_STATUS}",
  "swapCount": ${SWAP_COUNT},
  "message": "${AMNESIA_MSG}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
AMNEOF

# ------------------------------------------------------------------
# FIRST-BOOT INTEGRITY ATTESTATION — Item 5
# ------------------------------------------------------------------
# Re-computes the SHA-256 hash of /opt/safekeep/boot.html (the only
# file Chromium ever loads) and compares it against the expected
# hash baked into /opt/safekeep/manifest.json at build time.
#
# The comparison result is written to /run/safekeep-integrity.json
# (tmpfs, RAM-only) so boot.html can fetch it and render a pass/fail
# attestation badge alongside the Amnesia badge. On failure, the UI
# shows a red banner spanning the top of the screen and disables
# tool navigation.
#
# NOTE: This is a tamper-evidence signal, not a tamper-prevention
# one — a root-level attacker on the live USB can rewrite both
# boot.html and manifest.json. The real defenses are: (1) the
# read-only squashfs partition layout, and (2) the GRUB verified-
# boot chain in build.sh. This check catches accidental corruption,
# incomplete flash operations, and mismatched in-place edits.
# ------------------------------------------------------------------
BOOT_HTML="/opt/safekeep/boot.html"
MANIFEST="/opt/safekeep/manifest.json"
INTEGRITY_STATUS="unknown"
INTEGRITY_MSG="Integrity check did not run"
EXPECTED_HASH=""
LIVE_HASH=""

echo "[INTEGRITY] Verifying $BOOT_HTML against $MANIFEST..."

if [ ! -f "$BOOT_HTML" ]; then
    INTEGRITY_STATUS="fail"
    INTEGRITY_MSG="boot.html missing at $BOOT_HTML"
elif [ ! -f "$MANIFEST" ]; then
    INTEGRITY_STATUS="fail"
    INTEGRITY_MSG="manifest.json missing at $MANIFEST"
else
    # Extract the expected hash from manifest.json. We use grep/sed
    # instead of jq because jq isn't guaranteed to be on the minimal
    # live image, but the manifest format is stable (see build-offline.mjs).
    EXPECTED_HASH="$(
        grep -A2 '"boot.html"' "$MANIFEST" 2>/dev/null \
        | grep -oE '"sha256"[[:space:]]*:[[:space:]]*"[a-f0-9]+"' \
        | head -n1 \
        | sed -E 's/.*"([a-f0-9]+)".*/\1/'
    )"

    if [ -z "$EXPECTED_HASH" ]; then
        INTEGRITY_STATUS="fail"
        INTEGRITY_MSG="manifest.json did not contain sha256 for boot.html"
    else
        LIVE_HASH="$(sha256sum "$BOOT_HTML" 2>/dev/null | awk '{print $1}')"
        if [ -z "$LIVE_HASH" ]; then
            INTEGRITY_STATUS="fail"
            INTEGRITY_MSG="Failed to compute live sha256 of boot.html"
        elif [ "$LIVE_HASH" = "$EXPECTED_HASH" ]; then
            INTEGRITY_STATUS="ok"
            INTEGRITY_MSG="boot.html matches manifest (sha256: ${EXPECTED_HASH:0:12}…)"
        else
            INTEGRITY_STATUS="fail"
            INTEGRITY_MSG="HASH MISMATCH — expected ${EXPECTED_HASH:0:12}… got ${LIVE_HASH:0:12}…"
        fi
    fi
fi

echo "[INTEGRITY] ${INTEGRITY_MSG}"

# Echo to tty1 so the user sees the result at the splash screen
{
    echo ""
    echo "    INTEGRITY: ${INTEGRITY_MSG}"
    echo ""
} > /dev/tty1 2>/dev/null || true

# PASSED flag is a real JSON boolean so the front-end can trust it.
if [ "$INTEGRITY_STATUS" = "ok" ]; then
    PASSED_FLAG="true"
else
    PASSED_FLAG="false"
fi

# First-12 convenience for the UI pill so it never has to slice strings.
# Also emit the full hash so the UI can render "first8…last8" format.
HASH_PREFIX="${EXPECTED_HASH:0:12}"
HASH_FULL="${EXPECTED_HASH}"

cat > /run/safekeep-integrity.json 2>/dev/null << INTEOF || true
{
  "passed": ${PASSED_FLAG},
  "status": "${INTEGRITY_STATUS}",
  "message": "${INTEGRITY_MSG}",
  "expectedPrefix": "${HASH_PREFIX}",
  "expectedHash": "${HASH_FULL}",
  "algorithm": "sha256",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
INTEOF

DATA_LABEL="safekeep-data"
DATA_MOUNT="/mnt/safekeep-data"
VAULT_FILE=".vault.luks"
VAULT_MOUNT="/media/.safekeep-vault"
MAPPER_NAME="vault"
SEED_DIR="$VAULT_MOUNT/seeds"
SETUP_MARKER=".setup_complete"

# ---- EPHEMERAL MODE FLAG ----
# Set to 1 when unlock-vault exits 3 (user chose "Boot Ephemeral (RAM Only)"
# at the zenity passphrase prompt). When EPHEMERAL_MODE=1:
#   - The final "vault MUST be mounted" safety check is skipped.
#   - launch_browser() skips all vault-dependent setup (seeds dir creation,
#     sentinel write, wipe watcher daemon) and the Chromium URL is
#     appended with #ephemeral=true (HASH FRAGMENT, not query string —
#     Chromium treats ?foo=bar on file:/// URIs as part of the filename
#     and crashes with ERR_FILE_NOT_FOUND) so boot.html drops straight
#     into startEphemeralSession() instead of showing the lock overlay.
EPHEMERAL_MODE=0

# Chromium flags (passed as argument or use defaults)
SCALE_FACTOR="${SAFEKEEP_SCALE_FACTOR:-2}"
CHROMIUM_BASE_URL="file:///opt/safekeep/boot.html"

# Preferred mount point for the Transfer partition (used by initial mount)
TRANSFER_PREFERRED="/media/safekeep-transfer"

# -------------------------------------------------------------------
# DYNAMIC USB TRANSFER DRIVE DETECTION
# -------------------------------------------------------------------
# The exFAT Transfer partition may be mounted at different paths depending
# on the Linux environment:
#   - Our explicit mount:    /media/safekeep-transfer  (blkid -L "TRANSFER")
#   - Auto-mounter (udisks): /media/$USER/TRANSFER
#   - Manual mount:          /mnt/TRANSFER or similar
#
# This helper resolves the ACTUAL mount point at call time, using a
# multi-strategy fallback chain. Watchers call this before every write
# so they always target the real hardware — never a stale or empty path.
#
# Returns: prints the mount point path to stdout, or empty string if
#          no transfer drive is detected.
# Usage:  USB_DIR=$(find_transfer_drive)
#         [ -z "$USB_DIR" ] && echo "No drive" && exit 1
#
find_transfer_drive() {
    # Strategy 1: Check our preferred explicit mount point
    if mountpoint -q "$TRANSFER_PREFERRED" 2>/dev/null; then
        echo "$TRANSFER_PREFERRED"
        return 0
    fi

    # Strategy 2: Find by filesystem label "TRANSFER" via lsblk
    # lsblk -o LABEL,MOUNTPOINT -nr lists all block devices with their
    # labels and mount points. We look for our label specifically.
    local LABEL_MOUNT
    LABEL_MOUNT=$(lsblk -o LABEL,MOUNTPOINT -nr 2>/dev/null | awk '$1=="TRANSFER" && $2!="" {print $2; exit}')
    if [ -n "$LABEL_MOUNT" ] && mountpoint -q "$LABEL_MOUNT" 2>/dev/null; then
        echo "$LABEL_MOUNT"
        return 0
    fi

    # Strategy 3: Find any mounted removable drive (RM=1 in lsblk)
    # This catches USB drives auto-mounted by udisks/gvfs to dynamic paths.
    # Excludes the boot drive partitions (our own LUKS vault, data, EFI).
    local RM_MOUNT
    RM_MOUNT=$(lsblk -o RM,MOUNTPOINT,FSTYPE -nr 2>/dev/null | awk '
        $1==1 && $2!="" && $3!="crypto_LUKS" && $3!="ext4" && $3!="vfat" {
            print $2; exit
        }
    ')
    if [ -n "$RM_MOUNT" ] && mountpoint -q "$RM_MOUNT" 2>/dev/null; then
        echo "$RM_MOUNT"
        return 0
    fi

    # Strategy 4: Broadest removable scan — any RM=1 with a mount point,
    # excluding known internal mounts
    RM_MOUNT=$(lsblk -o RM,MOUNTPOINT -nr 2>/dev/null | awk '
        $1==1 && $2!="" && $2!="/" && $2!="/boot" && $2!="/boot/efi" {
            # Skip our own vault and data mounts
            if ($2 ~ /safekeep-vault/ || $2 ~ /safekeep-data/) next
            print $2; exit
        }
    ')
    if [ -n "$RM_MOUNT" ] && mountpoint -q "$RM_MOUNT" 2>/dev/null; then
        echo "$RM_MOUNT"
        return 0
    fi

    # No transfer drive found
    echo ""
    return 1
}

# -------------------------------------------------------------------
# STEP 1: CHECK VAULT STATE
# -------------------------------------------------------------------

# Helper: launch Chromium and exit
launch_browser() {
    echo "Vault ready. Launching SafeKeep..."

    # ==================================================================
    #  ENTROPY GATE — refuse to hand off to Chromium until the kernel
    #  CSPRNG reports at least 256 bits of entropy available.
    # ------------------------------------------------------------------
    #  Fresh live-USB boots often start with a starved entropy pool,
    #  especially on hardware without RDRAND or early jitter entropy.
    #  Chromium's window.crypto.getRandomValues() pulls from the same
    #  kernel pool that feeds /dev/random, so a starved pool at boot
    #  means a weak seed if the user hits "Generate" immediately.
    #
    #  We spin in a tight loop reading /proc/sys/kernel/random/entropy_avail.
    #  The first time we see it below the threshold we print a prominent
    #  "mash the keyboard" prompt to tty1; subsequent iterations update
    #  a single-line counter so the user sees progress. Once the pool
    #  reaches 256, we break out and proceed with the vault mount.
    # ==================================================================
    ENTROPY_REQUIRED=256
    ENTROPY_PROMPT_SHOWN=0
    while :; do
        ENTROPY_AVAIL="$(cat /proc/sys/kernel/random/entropy_avail 2>/dev/null || echo 0)"
        # Strip any stray whitespace and default to 0 if empty
        ENTROPY_AVAIL="${ENTROPY_AVAIL//[[:space:]]/}"
        : "${ENTROPY_AVAIL:=0}"

        if [ "${ENTROPY_AVAIL}" -ge "${ENTROPY_REQUIRED}" ] 2>/dev/null; then
            break
        fi

        if [ "${ENTROPY_PROMPT_SHOWN}" = "0" ]; then
            {
                echo ""
                echo "    ================================================================"
                echo "    ENTROPY POOL LOW  (${ENTROPY_AVAIL} / ${ENTROPY_REQUIRED} bits)"
                echo ""
                echo "    Please mash the keyboard or wiggle the mouse to generate"
                echo "    randomness. SafeKeep will launch automatically once the"
                echo "    kernel has collected enough entropy for safe seed"
                echo "    generation."
                echo "    ================================================================"
                echo ""
            } > /dev/tty1 2>/dev/null || true
            ENTROPY_PROMPT_SHOWN=1
        else
            printf "    Entropy: %s / %s bits          \r" \
                "${ENTROPY_AVAIL}" "${ENTROPY_REQUIRED}" > /dev/tty1 2>/dev/null || true
        fi

        sleep 1
    done

    if [ "${ENTROPY_PROMPT_SHOWN}" = "1" ]; then
        {
            echo ""
            echo "    Kernel CSPRNG ready: ${ENTROPY_AVAIL} bits available."
            echo ""
        } > /dev/tty1 2>/dev/null || true
    fi
    echo "[ENTROPY] Kernel CSPRNG ready: ${ENTROPY_AVAIL} bits available."

    # ── Ensure the DATA partition is mounted ──
    # The unlock flow (line ~1084) unmounts $DATA_MOUNT before calling
    # unlock-vault. We MUST re-mount it here because the Wipe Watcher
    # daemon needs to write the .wipe_pending flag to the PERSISTENT ext4
    # partition — not the casper tmpfs overlay. Without this, the flag is
    # written to RAM and lost on reboot, causing Phase 2 (LUKS header
    # destruction) to never fire.
    if ! mountpoint -q "$DATA_MOUNT" 2>/dev/null; then
        DATA_PART_DEV=$(blkid -L "$DATA_LABEL" 2>/dev/null || true)
        if [ -n "$DATA_PART_DEV" ]; then
            sudo mkdir -p "$DATA_MOUNT"
            sudo mount "$DATA_PART_DEV" "$DATA_MOUNT"
            echo "Data partition re-mounted at $DATA_MOUNT (required for wipe watcher)"
        else
            echo "WARNING: Cannot find data partition (label: $DATA_LABEL) — factory reset will be incomplete"
        fi
    else
        echo "Data partition already mounted at $DATA_MOUNT"
    fi

    # ---- VAULT-DEPENDENT SETUP ----
    # In ephemeral mode, the LUKS vault was never unlocked, /dev/mapper/vault
    # does not exist, and $VAULT_MOUNT is just an empty directory (not a
    # mountpoint). Writing the seeds dir or sentinel there would create
    # phantom files on the root overlay. Skip this entire block.
    if [ "$EPHEMERAL_MODE" != "1" ]; then
        # Ensure the seeds directory exists inside the vault BEFORE Chromium starts.
        # The vault-aware code paths (master-seed.json autosave) write directly
        # to this directory. Chromium's default download goes to TRANSFER instead.
        sudo mkdir -p "$VAULT_MOUNT/seeds"
        sudo chown "$(whoami)" "$VAULT_MOUNT/seeds"
        sudo chmod 700 "$VAULT_MOUNT/seeds"

        # ── Write the Vault Sentinel ──
        # This file proves to the browser that the REAL LUKS partition is mounted,
        # not a tmpfs/overlayfs ghost directory. The sentinel contains the dm-crypt
        # UUID from /dev/mapper/vault, which is only available after cryptsetup
        # successfully opens the encrypted volume. The browser checks for this file
        # before every save operation — if it's missing or malformed, saves are
        # blocked to prevent data loss to volatile RAM.
        SENTINEL_FILE="$VAULT_MOUNT/seeds/.vault-sentinel.json"
        VAULT_UUID=""
        if [ -e "/dev/mapper/$MAPPER_NAME" ]; then
            VAULT_UUID=$(sudo cryptsetup luksUUID "/dev/mapper/$MAPPER_NAME" 2>/dev/null || true)
            # Fallback: try the dmsetup info approach
            if [ -z "$VAULT_UUID" ]; then
                VAULT_UUID=$(sudo dmsetup info "$MAPPER_NAME" --noheadings -c -o uuid 2>/dev/null || true)
            fi
        fi
        # Even if UUID extraction fails, write a sentinel with the mapper presence
        # as proof. An empty UUID still proves cryptsetup ran (the mapper exists).
        if [ -e "/dev/mapper/$MAPPER_NAME" ]; then
            echo "{\"uuid\":\"${VAULT_UUID}\",\"mapper\":\"$MAPPER_NAME\",\"ts\":$(date +%s)}" > "$SENTINEL_FILE"
            echo "Vault sentinel written (UUID: ${VAULT_UUID:-unknown})"
        else
            echo "WARNING: /dev/mapper/$MAPPER_NAME not found — vault sentinel NOT written"
            echo "Saves will be blocked by the browser until the vault is properly unlocked."
        fi
    else
        echo "TEMPORARY SESSION: skipping seeds directory and vault sentinel (vault never unlocked)."
    fi

    # Mount the exFAT Transfer partition so the user can exchange files
    # with Mac/Windows machines. This is the ONLY drive visible in the
    # file explorer — all internal partitions are hidden by udev rules.
    #
    # CRITICAL DECOUPLING (task #91): this block runs UNCONDITIONALLY,
    # OUTSIDE the `[ "$EPHEMERAL_MODE" != "1" ]` guard above. The
    # Transfer Drive is a plaintext, non-sensitive partition used strictly
    # for air-gapped file transport — it has no cryptographic dependency
    # on the encrypted LUKS vault. A Temporary-mode user MUST retain full
    # read/write access to export signed PSBTs, addresses, and logs, since
    # that is the primary workflow a Temporary session exists to support.
    # Do NOT wrap this mount in an ephemeral guard.
    #
    # First try our explicit mount by label, then fall back to dynamic detection
    # in case an auto-mounter (udisks/gvfs) grabbed it first.
    TRANSFER_MOUNT=""
    TRANSFER_PART_DEV=$(blkid -L "TRANSFER" 2>/dev/null || true)
    if [ -n "$TRANSFER_PART_DEV" ]; then
        sudo mkdir -p "$TRANSFER_PREFERRED"
        if ! mountpoint -q "$TRANSFER_PREFERRED" 2>/dev/null; then
            if sudo mount -t exfat "$TRANSFER_PART_DEV" "$TRANSFER_PREFERRED" 2>/dev/null; then
                echo "Transfer partition mounted at $TRANSFER_PREFERRED"
            else
                echo "Warning: explicit mount failed, checking auto-mount..."
            fi
        fi
        if mountpoint -q "$TRANSFER_PREFERRED" 2>/dev/null; then
            TRANSFER_MOUNT="$TRANSFER_PREFERRED"
            sudo chown "$(whoami)" "$TRANSFER_MOUNT"
            sudo chmod 755 "$TRANSFER_MOUNT"
        fi
    fi

    # If explicit mount didn't work, try dynamic detection (auto-mounter may
    # have grabbed the drive at a different path like /media/$USER/TRANSFER)
    if [ -z "$TRANSFER_MOUNT" ]; then
        TRANSFER_MOUNT=$(find_transfer_drive)
        if [ -n "$TRANSFER_MOUNT" ]; then
            echo "Transfer drive detected via auto-mount at $TRANSFER_MOUNT"
        else
            echo "Warning: TRANSFER partition not found. Airlock not available."
        fi
    fi

    # Write the resolved path so the frontend (boot.js) can read it at runtime
    # via fetch(). This bridges the gap between dynamic bash detection and the
    # browser's hardcoded TRANSFER_ROOT constant.
    #
    # EPHEMERAL-MODE HANDLING (task #91): in Temporary sessions the encrypted
    # vault was never unlocked, so $VAULT_MOUNT/seeds/ does NOT exist and
    # writing the path file there would either fail with "No such file or
    # directory" (cosmetic noise) or land as a phantom file on the root
    # overlay (a minor write leak to the unencrypted OS partition). Skip
    # the write entirely — the frontend's _resolveTransferRoot() already
    # catches fetch failures and falls back to the default
    # /media/safekeep-transfer mount point, which is exactly where the
    # block above just mounted the drive. No functional loss.
    if [ "$EPHEMERAL_MODE" = "1" ]; then
        echo "TEMPORARY SESSION: skipping .transfer-mount-path write (frontend uses default /media/safekeep-transfer)."
    else
        TRANSFER_PATH_FILE="$VAULT_MOUNT/seeds/.transfer-mount-path"
        if [ -n "$TRANSFER_MOUNT" ]; then
            echo "$TRANSFER_MOUNT" > "$TRANSFER_PATH_FILE"
            echo "Transfer path written to $TRANSFER_PATH_FILE → $TRANSFER_MOUNT"
        else
            echo "" > "$TRANSFER_PATH_FILE"
        fi
    fi

    # --- Generate Archive Index for Reliquary Restore UI ---
    # The browser cannot list directory contents via file:// protocol.
    # We pre-generate a JSON index of all archive artefacts on the
    # transfer drive so SafeKeepOS.listBackups() can fetch it.
    #
    # The index includes two file kinds:
    #   • *.7z  — encrypted Reliquary backups (used for restore)
    #   • *.json — hardware-wallet exports (e.g. safekeep-nunchuk.json
    #              produced by The Armory's "Download JSON" button)
    # The index file itself (.backups-index.json) is excluded by the
    # leading-dot filter since it is a hidden dotfile and should never
    # be listed as a user artefact.
    #
    # The browser-side UI classifies each entry by extension and
    # renders .json files as read-only "Export" rows (no unlock prompt).
    regenerate_backups_index() {
        local TRANSFER_DIR="$1"
        [ -d "$TRANSFER_DIR" ] || return 0
        local IDX_FILE="$TRANSFER_DIR/.backups-index.json"
        (
            echo "["
            local FIRST=true
            # ls -1t sorts newest-first across BOTH extensions. If either
            # glob has zero matches the shell expands it back to the
            # literal pattern; the outer 2>/dev/null and the `-f` test
            # below filter those non-files cleanly.
            for f in $(ls -1t "$TRANSFER_DIR"/*.7z "$TRANSFER_DIR"/*.json 2>/dev/null); do
                [ -f "$f" ] || continue
                local BN
                BN=$(basename "$f")
                # Skip our own hidden index file if a stray glob ever
                # picked it up (case: dotglob-enabled shells).
                case "$BN" in
                    .backups-index.json|.backups*) continue ;;
                esac
                if [ "$FIRST" = true ]; then
                    FIRST=false
                else
                    echo ","
                fi
                echo "  \"$BN\""
            done
            echo "]"
        ) > "$IDX_FILE"
    }

    if [ -d "$TRANSFER_MOUNT" ]; then
        BACKUPS_INDEX="$TRANSFER_MOUNT/.backups-index.json"
        regenerate_backups_index "$TRANSFER_MOUNT"
        echo "Backups index: $(cat "$BACKUPS_INDEX" | tr -d '\n')"
    fi

    # --- Rescue orphaned .meta.json sidecars from seeds/ ---
    # If a previous session had the race condition where the File Router
    # moved a .html to codex/ but the .meta.json arrived in seeds/ after,
    # rescue those orphans now BEFORE building the index.
    for ORPHAN in "$SEED_DIR"/*.meta.json; do
        [ -f "$ORPHAN" ] || continue
        ORPHAN_SLUG="$(basename "$ORPHAN" .meta.json)"
        if [ -f "$VAULT_MOUNT/codex/${ORPHAN_SLUG}.html" ]; then
            mv "$ORPHAN" "$VAULT_MOUNT/codex/$(basename "$ORPHAN")" 2>/dev/null
            echo "Boot: rescued orphaned $(basename "$ORPHAN") → codex/"
        fi
    done

    # --- Generate Codex Index for boot-time note loading ---
    # The browser cannot list directory contents via file:// protocol.
    # We pre-generate a JSON index of all notes in codex/ so
    # SafeKeepOS can populate _codexStore at boot time.
    #
    # Task #213 (data-loss bugfix): The JS layer (shared/boot.js Sprint 22)
    # was refactored to write notes as a SINGLE .html file with metadata
    # embedded as a leading HTML comment of the form
    #   <!--SAFEKEEP_META:{"title":"…","slug":"…","updatedAt":"…"}-->
    # The previous implementation here scanned *.meta.json sidecars only.
    # Because the JS no longer writes sidecars, the loop was producing an
    # empty array → empty in-memory store on boot → notes invisible after
    # a backup/restore cycle (the .html files were on disk but unindexed).
    #
    # New strategy: scan *.html files directly, extract the embedded
    # SAFEKEEP_META JSON from the first line, and emit it. Falls back to
    # any legacy .meta.json sidecar if no embedded header is present, so
    # older notes saved before Sprint 22 still hydrate correctly.
    CODEX_INDEX_DIR="$VAULT_MOUNT/codex"
    mkdir -p "$CODEX_INDEX_DIR" 2>/dev/null
    CODEX_INDEX="$CODEX_INDEX_DIR/.codex-index.json"
    (
        echo "["
        FIRST=true
        for f in "$CODEX_INDEX_DIR"/*.html; do
            [ -f "$f" ] || continue
            BASENAME=$(basename "$f")
            SLUG="${BASENAME%.html}"
            # Try the embedded SAFEKEEP_META header first.
            META_LINE=$(head -1 "$f" 2>/dev/null)
            META_JSON=""
            case "$META_LINE" in
                '<!--SAFEKEEP_META:'*'-->'*)
                    # Strip the prefix and trailing -->.  Tolerates a CR.
                    META_JSON="${META_LINE#<!--SAFEKEEP_META:}"
                    META_JSON="${META_JSON%%-->*}"
                    ;;
            esac
            # Legacy fallback — pre-Sprint 22 notes have a sidecar.
            if [ -z "$META_JSON" ]; then
                SIDECAR="$CODEX_INDEX_DIR/${SLUG}.meta.json"
                if [ -f "$SIDECAR" ]; then
                    META_JSON=$(cat "$SIDECAR")
                fi
            fi
            # No metadata anywhere — synthesize a minimal entry from the
            # filename so the note still appears in the listing rather
            # than being silently dropped.
            if [ -z "$META_JSON" ]; then
                META_JSON="{\"title\":\"$SLUG\",\"slug\":\"$SLUG\",\"updatedAt\":\"\"}"
            fi
            if [ "$FIRST" = true ]; then
                FIRST=false
            else
                echo ","
            fi
            printf '%s' "$META_JSON"
        done
        echo
        echo "]"
    ) > "$CODEX_INDEX"
    echo "Codex index: $(wc -l < "$CODEX_INDEX") lines"

    # --- Generate Passphrase Index for boot-time cipher loading ---
    # Same approach: pre-generate a JSON index of all passphrase files
    # so SafeKeepOS can populate _passphraseStore at boot time.
    PASS_INDEX_DIR="$VAULT_MOUNT/passphrases"
    mkdir -p "$PASS_INDEX_DIR" 2>/dev/null
    PASS_INDEX="$PASS_INDEX_DIR/.passphrase-index.json"
    (
        echo "["
        FIRST=true
        for f in "$PASS_INDEX_DIR"/*.json; do
            [ -f "$f" ] || continue
            BASENAME=$(basename "$f")
            # Skip the index file itself
            case "$BASENAME" in
                .passphrase-index.json) continue ;;
            esac
            if [ "$FIRST" = true ]; then
                FIRST=false
            else
                echo ","
            fi
            # Emit the full .json contents (contains nickname, slug, passphrase, masked, updatedAt)
            cat "$f"
        done
        echo "]"
    ) > "$PASS_INDEX"
    echo "Passphrase index: $(wc -l < "$PASS_INDEX") lines"

    # --- Signal directory (tmpfs) for OS protocol files ---
    # Used for non-seed protocol signals (e.g. POWER_ACTION.txt) that
    # must survive Chromium's exit but never touch encrypted storage.
    # Lives on /tmp (tmpfs → RAM-only) so it is cleared on every boot
    # cycle automatically. Still cleared explicitly here to defeat any
    # stale signal left behind from a previous Chromium crash.
    SIGNAL_DIR="/tmp/safekeep-signals"
    mkdir -p "$SIGNAL_DIR"
    rm -f "$SIGNAL_DIR"/POWER_ACTION.txt 2>/dev/null || true
    chmod 1777 "$SIGNAL_DIR" 2>/dev/null || true
    echo "Signal dir: $SIGNAL_DIR (tmpfs, cleared of stale signals)"

    # --- Pick Chromium's DownloadDirectory based on boot mode ---
    # Normal boot: the encrypted vault is mounted; downloads (master-seed.json,
    #   WIPE_TRIGGER, POWER_ACTION, etc.) must land in $SEED_DIR so they are
    #   encrypted at rest.
    # Ephemeral boot: the vault is NEVER unlocked. $SEED_DIR does not exist.
    #   Route downloads to the tmpfs signal dir — any seed-material download
    #   would already be blocked upstream by the Amnesia / Volatile firewall.
    if [ "$EPHEMERAL_MODE" = "1" ]; then
        CHROMIUM_DOWNLOAD_DIR="$SIGNAL_DIR"
        POWER_ACTION_READ_PATH="$SIGNAL_DIR/POWER_ACTION.txt"
    else
        CHROMIUM_DOWNLOAD_DIR="$SEED_DIR"
        POWER_ACTION_READ_PATH="$SEED_DIR/POWER_ACTION.txt"
        # Defeat stale signal files from a previous Chromium run in this boot
        rm -f "$POWER_ACTION_READ_PATH" 2>/dev/null || true
    fi

    # --- Write Chromium enterprise policy at launch time ---
    # This overwrites any stale policy baked in at build time.
    #
    # CRITICAL (normal boot): DownloadDirectory MUST point to the encrypted
    # vault's seeds directory — NOT the unencrypted TRANSFER partition.
    # The master-seed.json is written via a Blob <a download="master-seed.json">
    # click, and Chromium routes that to whatever DownloadDirectory says.
    #
    # PromptForDownloadLocation = false: silent download, no dialog.
    # This ensures the seed file lands on the LUKS partition every time.
    #
    # For PSBT / Optical Transfer exports, the app explicitly creates a save
    # dialog or writes to a different filename — those are handled in-app.
    POLICY_DIR="/etc/chromium/policies/managed"
    sudo mkdir -p "$POLICY_DIR"
    # DeveloperToolsAvailability=2 → "DeveloperToolsDisallowed". This is
    # the managed-policy-level kill switch for F12 / Ctrl+Shift+I and
    # every URL-based DevTools entry point. It cannot be re-enabled by
    # the user and persists across Chromium updates. Paired with the
    # --disable-dev-tools command-line flag below for belt-and-braces.
    sudo tee "$POLICY_DIR/safekeep.json" > /dev/null << POLICYEOF
{
    "DownloadDirectory": "$CHROMIUM_DOWNLOAD_DIR",
    "DefaultDownloadDirectory": "$CHROMIUM_DOWNLOAD_DIR",
    "PromptForDownloadLocation": false,
    "AutomaticDownloadsAllowedForUrls": ["file://*"],
    "DeveloperToolsAvailability": 2
}
POLICYEOF
    echo "Chromium policy: downloads → $CHROMIUM_DOWNLOAD_DIR"
    echo "Chromium policy: DevTools disallowed (DeveloperToolsAvailability=2)"
    echo "Power-action read path: $POWER_ACTION_READ_PATH"

    # Probe the vault for an existing master seed.
    # If the file exists and is NOT a wiped marker, tell the frontend
    # the vault is already initialized so it can lock out seed creation.
    # In ephemeral mode the vault is sealed — there is no seed file to probe,
    # and the frontend should drop straight into startEphemeralSession().
    #
    # CRITICAL — HASH FRAGMENTS, NOT QUERY STRINGS:
    # Chromium treats query strings (?foo=bar) on file:/// URIs as part of
    # the literal filename — it looks for a file called "boot.html?foo=bar"
    # on disk and crashes with ERR_FILE_NOT_FOUND. Hash fragments (#foo=bar)
    # are handled client-side by the browser and never hit the filesystem
    # layer, so they load correctly. boot.html reads these via
    # window.location.hash. DO NOT revert to "?".
    SEED_FILE="$VAULT_MOUNT/seeds/master-seed.json"
    LAUNCH_URL="$CHROMIUM_BASE_URL"

    if [ "$EPHEMERAL_MODE" = "1" ]; then
        LAUNCH_URL="${CHROMIUM_BASE_URL}#ephemeral=true"
        echo "TEMPORARY SESSION: launching with #ephemeral=true (RAM-only, vault bypassed)."
    elif [ -f "$SEED_FILE" ]; then
        # Check whether the file is a wiped marker (contains __SAFEKEEP_WIPED__)
        if ! grep -q '__SAFEKEEP_WIPED__' "$SEED_FILE" 2>/dev/null; then
            echo "Existing master seed detected — launching in initialized mode."
            LAUNCH_URL="${CHROMIUM_BASE_URL}#state=initialized"
        else
            echo "Wiped marker found — launching in welcome mode (clean base URL)."
        fi
    else
        echo "No seed file — launching in welcome mode (clean base URL)."
    fi

    # -------------------------------------------------------------------
    # WIPE WATCHER DAEMON — TWO-PHASE CRYPTOGRAPHIC FACTORY RESET
    # -------------------------------------------------------------------
    # The web app (boot.js) cannot delete files from the OS filesystem.
    # To perform a Factory Reset, it silently downloads a trigger file:
    #   /media/.safekeep-vault/seeds/WIPE_TRIGGER.txt
    #
    # This is PHASE 1 of a two-phase cryptographic wipe:
    #
    #   PHASE 1 (here, immediate — best-effort content deletion):
    #     1. Delete master-seed.json (fast rm — browser polls for this)
    #     2. rm -rf codex/, passphrases/, settings/ (best-effort)
    #     3. Clean all remaining files from seeds/
    #     4. Write .wipe_pending flag to the DATA partition (persists)
    #     5. Remove trigger file (signals browser that Phase 1 is done)
    #     6. sync to flush writes
    #
    #   PHASE 2 (next boot, before vault unlock — cryptographic kill):
    #     The boot-time check near the top of this script detects
    #     .wipe_pending, zeroes the 16MB LUKS header (destroying all
    #     keyslots and the volume master key), deletes the vault file,
    #     removes the setup marker, and reboots into first-boot setup.
    #
    # WHY TWO PHASES:
    #   - File-level shred is INEFFECTIVE on SSDs (wear leveling moves
    #     data to new blocks; the old blocks may retain the original
    #     content). Shredding gives a false sense of security.
    #   - LUKS header destruction is the ONLY reliable guarantee:
    #     without keyslots, the volume master key is unrecoverable,
    #     making ALL data inside the LUKS container cryptographically
    #     inaccessible — regardless of what's on the raw blocks.
    #   - Phase 1 provides immediate UI feedback (master-seed gone →
    #     Welcome screen) and best-effort cleanup of plaintext files.
    #     Phase 2 provides the cryptographic guarantee on next boot.
    #
    # CRITICAL: The Transfer Drive (/media/safekeep-transfer/) is NEVER
    # touched. User .7z backups and .psbt exports are preserved across
    # factory resets. Only the encrypted LUKS vault is wiped.
    WIPE_TRIGGER="$SEED_DIR/WIPE_TRIGGER.txt"

    # In ephemeral mode the vault was never unlocked, so $SEED_DIR does not
    # exist and there is no vault content to wipe. A factory reset in
    # ephemeral mode is a no-op from the browser's perspective (RAM clears
    # on poweroff), so we skip the wipe watcher entirely. WIPE_WATCHER_PID
    # is left empty; the `kill "$WIPE_WATCHER_PID"` call after Chromium
    # exits is silenced by its trailing `|| true`.
    WIPE_WATCHER_PID=""
    if [ "$EPHEMERAL_MODE" = "1" ]; then
        echo "TEMPORARY SESSION: wipe watcher skipped (nothing to wipe in RAM-only session)."
    else
    (
        while true; do
            if [ -f "$WIPE_TRIGGER" ]; then
                echo "SafeKeep Wipe Watcher: trigger detected — executing two-phase factory reset (Phase 1)..."
                echo "SafeKeep Wipe Watcher: VAULT_MOUNT=$VAULT_MOUNT  DATA_MOUNT=$DATA_MOUNT"

                # ============================================================
                # CRITICAL SAFEGUARD: NEVER touch the Transfer Drive.
                # The transfer partition (/media/safekeep-transfer/) holds the
                # user's .7z Reliquary backups and .psbt exports. Factory reset
                # destroys ONLY the encrypted vault contents.
                # ============================================================

                # --- Pre-flight: verify vault is mounted ---
                if ! mountpoint -q "$VAULT_MOUNT" 2>/dev/null; then
                    echo "SafeKeep Wipe Watcher: CRITICAL — vault not mounted at $VAULT_MOUNT, cannot wipe!"
                    rm -f "$WIPE_TRIGGER"
                    continue
                fi
                echo "SafeKeep Wipe Watcher: vault confirmed mounted at $VAULT_MOUNT"

                # 1) Delete master-seed.json (the browser polls for this)
                #    Fast rm — no shred. LUKS destruction on next boot is
                #    the real cryptographic guarantee, not file-level overwrites.
                for f in "$SEED_DIR"/master-seed*.json; do
                    if [ -f "$f" ]; then
                        sudo rm -f "$f"
                        echo "SafeKeep Wipe Watcher: deleted $(basename "$f")"
                    fi
                done

                # 2) Wipe vault application data (codex notes, passphrases, settings)
                #    Uses sudo + explicit verification. If any deletion fails,
                #    Phase 2 LUKS destruction covers it — without keyslots the
                #    data is cryptographically unrecoverable.
                for dir in codex passphrases settings; do
                    VAULT_SUBDIR="$VAULT_MOUNT/$dir"
                    if [ -d "$VAULT_SUBDIR" ]; then
                        echo "SafeKeep Wipe Watcher: rm -rf $VAULT_SUBDIR ..."
                        sudo rm -rf "$VAULT_SUBDIR"
                        # Verify deletion
                        if [ -d "$VAULT_SUBDIR" ]; then
                            echo "SafeKeep Wipe Watcher: WARNING — $dir still exists after rm -rf!"
                        else
                            echo "SafeKeep Wipe Watcher: deleted vault/$dir ✓"
                        fi
                    else
                        echo "SafeKeep Wipe Watcher: vault/$dir does not exist, skipping"
                    fi
                done

                # 3) Clean all remaining files from seeds/ directory
                for f in "$SEED_DIR"/*; do
                    if [ -f "$f" ] && [ "$(basename "$f")" != "WIPE_TRIGGER.txt" ]; then
                        sudo rm -f "$f"
                    fi
                done
                echo "SafeKeep Wipe Watcher: seeds/ directory cleaned"

                # 4) Write the .wipe_pending flag to the DATA partition.
                #    This flag persists across reboot (ext4, not casper overlay).
                #    On next boot, safekeep-boot detects it and executes Phase 2:
                #    LUKS header destruction → vault file deletion → reboot into
                #    first-boot setup.
                #
                #    CRITICAL: Verify the data partition is actually mounted.
                #    If it's not (e.g., unmounted during unlock flow), re-mount
                #    it now. Without this, the flag goes to tmpfs and is lost.
                if ! mountpoint -q "$DATA_MOUNT" 2>/dev/null; then
                    echo "SafeKeep Wipe Watcher: WARNING — data partition not mounted at $DATA_MOUNT, re-mounting..."
                    WIPE_DATA_DEV=$(blkid -L "$DATA_LABEL" 2>/dev/null || true)
                    if [ -n "$WIPE_DATA_DEV" ]; then
                        sudo mkdir -p "$DATA_MOUNT"
                        sudo mount "$WIPE_DATA_DEV" "$DATA_MOUNT"
                        echo "SafeKeep Wipe Watcher: data partition re-mounted at $DATA_MOUNT"
                    else
                        echo "SafeKeep Wipe Watcher: FATAL — cannot find data partition, .wipe_pending will NOT persist!"
                    fi
                fi

                # Double-check: is the data partition ACTUALLY mounted now?
                if mountpoint -q "$DATA_MOUNT" 2>/dev/null; then
                    sudo bash -c "echo 'factory_reset_requested=$(date -u +%Y-%m-%dT%H:%M:%SZ)' > '$DATA_MOUNT/.wipe_pending'"
                    # Verify the flag was written
                    if [ -f "$DATA_MOUNT/.wipe_pending" ]; then
                        echo "SafeKeep Wipe Watcher: .wipe_pending flag written to persistent data partition ✓"
                        cat "$DATA_MOUNT/.wipe_pending"
                    else
                        echo "SafeKeep Wipe Watcher: FATAL — .wipe_pending flag write FAILED!"
                    fi
                else
                    echo "SafeKeep Wipe Watcher: FATAL — data partition still not mounted, Phase 2 will NOT fire on next boot!"
                fi

                # 5) Remove the trigger file — the browser polls for
                #    master-seed.json disappearance, NOT the trigger file.
                #    Removing it is just cleanup.
                sudo rm -f "$WIPE_TRIGGER"

                # 6) Flush ALL writes to persistent storage
                sync
                echo "SafeKeep Wipe Watcher: sync complete"

                echo "SafeKeep Wipe Watcher: Phase 1 complete. Content deleted, LUKS destruction queued for next boot."
                echo "SafeKeep Wipe Watcher: Transfer drive preserved."

                # 7) AUTO-REBOOT — trigger Phase 2 immediately.
                #    Phase 2 (LUKS header destruction) runs at boot time, so
                #    the machine MUST reboot for it to fire. Without this, the
                #    browser just shows the Welcome screen in the same session
                #    and the user never reboots — leaving the LUKS volume intact.
                echo "SafeKeep Wipe Watcher: rebooting to execute Phase 2 (LUKS destruction)..."
                # -------------------------------------------------------------------
                # REBOOT FENCE — prevents factory-reset race condition
                # -------------------------------------------------------------------
                # `sudo reboot` returns exit 0 the INSTANT it signals systemd, but
                # the OS takes ~10 seconds to tear down the session. Without a
                # fence, this subshell returns to the `while true` loop and keeps
                # polling during the shutdown window, while the browser UI in the
                # main process flashes the Recovery/Restore menu to the user.
                #
                # `exec sleep infinity` REPLACES this subshell with a sleep process
                # that can never return. When systemd brings the system down, sleep
                # is killed cleanly as part of shutdown.
                #
                # Same pattern as setup-vault.sh's first-boot fence.
                # -------------------------------------------------------------------
                sudo systemctl reboot 2>/dev/null || sudo reboot || true
                exec sleep infinity
            fi
            sleep 1
        done
    ) &
    WIPE_WATCHER_PID=$!
    echo "Wipe watcher daemon started (PID $WIPE_WATCHER_PID)"
    fi  # end: if [ "$EPHEMERAL_MODE" = "1" ] ... else (wipe watcher block)

    # -------------------------------------------------------------------
    # RELIQUARY WATCHER DAEMON — ENCRYPTED BACKUP EXECUTION
    # -------------------------------------------------------------------
    # The web app (boot.js) cannot execute shell commands. To create a .7z
    # encrypted backup, it silently downloads a trigger file containing the
    # pre-built 7z command:
    #   /media/.safekeep-vault/seeds/RELIQUARY_TRIGGER.json
    #
    # This background loop watches for that file and, when found:
    #   1. Validates the transfer drive is actually mounted and writable
    #   2. Validates that 7z (p7zip-full) is installed
    #   3. Extracts and executes the shell command from the trigger
    #   4. Writes a result file for the web app to poll:
    #      /media/.safekeep-vault/seeds/RELIQUARY_RESULT.json
    #      → { "ok": true, "filename": "Safekeep_backup_2026-04-07.7z" }
    #      → { "ok": false, "error": "Transfer drive not mounted" }
    #   5. Cleans up trigger + result after the web app acknowledges
    #
    # CRITICAL: The 7z command writes ONLY to /media/safekeep-transfer/
    # (the exFAT transfer partition). It reads from the encrypted vault.
    # The trigger/result files live in the vault seeds dir (LUKS-encrypted).
    RELIQUARY_TRIGGER="$SEED_DIR/RELIQUARY_TRIGGER.json"
    RELIQUARY_RESULT="$SEED_DIR/RELIQUARY_RESULT.json"
    RELIQUARY_ACK="$SEED_DIR/RELIQUARY_ACK.json"

    (
        while true; do
            if [ -f "$RELIQUARY_TRIGGER" ]; then
                echo ".7z Backup Watcher: trigger detected — creating encrypted backup..."

                # ── Pre-flight checks ──

                # 1) Dynamically detect the USB transfer drive
                USB_TARGET=$(find_transfer_drive)
                if [ -z "$USB_TARGET" ]; then
                    echo '{"ok":false,"error":"No external USB transfer drive detected. Insert the USB drive and try again."}' > "$RELIQUARY_RESULT"
                    rm -f "$RELIQUARY_TRIGGER"
                    echo ".7z Backup Watcher: FAILED — no USB drive detected"
                    sleep 1
                    continue
                fi
                echo ".7z Backup Watcher: USB drive resolved → $USB_TARGET"

                # Writable check — try to touch a temp file
                WRITE_TEST="$USB_TARGET/.reliquary_write_test"
                if ! touch "$WRITE_TEST" 2>/dev/null; then
                    echo "{\"ok\":false,\"error\":\"USB drive at $USB_TARGET is read-only. Check filesystem or remount.\"}" > "$RELIQUARY_RESULT"
                    rm -f "$RELIQUARY_TRIGGER"
                    echo ".7z Backup Watcher: FAILED — USB drive is read-only"
                    sleep 1
                    continue
                fi
                rm -f "$WRITE_TEST" 2>/dev/null

                # 2) 7z must be installed
                if ! command -v 7z >/dev/null 2>&1; then
                    echo '{"ok":false,"error":"7z (p7zip-full) is not installed. Run: sudo apt install p7zip-full"}' > "$RELIQUARY_RESULT"
                    rm -f "$RELIQUARY_TRIGGER"
                    echo ".7z Backup Watcher: FAILED — 7z not found"
                    sleep 1
                    continue
                fi

                # ── Extract the command and rewrite the output path ──
                # The trigger JSON contains a "command" field with the 7z shell
                # script block. The command was built by boot.js using a hardcoded
                # TRANSFER_ROOT (/media/safekeep-transfer). We replace that path
                # with the dynamically resolved USB_TARGET so 7z writes to the
                # actual physical hardware.
                RAW_CMD=$(python3 -c "
import json, sys
try:
    with open('$RELIQUARY_TRIGGER') as f:
        data = json.load(f)
    print(data.get('command', ''))
except Exception as e:
    print('', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null)

                if [ -z "$RAW_CMD" ]; then
                    echo '{"ok":false,"error":"Failed to parse trigger file — no command found."}' > "$RELIQUARY_RESULT"
                    rm -f "$RELIQUARY_TRIGGER"
                    echo ".7z Backup Watcher: FAILED — trigger parse error"
                    sleep 1
                    continue
                fi

                # Rewrite the hardcoded transfer path to the resolved USB mount
                CMD=$(echo "$RAW_CMD" | sed "s|/media/safekeep-transfer|$USB_TARGET|g")

                # Execute the 7z command block and capture output + exit code
                OUTPUT=$(bash -c "$CMD" 2>&1)
                EXIT_CODE=$?

                if [ $EXIT_CODE -eq 0 ]; then
                    # Extract the actual filename from the RELIQUARY_FILE= output line
                    ACTUAL_FILE=$(echo "$OUTPUT" | grep '^RELIQUARY_FILE=' | head -1 | cut -d= -f2)
                    if [ -z "$ACTUAL_FILE" ]; then
                        ACTUAL_FILE="unknown"
                    fi

                    # Verify the file actually exists on the USB drive
                    if [ -f "$USB_TARGET/$ACTUAL_FILE" ]; then
                        FILESIZE=$(stat -c%s "$USB_TARGET/$ACTUAL_FILE" 2>/dev/null || echo "0")
                        echo "{\"ok\":true,\"filename\":\"$ACTUAL_FILE\",\"size\":$FILESIZE,\"path\":\"$USB_TARGET\"}" > "$RELIQUARY_RESULT"
                        echo ".7z Backup Watcher: SUCCESS — $USB_TARGET/$ACTUAL_FILE ($FILESIZE bytes)"
                        # Regenerate the archive index so the newly-created
                        # file (backup .7z OR hardware-wallet .json export)
                        # shows up in the Archive UI's list on the next
                        # refresh — without needing a full reboot.
                        if type regenerate_backups_index >/dev/null 2>&1; then
                            regenerate_backups_index "$USB_TARGET"
                            echo ".7z Backup Watcher: archive index refreshed for $USB_TARGET"
                        fi
                    else
                        echo "{\"ok\":false,\"error\":\"7z reported success but file not found at $USB_TARGET/$ACTUAL_FILE\"}" > "$RELIQUARY_RESULT"
                        echo ".7z Backup Watcher: FAILED — file missing after 7z success"
                    fi
                else
                    # Sanitize output for JSON (escape quotes and newlines)
                    SAFE_OUTPUT=$(echo "$OUTPUT" | head -5 | tr '\n' ' ' | sed 's/"/\\"/g' | cut -c1-200)
                    echo "{\"ok\":false,\"error\":\"7z exited with code $EXIT_CODE: $SAFE_OUTPUT\"}" > "$RELIQUARY_RESULT"
                    echo ".7z Backup Watcher: FAILED — 7z exit code $EXIT_CODE"
                fi

                # Remove the trigger — the web app polls RELIQUARY_RESULT
                rm -f "$RELIQUARY_TRIGGER"

                # Wait for the web app to acknowledge, then clean up result
                ACK_WAIT=0
                while [ $ACK_WAIT -lt 120 ]; do
                    if [ -f "$RELIQUARY_ACK" ]; then
                        rm -f "$RELIQUARY_ACK" "$RELIQUARY_RESULT"
                        echo ".7z Backup Watcher: cleanup complete (ACK received)"
                        break
                    fi
                    sleep 1
                    ACK_WAIT=$((ACK_WAIT + 1))
                done
                # If no ACK after 120s, clean up anyway
                rm -f "$RELIQUARY_ACK" "$RELIQUARY_RESULT" 2>/dev/null
            fi
            sleep 1
        done
    ) &
    RELIQUARY_WATCHER_PID=$!
    echo ".7z backup watcher daemon started (PID $RELIQUARY_WATCHER_PID)"

    # -------------------------------------------------------------------
    # CODEX WATCHER DAEMON — NOTE FILE ROUTING & TRANSFER COPY
    # -------------------------------------------------------------------
    # Chromium's DownloadDirectory points to .safekeep-vault/seeds/, but
    # Codex notes belong in .safekeep-vault/codex/. The _silentDownload()
    # trick writes .html and .meta.json files into seeds/ — this watcher
    # moves them to the encrypted codex/ directory on the LUKS partition.
    #
    # SECURITY: Notes are NEVER copied to the unencrypted transfer drive.
    # They exist only inside the encrypted LUKS vault. To export notes
    # off-device, use The Reliquary's encrypted .7z backup.
    #
    # This replaces frontend File System Access API writes, which caused
    # Chromium's "Allow multiple downloads?" security prompt.
    #
    # Watched: /media/.safekeep-vault/seeds/*.html (note files)
    #          /media/.safekeep-vault/seeds/*.meta.json (sidecars)
    # Routed:  /media/.safekeep-vault/codex/ (vault storage)
    CODEX_DIR="$VAULT_MOUNT/codex"
    PASSPHRASE_DIR="$VAULT_MOUNT/passphrases"

    (
        while true; do
            ROUTED_FILES=0

            # ── Route Codex .html notes from seeds/ → codex/ ──
            for HTML_FILE in "$SEED_DIR"/*.html; do
                [ -f "$HTML_FILE" ] || continue
                BASENAME=$(basename "$HTML_FILE")

                # Skip system files — only process Codex notes
                case "$BASENAME" in
                    master-seed*|WIPE_*|RELIQUARY_*|RESTORE_*) continue ;;
                esac

                # Ensure codex directory exists
                mkdir -p "$CODEX_DIR" 2>/dev/null

                # Move the .html to the codex dir
                mv "$HTML_FILE" "$CODEX_DIR/$BASENAME" 2>/dev/null
                echo "File Router: routed $BASENAME → codex/"

                # Move the matching .meta.json sidecar if it exists
                SLUG="${BASENAME%.html}"
                META_FILE="$SEED_DIR/${SLUG}.meta.json"
                if [ -f "$META_FILE" ]; then
                    mv "$META_FILE" "$CODEX_DIR/${SLUG}.meta.json" 2>/dev/null
                    echo "File Router: routed ${SLUG}.meta.json → codex/"
                fi

                ROUTED_FILES=$((ROUTED_FILES + 1))

                # SECURITY: No cleartext copy to transfer drive.
                # Notes stay inside the encrypted LUKS vault only.
            done

            # ── Rescue orphaned .meta.json sidecars ──
            # If a .meta.json is in seeds/ but its matching .html is already
            # in codex/ (moved by a previous poll cycle before the sidecar
            # was written), move the orphan to codex/ now.
            for META_ORPHAN in "$SEED_DIR"/*.meta.json; do
                [ -f "$META_ORPHAN" ] || continue
                ORPHAN_BASE=$(basename "$META_ORPHAN")
                ORPHAN_SLUG="${ORPHAN_BASE%.meta.json}"
                # Only rescue if the matching .html already made it to codex/
                if [ -f "$CODEX_DIR/${ORPHAN_SLUG}.html" ]; then
                    mv "$META_ORPHAN" "$CODEX_DIR/$ORPHAN_BASE" 2>/dev/null
                    echo "File Router: rescued orphaned $ORPHAN_BASE → codex/"
                    ROUTED_FILES=$((ROUTED_FILES + 1))
                fi
            done

            # ── Route Cipher .json passphrases from seeds/ → passphrases/ ──
            # Passphrase files are saved via _silentDownload as <slug>.json
            # into seeds/ (Chromium's DownloadDirectory). We identify them by
            # the presence of a "passphrase" key in the JSON, which distinguishes
            # them from system trigger files (RELIQUARY_*, RESTORE_*, etc.).
            for JSON_FILE in "$SEED_DIR"/*.json; do
                [ -f "$JSON_FILE" ] || continue
                BASENAME=$(basename "$JSON_FILE")

                # Skip known system trigger/result/sentinel files
                case "$BASENAME" in
                    master-seed*|RELIQUARY_*|RESTORE_*|DISPLAY_SLEEP_*|.transfer*|.backups*|.vault-sentinel*) continue ;;
                esac

                # Check if this is a passphrase file (contains "passphrase" key)
                if grep -q '"passphrase"' "$JSON_FILE" 2>/dev/null; then
                    mkdir -p "$PASSPHRASE_DIR" 2>/dev/null
                    mv "$JSON_FILE" "$PASSPHRASE_DIR/$BASENAME" 2>/dev/null
                    echo "File Router: routed passphrase $BASENAME → passphrases/"
                    ROUTED_FILES=$((ROUTED_FILES + 1))
                fi
            done

            # ── Regenerate index files after routing ──
            # The browser reads .codex-index.json and .passphrase-index.json
            # to populate its in-memory stores. These indexes are generated
            # at boot time, but if the user creates notes or passphrases
            # during the session, the on-disk indexes go stale. Regenerate
            # them after every routing cycle that moved files, so a backup
            # taken mid-session will always contain up-to-date indexes.
            if [ $ROUTED_FILES -gt 0 ]; then
                echo "File Router: $ROUTED_FILES file(s) routed — regenerating indexes..."

                # ── Codex index (.codex-index.json) ──
                # Task #213 (data-loss bugfix): scan *.html files and
                # extract the embedded SAFEKEEP_META JSON header from the
                # first line. The previous implementation scanned *.meta.json
                # sidecars, which the JS layer (Sprint 22) no longer writes —
                # leaving the index permanently empty and causing notes to
                # vanish after backup/restore. Mirrors the boot-time logic
                # in the "Generate Codex Index" block above; keep the two
                # in lockstep if you change either.
                (
                    echo "["
                    FIRST=true
                    for f in "$CODEX_DIR"/*.html; do
                        [ -f "$f" ] || continue
                        CBASE=$(basename "$f")
                        CSLUG="${CBASE%.html}"
                        # Embedded header (Sprint 22+).
                        CMETA_LINE=$(head -1 "$f" 2>/dev/null)
                        CMETA_JSON=""
                        case "$CMETA_LINE" in
                            '<!--SAFEKEEP_META:'*'-->'*)
                                CMETA_JSON="${CMETA_LINE#<!--SAFEKEEP_META:}"
                                CMETA_JSON="${CMETA_JSON%%-->*}"
                                ;;
                        esac
                        # Legacy sidecar fallback (pre-Sprint 22 notes).
                        if [ -z "$CMETA_JSON" ]; then
                            CSIDECAR="$CODEX_DIR/${CSLUG}.meta.json"
                            if [ -f "$CSIDECAR" ]; then
                                CMETA_JSON=$(cat "$CSIDECAR")
                            fi
                        fi
                        # No metadata anywhere — synthesize so the note
                        # still appears rather than being silently dropped.
                        if [ -z "$CMETA_JSON" ]; then
                            CMETA_JSON="{\"title\":\"$CSLUG\",\"slug\":\"$CSLUG\",\"updatedAt\":\"\"}"
                        fi
                        if [ "$FIRST" = true ]; then
                            FIRST=false
                        else
                            echo ","
                        fi
                        printf '%s' "$CMETA_JSON"
                    done
                    echo
                    echo "]"
                ) > "$CODEX_DIR/.codex-index.json"
                echo "File Router: rebuilt .codex-index.json ($(wc -c < "$CODEX_DIR/.codex-index.json") bytes)"

                # ── Passphrase index (.passphrase-index.json) ──
                # Scan all *.json files in passphrases/ (excluding the index
                # itself). Emit each file's full contents into a JSON array.
                (
                    echo "["
                    FIRST=true
                    for f in "$PASSPHRASE_DIR"/*.json; do
                        [ -f "$f" ] || continue
                        case "$(basename "$f")" in
                            .passphrase-index.json) continue ;;
                        esac
                        if [ "$FIRST" = true ]; then
                            FIRST=false
                        else
                            echo ","
                        fi
                        cat "$f"
                    done
                    echo "]"
                ) > "$PASSPHRASE_DIR/.passphrase-index.json"
                echo "File Router: rebuilt .passphrase-index.json ($(wc -c < "$PASSPHRASE_DIR/.passphrase-index.json") bytes)"
            fi

            sleep 2
        done
    ) &
    CODEX_WATCHER_PID=$!
    echo "Codex watcher daemon started (PID $CODEX_WATCHER_PID)"

    # -------------------------------------------------------------------
    # DISPLAY-SLEEP WATCHER DAEMON — DPMS timer bridge (Task #14/#198)
    # -------------------------------------------------------------------
    # The Settings UI exposes a "Display Sleep" minutes field; the JS
    # bridge (shared/boot.js setDisplaySleep) drops a trigger file when
    # the user changes it. This loop watches for that file, parses the
    # seconds value out of the JSON, and runs the appropriate xset DPMS
    # sequence.
    #
    # CRITICAL — X11 environment. xset speaks to the X server via the
    # $DISPLAY socket and authenticates against $XAUTHORITY. This
    # subshell is forked by safekeep-boot before Chromium launches; it
    # inherits a partial environment from openbox-autostart, but if
    # safekeep-boot is ever restarted (e.g. session crash + Restart=)
    # those env bits can be missing. Exporting them explicitly here is
    # the difference between "xset works" and "xset silently fails to
    # reach the X server" — the latter is the bug we hit on MacBook
    # Pro hardware where the inherited env was incomplete.
    #
    # Apple hardware note: modern Linux Xorg on Apple GPUs honors DPMS
    # over standard pathways once xset is reaching the server. When the
    # env was missing the xset call exited 0 silently (couldn't open
    # display) — easy to mistake for an Apple-DPMS quirk. After the
    # explicit env exports, MacBook DPMS works normally.
    #
    # Defense in depth: if xset is unavailable or fails outright (return
    # code != 0), the watcher logs the failure AND tries a fallback
    # chain: vbetool dpms off (if installed), then a best-effort write
    # of "0" to /sys/class/backlight/*/brightness. These fallbacks fire
    # on FAILURE only — the happy path is always pure xset DPMS so the
    # screen wakes on user input cleanly.
    #
    # Trigger:  DISPLAY_SLEEP_TRIGGER.json  in $SEED_DIR
    # Body:     { "seconds": N, "timestamp": <ms> }
    # No result file — the watcher just acts and deletes the trigger.
    DISPLAY_SLEEP_TRIGGER="$SEED_DIR/DISPLAY_SLEEP_TRIGGER.json"
    DISPLAY_SLEEP_LOG="/tmp/safekeep-display-sleep.log"

    (
        # Export X11 env once at subshell start. This is the fix the
        # task is centered on — without these, xset from a background
        # subshell cannot reach :0.
        export DISPLAY="${DISPLAY:-:0}"
        export XAUTHORITY="${XAUTHORITY:-/root/.Xauthority}"

        echo "Display-sleep watcher: started (DISPLAY=$DISPLAY XAUTHORITY=$XAUTHORITY)" >> "$DISPLAY_SLEEP_LOG"

        while true; do
            if [ -f "$DISPLAY_SLEEP_TRIGGER" ]; then
                # Parse "seconds" out of the JSON. Pure shell — no jq
                # dependency. Tolerates whitespace and trailing comma.
                SECONDS_VAL=$(grep -o '"seconds"[[:space:]]*:[[:space:]]*[0-9]\+' "$DISPLAY_SLEEP_TRIGGER" \
                              | grep -o '[0-9]\+' | head -1)

                if [ -z "$SECONDS_VAL" ]; then
                    echo "Display-sleep watcher: malformed trigger (no seconds field)" >> "$DISPLAY_SLEEP_LOG"
                    rm -f "$DISPLAY_SLEEP_TRIGGER" 2>/dev/null
                else
                    echo "$(date -Is) Display-sleep watcher: applying timer = ${SECONDS_VAL}s" >> "$DISPLAY_SLEEP_LOG"

                    XSET_RC=0
                    if command -v xset >/dev/null 2>&1; then
                        if [ "$SECONDS_VAL" -eq 0 ]; then
                            # 0 = disable display sleep entirely. Mirrors the
                            # autostart's default kiosk-mode setting.
                            xset s off s noblank -dpms >> "$DISPLAY_SLEEP_LOG" 2>&1 || XSET_RC=$?
                        else
                            # Re-enable DPMS first (autostart turns it off),
                            # then arm all three timers — standby, suspend,
                            # off — to the same value. We use one number for
                            # all three so the screen blanks at exactly the
                            # configured timeout regardless of which DPMS
                            # state the driver enters first.
                            xset s off s noblank +dpms >> "$DISPLAY_SLEEP_LOG" 2>&1 || XSET_RC=$?
                            xset dpms "$SECONDS_VAL" "$SECONDS_VAL" "$SECONDS_VAL" \
                                >> "$DISPLAY_SLEEP_LOG" 2>&1 || XSET_RC=$?
                        fi
                    else
                        echo "Display-sleep watcher: xset not installed" >> "$DISPLAY_SLEEP_LOG"
                        XSET_RC=127
                    fi

                    # Fallback chain on xset failure. These do NOT replace
                    # the timeout-based sleep (they're immediate-blank
                    # operations) — they're only useful if the user ALSO
                    # has a manual force-off path. Logged so the operator
                    # can see why the primary path didn't take.
                    if [ "$XSET_RC" -ne 0 ]; then
                        echo "Display-sleep watcher: xset returned $XSET_RC — see manual debug command" >> "$DISPLAY_SLEEP_LOG"
                        if command -v vbetool >/dev/null 2>&1; then
                            echo "Display-sleep watcher: vbetool available as immediate-blank fallback" >> "$DISPLAY_SLEEP_LOG"
                        fi
                        for BL in /sys/class/backlight/*/brightness; do
                            [ -w "$BL" ] && echo "Display-sleep watcher: backlight node writable: $BL" >> "$DISPLAY_SLEEP_LOG"
                        done
                    fi

                    rm -f "$DISPLAY_SLEEP_TRIGGER" 2>/dev/null
                fi
            fi
            sleep 1
        done
    ) &
    DISPLAY_SLEEP_WATCHER_PID=$!
    echo "Display-sleep watcher daemon started (PID $DISPLAY_SLEEP_WATCHER_PID)"

    # -------------------------------------------------------------------
    # RESTORE WATCHER DAEMON — RELIQUARY INSPECT & COMMIT
    # -------------------------------------------------------------------
    # Handles the two-phase restore flow triggered from the Reliquary UI:
    #
    # Phase 1 — INSPECT: Extracts a .7z archive from the USB transfer drive
    #   into /tmp/reliquary, probes the contents, and returns a manifest
    #   describing what the archive contains (codex, settings, cipher, seed).
    #   Trigger:  RESTORE_INSPECT.json
    #   Result:   RESTORE_INSPECT_RESULT.json
    #
    # Phase 2 — COMMIT: Copies the extracted contents from /tmp/reliquary
    #   into the encrypted LUKS vault directories. Supports "merge" (overlay)
    #   and "overwrite" (wipe-then-copy) modes.
    #   Trigger:  RESTORE_COMMIT.json
    #   Result:   RESTORE_COMMIT_RESULT.json
    #
    # Both phases use the same trigger-file watcher pattern as the
    # Reliquary export (RELIQUARY_TRIGGER.json) and Factory Reset
    # (WIPE_TRIGGER.txt) watchers.
    RESTORE_INSPECT_TRIGGER="$SEED_DIR/RESTORE_INSPECT.json"
    RESTORE_INSPECT_RESULT="$SEED_DIR/RESTORE_INSPECT_RESULT.json"
    RESTORE_INSPECT_ACK="$SEED_DIR/RESTORE_INSPECT_ACK.json"
    RESTORE_COMMIT_TRIGGER="$SEED_DIR/RESTORE_COMMIT.json"
    RESTORE_COMMIT_RESULT="$SEED_DIR/RESTORE_COMMIT_RESULT.json"
    RESTORE_COMMIT_ACK="$SEED_DIR/RESTORE_COMMIT_ACK.json"
    RELIQUARY_TMP="/tmp/reliquary"

    (
        while true; do
            # ── Phase 1: INSPECT ──
            if [ -f "$RESTORE_INSPECT_TRIGGER" ]; then
                echo "Restore Watcher: inspect trigger detected — extracting archive..."

                # Pre-flight: 7z must be installed
                if ! command -v 7z >/dev/null 2>&1; then
                    echo '{"ok":false,"error":"7z (p7zip-full) is not installed."}' > "$RESTORE_INSPECT_RESULT"
                    rm -f "$RESTORE_INSPECT_TRIGGER"
                    sleep 1
                    continue
                fi

                # Dynamically detect the USB transfer drive
                USB_SRC=$(find_transfer_drive)
                if [ -z "$USB_SRC" ]; then
                    echo '{"ok":false,"error":"No USB transfer drive detected. Insert the drive and try again."}' > "$RESTORE_INSPECT_RESULT"
                    rm -f "$RESTORE_INSPECT_TRIGGER"
                    echo "Restore Watcher: FAILED — no USB drive"
                    sleep 1
                    continue
                fi
                echo "Restore Watcher: USB drive resolved → $USB_SRC"

                # Parse trigger JSON — extract filename and password
                INSPECT_DATA=$(python3 -c "
import json, sys
try:
    with open('$RESTORE_INSPECT_TRIGGER') as f:
        data = json.load(f)
    print(data.get('filename', ''))
    print(data.get('password', ''))
except Exception as e:
    sys.exit(1)
" 2>/dev/null)

                ARCHIVE_FILE=$(echo "$INSPECT_DATA" | sed -n '1p')
                ARCHIVE_PW=$(echo "$INSPECT_DATA" | sed -n '2p')

                if [ -z "$ARCHIVE_FILE" ]; then
                    echo '{"ok":false,"error":"Trigger file missing filename."}' > "$RESTORE_INSPECT_RESULT"
                    rm -f "$RESTORE_INSPECT_TRIGGER"
                    sleep 1
                    continue
                fi

                ARCHIVE_PATH="$USB_SRC/$ARCHIVE_FILE"
                echo "Restore Watcher: archive=$ARCHIVE_PATH  pw_len=${#ARCHIVE_PW}"
                if [ ! -f "$ARCHIVE_PATH" ]; then
                    echo "{\"ok\":false,\"error\":\"Archive not found: $ARCHIVE_FILE\"}" > "$RESTORE_INSPECT_RESULT"
                    rm -f "$RESTORE_INSPECT_TRIGGER"
                    echo "Restore Watcher: FAILED — file not found: $ARCHIVE_PATH"
                    sleep 1
                    continue
                fi

                # Extract to temp directory
                rm -rf "$RELIQUARY_TMP"
                mkdir -p "$RELIQUARY_TMP"

                echo "Restore Watcher: extracting with: 7z x -o\"$RELIQUARY_TMP\" -p\"***\" \"$ARCHIVE_PATH\" -y"
                OUTPUT=$(7z x -o"$RELIQUARY_TMP" -p"$ARCHIVE_PW" "$ARCHIVE_PATH" -y 2>&1)
                EXIT_CODE=$?
                echo "Restore Watcher: 7z exit code=$EXIT_CODE"

                if [ $EXIT_CODE -ne 0 ]; then
                    SAFE_OUTPUT=$(echo "$OUTPUT" | head -5 | tr '\n' ' ' | sed 's/"/\\"/g' | cut -c1-200)
                    echo "{\"ok\":false,\"error\":\"7z extraction failed (code $EXIT_CODE): $SAFE_OUTPUT\"}" > "$RESTORE_INSPECT_RESULT"
                    rm -f "$RESTORE_INSPECT_TRIGGER"
                    rm -rf "$RELIQUARY_TMP"
                    echo "Restore Watcher: FAILED — 7z exit code $EXIT_CODE"
                    echo "Restore Watcher: 7z output: $OUTPUT"
                    sleep 1
                    continue
                fi

                # Diagnostic: show what was extracted
                echo "Restore Watcher: extraction complete — directory tree:"
                find "$RELIQUARY_TMP" -maxdepth 5 -type d 2>/dev/null | head -30
                echo "Restore Watcher: total files extracted: $(find "$RELIQUARY_TMP" -type f 2>/dev/null | wc -l)"

                # ── Dynamic PROBE_ROOT detection ──
                # The archive may store vault dirs at different depths depending
                # on how 7z handled the absolute source paths at backup time:
                #   Case A: /tmp/reliquary/media/.safekeep-vault/codex/...
                #   Case B: /tmp/reliquary/codex/...  (flat, prefix stripped)
                #   Case C: /tmp/reliquary/.safekeep-vault/codex/...
                #
                # We search for the first directory containing a recognized vault
                # subdirectory (codex, passphrases, settings, or seeds) and use
                # that as PROBE_ROOT.
                PROBE_ROOT=""
                for CANDIDATE in \
                    "$RELIQUARY_TMP$VAULT_MOUNT" \
                    "$RELIQUARY_TMP" \
                    "$RELIQUARY_TMP/.safekeep-vault" \
                    ; do
                    if [ -d "$CANDIDATE/codex" ] || [ -d "$CANDIDATE/passphrases" ] || \
                       [ -d "$CANDIDATE/settings" ] || [ -d "$CANDIDATE/seeds" ]; then
                        PROBE_ROOT="$CANDIDATE"
                        break
                    fi
                done

                # Fallback: search the tree for any 'codex' or 'passphrases' dir
                if [ -z "$PROBE_ROOT" ]; then
                    echo "Restore Watcher: known candidates failed, searching tree..."
                    FOUND_DIR=$(find "$RELIQUARY_TMP" -maxdepth 5 -type d \( -name codex -o -name passphrases \) -print -quit 2>/dev/null)
                    if [ -n "$FOUND_DIR" ]; then
                        PROBE_ROOT=$(dirname "$FOUND_DIR")
                        echo "Restore Watcher: found vault dir at $FOUND_DIR → PROBE_ROOT=$PROBE_ROOT"
                    fi
                fi

                if [ -z "$PROBE_ROOT" ]; then
                    echo "Restore Watcher: FATAL — no vault directories found anywhere in extraction"
                    echo "{\"ok\":false,\"error\":\"Archive extracted but contains no vault data (no codex/, passphrases/, settings/, or seeds/ found).\"}" > "$RESTORE_INSPECT_RESULT"
                    rm -f "$RESTORE_INSPECT_TRIGGER"
                    rm -rf "$RELIQUARY_TMP"
                    sleep 1
                    continue
                fi

                echo "Restore Watcher: PROBE_ROOT resolved → $PROBE_ROOT"

                HAS_CODEX=false; HAS_SETTINGS=false; HAS_CIPHER=false; HAS_SEED=false
                CODEX_COUNT=0; CIPHER_COUNT=0

                [ -d "$PROBE_ROOT/codex" ] && HAS_CODEX=true
                [ -d "$PROBE_ROOT/settings" ] && HAS_SETTINGS=true
                [ -d "$PROBE_ROOT/passphrases" ] && HAS_CIPHER=true
                [ -d "$PROBE_ROOT/seeds" ] && HAS_SEED=true

                if [ "$HAS_CODEX" = "true" ]; then
                    CODEX_COUNT=$(ls "$PROBE_ROOT/codex/"*.html 2>/dev/null | wc -l)
                fi
                if [ "$HAS_CIPHER" = "true" ]; then
                    CIPHER_COUNT=$(ls "$PROBE_ROOT/passphrases/" 2>/dev/null | wc -l)
                fi

                echo "{\"ok\":true,\"codex\":$HAS_CODEX,\"settings\":$HAS_SETTINGS,\"cipher\":$HAS_CIPHER,\"seed\":$HAS_SEED,\"codexCount\":$CODEX_COUNT,\"cipherCount\":$CIPHER_COUNT}" > "$RESTORE_INSPECT_RESULT"
                rm -f "$RESTORE_INSPECT_TRIGGER"
                echo "Restore Watcher: inspect SUCCESS — codex=$HAS_CODEX settings=$HAS_SETTINGS cipher=$HAS_CIPHER seed=$HAS_SEED"

                # Persist metadata for COMMIT phase:
                # - The resolved PROBE_ROOT so commit copies from the right place
                # - Archive path + password for re-extraction fallback
                echo "$PROBE_ROOT" > "$RELIQUARY_TMP/.probe_root"
                echo "$ARCHIVE_PATH" > "$RELIQUARY_TMP/.archive_path"
                echo "$ARCHIVE_PW" > "$RELIQUARY_TMP/.archive_pw"

                # Wait for ACK, then clean up result file
                ACK_WAIT=0
                while [ $ACK_WAIT -lt 120 ]; do
                    if [ -f "$RESTORE_INSPECT_ACK" ]; then
                        rm -f "$RESTORE_INSPECT_ACK" "$RESTORE_INSPECT_RESULT"
                        echo "Restore Watcher: inspect cleanup complete (ACK received)"
                        break
                    fi
                    sleep 1
                    ACK_WAIT=$((ACK_WAIT + 1))
                done
                rm -f "$RESTORE_INSPECT_ACK" "$RESTORE_INSPECT_RESULT" 2>/dev/null
                echo "Restore Watcher: inspect phase done — /tmp/reliquary preserved for commit"
                echo "Restore Watcher: PROBE_ROOT still exists = $([ -d "$PROBE_ROOT" ] && echo YES || echo NO)"
            fi

            # ── Phase 2: COMMIT ──
            if [ -f "$RESTORE_COMMIT_TRIGGER" ]; then
                echo "Restore Watcher: commit trigger detected — writing to vault..."

                # ── Resolve PROBE_ROOT ──
                # The inspect phase saved the dynamically-resolved path to
                # .probe_root. Read it back so we copy from wherever the
                # files actually landed (not a hardcoded assumption).
                PROBE_ROOT=""
                if [ -f "$RELIQUARY_TMP/.probe_root" ]; then
                    PROBE_ROOT=$(cat "$RELIQUARY_TMP/.probe_root")
                    echo "Restore Watcher: loaded PROBE_ROOT from .probe_root → $PROBE_ROOT"
                fi

                # Verify it actually exists
                if [ -z "$PROBE_ROOT" ] || [ ! -d "$PROBE_ROOT" ]; then
                    echo "Restore Watcher: saved PROBE_ROOT missing or invalid, re-detecting..."

                    # Re-run the same dynamic detection as inspect
                    PROBE_ROOT=""
                    for CANDIDATE in \
                        "$RELIQUARY_TMP$VAULT_MOUNT" \
                        "$RELIQUARY_TMP" \
                        "$RELIQUARY_TMP/.safekeep-vault" \
                        ; do
                        if [ -d "$CANDIDATE/codex" ] || [ -d "$CANDIDATE/passphrases" ] || \
                           [ -d "$CANDIDATE/settings" ] || [ -d "$CANDIDATE/seeds" ]; then
                            PROBE_ROOT="$CANDIDATE"
                            break
                        fi
                    done

                    if [ -z "$PROBE_ROOT" ]; then
                        FOUND_DIR=$(find "$RELIQUARY_TMP" -maxdepth 5 -type d \( -name codex -o -name passphrases \) -print -quit 2>/dev/null)
                        if [ -n "$FOUND_DIR" ]; then
                            PROBE_ROOT=$(dirname "$FOUND_DIR")
                        fi
                    fi
                fi

                echo "Restore Watcher: final PROBE_ROOT=$PROBE_ROOT"
                echo "Restore Watcher: PROBE_ROOT exists = $([ -d "$PROBE_ROOT" ] && echo YES || echo NO)"

                if [ -z "$PROBE_ROOT" ] || [ ! -d "$PROBE_ROOT" ]; then
                    echo "Restore Watcher: FATAL — cannot locate vault data in extraction"
                    echo "Restore Watcher: ls $RELIQUARY_TMP = $(ls -la "$RELIQUARY_TMP" 2>&1 | head -10)"
                    echo '{"ok":false,"error":"No extracted archive found. Run inspect first."}' > "$RESTORE_COMMIT_RESULT"
                    rm -f "$RESTORE_COMMIT_TRIGGER"
                    sleep 1
                    continue
                fi

                # Parse trigger for mode (merge vs overwrite)
                COMMIT_MODE=$(python3 -c "
import json, sys
try:
    with open('$RESTORE_COMMIT_TRIGGER') as f:
        data = json.load(f)
    print(data.get('mode', 'merge'))
except Exception as e:
    print('merge')
" 2>/dev/null)

                echo "Restore Watcher: mode=$COMMIT_MODE  src=$PROBE_ROOT  dest=$VAULT_MOUNT"

                # ── Build and execute the copy command locally ──
                # We do NOT use the pre-built command from boot.js because
                # it assumes a hardcoded extraction path that may not match
                # reality. Instead we build the command here using the
                # dynamically-resolved PROBE_ROOT.
                #
                # CRITICAL: We copy per-subdirectory using explicit src/. → dest/
                # syntax to guarantee dotfiles (e.g. .codex-index.json,
                # .passphrase-index.json) are included. A top-level
                # cp -a PROBE_ROOT/. VAULT/ can silently skip hidden files
                # in subdirectories on some systems.

                # Log what the archive actually contains (including dotfiles)
                echo "Restore Watcher: archive contents at PROBE_ROOT (including dotfiles):"
                for VDIR in codex passphrases settings seeds; do
                    if [ -d "$PROBE_ROOT/$VDIR" ]; then
                        echo "  $VDIR/: $(ls -la "$PROBE_ROOT/$VDIR/" 2>/dev/null | grep -c '^-') files"
                        ls -la "$PROBE_ROOT/$VDIR/" 2>/dev/null | head -10
                    fi
                done

                COMMIT_EXIT=0
                if [ "$COMMIT_MODE" = "overwrite" ]; then
                    echo "Restore Watcher: OVERWRITE — wiping vault dirs then copying..."
                    sudo rm -rf "$VAULT_MOUNT/codex" "$VAULT_MOUNT/settings" "$VAULT_MOUNT/passphrases" "$VAULT_MOUNT/seeds"
                fi

                # Copy each vault subdirectory individually with /. syntax
                # to force inclusion of ALL files including dotfiles
                for VDIR in codex passphrases settings seeds; do
                    if [ -d "$PROBE_ROOT/$VDIR" ]; then
                        sudo mkdir -p "$VAULT_MOUNT/$VDIR"
                        sudo cp -a "$PROBE_ROOT/$VDIR/." "$VAULT_MOUNT/$VDIR/" 2>&1 || COMMIT_EXIT=$?
                        echo "Restore Watcher: copied $VDIR/ (exit=$COMMIT_EXIT)"
                    fi
                done

                # Also copy any root-level files (master-seed.json, etc.)
                # Using a bash subshell with dotglob to catch hidden root files
                (
                    shopt -s dotglob
                    for F in "$PROBE_ROOT"/*; do
                        [ -f "$F" ] && sudo cp -a "$F" "$VAULT_MOUNT/" 2>&1
                    done
                )
                echo "Restore Watcher: root-level files copied (with dotglob)"

                # Clean up temp extraction
                rm -rf "$RELIQUARY_TMP"

                # Post-copy verification: explicitly check dotfiles survived
                echo "Restore Watcher: post-copy dotfile verification:"
                for VDIR in codex passphrases settings seeds; do
                    if [ -d "$VAULT_MOUNT/$VDIR" ]; then
                        DOTCOUNT=$(ls -la "$VAULT_MOUNT/$VDIR/" 2>/dev/null | grep '^\-.*\.' | grep -c '^\-')
                        echo "  $VDIR/: $(ls -la "$VAULT_MOUNT/$VDIR/" 2>/dev/null)"
                    fi
                done

                if [ $COMMIT_EXIT -eq 0 ]; then
                    echo '{"ok":true}' > "$RESTORE_COMMIT_RESULT"
                    echo "Restore Watcher: commit SUCCESS — vault restored"
                    echo "Restore Watcher: vault contents after restore:"
                    ls -la "$VAULT_MOUNT/" 2>/dev/null | head -15
                else
                    echo "{\"ok\":false,\"error\":\"Copy to vault failed (code $COMMIT_EXIT).\"}" > "$RESTORE_COMMIT_RESULT"
                    echo "Restore Watcher: FAILED — cp exit code $COMMIT_EXIT"
                fi

                rm -f "$RESTORE_COMMIT_TRIGGER"

                # Wait for ACK, then clean up
                ACK_WAIT=0
                while [ $ACK_WAIT -lt 120 ]; do
                    if [ -f "$RESTORE_COMMIT_ACK" ]; then
                        rm -f "$RESTORE_COMMIT_ACK" "$RESTORE_COMMIT_RESULT"
                        echo "Restore Watcher: commit cleanup complete (ACK received)"
                        break
                    fi
                    sleep 1
                    ACK_WAIT=$((ACK_WAIT + 1))
                done
                rm -f "$RESTORE_COMMIT_ACK" "$RESTORE_COMMIT_RESULT" 2>/dev/null
            fi

            sleep 1
        done
    ) &
    RESTORE_WATCHER_PID=$!
    echo "Restore watcher daemon started (PID $RESTORE_WATCHER_PID)"

    # -------------------------------------------------------------------
    # KIOSK MODE — TRUE BORDERLESS FULLSCREEN
    # -------------------------------------------------------------------
    # --kiosk: launches Chromium in fullscreen kiosk mode (no address bar,
    #          no window decorations, no task switching UI). Combined with
    #          --app, this removes ALL browser chrome.
    # --start-fullscreen: belt-and-suspenders fullscreen enforcement.
    # --window-position / --window-size: ensures Chromium grabs the entire
    #          display even if kiosk mode doesn't auto-detect resolution.
    # --noerrdialogs / --disable-infobars / --disable-session-crashed-bubble:
    #          suppress any pop-over dialogs that could break the kiosk UX.
    #
    # The tint2 panel is killed BEFORE Chromium launches so the OS taskbar,
    # system tray, and clock are completely obliterated from the screen.
    # -------------------------------------------------------------------
    pkill -f tint2 2>/dev/null || true

    # Launch Chromium in BLOCKING mode (no &). When the kiosk window closes
    # (via skui_shutdownVault() calling window.close()), this line unblocks
    # and the script proceeds to poweroff, cutting power to RAM.
    #
    # FLAG NOTES (Phase 1 lockdown — 2026-04-17):
    #   --disable-dev-tools     CRITICAL. Hard-closes DevTools even if the
    #                           managed policy layer is somehow bypassed.
    #                           Without this, F12 exposes the full JS heap
    #                           (every mnemonic in every loaded tool) to
    #                           anyone with physical keyboard access.
    #   --test-type             REMOVED. Google documents this as "not for
    #                           production" — relaxed policy enforcement.
    #                           Kiosk works without it.
    #   --disable-web-security  RETAINED. Required by boot.html's call
    #                           `fetch('file:///run/safekeep-amnesia.json')`,
    #                           which is a cross-origin fetch under strict
    #                           SOP on a file:// origin. Until we refactor
    #                           to a localhost HTTP server inside the kiosk,
    #                           dropping this flag breaks amnesia detection.
    #   --no-sandbox            RETAINED. Chromium refuses to start its
    #                           sandbox when invoked as root (which the
    #                           live-boot systemd launcher is). Moving to
    #                           a non-root user + SUID-root chrome-sandbox
    #                           is a Phase 2 task.
    #   --allow-file-access-    Needed because boot.html is loaded via
    #     from-files            file:// and reads sibling files.
    # Time-stamped exit-code capture so we can distinguish a genuine
    # user-requested shutdown (Chromium ran for a while, user closed it
    # via the dashboard Power Options modal) from a launch failure
    # (binary missing, library missing, segfault during init, etc.).
    # Without this, EVERY Chromium exit cascaded into sudo poweroff
    # below, which on a launch failure would casper-shutdown the box
    # before any error message was readable.
    CHROMIUM_START_EPOCH=$(date +%s)
    # Binary is `ungoogled-chromium` from the xtradeb/apps PPA. The
    # package name is unique to that PPA — Canonical's official repos
    # don't ship a competing package — so there is no apt-pin needed
    # and no risk of accidentally getting the snap-transitional
    # `chromium-browser` wrapper that bit earlier builds. The binary
    # lives at /usr/bin/ungoogled-chromium and is a real native
    # Chromium build with Google services / telemetry stripped, which
    # is a slightly stronger fit for the SafeKeep kiosk's air-gapped
    # threat model than vanilla Chromium would be.
    ungoogled-chromium \
        --kiosk \
        --start-fullscreen \
        --app="$LAUNCH_URL" \
        --disable-dev-tools \
        --incognito \
        --force-device-scale-factor="$SCALE_FACTOR" \
        --no-first-run \
        --allow-file-access-from-files \
        --disable-web-security \
        --disable-gpu \
        --password-store=basic \
        --disable-notifications \
        --noerrdialogs \
        --disable-infobars \
        --disable-session-crashed-bubble \
        --use-fake-ui-for-media-stream \
        --disable-features=XdgDesktopPortalFilePicker,NativeNotifications \
        --no-sandbox
    CHROMIUM_EXIT=$?
    CHROMIUM_ELAPSED=$(( $(date +%s) - CHROMIUM_START_EPOCH ))
    echo "[BOOT] Chromium exited after ${CHROMIUM_ELAPSED}s with status ${CHROMIUM_EXIT}"

    # ====================================================================
    # FAST-FAIL DIAGNOSTIC HALT
    # ====================================================================
    # If Chromium died within 5 seconds of launch, it almost certainly
    # failed to start (missing binary, missing library, sandbox refused,
    # display unreachable, etc.) — the user did not request a shutdown.
    # Issuing sudo poweroff in this state hides the underlying error and
    # produces the "Please remove the installation medium" + I/O-error
    # casper-shutdown screen that's been confusing first-boot QA.
    #
    # Instead: persist a copy of the boot log to /mnt/safekeep-data
    # (which survives the poweroff because it's the persistent ext4
    # partition, not casper tmpfs), print a clear diagnostic to /dev/tty1,
    # and sleep forever. The user can take a photo of tty1, then pull the
    # USB and read the log on another machine. This is the ONLY way to
    # diagnose Chromium-launch failures on a hardened kiosk where every
    # getty is masked and dropping to a shell is impossible.
    if [ "$CHROMIUM_ELAPSED" -lt 5 ]; then
        # Persist the in-memory boot log to the data partition. /tmp is
        # tmpfs and gets wiped on poweroff; /mnt/safekeep-data is ext4
        # and survives. After this halt the user pulls the USB, mounts
        # safekeep-data on a Mac/Linux box, and reads the log there.
        if mountpoint -q "$DATA_MOUNT" 2>/dev/null; then
            cp -a /tmp/safekeep-boot.log "$DATA_MOUNT/safekeep-boot.log" 2>/dev/null || true
            sync
        fi

        if [ -w /dev/tty1 ]; then
            {
                printf '\033[2J\033[H\r'
                printf '\r\n'
                printf '    ================================================================\r\n'
                printf '    SAFEKEEP DIAGNOSTIC HALT\r\n'
                printf '    ================================================================\r\n'
                printf '\r\n'
                printf '    Chromium exited %ss after launch with status %s.\r\n' \
                    "${CHROMIUM_ELAPSED}" "${CHROMIUM_EXIT}"
                printf '    This is too fast to be a deliberate shutdown — it is a launch\r\n'
                printf '    failure. Auto-poweroff has been suppressed so this message\r\n'
                printf '    stays on screen for diagnosis.\r\n'
                printf '\r\n'
                printf '    To diagnose:\r\n'
                printf '      1. Take a photo of this screen.\r\n'
                printf '      2. Hold the power button to force shutdown.\r\n'
                printf '      3. Insert the USB into another computer.\r\n'
                printf '      4. Mount the partition labeled "safekeep-data".\r\n'
                printf '      5. Read the file: safekeep-boot.log\r\n'
                printf '\r\n'
                printf '    Send the photo + log file to the SafeKeep team to diagnose.\r\n'
                printf '    ================================================================\r\n'
                printf '\r\n'
            } > /dev/tty1 2>/dev/null || true
        fi

        # Block forever so the diagnostic stays visible. The user must
        # hold-power-button or pull the USB to recover. Better than a
        # silent reboot loop.
        exec sleep infinity
    fi

    # ---- POWER SEQUENCE ----
    # Chromium ran for ${CHROMIUM_ELAPSED}s — long enough to be a real
    # user session, not a launch crash. Proceed to the normal power
    # sequence: kill the wipe watcher daemon, then read the POWER_ACTION
    # signal file (dropped by the dashboard Power Options modal) to
    # decide between reboot and poweroff.
    kill "$WIPE_WATCHER_PID" 2>/dev/null || true

    # Persist the boot log to the data partition before the poweroff
    # erases /tmp. Keeps a forensic trail even on clean shutdowns so the
    # next boot's "noticeably longer load" or any other anomaly can be
    # diagnosed from outside the box.
    if mountpoint -q "$DATA_MOUNT" 2>/dev/null; then
        cp -a /tmp/safekeep-boot.log "$DATA_MOUNT/safekeep-boot.log" 2>/dev/null || true
        sync
    fi

    # Default action: poweroff (safe fallback — destroys RAM contents).
    POWER_ACTION="poweroff"
    if [ -f "$POWER_ACTION_READ_PATH" ]; then
        # Read the first line and trim whitespace/newlines.
        REQUESTED=$(head -n 1 "$POWER_ACTION_READ_PATH" 2>/dev/null | tr -d '[:space:]')
        case "$REQUESTED" in
            reboot|poweroff)
                POWER_ACTION="$REQUESTED"
                ;;
            *)
                echo "Power-action file contained unrecognised value '$REQUESTED' — defaulting to poweroff."
                ;;
        esac
        # Shred and remove the signal file so nothing persists. On tmpfs
        # (ephemeral) this is moot; on the encrypted seeds dir it is still
        # cheap insurance against stale signals on next boot.
        shred -u "$POWER_ACTION_READ_PATH" 2>/dev/null || rm -f "$POWER_ACTION_READ_PATH" 2>/dev/null || true
    else
        echo "No POWER_ACTION.txt found — defaulting to poweroff (safe fallback)."
    fi
    echo "Power sequence: $POWER_ACTION"

    # ------------------------------------------------------------------
    # tty1 SHUTDOWN SPLASH — raw-TTY safe
    # ------------------------------------------------------------------
    # At this point X is about to exit and tty1 becomes the visible
    # console again. On the raw Linux VT, `onlcr` is often disabled by
    # whatever previously owned the terminal, so a plain `echo` (\n
    # only) produces the classic "staircase effect" — each line is
    # printed one row down but at the SAME column as the previous line
    # ended, slanting the logo across the screen.
    #
    # We defeat this by emitting every line through `printf '%s\r\n'`,
    # which sends an explicit Carriage Return *and* Line Feed so the
    # cursor unconditionally returns to column 0 before the next line.
    # Matches the boot-splash rendering path at the top of this file.
    # ------------------------------------------------------------------
    if [ -w /dev/tty1 ]; then
        # Pick the splash sub-title based on the requested action.
        if [ "$POWER_ACTION" = "reboot" ]; then
            _SKB_BYE_HEADLINE="                      Session ended. Restarting..."
        else
            _SKB_BYE_HEADLINE="                      Session ended. Powering off..."
        fi
        {
            printf '\033[2J\033[H\r'
            # ASCII-art logo: quoted heredoc keeps backslashes/backticks literal.
            while IFS= read -r _skb_bye_line; do
                printf '%s\r\n' "$_skb_bye_line"
            done << 'SKB_BYE_EOF'


          _____        ____      __ __                 __    __           ____
         / ___/____ _ / __/___  / //_/___   ___   ____ | |  / /____ _ __ / / /_
         \__ \/ __ `// /_ / _ \/ ,<  / _ \ / _ \ / __ \| | / // __ `// // / __/
        ___/ / /_/ // __//  __/ /| |/  __//  __// /_/ /| |/ // /_/ // // / /_
       /____/\__,_//_/   \___/_/ |_|\___/ \___// .___/ |___/ \__,_/ \__/\__/
                                              /_/

SKB_BYE_EOF
            # Subtitle printed separately so we can interpolate the action.
            printf '%s\r\n' "$_SKB_BYE_HEADLINE"
            printf '%s\r\n' "                  Destroying all temporary session data in RAM."
            printf '\r\n\r\n'
        } > /dev/tty1 2>/dev/null || true
    fi

    # Dispatch: reboot or poweroff based on the user's dashboard selection.
    if [ "$POWER_ACTION" = "reboot" ]; then
        printf 'Chromium closed. Rebooting to destroy RAM contents...\r\n'
        sudo reboot
    else
        printf 'Chromium closed. Powering off to destroy RAM contents...\r\n'
        sudo poweroff
    fi
}

# Already unlocked from a previous session? (e.g., user relaunched Chromium)
if mountpoint -q "$VAULT_MOUNT" 2>/dev/null; then
    echo "Vault already mounted. Launching browser..."
    launch_browser
fi

# Find the data partition
DATA_PART=$(blkid -L "$DATA_LABEL" 2>/dev/null || true)

if [ -z "$DATA_PART" ]; then
    zenity --error --title="SafeKeep Boot Error" --width=400 \
        --text="No writable storage partition found (label: $DATA_LABEL).\n\nThe USB drive may not have been prepared correctly.\nPlease re-flash from your build machine."
    exit 1
fi

# -------------------------------------------------------------------
# FACTORY RESET COMPLETION — LUKS HEADER DESTRUCTION (Phase 2)
# -------------------------------------------------------------------
# If a previous session initiated a Factory Reset, the Wipe Watcher
# wrote a .wipe_pending flag to the persistent data partition. We now
# complete the wipe by destroying the LUKS vault entirely.
#
# CRITICAL: This block handles its OWN data partition mounting.
# It does NOT rely on any prior mount — the earlier mount may fail
# silently (no set -e), leaving $DATA_MOUNT pointing at the casper
# overlay tmpfs where .wipe_pending is invisible. To guarantee
# detection, Phase 2 mounts the partition independently and verifies
# every step with diagnostic logging.
#
# WHY TWO PHASES?
#   Phase 1 (previous session): Best-effort file deletion + flag write.
#     The wipe watcher deletes master-seed.json, codex/, passphrases/,
#     and signals the browser. But this can be interrupted by poweroff,
#     and shred is ineffective on SSDs due to wear leveling.
#
#   Phase 2 (this boot): Cryptographic destruction. We overwrite the
#     LUKS header with zeros, destroying all keyslots. Without the
#     keyslots the volume master key is unrecoverable — the remaining
#     ciphertext is random noise. Then we delete the vault file and
#     the setup marker, forcing a fresh vault creation on next boot.
#
# This guarantees data destruction even if Phase 1 was incomplete.
# -------------------------------------------------------------------
echo ""
echo "=== Phase 2 Factory Reset Check ==="
echo "DATA_PART=$DATA_PART  DATA_MOUNT=$DATA_MOUNT"

# Phase 2 mounts the data partition ITSELF — do not trust earlier mount.
sudo mkdir -p "$DATA_MOUNT"
if ! mountpoint -q "$DATA_MOUNT" 2>/dev/null; then
    echo "Phase 2: data partition not yet mounted, mounting $DATA_PART → $DATA_MOUNT"
    if sudo mount "$DATA_PART" "$DATA_MOUNT"; then
        echo "Phase 2: mount succeeded"
    else
        echo "Phase 2: WARNING — mount failed (exit $?), trying with fsck first..."
        sudo fsck.ext4 -y "$DATA_PART" 2>&1 || true
        sudo mount "$DATA_PART" "$DATA_MOUNT" || echo "Phase 2: mount STILL failed after fsck"
    fi
else
    echo "Phase 2: data partition already mounted at $DATA_MOUNT"
fi

# Diagnostic: show mount status and directory contents
echo "Phase 2: mountpoint check = $(mountpoint "$DATA_MOUNT" 2>&1)"
echo "Phase 2: ls $DATA_MOUNT = $(ls -la "$DATA_MOUNT" 2>&1 | head -10)"

WIPE_PENDING="$DATA_MOUNT/.wipe_pending"
echo "Phase 2: checking for $WIPE_PENDING"
echo "Phase 2: [ -f $WIPE_PENDING ] = $([ -f "$WIPE_PENDING" ] && echo TRUE || echo FALSE)"

if [ -f "$WIPE_PENDING" ]; then
    echo ""
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "!! FACTORY RESET DETECTED — DESTROYING VAULT    !!"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo ""
    echo "Phase 2: flag contents: $(cat "$WIPE_PENDING")"

    # 1) Force-unmount the vault (should not be mounted, but be safe)
    sudo umount -l "$VAULT_MOUNT" 2>/dev/null || true

    # 2) Close the LUKS mapping if open
    sudo cryptsetup close "$MAPPER_NAME" 2>/dev/null || true

    # 3) Detach any loop device for the vault file
    VAULT_PATH="$DATA_MOUNT/$VAULT_FILE"
    echo "Phase 2: vault file path = $VAULT_PATH"
    echo "Phase 2: vault file exists = $([ -f "$VAULT_PATH" ] && echo YES || echo NO)"

    if [ -f "$VAULT_PATH" ]; then
        WIPE_LOOP=$(losetup -j "$VAULT_PATH" 2>/dev/null | awk -F: '{print $1}' | head -1 || true)
        if [ -n "$WIPE_LOOP" ]; then
            echo "Phase 2: detaching loop device $WIPE_LOOP"
            sudo losetup -d "$WIPE_LOOP" 2>/dev/null || true
        fi

        # 4) Overwrite the LUKS header with zeros (cryptographic kill).
        #    The LUKS2 header is typically 16MB. Zeroing this region
        #    destroys all keyslots — the volume master key cannot be
        #    derived, and the entire encrypted payload is unrecoverable.
        echo "Phase 2: zeroing LUKS header (16MB)..."
        sudo dd if=/dev/zero of="$VAULT_PATH" bs=1M count=16 conv=notrunc 2>&1
        echo "Phase 2: LUKS header destroyed"

        # 5) Delete the vault file entirely
        sudo rm -f "$VAULT_PATH"
        echo "Phase 2: vault file deleted = $([ ! -f "$VAULT_PATH" ] && echo YES || echo NO)"
    else
        echo "Phase 2: WARNING — vault file not found at $VAULT_PATH (may already be gone)"
    fi

    # 6) Remove the setup marker → first-boot setup will run next
    sudo rm -f "$DATA_MOUNT/$SETUP_MARKER"
    echo "Phase 2: setup marker removed"

    # 7) Remove the wipe-pending flag
    sudo rm -f "$WIPE_PENDING"
    echo "Phase 2: wipe_pending flag removed"

    # 8) Sync, notify user, and reboot into first-boot setup
    sync
    echo "Phase 2: COMPLETE — rebooting into first-boot setup"

    zenity --info --title="Factory Reset Complete" --width=400 \
        --text="All vault data has been cryptographically destroyed.\n\nThe system will now reboot. You will be prompted\nto create a new encrypted vault.\n\nClick OK to reboot." 2>/dev/null || true

    # -------------------------------------------------------------------
    # REBOOT FENCE — prevents factory-reset race condition
    # -------------------------------------------------------------------
    # `sudo reboot` returns exit 0 the INSTANT it signals systemd, but
    # the OS takes ~10 seconds to tear the system down. A bare `exit 0`
    # here merely terminates THIS script — the surrounding flow (display
    # manager / kiosk wrapper) can still spawn the next UI prompt during
    # the shutdown window, flashing the Recovery/Restore menu at the
    # user for ~10 seconds.
    #
    # `exec sleep infinity` REPLACES this process with sleep so it can
    # never return. When systemd brings the system down, sleep is killed
    # cleanly as part of shutdown.
    #
    # Same pattern as setup-vault.sh's first-boot fence.
    # -------------------------------------------------------------------
    sudo systemctl reboot 2>/dev/null || sudo reboot || true
    exec sleep infinity
else
    echo "Phase 2: no .wipe_pending flag found — normal boot continues"
fi
echo "=== End Phase 2 Check ==="
echo ""

# Mount the data partition for subsequent checks (may already be mounted by Phase 2 block above)
if ! mountpoint -q "$DATA_MOUNT" 2>/dev/null; then
    sudo mkdir -p "$DATA_MOUNT"
    sudo mount "$DATA_PART" "$DATA_MOUNT" || echo "WARNING: data partition mount failed"
fi

# -------------------------------------------------------------------
# STEP 2: FIRST-TIME SETUP OR UNLOCK
# -------------------------------------------------------------------

# --- State Lock Check ---
# The .setup_complete marker on the data partition tells us whether
# first-boot initialization (vault creation) has been completed.
# If the marker is MISSING, we need to run setup-vault which creates
# the encrypted vault and triggers a mandatory reboot.
if [ ! -f "$DATA_MOUNT/$SETUP_MARKER" ]; then
    # ---- FIRST BOOT: Full initialization required ----
    echo "First boot detected (no .setup_complete marker). Starting initialization..."
    sudo umount "$DATA_MOUNT" 2>/dev/null || true

    # setup-vault handles vault creation, OS hardening, initramfs rebuild,
    # writes the state marker, and triggers a mandatory reboot.
    # This script will NOT continue past this point on first boot —
    # setup-vault fences its own reboot with `exec sleep infinity`, so
    # on a successful run control NEVER returns from the call below.
    setup-vault || true

    # If we reach here, setup-vault exited without rebooting (cancelled/error).
    # Re-mount and check if the vault was at least created.
    if ! mountpoint -q "$DATA_MOUNT"; then
        sudo mount "$DATA_PART" "$DATA_MOUNT" || {
            zenity --error --text="Cannot re-mount data partition after setup." 2>/dev/null || true
            exit 1
        }
    fi

    # ---- Defense-in-depth reboot fence ----
    # setup-vault fences its own reboot, so reaching this line SHOULD mean
    # it exited without rebooting. But if the .setup_complete marker was
    # written before an unexpected exit, a reboot is still pending and we
    # must NOT fall through to the unlock-vault block — doing so would
    # flash the "Unlock Vault" dialog during the ~10s shutdown window,
    # which is the bug we are fixing.
    if [ -f "$DATA_MOUNT/$SETUP_MARKER" ]; then
        echo "Setup marker present after setup-vault exit — reboot is pending. Halting to avoid unlock-vault fall-through."
        sync
        exec sleep infinity
    fi

    if [ ! -f "$DATA_MOUNT/$VAULT_FILE" ]; then
        zenity --warning --title="Setup Incomplete" --width=400 \
            --text="First-boot setup was not completed.\n\nSafeKeep cannot start without an encrypted vault and OS hardening.\nPlease restart and try again."
        sudo umount "$DATA_MOUNT" 2>/dev/null || true
        exit 1
    fi
fi

# ---- UNLOCK THE VAULT ----
# Check if already unlocked (setup-vault might have left it open)
if mountpoint -q "$VAULT_MOUNT" 2>/dev/null; then
    echo "Vault mounted after setup. Proceeding..."
else
    # Retry loop: unlock-vault now handles wrong-password retries internally
    # (infinite loop with zenity prompts). It only exits with:
    #   0 = vault unlocked and mounted
    #   1 = fatal error (no partition, no vault file, loop device failure)
    #   2 = user explicitly cancelled (clicked X on method-choice dialog)
    #
    # We still wrap this in a loop so that if the user cancels (exit 2),
    # we give them one more chance rather than halting immediately.
    UNLOCK_ATTEMPT=0

    while ! mountpoint -q "$VAULT_MOUNT" 2>/dev/null; do
        UNLOCK_ATTEMPT=$((UNLOCK_ATTEMPT + 1))
        echo "Unlock attempt $UNLOCK_ATTEMPT (unlimited retries)..."

        # unlock-vault handles its own data partition mounting, so unmount first
        sudo umount "$DATA_MOUNT" 2>/dev/null || true

        # Run unlock-vault and capture its exit code
        UNLOCK_EXIT=0
        unlock-vault || UNLOCK_EXIT=$?

        if [ "$UNLOCK_EXIT" -eq 0 ]; then
            # Success — verify the mount landed at our hardcoded path
            if mountpoint -q "$VAULT_MOUNT" 2>/dev/null; then
                echo "Vault unlocked successfully."
                break
            else
                echo "Warning: unlock-vault exited 0 but vault not at $VAULT_MOUNT"
            fi
        elif [ "$UNLOCK_EXIT" -eq 2 ]; then
            # Non-fatal: user cancelled the method-choice dialog.
            # Loop back — they might have fat-fingered the X button.
            echo "User cancelled unlock dialog. Retrying..."
            continue
        elif [ "$UNLOCK_EXIT" -eq 3 ]; then
            # ---- EPHEMERAL BOOT PATH ----
            # User chose "Boot Ephemeral (RAM Only)" at the zenity prompt.
            # Skip vault decryption entirely. The vault stays sealed; boot.html
            # runs RAM-only via #ephemeral=true (hash fragment — see the
            # LAUNCH_URL construction block for why we MUST NOT use "?"
            # on file:/// URIs). This is the ONE code path where we
            # intentionally break out of this loop without a mounted
            # vault — the final mountpoint check below is bypassed by the
            # EPHEMERAL_MODE flag.
            EPHEMERAL_MODE=1
            echo "TEMPORARY SESSION BOOT: user selected RAM-only mode. Vault remains locked."
            break
        else
            # Fatal error (exit 1) — no point retrying
            zenity --error --title="Unlock Failed" --width=400 \
                --text="A fatal error occurred during vault unlock.\n\nSafeKeep cannot start. Please restart and try again." 2>/dev/null || true
            exit 1
        fi
    done

    # Final safety check: vault MUST be at our path — EXCEPT in ephemeral mode,
    # where we deliberately never unlocked the vault. The browser will operate
    # entirely in RAM, so a missing mountpoint here is the expected state.
    if [ "$EPHEMERAL_MODE" != "1" ] && ! mountpoint -q "$VAULT_MOUNT" 2>/dev/null; then
        zenity --warning --title="Vault Locked" --width=400 \
            --text="The vault was not unlocked.\n\nSafeKeep cannot start without access to the encrypted vault.\nPlease restart and try again." 2>/dev/null || true
        exit 1
    fi
fi

# -------------------------------------------------------------------
# STEP 3: LAUNCH BROWSER
# -------------------------------------------------------------------
launch_browser

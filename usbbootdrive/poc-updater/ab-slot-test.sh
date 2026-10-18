#!/bin/bash
# =====================================================================
#  ab-slot-test.sh — updater proof of concept, step 2 (run ON the stick)
# =====================================================================
#
#  Run from the Terminal of a DEVELOPER build (SAFEKEEP_DEV_SHELL=1)
#  booted from a stick converted with ab-convert.sh. It tests the one
#  thing we can't test on the ZBook: writing the OS slot that isn't
#  running while SafeKeep is running from the same partition (casper keeps
#  it mounted read-only at /cdrom).
#
#     bash ab-slot-test.sh status         which slot is running, what's on disk
#     bash ab-slot-test.sh copy           copy the running slot into the idle slot
#     bash ab-slot-test.sh switch         boot the idle slot next time
#     bash ab-slot-test.sh fallback-test  point slot.cfg at a slot with no kernel
#     bash ab-slot-test.sh fallback-undo  put that kernel back
#
#  Nothing here touches the vault or the transfer drive.
# =====================================================================
set -euo pipefail

OS_MNT=/cdrom
FILES="filesystem.squashfs vmlinuz initrd filesystem.size filesystem.manifest"

die() { echo ""; echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root."
mountpoint -q "$OS_MNT" || die "$OS_MNT is not mounted — is this a SafeKeep stick?"
OS_DEV=$(findmnt -no SOURCE "$OS_MNT")
[ "$(lsblk -no LABEL "$OS_DEV" 2>/dev/null)" = "safekeep-os" ] \
    || die "$OS_MNT ($OS_DEV) is not the safekeep-os partition."

RUNNING=$(sed -n 's/.*live-media-path=casper-\([ab]\).*/\1/p' /proc/cmdline)
[ -n "$RUNNING" ] || die "not booted from a slot (no live-media-path=casper-a/b in /proc/cmdline). Was the stick converted with ab-convert.sh?"
if [ "$RUNNING" = a ]; then IDLE=b; else IDLE=a; fi

rw()  { mount -o remount,rw "$OS_MNT" || die "could not remount $OS_MNT read-write. This is the key result: please send this output."; }
ro()  { sync; mount -o remount,ro "$OS_MNT" 2>/dev/null || echo "WARNING: could not remount $OS_MNT read-only."; }

set_slot() {
    printf 'set slot=%s\n' "$1" > "$OS_MNT/.slot.cfg.new"
    sync
    mv -f "$OS_MNT/.slot.cfg.new" "$OS_MNT/slot.cfg"
    sync
}

case "${1:-status}" in
status)
    echo "Running slot:     $RUNNING   (idle slot: $IDLE)"
    echo "slot.cfg says:    $(cat "$OS_MNT/slot.cfg" 2>/dev/null || echo '(missing)')"
    echo "Kernel command line:"
    echo "  $(cat /proc/cmdline)"
    echo "OS partition ($OS_DEV, mounted at $OS_MNT):"
    findmnt -no OPTIONS "$OS_MNT" | sed 's/^/  options: /'
    for s in a b; do
        if [ -d "$OS_MNT/casper-$s" ]; then
            echo "  casper-$s: $(du -sm "$OS_MNT/casper-$s" | awk '{print $1}') MB  $(ls "$OS_MNT/casper-$s" | tr '\n' ' ')"
        else
            echo "  casper-$s: (empty)"
        fi
    done
    df -h "$OS_MNT" | tail -1 | awk '{print "  free: " $4 " of " $2}'
    ;;
copy)
    SRC="$OS_MNT/casper-$RUNNING"
    NEW="$OS_MNT/.casper-$IDLE.new"
    NEED_KB=$(du -sk "$SRC" | awk '{print $1}')
    FREE_KB=$(df -Pk "$OS_MNT" | awk 'NR==2 {print $4}')
    OLD_KB=0
    [ -d "$OS_MNT/casper-$IDLE" ] && OLD_KB=$(du -sk "$OS_MNT/casper-$IDLE" | awk '{print $1}')
    [ $(( FREE_KB + OLD_KB )) -gt $(( NEED_KB + 51200 )) ] || die "not enough room on the OS partition for a second slot."
    START=$(date +%s)
    trap ro EXIT
    rw
    echo "Writing slot $IDLE from the running slot $RUNNING ($(( NEED_KB / 1024 )) MB) ..."
    # The old idle slot goes first, to make room. The running slot and
    # slot.cfg are untouched until the new copy is complete and checked.
    rm -rf "$NEW" "$OS_MNT/casper-$IDLE"
    sync
    mkdir "$NEW"
    for f in $FILES; do
        [ -f "$SRC/$f" ] && cp "$SRC/$f" "$NEW/$f"
    done
    sync
    echo 3 > /proc/sys/vm/drop_caches   # make the check read back from the stick
    (cd "$SRC" && sha256sum filesystem.squashfs vmlinuz initrd) > /tmp/ab-src.sha
    (cd "$NEW" && sha256sum -c --quiet /tmp/ab-src.sha) || die "the new slot does not match. Not switching."
    mv "$NEW" "$OS_MNT/casper-$IDLE"
    sync
    echo "Slot $IDLE written and checked in $(( $(date +%s) - START ))s. slot.cfg still says: $(cat "$OS_MNT/slot.cfg")"
    echo "Next: bash ab-slot-test.sh switch"
    ;;
switch)
    for f in filesystem.squashfs vmlinuz initrd; do
        [ -f "$OS_MNT/casper-$IDLE/$f" ] || die "slot $IDLE is incomplete ($f missing). Run: bash ab-slot-test.sh copy"
    done
    trap ro EXIT
    rw
    set_slot "$IDLE"
    echo "slot.cfg now says: $(cat "$OS_MNT/slot.cfg")"
    echo "Reboot. GRUB should boot slot $IDLE; then run: bash ab-slot-test.sh status"
    ;;
fallback-test)
    [ -f "$OS_MNT/casper-$IDLE/vmlinuz" ] || die "slot $IDLE has no kernel to hide. Run copy first."
    trap ro EXIT
    rw
    mv "$OS_MNT/casper-$IDLE/vmlinuz" "$OS_MNT/casper-$IDLE/vmlinuz.off"
    set_slot "$IDLE"
    echo "slot.cfg points at slot $IDLE, which now has no kernel."
    echo "Reboot. GRUB should fall back and boot slot $RUNNING, with no 'previous version' entry."
    echo "Afterwards: bash ab-slot-test.sh fallback-undo"
    ;;
fallback-undo)
    trap ro EXIT
    rw
    [ -f "$OS_MNT/casper-$IDLE/vmlinuz.off" ] && mv "$OS_MNT/casper-$IDLE/vmlinuz.off" "$OS_MNT/casper-$IDLE/vmlinuz"
    set_slot "$RUNNING"
    echo "Kernel restored in slot $IDLE; slot.cfg says: $(cat "$OS_MNT/slot.cfg")"
    ;;
*)
    die "unknown command '$1'. Use: status, copy, switch, fallback-test or fallback-undo."
    ;;
esac

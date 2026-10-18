#!/bin/bash
# =====================================================================
#  os-slots.sh — the two OS slots on the OS partition (sourced, not run)
# =====================================================================
#
#  The OS partition (label safekeep-os) holds casper-a/ and casper-b/, and
#  slot.cfg ("set slot=a" or "set slot=b") names the slot GRUB boots
#  (grub.cfg, UPDATER_DESIGN.md). A new OS always goes into the idle slot:
#  it is written under a temporary name, read back and checked, renamed into
#  place, and only then does slot.cfg switch, by renaming a complete new file
#  over it. A power cut at any point leaves a stick that boots.
#
#  Used by quick-update.sh, and later by the on-stick updater.
#
#     source os-slots.sh
#     slot_layout   MNT            → "two-slot", "legacy" (casper/) or "unknown"
#     slot_active   MNT            → a | b  (the slot GRUB boots)
#     slot_write    MNT SLOT SRC   copy SRC/{squashfs,kernel,…} into SLOT, checked
#     slot_switch   MNT SLOT       make GRUB boot SLOT from now on
#
#  Functions return non-zero with a message on stderr; nothing here exits.
# =====================================================================

SLOT_FILES="filesystem.squashfs vmlinuz initrd filesystem.size filesystem.manifest"
SLOT_REQUIRED="filesystem.squashfs vmlinuz initrd"

slot_layout() {
    if [ -f "$1/slot.cfg" ] || [ -d "$1/casper-a" ]; then echo two-slot
    elif [ -d "$1/casper" ]; then echo legacy
    else echo unknown
    fi
}

slot_other() { if [ "$1" = a ]; then echo b; else echo a; fi; }

# Same choice as grub.cfg: the slot slot.cfg names, unless it has no kernel.
slot_active() {
    local mnt="$1" s=a
    if [ -f "$mnt/slot.cfg" ] && grep -qx 'set slot=b' "$mnt/slot.cfg"; then s=b; fi
    if [ ! -f "$mnt/casper-$s/vmlinuz" ]; then s=$(slot_other "$s"); fi
    echo "$s"
}

slot_write() {
    local mnt="$1" slot="$2" src="$3" f need_kb free_kb old_kb new="$1/.casper-$2.new"
    case "$slot" in a|b) ;; *) echo "slot_write: bad slot '$slot'" >&2; return 1 ;; esac
    for f in $SLOT_REQUIRED; do
        [ -s "$src/$f" ] || { echo "slot_write: $src/$f is missing" >&2; return 1; }
    done
    need_kb=$(du -sk "$src" | awk '{print $1}')
    free_kb=$(df -Pk "$mnt" | awk 'NR==2 {print $4}')
    old_kb=0
    [ -d "$mnt/casper-$slot" ] && old_kb=$(du -sk "$mnt/casper-$slot" | awk '{print $1}')
    [ -d "$new" ] && old_kb=$(( old_kb + $(du -sk "$new" | awk '{print $1}') ))
    if [ $(( free_kb + old_kb )) -lt $(( need_kb + 51200 )) ]; then
        echo "slot_write: not enough room on the OS partition for slot $slot ($(( need_kb / 1024 )) MB needed)" >&2
        return 1
    fi
    # The old copy in this slot goes first, to make room. The other slot and
    # slot.cfg are untouched until the new copy is complete and checked.
    rm -rf "$new" "$mnt/casper-$slot" || return 1
    sync
    mkdir "$new" || return 1
    for f in $SLOT_FILES; do
        if [ -f "$src/$f" ]; then cp "$src/$f" "$new/$f" || return 1; fi
    done
    sync
    # Read back from the stick, not from the page cache.
    echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
    for f in $SLOT_REQUIRED; do
        if [ "$(sha256sum < "$src/$f")" != "$(sha256sum < "$new/$f")" ]; then
            echo "slot_write: $f in slot $slot does not match after writing" >&2
            return 1
        fi
    done
    mv "$new" "$mnt/casper-$slot" || return 1
    sync
}

slot_switch() {
    local mnt="$1" slot="$2" f
    case "$slot" in a|b) ;; *) echo "slot_switch: bad slot '$slot'" >&2; return 1 ;; esac
    for f in $SLOT_REQUIRED; do
        [ -s "$mnt/casper-$slot/$f" ] || { echo "slot_switch: slot $slot is incomplete ($f missing)" >&2; return 1; }
    done
    printf 'set slot=%s\n' "$slot" > "$mnt/.slot.cfg.new" || return 1
    sync
    mv -f "$mnt/.slot.cfg.new" "$mnt/slot.cfg" || return 1
    sync
}

#!/bin/bash
# =====================================================================
#  safekeep-brightness.sh — the built-in screen's brightness
# =====================================================================
#  SafeKeep has no desktop, so nothing answers a laptop's brightness keys.
#  The app's Device Options → Screen Brightness slider (and the one in Draw
#  my SeedQR's light box, and the brightness keys while the app has focus)
#  ask safekeep-boot.sh's Brightness Watcher, which runs this as root:
#
#     safekeep-brightness.sh get          report the brightness
#     safekeep-brightness.sh set <pct>    set it, 10–100 (%)
#     safekeep-brightness.sh up | down    one step of 10 %
#
#  It writes every backlight in /sys/class/backlight (a laptop or iMac
#  panel: intel_backlight, amdgpu_bl0, gmux_backlight, acpi_video0, …) to
#  the same percentage, reads the result back from the finest one, and
#  writes the status the app reads:
#     /tmp/safekeep-signals/BRIGHTNESS.json
#       { "available": true, "percent": 70, "at": <unix time>,
#         "action": "set", "devices": "intel_backlight raw 3367/4810, …" }
#       { "available": false, "at": … }   (an external monitor: use its buttons)
#  "devices" (each backlight's name, type and value/max after the change)
#  is shown under the slider in Device Options, so a screen that doesn't
#  respond can be diagnosed from a screenshot. Each run is also logged to
#  /tmp/safekeep-brightness.log.
#  Never below 10 %, so the screen can't be turned black by mistake.
#  It reads nothing but the number it is given and runs no other command.
#
#  For tests: SAFEKEEP_BACKLIGHT_DIR and SAFEKEEP_BRIGHTNESS_STATUS move
#  the sysfs folder and the status file.
# =====================================================================
set -u

BL_DIR="${SAFEKEEP_BACKLIGHT_DIR:-/sys/class/backlight}"
STATUS="${SAFEKEEP_BRIGHTNESS_STATUS:-/tmp/safekeep-signals/BRIGHTNESS.json}"
MIN_PCT=10
STEP_PCT=10

# Every backlight, the finest (largest max_brightness) first: the level is
# read back from that one, so a coarse one (acpi_video0 often has 8 steps)
# can't make a step round back to where it was.
devices=()
best_max=0
for d in "$BL_DIR"/*; do
    [ -f "$d/brightness" ] && [ -f "$d/max_brightness" ] || continue
    max=$(head -c 16 "$d/max_brightness" 2>/dev/null | tr -cd '0-9')
    [ -n "$max" ] && [ "$max" -gt 0 ] || continue
    if [ "$max" -gt "$best_max" ]; then devices=("$d" "${devices[@]}"); best_max=$max
    else devices+=("$d"); fi
done

write_status() {
    local tmp="$STATUS.tmp.$$"
    mkdir -p "$(dirname "$STATUS")" 2>/dev/null
    printf '%s\n' "$1" > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$STATUS"
}

current_pct() {
    local d="${devices[0]}" cur max
    cur=$(head -c 16 "$d/brightness" 2>/dev/null | tr -cd '0-9')
    max=$(head -c 16 "$d/max_brightness" 2>/dev/null | tr -cd '0-9')
    [ -n "$cur" ] || cur=0
    echo $(( (cur * 100 + max / 2) / max ))
}

set_pct() {
    local pct="$1" d max val
    [ "$pct" -lt "$MIN_PCT" ] && pct=$MIN_PCT
    [ "$pct" -gt 100 ] && pct=100
    for d in "${devices[@]}"; do
        max=$(head -c 16 "$d/max_brightness" 2>/dev/null | tr -cd '0-9')
        val=$(( (pct * max + 50) / 100 ))
        [ "$val" -lt 1 ] && val=1
        if ! echo "$val" > "$d/brightness" 2>>"$LOG"; then
            echo "$(date -Is) write $val to $d failed" >> "$LOG" 2>/dev/null
        fi
    done
}

LOG="${SAFEKEEP_BRIGHTNESS_LOG:-/tmp/safekeep-brightness.log}"
now=$(date +%s)

# "name type value/max" for every backlight, comma-separated.
describe() {
    local d out="" name type cur max
    for d in "${devices[@]}"; do
        name=$(basename "$d" | tr -cd 'A-Za-z0-9_.-' | head -c 32)
        type=$(head -c 16 "$d/type" 2>/dev/null | tr -cd 'a-z')
        cur=$(head -c 16 "$d/brightness" 2>/dev/null | tr -cd '0-9')
        max=$(head -c 16 "$d/max_brightness" 2>/dev/null | tr -cd '0-9')
        out="$out${out:+, }$name ${type:-?} ${cur:-?}/$max"
    done
    printf '%s' "$out"
}

if [ "${#devices[@]}" -eq 0 ]; then
    write_status "{\"available\": false, \"at\": $now, \"devices\": \"\"}"
    echo "$(date -Is) ${1:-get}: no backlight in $BL_DIR" >> "$LOG" 2>/dev/null
    exit 0
fi

action="${1:-get}"
case "$action" in
    get) ;;
    set)
        pct=$(printf '%s' "${2:-}" | head -c 4 | tr -cd '0-9')
        [ -n "$pct" ] || { echo "safekeep-brightness: set needs a number" >&2; exit 2; }
        set_pct "$((10#$pct))"
        ;;
    up|down)
        now=$(current_pct)
        # Round to the step first, so 73 % goes to 80 % or 70 %.
        if [ "$action" = up ]; then set_pct $(( (now / STEP_PCT + 1) * STEP_PCT ))
        else set_pct $(( ((now + STEP_PCT - 1) / STEP_PCT - 1) * STEP_PCT )); fi
        ;;
    *) echo "safekeep-brightness: unknown action" >&2; exit 2 ;;
esac

desc=$(describe)
echo "$(date -Is) $action ${2:-}: $desc" >> "$LOG" 2>/dev/null
write_status "{\"available\": true, \"percent\": $(current_pct), \"at\": $now, \"action\": \"$action\", \"devices\": \"$desc\"}"

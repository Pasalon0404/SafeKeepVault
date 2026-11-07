#!/bin/bash
# =====================================================================
#  safekeep-brightness.sh — screen brightness, for any computer
# =====================================================================
#  SafeKeep has no desktop, so the app's brightness controls ask
#  safekeep-boot.sh's Brightness Watcher, which runs this as root:
#
#     safekeep-brightness.sh dim <pct>   software dimming, 30–100 (%)
#     safekeep-brightness.sh full        light box: backlight to 100 %
#     safekeep-brightness.sh restore     light box closed: backlight back
#     safekeep-brightness.sh up | down   the keyboard's brightness keys
#
#  dim — Device Options → Screen Brightness and the ☀ slider in Draw my
#    SeedQR's light box. Darkens the picture itself on every connected
#    screen (xrandr --brightness), so it works the same on a laptop, a
#    desktop's monitor, a Mac or a PC with two graphics chips. It can only
#    dim: 100 % is the screen's own brightness. Not below 30 %, where the
#    picture loses too much contrast.
#
#  full / restore / up / down — the hardware backlight (every backlight in
#    /sys/class/backlight, read back from the finest one). Laptops differ:
#    on some, none of the backlights Linux offers drives the panel, and on
#    a desktop there is none. That's fine: these are best effort, and the
#    sliders don't depend on them. `full` remembers the level it found,
#    and `restore` puts it back. Never below 10 %.
#
#  It reads nothing but the number it is given, runs nothing but xrandr,
#  and logs each run to /tmp/safekeep-brightness.log.
#
#  For tests: SAFEKEEP_BACKLIGHT_DIR, SAFEKEEP_BRIGHTNESS_STATE,
#  SAFEKEEP_BRIGHTNESS_LOG move the sysfs folder, the remembered level and
#  the log; SAFEKEEP_XRANDR replaces the xrandr command.
# =====================================================================
set -u

BL_DIR="${SAFEKEEP_BACKLIGHT_DIR:-/sys/class/backlight}"
STATE="${SAFEKEEP_BRIGHTNESS_STATE:-/tmp/safekeep-signals/brightness-before-lightbox}"
LOG="${SAFEKEEP_BRIGHTNESS_LOG:-/tmp/safekeep-brightness.log}"
XRANDR="${SAFEKEEP_XRANDR:-xrandr}"
MIN_HW_PCT=10
MIN_DIM_PCT=30
STEP_PCT=10

log() { echo "$(date -Is) $*" >> "$LOG" 2>/dev/null; }

# ---- software dimming ----------------------------------------------
dim() {
    local pct="$1" frac outputs o n=0
    [ "$pct" -lt "$MIN_DIM_PCT" ] && pct=$MIN_DIM_PCT
    [ "$pct" -gt 100 ] && pct=100
    frac=$(printf '%d.%02d' $((pct / 100)) $((pct % 100)))
    outputs=$("$XRANDR" --query 2>>"$LOG" | awk '$2 == "connected" {print $1}' | tr -cd 'A-Za-z0-9_.\n-')
    for o in $outputs; do
        "$XRANDR" --output "$o" --brightness "$frac" 2>>"$LOG" && n=$((n + 1))
    done
    log "dim $pct% ($frac) on $n screen(s): $(echo $outputs)"
}

# ---- hardware backlight --------------------------------------------
# Every backlight, the finest (largest max_brightness) first: the level is
# read back from that one, so a coarse one can't stall a step.
devices=()
best_max=0
for d in "$BL_DIR"/*; do
    [ -f "$d/brightness" ] && [ -f "$d/max_brightness" ] || continue
    max=$(head -c 16 "$d/max_brightness" 2>/dev/null | tr -cd '0-9')
    [ -n "$max" ] && [ "$max" -gt 0 ] || continue
    if [ "$max" -gt "$best_max" ]; then devices=("$d" "${devices[@]}"); best_max=$max
    else devices+=("$d"); fi
done

hw_pct() {
    local d="${devices[0]}" cur max
    cur=$(head -c 16 "$d/brightness" 2>/dev/null | tr -cd '0-9')
    max=$(head -c 16 "$d/max_brightness" 2>/dev/null | tr -cd '0-9')
    [ -n "$cur" ] || cur=0
    echo $(( (cur * 100 + max / 2) / max ))
}

hw_set() {
    local pct="$1" d max val
    [ "$pct" -lt "$MIN_HW_PCT" ] && pct=$MIN_HW_PCT
    [ "$pct" -gt 100 ] && pct=100
    for d in "${devices[@]}"; do
        max=$(head -c 16 "$d/max_brightness" 2>/dev/null | tr -cd '0-9')
        val=$(( (pct * max + 50) / 100 ))
        [ "$val" -lt 1 ] && val=1
        echo "$val" > "$d/brightness" 2>>"$LOG" || log "write $val to $d failed"
    done
    log "backlight $pct%: $(for d in "${devices[@]}"; do printf '%s ' "$(basename "$d")"; done)"
}

action="${1:-}"
case "$action" in
    dim)
        pct=$(printf '%s' "${2:-}" | head -c 4 | tr -cd '0-9')
        [ -n "$pct" ] || { echo "safekeep-brightness: dim needs a number" >&2; exit 2; }
        dim "$((10#$pct))"
        ;;
    full|restore|up|down)
        if [ "${#devices[@]}" -eq 0 ]; then log "$action: no backlight"; exit 0; fi
        case "$action" in
            full)
                # Remember the level only once, so a second full can't
                # overwrite it with 100.
                if [ ! -f "$STATE" ]; then
                    mkdir -p "$(dirname "$STATE")" 2>/dev/null
                    hw_pct > "$STATE"
                fi
                hw_set 100
                ;;
            restore)
                [ -f "$STATE" ] || exit 0
                was=$(head -c 4 "$STATE" | tr -cd '0-9')
                rm -f "$STATE"
                [ -n "$was" ] && hw_set "$((10#$was))"
                ;;
            up)   now=$(hw_pct); hw_set $(( (now / STEP_PCT + 1) * STEP_PCT )) ;;
            down) now=$(hw_pct); hw_set $(( ((now + STEP_PCT - 1) / STEP_PCT - 1) * STEP_PCT )) ;;
        esac
        ;;
    *) echo "safekeep-brightness: unknown action" >&2; exit 2 ;;
esac
exit 0

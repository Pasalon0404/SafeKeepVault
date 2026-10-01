#!/bin/bash
# =====================================================================
#  trezor-hw-test.sh — try safekeep-trezor.py against a REAL Trezor One
# =====================================================================
#  Runs on the ZBook (not SafeKeep). Does exactly what the SafeKeep
#  watcher + app will do, in the same order:
#    1. "detect"      — finds the Trezor, says whether it is locked
#    2. "prompt_pin"  — (only if locked) the Trezor shows its shuffled grid
#       "send_pin"    — you type the POSITIONS of your PIN digits here
#                       (keypad layout, hidden as you type). There is NO
#                       detect between these two steps: that would reset
#                       the Trezor's PIN request.
#    3. "detect"      — again, now unlocked: fingerprint + identity key
#    4. "pair"        — saves that Trezor as paired (to a TEMPORARY file
#                       for this test only)
#    5. "sign"        — (only if you give a PSBT) sends it to the Trezor,
#                       you approve or decline ON THE TREZOR, and the result
#                       is saved next to the input as <name>-trezor-signed.psbt
#  Nothing is broadcast. Use a PSBT that cannot be broadcast with one
#  signature (e.g. the 2-of-3 multisig test transaction).
#
#  Python: the hash-pinned test install ~/hwi-pinned if it exists (same
#  files as SafeKeep), otherwise ~/hwi-test. Override with TZ_PY=...
#
#  Usage:  sudo bash tests/trezor-hw-test.sh                 (unlock + pair)
#          sudo bash tests/trezor-hw-test.sh ~/cctest2.psbt  (… + sign)
# =====================================================================
set -u
if [ -n "${TZ_PY:-}" ]; then PY="$TZ_PY"
elif [ -x /home/${SUDO_USER:-$USER}/hwi-pinned/bin/python3 ]; then PY=/home/${SUDO_USER:-$USER}/hwi-pinned/bin/python3
else PY=/home/${SUDO_USER:-$USER}/hwi-test/bin/python3; fi
HELPER="$(cd "$(dirname "$0")/.." && pwd)/safekeep-trezor.py"
PSBT="${1:-}"

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
[ -x "$PY" ] || { echo "HWI test install not found at $PY"; exit 1; }
[ -f "$HELPER" ] || { echo "helper not found at $HELPER"; exit 1; }
[ -z "$PSBT" ] || [ -f "$PSBT" ] || { echo "PSBT file not found: $PSBT"; exit 1; }

W=$(mktemp -d)
chmod 700 "$W"
trap 'rm -rf "$W"' EXIT
export SAFEKEEP_TZ_PAIRING="$W/trezor-pairing.json"
export PYTHONDONTWRITEBYTECODE=1

echo "Using: $PY  (HWI $("$PY" -c 'import importlib.metadata as m; print(m.version("hwi"))' 2>/dev/null || echo '?'))"

run() {   # run <name>: helper reads $W/req.json, writes $W/<name>.json
    "$PY" "$HELPER" "$W/req.json" "$W/$1.json" 2>>"$W/stderr.log"
    [ -f "$W/req.json" ] && echo "   WARNING: request file was not deleted by the helper"
    python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print('   status : %s' % r.get('status')); r.get('ok') or print('   message: %s' % r.get('error'))" "$W/$1.json"
}
field() { python3 -c "import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print('' if v is None else v)" "$W/$1.json" "$2"; }

echo
echo "== 1. detect"
echo '{"action":"detect"}' > "$W/req.json"
run detect1
[ "$(field detect1 ok)" = "True" ] || exit 1
TPATH="$(field detect1 path)"
echo "   path   : $TPATH"
echo "   locked : $(field detect1 locked)   firmware: $(field detect1 firmware)   passphrase protection: $(field detect1 passphrase_protection)"

if [ "$(field detect1 locked)" = "True" ]; then
    echo
    echo "== 2. PIN"
    python3 -c "import json,sys; json.dump({'action':'prompt_pin','path':sys.argv[1]}, open(sys.argv[2],'w'))" "$TPATH" "$W/req.json"
    run prompt
    if [ "$(field prompt status)" = "pin_requested" ]; then
        echo
        echo "   The Trezor now shows 9 numbers in a shuffled 3x3 grid."
        echo "   For each digit of your PIN, find it on the Trezor and type the"
        echo "   POSITION of that square, using this layout:"
        echo
        echo "        7 8 9      (top row)"
        echo "        4 5 6      (middle row)"
        echo "        1 2 3      (bottom row)"
        echo
        echo "   Example: if your first PIN digit is in the top-left square, type 7."
        echo "   Nothing shows while you type. Press Enter when done."
        echo
        IFS= read -r -s -p "   Positions: " POS
        echo
        printf '%s' "$POS" | python3 -c "import json,os,sys; p=sys.stdin.read(); fd=os.open(sys.argv[2], os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600); os.write(fd, json.dumps({'action':'send_pin','path':sys.argv[1],'pin_positions':p}).encode()); os.close(fd)" "$TPATH" "$W/req.json"
        POS=""
        run sendpin
        [ "$(field sendpin status)" = "unlocked" ] || { echo "   Not unlocked. Run the script again for a new grid."; exit 1; }
    elif [ "$(field prompt status)" != "unlocked" ]; then
        exit 1
    fi
fi

echo
echo "== 3. detect (unlocked)"
echo '{"action":"detect"}' > "$W/req.json"
run detect2
[ "$(field detect2 ok)" = "True" ] && [ "$(field detect2 locked)" = "False" ] || { echo "   Still locked."; exit 1; }
XFP="$(field detect2 xfp)"
echo "   xfp    : ${XFP^^}"
python3 -c "import json,sys; x=json.load(open(sys.argv[1]))['id_xpub']; print('   id xpub: %s...%s (m/0h)' % (x[:12], x[-6:]))" "$W/detect2.json"

echo
echo "== 4. pair (temporary, test only)"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); json.dump({'action':'pair','expected_xfp':d['xfp'],'expected_xpub':d['id_xpub']}, open(sys.argv[2],'w'))" "$W/detect2.json" "$W/req.json"
run pair

if [ -z "$PSBT" ]; then
    echo
    echo "Unlock and pairing worked. Give a PSBT file to also test signing."
else
    echo
    echo "== 5. sign $(basename "$PSBT")"
    echo "   Look at the Trezor now: check the amount and address, then confirm or cancel."
    python3 - "$PSBT" "$W/req.json" <<'EOF'
import base64, json, sys
json.dump({'action': 'sign', 'request_id': 'hwtest',
           'psbt_b64': base64.b64encode(open(sys.argv[1], 'rb').read()).decode()},
          open(sys.argv[2], 'w'))
EOF
    run sign
    OUT="${PSBT%.psbt}-trezor-signed.psbt"
    python3 - "$W/sign.json" "$PSBT" "$OUT" <<'EOF'
import base64, json, struct, sys
r = json.load(open(sys.argv[1]))
if not r.get('ok'):
    sys.exit(0)
data = base64.b64decode(r['psbt_b64'])
open(sys.argv[3], 'wb').write(data)
def ci(b, i):
    n = b[i]
    if n < 0xfd: return n, i + 1
    if n == 0xfd: return struct.unpack_from('<H', b, i + 1)[0], i + 3
    if n == 0xfe: return struct.unpack_from('<I', b, i + 1)[0], i + 5
    return struct.unpack_from('<Q', b, i + 1)[0], i + 9
def sigs(b):
    i, maps, cur = 5, [], []
    while i < len(b):
        kl, i = ci(b, i)
        if kl == 0: maps.append(cur); cur = []; continue
        k = b[i:i + kl]; i += kl; vl, i = ci(b, i); v = b[i:i + vl]; i += vl; cur.append((k, v))
    inp = maps[1]
    fps = {k[1:]: v[:4].hex() for k, v in inp if k[0] == 0x06}
    return [fps.get(k[1:], '?') for k, v in inp if k[0] == 0x02]
print('   changed: %s' % r.get('changed'))
for label, blob in (('before', open(sys.argv[2], 'rb').read()), ('after ', data)):
    try:
        s = sigs(blob)
        print('   signatures %s: %d %s' % (label, len(s), s))
    except Exception:
        print('   signatures %s: (could not read this PSBT)' % label)
print('   saved: %s (%d bytes)' % (sys.argv[3], len(data)))
EOF
fi

echo
if grep -q "[1-9]\{4,\}" "$W/stderr.log" 2>/dev/null; then
    echo "Helper messages (check no PIN positions appear):"; cat "$W/stderr.log"
else
    echo "Helper log: $(wc -l < "$W/stderr.log" 2>/dev/null || echo 0) line(s), no digit runs (PIN positions never logged)."
fi

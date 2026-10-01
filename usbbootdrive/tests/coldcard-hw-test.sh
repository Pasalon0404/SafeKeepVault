#!/bin/bash
# =====================================================================
#  coldcard-hw-test.sh — try safekeep-coldcard.py against a REAL Coldcard
# =====================================================================
#  Runs on the ZBook (not SafeKeep), using the ckcc test install in
#  ~/ckcc-test. Does exactly what the SafeKeep watcher will do:
#    1. "detect"  — finds the Coldcard, shows its fingerprint
#    2. "sign"    — (only if you give a PSBT) sends it to the Coldcard,
#                   you approve or decline ON THE COLDCARD, and the result
#                   is saved next to the input as <name>-safekeep-signed.psbt
#  Nothing is broadcast. Use a PSBT that cannot be broadcast with one
#  signature (e.g. a 2-of-3 multisig test transaction).
#
#  Usage:  sudo bash tests/coldcard-hw-test.sh                (detect only)
#          sudo bash tests/coldcard-hw-test.sh ~/cctest2.psbt (detect + sign)
# =====================================================================
set -u
PY="${CKCC_PY:-/home/${SUDO_USER:-$USER}/ckcc-test/bin/python3}"
HELPER="$(cd "$(dirname "$0")/.." && pwd)/safekeep-coldcard.py"
PSBT="${1:-}"

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
[ -x "$PY" ] || { echo "ckcc test install not found at $PY"; exit 1; }
[ -f "$HELPER" ] || { echo "helper not found at $HELPER"; exit 1; }
[ -z "$PSBT" ] || [ -f "$PSBT" ] || { echo "PSBT file not found: $PSBT"; exit 1; }

W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

echo "== 1. detect"
echo '{"action":"detect"}' > "$W/req.json"
"$PY" "$HELPER" "$W/req.json" "$W/detect.json"
python3 - "$W/detect.json" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
if r.get('ok'):
    print('   status : %s' % r['status'])
    print('   serial : %s' % r['serial'])
    print('   xfp    : %s' % r['xfp'].upper())
    print('   xpub   : %s...%s' % (r['master_xpub'][:12], r['master_xpub'][-6:]))
else:
    print('   status : %s' % r.get('status'))
    print('   error  : %s' % r.get('error'))
    sys.exit(1)
EOF
[ $? -eq 0 ] || exit 1

[ -n "$PSBT" ] || { echo; echo "Detect worked. Give a PSBT file to also test signing."; exit 0; }

echo
echo "== 2. sign $(basename "$PSBT")"
echo "   Look at the Coldcard now: check the amount and address, then approve or decline."
python3 - "$W/detect.json" "$PSBT" "$W/req.json" <<'EOF'
import base64, json, sys
d = json.load(open(sys.argv[1]))
json.dump({'action': 'sign',
           'psbt_b64': base64.b64encode(open(sys.argv[2], 'rb').read()).decode(),
           'expected_xfp': d['xfp'], 'expected_xpub': d['master_xpub']},
          open(sys.argv[3], 'w'))
EOF
"$PY" "$HELPER" "$W/req.json" "$W/sign.json"
OUT="${PSBT%.psbt}-safekeep-signed.psbt"
python3 - "$W/sign.json" "$PSBT" "$OUT" <<'EOF'
import base64, json, struct, sys
r = json.load(open(sys.argv[1]))
print('   status : %s' % r.get('status'))
if not r.get('ok'):
    print('   message: %s' % r.get('error')); sys.exit(0)
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
for label, blob in (('before', open(sys.argv[2], 'rb').read()), ('after ', data)):
    try:
        s = sigs(blob)
        print('   signatures %s: %d %s' % (label, len(s), s))
    except Exception:
        print('   signatures %s: (could not read this PSBT)' % label)
print('   saved: %s (%d bytes)' % (sys.argv[3], len(data)))
EOF

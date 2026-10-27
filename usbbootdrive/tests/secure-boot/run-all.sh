#!/bin/bash
# Secure Boot test for the stick's boot chain (SECURE_BOOT.md), in QEMU.
# Builds small images with the stick's layout and build.sh's pinned signed
# boot files, boots them as a USB stick, and prints what happened.
#
# Needs an Ubuntu 24.04 host with:
#   sudo apt-get install qemu-system-x86 ovmf mtools dosfstools gdisk grub-pc-bin \
#        zstd cpio gcc python3-virt-firmware
# No root. About 15 minutes without KVM (two cases wait for a timeout).
# What it can't show: real firmware quirks, real screens and USB devices;
# those are the hardware checklist in SECURE_BOOT.md.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CACHE=${SB_TEST_CACHE:-$HERE/.cache}
export SB_TEST_CACHE=$CACHE
bash "$HERE/fetch.sh" || exit 1
OUT=$CACHE/run; mkdir -p "$OUT"
clean() { sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' "$1" | tr -d '\r'; }
field() { clean "$1" | grep -a -o "SKTEST $2: .*" | head -1 | sed "s/^SKTEST $2: //"; }
fail=0

# name  slot.cfg  slots  cfg-place  firmware  expect(slot|grub>|denied)  [vars]  [timeout]
case_() {
    local name=$1 slot=$2 slots=$3 place=$4 fw=$5 expect=$6 vars=${7:-} limit=${8:-600}
    local img=$OUT/$name.img log=$OUT/$name.log
    bash "$HERE/make-test-image.sh" "$img" "$slot" "$slots" "$place" >/dev/null 2>&1 || { echo "FAIL $name: image build"; fail=1; return; }
    bash "$HERE/run-qemu.sh" "$img" "$fw" "$log" "$vars" "$limit" >/dev/null
    local got path lock sb
    path=$(field "$log" cmdline | grep -o 'live-media-path=casper-[ab]' | sed 's/.*casper-//')
    if [ -n "$path" ]; then got=$path
    elif clean "$log" | grep -a -q 'grub> '; then got='grub>'
    elif clean "$log" | grep -a -q 'Access Denied'; then got=denied
    else got=nothing; fi
    sb=$(field "$log" firmware); lock=$(field "$log" lockdown)
    local mark=PASS; [ "$got" = "$expect" ] || { mark=FAIL; fail=1; }
    printf '%s %-24s %-7s boots=%-7s expected=%-7s %s %s\n' "$mark" "$name" "$fw" "$got" "$expect" "${sb:+[$sb]}" "${lock:+lockdown=$lock}"
    if [ -n "$path" ]; then
        printf '     unsigned module: %s | signed exFAT: %s\n' "$(field "$log" 'unsigned exfat module')" "$(field "$log" 'signed exfat module')"
    fi
    rm -f "${img:?}"
}

VARS_ON=$OUT/vars-ms.fd; cp /usr/share/OVMF/OVMF_VARS_4M.ms.fd "$VARS_ON"
case_ sb-on                a a  ubuntu sb-on  a "$VARS_ON"
case_ sb-off               a a  ubuntu sb-off a
case_ legacy-bios          a a  ubuntu bios   a
case_ slot-b               b ab ubuntu sb-on  b
case_ slot-b-missing       b a  ubuntu sb-on  a
case_ legacy-slot-b-missing b a ubuntu bios   a
case_ cfg-in-efi-boot      a a  boot   sb-on  a
case_ cfg-missing          a a  none   sb-on  'grub>' '' 120

# Firmware that does not trust Microsoft's third-party CA (2011): new PCs
# trusting only the 2023 CAs, Secured-core PCs with the third-party CA off,
# Intel Macs with T2 at Medium Security. The firmware should refuse shim.
if command -v virt-fw-vars >/dev/null; then
    C=$(python3 -c 'import virt.firmware, os; print(os.path.dirname(virt.firmware.__file__))')/certs
    MS=77fa9abd-0359-4d32-bd60-28f4e78f784b
    VARS_NO3P=$OUT/vars-no-third-party.fd
    virt-fw-vars --input /usr/share/OVMF/OVMF_VARS_4M.fd --output "$VARS_NO3P" \
        --set-pk "$MS" "$C/RedHatSecureBootPKKEKkey1.pem" --add-kek "$MS" "$C/MicrosoftCorporationKEKCA2011.pem" \
        --add-db "$MS" "$C/MicrosoftWindowsProductionPCA2011.pem" --secure-boot >/dev/null 2>&1
    case_ no-third-party-ca a a ubuntu sb-on denied "$VARS_NO3P" 120
else
    echo "SKIP no-third-party-ca (install python3-virt-firmware)"
fi

# shim records its revocation list (SbatLevel) in the computer's firmware.
python3 - "$VARS_ON" <<'EOF'
import sys
d = open(sys.argv[1], 'rb').read()
i = d.find('SbatLevel'.encode('utf-16-le'))
txt = bytes(c for c in d[i:i+200] if 32 <= c < 127 or c == 10).decode() if i > 0 else ''
print('NOTE SbatLevel written to the firmware by shim:', ' / '.join(txt.split('\n')[1:5]) if i > 0 else 'no')
EOF
[ $fail = 0 ] && echo "ALL PASSED" || echo "SOME FAILED (logs in $OUT)"
exit $fail

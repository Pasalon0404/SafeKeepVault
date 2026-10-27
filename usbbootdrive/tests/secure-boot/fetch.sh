#!/bin/bash
# Fetch what the Secure Boot test needs into $CACHE:
#   - the signed shim and GRUB, using build.sh's own pinned versions,
#     hashes and download code (so the test checks exactly what ships);
#   - Ubuntu's current signed kernel and its modules (exFAT lives in
#     linux-modules-extra), and a static busybox for the test initramfs.
# Needs an Ubuntu 24.04 host (apt-get download), no root.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
USB=$(cd "$HERE/../.." && pwd)
CACHE=${SB_TEST_CACHE:-$HERE/.cache}
mkdir -p "$CACHE"

# build.sh's pinned-fetch block, from its header comment to its "OK:" line.
awk '/^# --- Ubuntu.s signed UEFI boot chain, pinned/,/echo "  OK: \$SHIM_DEB/' "$USB/build.sh" > "$CACHE/fetch-block.sh"
[ -s "$CACHE/fetch-block.sh" ] || { echo "ERROR: pinned-fetch block not found in build.sh" >&2; exit 1; }
( cd "$CACHE" && WORKSPACE=ws && source ./fetch-block.sh && \
  { echo "SHIM_EFI=$CACHE/$SHIM_EFI"; echo "GRUB_EFI=$CACHE/$GRUB_EFI"; echo "MM_EFI=$CACHE/$MM_EFI"; } > "$CACHE/signed.env" )

if [ ! -d "$CACHE/k/lib/modules" ]; then
    KPKG=$(apt-cache depends linux-image-generic | grep -o 'linux-image-[0-9][^ ]*-generic' | head -1)
    ( cd "$CACHE" && apt-get download -q "$KPKG" "${KPKG/linux-image/linux-modules}" \
        "${KPKG/linux-image/linux-modules-extra}" busybox-static 2>&1 | grep -v '^W:' || true )
    for d in "$CACHE"/linux-*.deb; do dpkg-deb -x "$d" "$CACHE/k"; done
    dpkg-deb -x "$CACHE"/busybox-static_*.deb "$CACHE/bb"
fi
[ -x "$CACHE/kmod-load" ] || gcc -static -O2 -o "$CACHE/kmod-load" "$HERE/kmod-load.c"
echo "fetch: shim/GRUB pinned by build.sh; kernel $(ls "$CACHE/k/lib/modules")"

#!/bin/bash
# =====================================================================
#  make-update.sh — pack the last build's OS into a SafeKeep update file
# =====================================================================
#
#  Run on the build machine after `sudo bash build.sh`. It packs the OS that
#  build made (workspace/staging/casper) into
#     SafeKeep-Update-v<version>.tar        (release builds)
#     SafeKeep-Update-v<version>-build<N>.tar  (builds with local changes)
#  plus a copy of its manifest.json, for signing:
#
#     manifest.json   {format, kind, version, build stamp, app_sha256,
#                      layout, files: {name: {size, sha256}}}
#
#  The app hash is read from INSIDE the squashfs (opt/safekeep/boot.html),
#  so it is the app this update really installs. For a release it must
#  equal the boot.html line of that release's SHA256SUMS.
#
#  Then, on the Mac (VERIFYING.md, "For the maintainer"):
#     gpg --local-user <fingerprint> --armor --detach-sign manifest.json
#     tar -rf SafeKeep-Update-v<version>.tar manifest.json.asc
#  The stick (safekeep-update.py) refuses an update without that signature.
#
#  Usage (from /home/safekeep-build):
#     sudo bash make-update.sh
# =====================================================================
set -euo pipefail

STAGING="workspace/staging/casper"
die() { echo ""; echo "ERROR: $*" >&2; exit 1; }

[ -f build.sh ] || die "run this from the build folder (the one containing build.sh)."
for f in filesystem.squashfs vmlinuz initrd; do
    [ -s "$STAGING/$f" ] || die "$STAGING/$f is missing — run the full build first: sudo bash build.sh"
done
command -v unsquashfs >/dev/null || die "unsquashfs is missing (apt-get install squashfs-tools)."

# The app inside this OS, and its build stamp.
APP_SHA=$(unsquashfs -cat "$STAGING/filesystem.squashfs" opt/safekeep/boot.html | sha256sum | cut -d' ' -f1)
STAMP=$(unsquashfs -cat "$STAGING/filesystem.squashfs" opt/safekeep/boot.html \
    | grep -o -m1 'v[0-9]\{1,3\}\.[0-9]\{1,3\} · build [0-9]\{1,7\} · [0-9a-f]\{7,40\} · [0-9-]\{10\}[^<"]\{0,40\}' || true)
[ -n "$STAMP" ] || die "could not read the build stamp of the app inside the OS."
VERSION=$(echo "$STAMP" | sed -n 's/^v\([0-9]*\.[0-9]*\) · .*/\1/p')
BUILDNO=$(echo "$STAMP" | sed -n 's/^v[0-9.]* · build \([0-9]*\) · .*/\1/p')
# Which Chromium the build installed (chroot-setup.sh); an unpinned one is
# never a release.
CHROMIUM=$(unsquashfs -cat "$STAGING/filesystem.squashfs" etc/safekeep-chromium 2>/dev/null | head -1 || true)
NOT_RELEASE_WHY=""
case "$STAMP" in
    *"+ "*) NOT_RELEASE_WHY="the build stamp has local changes" ;;
esac
case "$CHROMIUM" in
    UNPINNED*) NOT_RELEASE_WHY="${NOT_RELEASE_WHY:+$NOT_RELEASE_WHY; }Chromium was not pinned (UC_ALLOW_UNPINNED=1)" ;;
esac
if [ -n "$NOT_RELEASE_WHY" ]; then
    NAME="SafeKeep-Update-v${VERSION}-build${BUILDNO}.tar"; NOT_RELEASE=1
else
    NAME="SafeKeep-Update-v${VERSION}.tar"; NOT_RELEASE=0
fi

OUT="workspace/update"
rm -rf "$OUT"
mkdir -p "$OUT"
FILES=""
for f in filesystem.squashfs vmlinuz initrd filesystem.size filesystem.manifest; do
    [ -s "$STAGING/$f" ] && FILES="$FILES $f"
done

echo "Hashing the OS files..."
python3 -I - "$OUT/manifest.json" "$STAGING" "$VERSION" "$STAMP" "$APP_SHA" $FILES <<'PYEOF'
import hashlib, json, os, sys
out, staging, version, stamp, app_sha, *files = sys.argv[1:]
entries = {}
for name in files:
    h = hashlib.sha256()
    with open(os.path.join(staging, name), 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    entries[name] = {'size': os.path.getsize(os.path.join(staging, name)), 'sha256': h.hexdigest()}
manifest = {'format': 1, 'kind': 'safekeep-os-update', 'version': version, 'build': stamp,
            'app_sha256': app_sha, 'layout': 'two-slot', 'files': entries}
with open(out, 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write('\n')
PYEOF

# Uncompressed tar (the squashfs is already compressed), manifest first.
# --format=ustar: plain headers any tar reads, including the Mac's.
# Absolute paths: a second -C is relative to the first one.
tar --format=ustar --owner=0 --group=0 --numeric-owner -cf "$NAME" \
    -C "$(cd "$OUT" && pwd)" manifest.json -C "$(cd "$STAGING" && pwd)" $FILES
cp "$OUT/manifest.json" manifest.json
rm -f manifest.json.asc

echo ""
echo "========================================="
echo "  Update file ready (NOT SIGNED YET)"
echo "========================================="
echo "  File       : $NAME ($(( $(stat -c%s "$NAME") / 1048576 )) MB)"
echo "  Build      : $STAMP"
echo "  app sha256 : $APP_SHA"
echo "  Chromium   : ${CHROMIUM:-not recorded (built before the pin)}"
echo "  Also wrote : manifest.json (to sign)"
if [ "$NOT_RELEASE" = 1 ]; then
    echo ""
    echo "  NOT FOR A RELEASE: $NOT_RELEASE_WHY."
fi
echo ""
echo "  On the Mac, copy both files over, then sign and add the signature:"
echo "    gpg --local-user A333EB826F70A79A736F09948EA7DD8CEDBA86C2 --armor --detach-sign manifest.json"
echo "    tar -rf $NAME manifest.json.asc"

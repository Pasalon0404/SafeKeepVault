#!/bin/bash
# =====================================================================
#  prepare-app.sh — build the web app from source into src/dist
# =====================================================================
#
#  For building SafeKeep OS from a fresh clone of the repo on a single
#  Linux machine. It compiles seed-xor-tool from source and puts the
#  result in usbbootdrive/src/dist, where build.sh and quick-update.sh
#  expect it. (The usual Mac → rsync workflow does not need this.)
#
#  It always rebuilds from source — it never reuses an existing
#  seed-xor-tool/dist.
#
#  Needs: git, Node.js 22+ and npm. Run WITHOUT sudo, from usbbootdrive/:
#     bash prepare-app.sh
#     sudo bash build.sh
# =====================================================================
set -euo pipefail

die() { echo ""; echo "ERROR: $*" >&2; exit 1; }

cd "$(dirname "$0")"
APP_DIR="../seed-xor-tool"

[ -f build.sh ] || die "run this from the usbbootdrive folder of a repo checkout."
[ -f "$APP_DIR/package.json" ] || die "$APP_DIR not found — this needs a full clone of the repo."
[ "$(id -u)" -ne 0 ] || die "run this without sudo (npm should not run as root)."
command -v node >/dev/null || die "Node.js is not installed (version 22 or newer)."
command -v npm >/dev/null || die "npm is not installed."

echo "Installing exact dependency versions from package-lock.json..."
(cd "$APP_DIR" && npm ci --no-audit --no-fund)

echo "Building the app from source..."
(cd "$APP_DIR" && rm -rf dist && npm run build)

[ -s "$APP_DIR/dist/boot.html" ] || die "build finished but dist/boot.html is missing."

rm -rf src/dist
mkdir -p src/dist
cp -r "$APP_DIR"/dist/* src/dist/

echo ""
echo "App ready in usbbootdrive/src/dist:"
node -e 'const f=require("./src/dist/manifest.json").files["boot.html"]; console.log("  boot.html sha256 " + f.sha256)' || true
echo ""
echo "Next: sudo bash build.sh"

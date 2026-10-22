#!/usr/bin/env python3
# =====================================================================
#  safekeep-passphrase.py — check or change the vault's Master Passphrase
# =====================================================================
#  Run as root by change-passphrase.sh (Device Options → Change Master
#  Passphrase; PASSPHRASE_STRENGTH_DESIGN.md, Part 3).
#
#  Usage (the passphrases on stdin, never on the command line):
#     printf '%s' "$P" | safekeep-passphrase.py verify /dev/loopN
#        exit 0: the passphrase opens the vault; 2: it doesn't
#     printf '%s\0%s' "$OLD" "$NEW" | safekeep-passphrase.py change /dev/loopN
#        exit 0: changed and checked; 2: the current passphrase is wrong;
#        1: anything else (the message is on stderr)
#
#  verify runs `cryptsetup open --test-passphrase`, which opens nothing.
#  change runs `cryptsetup luksChangeKey`, which replaces the key slot the
#  current passphrase opens with one for the new passphrase. The vault's
#  contents and its master key are not touched, so nothing is re-encrypted.
#  Afterwards the new passphrase must open the vault and the old one must
#  not. The passphrases reach cryptsetup through pipes (/dev/fd/N), so they
#  are never in a file or in the process list.
# =====================================================================
import os
import re
import subprocess
import sys

CRYPTSETUP = "cryptsetup"
MAX_BYTES = 4096
DEVICE_RE = re.compile(r"^/dev/loop[0-9]{1,4}$")


def fail(code, message):
    sys.stderr.write(message + "\n")
    sys.exit(code)


def device_ok(path):
    # Tests use a LUKS file instead of a loop device; root never gets this
    # variable through sudo, which resets the environment.
    if os.environ.get("SAFEKEEP_PASSPHRASE_TEST_FILE") == "1":
        return os.path.isfile(path)
    return bool(DEVICE_RE.match(path)) and os.path.exists(path)


def pipe_with(data):
    r, w = os.pipe()
    os.write(w, data)
    os.close(w)
    return r


def opens(device, passphrase):
    fd = pipe_with(passphrase)
    try:
        result = subprocess.run(
            [CRYPTSETUP, "open", "--test-passphrase", device, "--key-file", "/dev/fd/%d" % fd],
            pass_fds=(fd,), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    finally:
        os.close(fd)
    return result.returncode == 0


def change(device, old, new):
    old_fd, new_fd = pipe_with(old), pipe_with(new)
    try:
        result = subprocess.run(
            [CRYPTSETUP, "luksChangeKey", device, "--key-file", "/dev/fd/%d" % old_fd, "/dev/fd/%d" % new_fd],
            pass_fds=(old_fd, new_fd), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    finally:
        os.close(old_fd)
        os.close(new_fd)
    return result


def main(argv):
    if len(argv) != 3 or argv[1] not in ("verify", "change"):
        fail(1, "usage: safekeep-passphrase.py verify|change /dev/loopN  (passphrases on stdin)")
    action, device = argv[1], argv[2]
    if not device_ok(device):
        fail(1, "not a vault device: " + device)
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        fail(1, "passphrase too long")

    if action == "verify":
        if not data:
            fail(2, "empty passphrase")
        sys.exit(0 if opens(device, data) else 2)

    parts = data.split(b"\0")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        fail(1, "expected the current and the new passphrase, separated by a NUL")
    old, new = parts
    if old == new:
        fail(1, "the new passphrase is the same as the current one")
    if not opens(device, old):
        fail(2, "the current passphrase does not open the vault")
    result = change(device, old, new)
    if result.returncode != 0:
        fail(1, "cryptsetup luksChangeKey failed (exit %d): %s"
             % (result.returncode, result.stderr.decode("utf-8", "replace").strip()))
    if not opens(device, new):
        fail(1, "the new passphrase does not open the vault after the change")
    if opens(device, old):
        fail(1, "the old passphrase still opens the vault after the change")
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)

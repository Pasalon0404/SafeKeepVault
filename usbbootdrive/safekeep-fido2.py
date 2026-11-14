#!/usr/bin/env python3
# =====================================================================
#  safekeep-fido2.py — security keys (FIDO2) for the vault
# =====================================================================
#  SECURITY_KEY_DESIGN.md, Part 1. Run as root by unlock-vault.sh and
#  manage-security-key.sh. The only code that talks to a security key,
#  through Yubico's python-fido2 (Ubuntu's python3-fido2), over hidraw.
#
#  How a security key opens the vault
#    Each key that is added gets its own FIDO2 credential (non-resident:
#    nothing is stored on the key) and its own LUKS2 key slot. The slot's
#    key is the key's hmac-secret output for this vault's salt, made with
#    the PIN (user verification) and a touch (user presence), base64-
#    encoded. A LUKS2 token beside each slot holds, in plain sight, the
#    credential ID, the key's name and the date it was added; one more
#    token holds the vault's salt. Neither helps anyone open the vault.
#
#    Whether the vault has a passphrase is read from the key slots: a slot
#    with no security key token is the Master Passphrase's. So the choice
#    "How this vault unlocks" is never stored, only seen:
#      passphrase slot, no keys  → Master Passphrase
#      passphrase slot and keys  → Passphrase or security key
#      keys only                 → Security key only
#
#  Usage (secrets on stdin, separated by NUL bytes; never on the command
#  line, in a file, or in the log):
#     probe                      the key plugged in → JSON
#     set-pin                    stdin: PIN (only for a key with no PIN)
#     status   DEV               the vault's key slots → JSON
#     enroll   DEV               stdin: EXISTING \0 PIN \0 NAME → the slot
#     secret   DEV               stdin: PIN → "SLOT\nKEY\n" (slot key, base64)
#     open     DEV MAPPER        stdin: PIN → opens the vault as MAPPER
#     remove   DEV SLOT          stdin: EXISTING (opens another slot)
#     add-passphrase    DEV      stdin: EXISTING \0 NEW
#     remove-passphrase DEV      stdin: EXISTING (a security key's slot key)
#     rename   DEV SLOT          stdin: NAME
#  EXISTING is anything that opens one of the vault's key slots now: the
#  Master Passphrase, or a security key's slot key from "secret".
#
#  Exit codes
#     0 done                       13 wrong PIN (stderr: "retries=N")
#     1 anything else (stderr)     14 the PIN is blocked for good
#     2 EXISTING doesn't open it   15 too many wrong PINs: unplug and replug
#    10 no security key plugged in 16 not touched in time, or refused
#    11 more than one plugged in   17 not one of this vault's keys
#    12 not FIDO2 with hmac-secret 18 the key has no PIN yet
#    19 PIN too short or refused   20 already 4 keys
#    21 would leave no way in      22 this key is already added
#
#  Every change first copies the LUKS header to RAM and puts it back if
#  anything fails, adds and tests new key slots before removing old ones,
#  and never removes the last way in (cryptsetup itself also refuses to
#  remove a slot with the key from that same slot).
# =====================================================================
import base64
import datetime
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile

CRYPTSETUP = "cryptsetup"
RP_ID = "vault.safekeep"
RP_NAME = "SafeKeep Vault"
KEY_TOKEN = "safekeep-fido2"
VAULT_TOKEN = "safekeep-vault"
MAX_KEYS = 4
MAX_INPUT = 8192
MAX_NAME = 40
MIN_PIN = 6
DEVICE_RE = re.compile(r"^/dev/loop[0-9]{1,4}$")
MAPPER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,30}$")


class Fail(Exception):
    def __init__(self, code, message, retries=None):
        super().__init__(message)
        self.code = code
        self.retries = retries


def testing():
    # Tests use a LUKS file instead of a loop device (and a software
    # security key, usbbootdrive/tests/virtual_fido2.py, which is never in
    # the image). Root never gets this variable through sudo, which resets
    # the environment.
    return os.environ.get("SAFEKEEP_FIDO2_TEST") == "1"


# ---------------------------------------------------------------------
#  The security key
# ---------------------------------------------------------------------
class RealKey:
    """A FIDO2 key over hidraw, through python-fido2."""

    def __init__(self):
        from fido2.hid import CtapHidDevice
        from fido2.ctap import CtapError
        from fido2.ctap2 import Ctap2
        from fido2.ctap2.pin import ClientPin
        from fido2.ctap2.extensions import HmacSecretExtension
        self.CtapError, self.Ctap2, self.ClientPin = CtapError, Ctap2, ClientPin
        self.Hmac = HmacSecretExtension
        devices = list(CtapHidDevice.list_devices())
        if not devices:
            raise Fail(10, "no security key is plugged in")
        if len(devices) > 1:
            raise Fail(11, "more than one security key is plugged in")
        self.device = devices[0]
        try:
            self.ctap = Ctap2(self.device)
        except Exception:
            raise Fail(12, "this key isn't a FIDO2 security key")
        self.info = self.ctap.info

    def _error(self, e, client_pin=None):
        E = self.CtapError.ERR
        code = getattr(e, "code", None)
        if code == E.PIN_INVALID:
            retries = None
            try:
                retries = (client_pin or self.ClientPin(self.ctap)).get_pin_retries()[0]
            except Exception:
                pass
            return Fail(13, "wrong PIN", retries)
        if code == E.PIN_BLOCKED:
            return Fail(14, "the PIN is blocked")
        if code == E.PIN_AUTH_BLOCKED:
            return Fail(15, "too many wrong PINs in a row: unplug the key and plug it back in")
        if code == E.NO_CREDENTIALS:
            return Fail(17, "this security key isn't one of this vault's keys")
        if code in (E.USER_ACTION_TIMEOUT, E.ACTION_TIMEOUT, E.OPERATION_DENIED, E.KEEPALIVE_CANCEL):
            return Fail(16, "the key wasn't touched in time")
        if code == E.PIN_NOT_SET:
            return Fail(18, "the key has no PIN yet")
        if code == E.PIN_POLICY_VIOLATION:
            return Fail(19, "the key refused that PIN")
        if code == E.CREDENTIAL_EXCLUDED:
            return Fail(22, "this security key is already added")
        return Fail(1, "security key error: %r" % (e,))

    def probe(self):
        options = self.info.options or {}
        pin = "set" if options.get("clientPin") is True else ("unset" if "clientPin" in options else "none")
        retries = None
        if pin == "set":
            try:
                retries = self.ClientPin(self.ctap).get_pin_retries()[0]
            except Exception:
                retries = None
        return {
            "hmac": "hmac-secret" in (self.info.extensions or []),
            "pin": pin,
            "retries": retries,
            "min_pin": max(MIN_PIN, int(getattr(self.info, "min_pin_length", 4) or 4)),
            "product": (getattr(self.device, "product_name", None) or "")[:60],
        }

    def set_pin(self, pin):
        try:
            self.ClientPin(self.ctap).set_pin(pin)
        except self.CtapError as e:
            raise self._error(e)

    def _token(self, pin, permissions):
        client_pin = self.ClientPin(self.ctap)
        try:
            token = client_pin.get_pin_token(pin, permissions, RP_ID)
        except self.CtapError as e:
            raise self._error(e, client_pin)
        return client_pin, token

    def make_credential(self, pin, exclude):
        P = self.ClientPin.PERMISSION
        client_pin, token = self._token(pin, P.MAKE_CREDENTIAL)
        cdh = hashlib.sha256(secrets.token_bytes(32)).digest()
        try:
            att = self.ctap.make_credential(
                cdh,
                {"id": RP_ID, "name": RP_NAME},
                {"id": secrets.token_bytes(16), "name": RP_NAME, "displayName": RP_NAME},
                [{"type": "public-key", "alg": -7}, {"type": "public-key", "alg": -8}],
                exclude_list=[{"type": "public-key", "id": c} for c in exclude] or None,
                extensions={"hmac-secret": True},
                options={"rk": False},
                pin_uv_param=client_pin.protocol.authenticate(token, cdh),
                pin_uv_protocol=client_pin.protocol.VERSION,
            )
        except self.CtapError as e:
            raise self._error(e, client_pin)
        if not (att.auth_data.extensions or {}).get("hmac-secret"):
            raise Fail(12, "the key made a credential without hmac-secret")
        return bytes(att.auth_data.credential_data.credential_id)

    def hmac_secret(self, pin, credentials, salt):
        P = self.ClientPin.PERMISSION
        client_pin, token = self._token(pin, P.GET_ASSERTION)
        ext = self.Hmac(self.ctap, client_pin.protocol)
        try:
            ext_in = ext.process_get_input({"hmacGetSecret": {"salt1": salt}})
            if not ext_in:
                raise Fail(12, "this key doesn't have hmac-secret")
            cdh = hashlib.sha256(secrets.token_bytes(32)).digest()
            resp = self.ctap.get_assertion(
                RP_ID, cdh,
                allow_list=[{"type": "public-key", "id": c} for c in credentials],
                extensions={"hmac-secret": ext_in},
                options={"up": True},
                pin_uv_param=client_pin.protocol.authenticate(token, cdh),
                pin_uv_protocol=client_pin.protocol.VERSION,
            )
            output = ext.process_get_output(resp)["hmacGetSecret"]["output1"]
        except self.CtapError as e:
            raise self._error(e, client_pin)
        cred = resp.credential["id"] if resp.credential else (credentials[0] if len(credentials) == 1 else None)
        if cred is None:
            raise Fail(1, "the key didn't say which credential it used")
        return bytes(cred), bytes(output)


def security_key():
    try:
        return RealKey()
    except Fail:
        raise
    except ImportError:
        raise Fail(1, "the security key library (python3-fido2) is missing")
    except Exception as e:
        raise Fail(1, "couldn't reach the security key: %r" % (e,))


# ---------------------------------------------------------------------
#  The vault's LUKS2 header
# ---------------------------------------------------------------------
def device_ok(path):
    if testing():
        return os.path.isfile(path)
    return bool(DEVICE_RE.match(path)) and os.path.exists(path)


def pipe_with(data):
    r, w = os.pipe()
    os.write(w, data)
    os.close(w)
    return r


def run(args, data=None, fds=()):
    return subprocess.run([CRYPTSETUP] + args, input=data, pass_fds=fds,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def fast_args():
    # Tests only: a cheap key derivation, so a run takes seconds, not minutes.
    if testing() and os.environ.get("SAFEKEEP_FIDO2_FAST") == "1":
        return ["--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000"]
    return []


def metadata(device):
    r = run(["luksDump", "--dump-json-metadata", device])
    if r.returncode != 0:
        raise Fail(1, "couldn't read the vault header: " + r.stderr.decode("utf-8", "replace").strip())
    return json.loads(r.stdout)


def vault_state(device):
    meta = metadata(device)
    slots = sorted(int(s) for s in meta.get("keyslots", {}))
    keys, salt, salt_token = [], None, None
    for tid, tok in sorted(meta.get("tokens", {}).items(), key=lambda t: int(t[0])):
        if tok.get("type") == KEY_TOKEN and len(tok.get("keyslots", [])) == 1:
            slot = int(tok["keyslots"][0])
            if slot in slots:
                keys.append({"token": int(tid), "slot": slot, "credential": tok.get("credential", ""),
                             "name": tok.get("name", ""), "added": tok.get("added", "")})
        elif tok.get("type") == VAULT_TOKEN and salt is None:
            salt, salt_token = tok.get("salt"), int(tid)
    key_slots = {k["slot"] for k in keys}
    return {"slots": slots, "keys": keys, "salt": salt, "salt_token": salt_token,
            "passphrase_slots": [s for s in slots if s not in key_slots]}


def opens(device, secret, slot=None):
    fd = pipe_with(secret)
    try:
        args = ["open", "--test-passphrase", device, "--key-file", "/dev/fd/%d" % fd]
        if slot is not None:
            args += ["--key-slot", str(slot)]
        r = run(args, fds=(fd,))
    finally:
        os.close(fd)
    return r.returncode == 0


def import_token(device, token, token_id=None):
    args = ["token", "import", device, "--json-file", "-"]
    if token_id is not None:
        args += ["--token-id", str(token_id), "--token-replace"]
    r = run(args, data=json.dumps(token).encode())
    if r.returncode != 0:
        raise Fail(1, "couldn't write the vault header: " + r.stderr.decode("utf-8", "replace").strip())


def remove_token(device, token_id):
    r = run(["token", "remove", "--token-id", str(token_id), device])
    if r.returncode != 0:
        raise Fail(1, "couldn't update the vault header: " + r.stderr.decode("utf-8", "replace").strip())


def add_slot(device, existing, new):
    before = set(vault_state(device)["slots"])
    a, b = pipe_with(existing), pipe_with(new)
    try:
        r = run(["luksAddKey", device, "--key-file", "/dev/fd/%d" % a, "/dev/fd/%d" % b] + fast_args(), fds=(a, b))
    finally:
        os.close(a)
        os.close(b)
    if r.returncode != 0:
        raise Fail(1, "couldn't add a key slot: " + r.stderr.decode("utf-8", "replace").strip())
    added = set(vault_state(device)["slots"]) - before
    if len(added) != 1:
        raise Fail(1, "couldn't tell which key slot was added")
    slot = added.pop()
    if not opens(device, new, slot):
        raise Fail(1, "the new key slot doesn't open the vault")
    return slot


def kill_slot(device, slot, existing):
    fd = pipe_with(existing)
    try:
        r = run(["luksKillSlot", "-q", device, str(slot), "--key-file", "/dev/fd/%d" % fd], fds=(fd,))
    finally:
        os.close(fd)
    if r.returncode != 0:
        raise Fail(1, "couldn't remove key slot %d: %s" % (slot, r.stderr.decode("utf-8", "replace").strip()))


class HeaderBackup:
    """Copy the LUKS header to RAM; put it back if the change fails."""

    def __init__(self, device):
        self.device = device

    def __enter__(self):
        fd, self.path = tempfile.mkstemp(prefix="safekeep-header-", dir="/dev/shm" if os.path.isdir("/dev/shm") else None)
        os.close(fd)
        os.unlink(self.path)
        r = run(["luksHeaderBackup", self.device, "--header-backup-file", self.path])
        if r.returncode != 0:
            raise Fail(1, "couldn't copy the vault header before the change")
        return self

    def __exit__(self, kind, value, tb):
        try:
            if kind is not None:
                r = run(["luksHeaderRestore", "-q", self.device, "--header-backup-file", self.path])
                if r.returncode != 0:
                    sys.stderr.write("the vault header couldn't be put back after a failed change\n")
        finally:
            try:
                os.unlink(self.path)
            except OSError:
                pass
        return False


def b64(data):
    return base64.b64encode(data).decode()


def slot_key(output):
    return b64(output).encode()


def clean_name(raw, fallback):
    name = "".join(ch for ch in raw if ch.isprintable()).strip()[:MAX_NAME]
    return name or fallback


def read_fields(count):
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        raise Fail(1, "input too long")
    parts = data.split(b"\0") if count > 1 else [data]
    if len(parts) != count:
        raise Fail(1, "expected %d values separated by NUL bytes" % count)
    return parts


def text(b):
    return b.decode("utf-8", "strict")


# ---------------------------------------------------------------------
#  Actions
# ---------------------------------------------------------------------
def do_probe():
    key = security_key()
    print(json.dumps(key.probe()))


def do_set_pin():
    (pin,) = read_fields(1)
    pin = text(pin)
    key = security_key()
    if key.probe()["pin"] == "set":
        raise Fail(1, "this key already has a PIN")
    if len(pin) < MIN_PIN:
        raise Fail(19, "the PIN must be at least %d characters" % MIN_PIN)
    key.set_pin(pin)


def do_status(device):
    st = vault_state(device)
    print(json.dumps({"passphrase": bool(st["passphrase_slots"]),
                      "keys": [{"slot": k["slot"], "name": k["name"], "added": k["added"]} for k in st["keys"]]}))


def do_enroll(device):
    existing, pin, name = read_fields(3)
    pin = text(pin)
    st = vault_state(device)
    if len(st["keys"]) >= MAX_KEYS:
        raise Fail(20, "this vault already has %d security keys" % MAX_KEYS)
    if not existing or not opens(device, existing):
        raise Fail(2, "that doesn't open the vault")
    key = security_key()
    info = key.probe()
    if not info["hmac"]:
        raise Fail(12, "this key doesn't have hmac-secret")
    if info["pin"] != "set":
        raise Fail(18, "the key has no PIN yet")
    exclude = [base64.b64decode(k["credential"]) for k in st["keys"] if k["credential"]]
    credential = key.make_credential(pin, exclude)                      # touch 1
    salt = base64.b64decode(st["salt"]) if st["salt"] else secrets.token_bytes(32)
    _, output = key.hmac_secret(pin, [credential], salt)                # touch 2
    with HeaderBackup(device):
        if not st["salt"]:
            import_token(device, {"type": VAULT_TOKEN, "keyslots": [], "salt": b64(salt)})
        slot = add_slot(device, existing, slot_key(output))
        import_token(device, {"type": KEY_TOKEN, "keyslots": [str(slot)], "credential": b64(credential),
                              "name": clean_name(text(name), "Security key %d" % (len(st["keys"]) + 1)),
                              "added": datetime.date.today().isoformat()})
        if not any(k["slot"] == slot for k in vault_state(device)["keys"]):
            raise Fail(1, "the new key's record wasn't saved")
    print(slot)


def key_secret(device, pin):
    st = vault_state(device)
    if not st["keys"] or not st["salt"]:
        raise Fail(17, "this vault has no security keys")
    by_cred = {base64.b64decode(k["credential"]): k for k in st["keys"] if k["credential"]}
    key = security_key()
    credential, output = key.hmac_secret(pin, list(by_cred), base64.b64decode(st["salt"]))
    k = by_cred.get(credential)
    if k is None:
        raise Fail(17, "this security key isn't one of this vault's keys")
    secret = slot_key(output)
    if not opens(device, secret, k["slot"]):
        raise Fail(17, "this security key doesn't open its key slot")
    return k["slot"], secret


def do_secret(device):
    (pin,) = read_fields(1)
    slot, secret = key_secret(device, text(pin))
    sys.stdout.write("%d\n%s\n" % (slot, secret.decode()))


def do_open(device, mapper):
    if not MAPPER_RE.match(mapper):
        raise Fail(1, "bad mapper name")
    (pin,) = read_fields(1)
    slot, secret = key_secret(device, text(pin))
    fd = pipe_with(secret)
    try:
        r = run(["open", device, mapper, "--key-slot", str(slot), "--key-file", "/dev/fd/%d" % fd], fds=(fd,))
    finally:
        os.close(fd)
    if r.returncode != 0:
        raise Fail(1, "cryptsetup open failed: " + r.stderr.decode("utf-8", "replace").strip())


def do_remove(device, slot):
    (existing,) = read_fields(1)
    st = vault_state(device)
    k = next((k for k in st["keys"] if k["slot"] == slot), None)
    if k is None:
        raise Fail(1, "no security key in slot %d" % slot)
    if len(st["slots"]) <= 1:
        raise Fail(21, "that would leave no way to open the vault")
    if not existing or not opens(device, existing):
        raise Fail(2, "that doesn't open the vault")
    if opens(device, existing, slot):
        raise Fail(21, "unlock with something other than the key being removed")
    with HeaderBackup(device):
        kill_slot(device, slot, existing)
        remove_token(device, k["token"])
        if not opens(device, existing):
            raise Fail(1, "the vault no longer opened after the change")


def do_add_passphrase(device):
    existing, new = read_fields(2)
    st = vault_state(device)
    if st["passphrase_slots"]:
        raise Fail(1, "this vault already has a Master Passphrase")
    if not new:
        raise Fail(1, "empty passphrase")
    if not existing or not opens(device, existing):
        raise Fail(2, "that doesn't open the vault")
    with HeaderBackup(device):
        add_slot(device, existing, new)
        if not vault_state(device)["passphrase_slots"]:
            raise Fail(1, "the passphrase slot wasn't added")


def do_remove_passphrase(device):
    (existing,) = read_fields(1)
    st = vault_state(device)
    if not st["passphrase_slots"]:
        raise Fail(1, "this vault has no Master Passphrase")
    if not st["keys"]:
        raise Fail(21, "add a security key first")
    if not existing or not any(opens(device, existing, k["slot"]) for k in st["keys"]):
        raise Fail(2, "unlock with a security key to remove the passphrase")
    with HeaderBackup(device):
        for slot in st["passphrase_slots"]:
            kill_slot(device, slot, existing)
        after = vault_state(device)
        if after["passphrase_slots"] or not after["keys"] or not opens(device, existing):
            raise Fail(1, "the change didn't leave the vault as expected")


def do_rename(device, slot):
    (name,) = read_fields(1)
    st = vault_state(device)
    k = next((k for k in st["keys"] if k["slot"] == slot), None)
    if k is None:
        raise Fail(1, "no security key in slot %d" % slot)
    meta = metadata(device)["tokens"][str(k["token"])]
    meta["name"] = clean_name(text(name), k["name"] or "Security key")
    import_token(device, meta, k["token"])


def main(argv):
    action = argv[1] if len(argv) > 1 else ""
    try:
        if action == "probe" and len(argv) == 2:
            return do_probe()
        if action == "set-pin" and len(argv) == 2:
            return do_set_pin()
        if len(argv) < 3 or not device_ok(argv[2]):
            raise Fail(1, "usage: see the top of safekeep-fido2.py (and a vault device)")
        device = argv[2]
        if action == "status" and len(argv) == 3:
            return do_status(device)
        if action == "enroll" and len(argv) == 3:
            return do_enroll(device)
        if action == "secret" and len(argv) == 3:
            return do_secret(device)
        if action == "open" and len(argv) == 4:
            return do_open(device, argv[3])
        if action in ("remove", "rename") and len(argv) == 4 and argv[3].isdigit():
            return (do_remove if action == "remove" else do_rename)(device, int(argv[3]))
        if action == "add-passphrase" and len(argv) == 3:
            return do_add_passphrase(device)
        if action == "remove-passphrase" and len(argv) == 3:
            return do_remove_passphrase(device)
        raise Fail(1, "unknown action")
    except Fail as e:
        sys.stderr.write(str(e) + "\n")
        if e.retries is not None:
            sys.stderr.write("retries=%d\n" % e.retries)
        sys.exit(e.code)
    except UnicodeDecodeError:
        sys.stderr.write("not valid text\n")
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv)

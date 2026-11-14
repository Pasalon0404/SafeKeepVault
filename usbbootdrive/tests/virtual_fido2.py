"""
A software FIDO2 security key, for testing safekeep-fido2.py's real-key
code (RealKey) without hardware. Test-only: never installed in the image.

It answers CTAP2 commands over the same interface as python-fido2's
CtapHidDevice (call(CTAPHID.CBOR, ...)), so python-fido2's own Ctap2,
ClientPin and HmacSecretExtension code runs unchanged against it:
getInfo, clientPin (retries, key agreement, set PIN, PIN token with and
without permissions), makeCredential and getAssertion with hmac-secret,
using PIN/UV protocol 2 (a CTAP 2.1 key) or 1 (a CTAP 2.0 key).

State that a real key keeps across plugging in (its secret, PIN, retry
count) lives in a JSON file, so each helper run sees the same key.
"""
import hashlib
import hmac
import json
import os
import struct

from cryptography.hazmat.primitives.asymmetric import ec
from fido2 import cbor
from fido2.ctap2.pin import PinProtocolV1, PinProtocolV2
from fido2.hid import CTAPHID, CAPABILITY
from fido2.utils import int2bytes, bytes2int

OK = 0x00
INVALID_PARAMETER = 0x02
CREDENTIAL_EXCLUDED = 0x19
UNSUPPORTED_ALGORITHM = 0x26
NO_CREDENTIALS = 0x2E
USER_ACTION_TIMEOUT = 0x2F
NOT_ALLOWED = 0x30
PIN_INVALID = 0x31
PIN_BLOCKED = 0x32
PIN_AUTH_INVALID = 0x33
PIN_AUTH_BLOCKED = 0x34
PIN_NOT_SET = 0x35
PIN_REQUIRED = 0x36
PIN_POLICY_VIOLATION = 0x37
INVALID_COMMAND = 0x01

AAGUID = bytes.fromhex("5afe6b0a5afe6b0a5afe6b0a5afe6b0a")


class CtapStatus(Exception):
    def __init__(self, code):
        self.code = code


def cose_public(sk):
    pn = sk.public_key().public_numbers()
    return {1: 2, 3: -25, -1: 1, -2: int2bytes(pn.x, 32), -3: int2bytes(pn.y, 32)}


class VirtualKey:
    def __init__(self, state_path):
        self.path = state_path
        with open(state_path) as f:
            self.s = json.load(f)
        self.s.setdefault("secret", os.urandom(32).hex())
        self.s.setdefault("retries", 8)
        self.s.setdefault("row", 0)
        self.s.setdefault("touches", 0)
        self._save()
        self.ctap21 = self.s.get("ctap21", True)
        self.proto = PinProtocolV2() if self.ctap21 else PinProtocolV1()
        self.agreement = ec.generate_private_key(ec.SECP256R1())
        self.token = None
        self.product_name = self.s.get("product", "Virtual FIDO2 Key")

    # --- python-fido2 device interface ---
    @property
    def capabilities(self):
        return CAPABILITY.CBOR | CAPABILITY.WINK

    def call(self, cmd, data=b"", event=None, on_keepalive=None):
        if cmd != CTAPHID.CBOR:
            raise ValueError("only CBOR is supported")
        command, body = data[0], data[1:]
        args = cbor.decode(body) if body else {}
        try:
            result = {
                0x04: self.get_info, 0x06: self.client_pin,
                0x01: self.make_credential, 0x02: self.get_assertion,
            }[command](args)
        except KeyError:
            return bytes([INVALID_COMMAND])
        except CtapStatus as e:
            return bytes([e.code])
        return bytes([OK]) + (cbor.encode(result) if result is not None else b"")

    def close(self):
        pass

    # --- helpers ---
    def _save(self):
        with open(self.path, "w") as f:
            json.dump(self.s, f)

    def _secret(self):
        return bytes.fromhex(self.s["secret"])

    def _shared(self, peer):
        x, y = bytes2int(peer[-2]), bytes2int(peer[-3])
        pk = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()
        return self.proto.kdf(self.agreement.exchange(ec.ECDH(), pk))

    def _touch(self):
        if not self.s.get("touch", True):
            raise CtapStatus(USER_ACTION_TIMEOUT)
        self.s["touches"] += 1
        self._save()

    def _check_token(self, cdh, param, protocol):
        if param is None:
            raise CtapStatus(PIN_REQUIRED)
        if protocol != self.proto.VERSION or self.token is None:
            raise CtapStatus(PIN_AUTH_INVALID)
        if not hmac.compare_digest(self.proto.authenticate(self.token, cdh), param):
            raise CtapStatus(PIN_AUTH_INVALID)

    def _cred_id(self, rp_id, nonce):
        tag = hmac.new(self._secret(), b"cred" + hashlib.sha256(rp_id.encode()).digest() + nonce, hashlib.sha256).digest()
        return nonce + tag

    def _owns(self, rp_id, cred_id):
        return len(cred_id) == 48 and hmac.compare_digest(self._cred_id(rp_id, cred_id[:16]), cred_id)

    # --- CTAP2 commands ---
    def get_info(self, args):
        options = {"rk": True, "up": True, "plat": False}
        if self.s.get("pin_supported", True):
            options["clientPin"] = bool(self.s.get("pin"))
        if self.ctap21:
            options["pinUvAuthToken"] = True
        info = {
            1: ["FIDO_2_0", "FIDO_2_1"] if self.ctap21 else ["U2F_V2", "FIDO_2_0"],
            2: ["hmac-secret"] if self.s.get("hmac", True) else ["credProtect"],
            3: AAGUID,
            4: options,
            6: [self.proto.VERSION],
        }
        return info

    def client_pin(self, a):
        sub = a.get(2)
        if a.get(1) is not None and a[1] != self.proto.VERSION:
            raise CtapStatus(INVALID_PARAMETER)
        if sub == 0x01:
            return {3: self.s["retries"]}
        if sub == 0x02:
            return {1: cose_public(self.agreement)}
        if sub == 0x03:   # set PIN
            if self.s.get("pin"):
                raise CtapStatus(NOT_ALLOWED)
            shared = self._shared(a[3])
            if not hmac.compare_digest(self.proto.authenticate(shared, a[5]), a[4]):
                raise CtapStatus(PIN_AUTH_INVALID)
            pin = self.proto.decrypt(shared, a[5]).rstrip(b"\0").decode()
            if len(pin) < 4:
                raise CtapStatus(PIN_POLICY_VIOLATION)
            self.s.update(pin=pin, retries=8, row=0)
            self._save()
            return None
        if sub in (0x05, 0x09):   # PIN token (legacy, or with permissions)
            if sub == 0x09 and not self.ctap21:
                raise CtapStatus(INVALID_PARAMETER)
            if not self.s.get("pin"):
                raise CtapStatus(PIN_NOT_SET)
            if self.s["retries"] <= 0:
                raise CtapStatus(PIN_BLOCKED)
            if self.s["row"] >= 3:
                raise CtapStatus(PIN_AUTH_BLOCKED)
            shared = self._shared(a[3])
            pin_hash = self.proto.decrypt(shared, a[6])[:16]
            if not hmac.compare_digest(pin_hash, hashlib.sha256(self.s["pin"].encode()).digest()[:16]):
                self.s["retries"] -= 1
                self.s["row"] += 1
                self._save()
                self.agreement = ec.generate_private_key(ec.SECP256R1())
                if self.s["retries"] <= 0:
                    raise CtapStatus(PIN_BLOCKED)
                if self.s["row"] >= 3:
                    raise CtapStatus(PIN_AUTH_BLOCKED)
                raise CtapStatus(PIN_INVALID)
            self.s.update(retries=8, row=0)
            self._save()
            self.token = os.urandom(32)
            return {2: self.proto.encrypt(shared, self.token)}
        raise CtapStatus(INVALID_PARAMETER)

    def _auth_data(self, rp_id, flags, attested=b"", extensions=None):
        out = hashlib.sha256(rp_id.encode()).digest() + bytes([flags]) + struct.pack(">I", 1) + attested
        if extensions:
            out += cbor.encode(extensions)
        return out

    def make_credential(self, a):
        cdh, rp, params = a[1], a[2], a[4]
        self._check_token(cdh, a.get(8), a.get(9))
        if not any(p.get("alg") == -7 for p in params):
            raise CtapStatus(UNSUPPORTED_ALGORITHM)
        for c in a.get(5) or []:
            if self._owns(rp["id"], c["id"]):
                self._touch()
                raise CtapStatus(CREDENTIAL_EXCLUDED)
        self._touch()
        cred = self._cred_id(rp["id"], os.urandom(16))
        sk = ec.generate_private_key(ec.SECP256R1())
        pub = cose_public(sk)
        pub[3] = -7
        attested = AAGUID + struct.pack(">H", len(cred)) + cred + cbor.encode(pub)
        ext = None
        if (a.get(6) or {}).get("hmac-secret") and self.s.get("hmac", True):
            ext = {"hmac-secret": True}
        flags = 0x01 | 0x04 | 0x40 | (0x80 if ext else 0)
        return {1: "none", 2: self._auth_data(rp["id"], flags, attested, ext), 3: {}}

    def get_assertion(self, a):
        rp_id, cdh = a[1], a[2]
        self._check_token(cdh, a.get(6), a.get(7))
        cred = next((c["id"] for c in a.get(3) or [] if self._owns(rp_id, c["id"])), None)
        if cred is None:
            raise CtapStatus(NO_CREDENTIALS)
        self._touch()
        ext = None
        req = (a.get(4) or {}).get("hmac-secret")
        if req and self.s.get("hmac", True):
            shared = self._shared(req[1])
            if not hmac.compare_digest(self.proto.authenticate(shared, req[2]), req[3]):
                raise CtapStatus(INVALID_PARAMETER)
            salts = self.proto.decrypt(shared, req[2])
            cred_random = hmac.new(self._secret(), b"uv" + cred, hashlib.sha256).digest()
            out = b"".join(hmac.new(cred_random, salts[i:i + 32], hashlib.sha256).digest()
                           for i in range(0, len(salts), 32))
            ext = {"hmac-secret": self.proto.encrypt(shared, out)}
        flags = 0x01 | 0x04 | (0x80 if ext else 0)
        return {1: {"type": "public-key", "id": cred}, 2: self._auth_data(rp_id, flags, extensions=ext),
                3: os.urandom(70)}


def install(state_path):
    """Make python-fido2's CtapHidDevice.list_devices() find the virtual key
    (or none, or two, as the state file says)."""
    import fido2.hid

    with open(state_path) as f:
        count = json.load(f).get("count", 1)

    def list_devices(cls=None):
        return [VirtualKey(state_path) for _ in range(count)]

    fido2.hid.CtapHidDevice.list_devices = classmethod(lambda cls: list_devices())

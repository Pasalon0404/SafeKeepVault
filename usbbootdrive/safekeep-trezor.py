#!/usr/bin/env python3
"""
safekeep-trezor — talk to a paired Trezor One over USB for the SafeKeep app.

    safekeep-trezor.py REQUEST.json RESULT.json

Run by the Trezor Watcher in safekeep-boot.sh, using the pinned HWI install
in /opt/safekeep-hwi (see config/hwi-requirements.txt). Sibling of
safekeep-coldcard.py: same request/result files, same safety rules.

ROLE
  The Trezor One holds the "person" key — the same key as SafeKeep's vault
  seed. It is an alternative signer for that key (e.g. a seedless temporary
  session: Trezor + Coldcard), never a second signature from the same key.

SECURITY MODEL
  * The request file is UNTRUSTED DATA written by the browser. It is read
    once, deleted immediately, size-limited and validated field by field.
    Nothing in it is ever run as a command.
  * Only these actions exist:
      detect     -> report the single connected Trezor One: USB path, locked?,
                    and (when unlocked) fingerprint + identity xpub (m/0h).
      prompt_pin -> ask the Trezor (by USB path) to show its scrambled PIN
                    grid. Nothing secret is involved.
      send_pin   -> send PIN grid POSITIONS (digits 1-9, keypad layout) to
                    the Trezor at that USB path. The positions mean nothing
                    without the shuffle shown only on the Trezor's screen.
                    They are never logged or echoed. This step must NOT
                    re-scan the device the HWI way: a re-scan sends the
                    Trezor a reset, which cancels the PIN request.
      pair       -> check the connected Trezor is the one the user confirmed
                    (expected_xfp + expected_xpub) and SAVE the pairing.
      unpair     -> delete the saved pairing.
      sign       -> send a PSBT to the PAIRED Trezor and return the result.
  * The pairing is stored by THIS helper (path in SAFEKEEP_TZ_PAIRING: the
    vault's settings folder, or RAM in a temporary session). "sign" trusts
    only that stored pairing — never device identity sent by the browser.
  * "sign" refuses unless the Trezor's fingerprint AND identity xpub match
    the pairing. (Trezor has no Coldcard-style anti-MiTM check; the Trezor's
    own screen is the check.)
  * No network: HWI's open-by-path also probes for a Trezor *simulator* on
    UDP 127.0.0.1:21324. That probe is switched off here — only real USB
    devices are ever looked at. Nothing is broadcast or finalized.
  * The user must approve on the Trezor's own screen; declining is reported.
  * Every action runs under a time limit. A stuck USB call cannot be
    interrupted, so on timeout the result is written and the process exits.
  * The result is always written (ok or error) so the app never hangs.

Result JSON: {"ok": true/false, "status": "...", ...}
  ok statuses   : detected, pin_requested, unlocked, paired, unpaired, signed
  error statuses: bad_request, not_installed, not_paired, not_connected,
                  multiple_devices, unsupported_model, no_seed, locked,
                  wrong_pin, wrong_device, outdated_firmware, refused, busy,
                  timeout, rejected, error
  Every result echoes the request's "request_id" (if valid) so the app can
  ignore stale results.
"""
import base64
import binascii
import json
import os
import re
import sys
import threading
import time

# Trezor One: modern firmware talks WebUSB as 1209:53c1; very old firmware
# used HID as 534c:0001. 1209:53c0 (bootloader mode) is left out on purpose:
# a Trezor in bootloader mode cannot sign.
HID_IDS = {(0x534C, 0x0001)}
WEBUSB_IDS = {(0x1209, 0x53C1)}

MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_PSBT_BYTES = 2 * 1024 * 1024
SIGN_TIMEOUT_S = int(os.environ.get('SAFEKEEP_TZ_TIMEOUT', '600'))
SHORT_TIMEOUT_S = int(os.environ.get('SAFEKEEP_TZ_SHORT_TIMEOUT', '60'))
PSBT_MAGIC = b'psbt\xff'
XFP_RE = re.compile(r'^[0-9a-f]{8}$')
XPUB_RE = re.compile(r'^[xt]pub[1-9A-HJ-NP-Za-km-z]{100,112}$')
PATH_RE = re.compile(r'^(webusb|hid):[A-Za-z0-9:._/-]{1,128}$')
PIN_POS_RE = re.compile(r'^[1-9]{1,9}$')
REQUEST_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
DEFAULT_PAIRING = '/media/.safekeep-vault/settings/trezor-pairing.json'
IDENTITY_PATH = 'm/0h'   # the same key HWI reads to get the fingerprint

MSG_NOT_CONNECTED = ('No Trezor found. Plug it in and try again. If it is plugged in, '
                     'unplug it and plug it back in.')
MSG_GONE = ('The Trezor is no longer at the same USB connection (it may have been '
            'unplugged). Start the PIN entry again.')
MSG_LOCKED = 'The Trezor is locked. Unlock it with your PIN first.'


class Fail(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def write_result(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def load_request(path):
    try:
        with open(path, 'rb') as f:
            raw = f.read(MAX_REQUEST_BYTES + 1)
    except OSError:
        raise Fail('bad_request', 'Could not read the Trezor request.')
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    if len(raw) > MAX_REQUEST_BYTES:
        raise Fail('bad_request', 'Trezor request is too large.')
    try:
        data = json.loads(raw.decode('utf-8'))
    except Exception:
        raise Fail('bad_request', 'Trezor request is not valid JSON.')
    if not isinstance(data, dict):
        raise Fail('bad_request', 'Trezor request has the wrong format.')
    return data


# ---------------------------------------------------------------- fields

def field_xfp(data):
    v = data.get('expected_xfp')
    if not isinstance(v, str) or not XFP_RE.match(v.lower()):
        raise Fail('bad_request', 'Request is missing the Trezor fingerprint to confirm.')
    return v.lower()


def field_xpub(data):
    v = data.get('expected_xpub')
    if not isinstance(v, str) or not XPUB_RE.match(v):
        raise Fail('bad_request', 'Request is missing the Trezor key to confirm.')
    return v


def field_path(data):
    v = data.get('path')
    if not isinstance(v, str) or not PATH_RE.match(v):
        raise Fail('bad_request', 'Request is missing the Trezor USB connection.')
    return v


def field_pin_positions(data):
    v = data.get('pin_positions')
    if not isinstance(v, str) or not PIN_POS_RE.match(v):
        # Deliberately does not repeat what was sent.
        raise Fail('bad_request', 'The PIN entry was not valid. Click 1 to 9 squares, then Enter.')
    return v


def field_psbt(data):
    v = data.get('psbt_b64')
    if not isinstance(v, str) or not v:
        raise Fail('bad_request', 'Request has no transaction.')
    if len(v) > (MAX_PSBT_BYTES * 4) // 3 + 4:
        raise Fail('bad_request', 'Transaction is too large.')
    try:
        psbt = base64.b64decode(v, validate=True)
    except (binascii.Error, ValueError):
        raise Fail('bad_request', 'Transaction is not valid base64.')
    if not psbt.startswith(PSBT_MAGIC):
        raise Fail('bad_request', 'That is not a PSBT (partially signed Bitcoin transaction).')
    return base64.b64encode(psbt).decode('ascii')   # canonical form for HWI


# ---------------------------------------------------------------- pairing

def pairing_path():
    return os.environ.get('SAFEKEEP_TZ_PAIRING') or DEFAULT_PAIRING


def read_pairing():
    try:
        with open(pairing_path(), 'r') as f:
            p = json.load(f)
    except FileNotFoundError:
        return None
    except Exception:
        raise Fail('error', 'The saved Trezor pairing could not be read. Pair the Trezor again.')
    if (not isinstance(p, dict) or not isinstance(p.get('xfp'), str) or not XFP_RE.match(p['xfp'])
            or not isinstance(p.get('id_xpub'), str) or not XPUB_RE.match(p['id_xpub'])):
        raise Fail('error', 'The saved Trezor pairing is damaged. Pair the Trezor again.')
    return p


def write_pairing(info):
    path = pairing_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(info, f)
    os.replace(tmp, path)


# ---------------------------------------------------------------- HWI

class Hwi:
    """The parts of HWI this helper uses, loaded once and made USB-only."""

    def __init__(self):
        try:
            from hwilib import errors
            from hwilib.psbt import PSBT
            from hwilib.devices import trezor as tz
            from hwilib.devices.trezorlib import exceptions as tzexc
        except ImportError:
            raise Fail('not_installed', 'Trezor support is not installed on this SafeKeep build.')
        self.errors, self.PSBT, self.tz, self.tzexc = errors, PSBT, tz, tzexc

        # No network: never probe for the Trezor simulator over UDP, and make
        # HWI's open-by-path look only at real Trezor One USB devices.
        tz.udp.UdpTransport.enumerate = classmethod(lambda cls, *a, **k: [])
        hwi_errors = errors

        def usb_only_get_path_transport(path, hid_ids=None, webusb_ids=None, sim_path=None):
            for dev in self.usb_transports():
                if dev.get_path() == path:
                    return dev
            raise hwi_errors.BadArgumentError('Could not find device by path')
        tz.get_path_transport = usb_only_get_path_transport

    def usb_transports(self):
        # USB listing only: no message is sent to any device here.
        devs = list(self.tz.hid.HidTransport.enumerate(usb_ids=HID_IDS))
        devs.extend(self.tz.webusb.WebUsbTransport.enumerate(usb_ids=WEBUSB_IDS))
        return devs

    def usb_paths(self):
        paths = []
        for d in self.usb_transports():
            p = d.get_path()
            if p not in paths:
                paths.append(p)
        return paths

    def client(self, path):
        # password '' = the standard wallet (no passphrase); matches HWI's default.
        return self.tz.TrezorClient(path, password='')


def translate(hwi, e):
    """Turn an HWI / trezorlib exception into a plain-English Fail."""
    E = hwi.errors
    if isinstance(e, Fail):
        return e
    if isinstance(e, E.ActionCanceledError):
        return Fail('refused', 'You declined on the Trezor. Nothing was signed.')
    if isinstance(e, E.DeviceNotReadyError):
        return Fail('locked', MSG_LOCKED)
    if isinstance(e, E.DeviceBusyError):
        return Fail('busy', 'The Trezor is busy. Finish or cancel what is on its screen, then try again.')
    if isinstance(e, E.DeviceConnectionError):
        return Fail('not_connected', MSG_NOT_CONNECTED)
    if isinstance(e, E.NoPasswordError):
        return Fail('error', 'This Trezor asked for a passphrase, which SafeKeep does not support yet.')
    if isinstance(e, E.BadArgumentError) and 'find device by path' in str(e):
        return Fail('not_connected', MSG_GONE)
    if isinstance(e, hwi.tzexc.OutdatedFirmwareError):
        return Fail('outdated_firmware', 'The Trezor firmware is too old. Update it with Trezor Suite '
                                         'on another computer, then try again.')
    if isinstance(e, hwi.tzexc.TrezorFailure):
        return Fail('rejected', 'The Trezor refused: %s' % str(e)[:200])
    if isinstance(e, E.HWWError):
        return Fail('error', 'Trezor error: %s' % str(e)[:200])
    return Fail('error', 'Unexpected Trezor error (%s): %s' % (type(e).__name__, str(e)[:200]))


def single_path(hwi):
    paths = hwi.usb_paths()
    if not paths:
        raise Fail('not_connected', MSG_NOT_CONNECTED)
    if len(paths) > 1:
        raise Fail('multiple_devices', 'More than one Trezor is connected. Unplug all but one and try again.')
    return paths[0]


def check_trezor_one(client):
    """Read the Trezor's features (sends Initialize — never between the PIN steps)."""
    client._prepare_device()
    f = client.client.features
    if 'trezor' not in (f.vendor or '').lower():
        raise Fail('unsupported_model', 'The connected device is not a Trezor.')
    if f.model != '1':
        raise Fail('unsupported_model', 'Only the Trezor One is supported for now (this is a Trezor model %s).'
                   % re.sub(r'[^A-Za-z0-9]', '', str(f.model))[:8])
    if not f.initialized:
        raise Fail('no_seed', 'The Trezor has no seed set up.')
    return {
        'locked': bool(f.pin_protection and not f.unlocked),
        'passphrase_protection': bool(f.passphrase_protection),
        'firmware': '%d.%d.%d' % (f.major_version or 0, f.minor_version or 0, f.patch_version or 0),
    }


def identity(client):
    key = client.get_pubkey_at_path(IDENTITY_PATH)
    return binascii.hexlify(key.parent_fingerprint).decode('ascii'), key.to_string()


# ---------------------------------------------------------------- actions

def do_detect(hwi, data):
    path = single_path(hwi)
    client = hwi.client(path)
    try:
        info = check_trezor_one(client)
        result = dict({'ok': True, 'status': 'detected', 'path': path, 'model': 'trezor_1'}, **info)
        if not info['locked']:
            result['xfp'], result['id_xpub'] = identity(client)
        return result
    finally:
        client.close()


def do_prompt_pin(hwi, data):
    path = field_path(data)
    if path not in hwi.usb_paths():
        raise Fail('not_connected', MSG_GONE)
    client = hwi.client(path)
    try:
        info = check_trezor_one(client)
        if not info['locked']:
            return {'ok': True, 'status': 'unlocked', 'path': path}
        client.prompt_pin()
        return {'ok': True, 'status': 'pin_requested', 'path': path}
    except hwi.errors.DeviceAlreadyUnlockedError:
        return {'ok': True, 'status': 'unlocked', 'path': path}
    finally:
        client.close()


def do_send_pin(hwi, data):
    path = field_path(data)
    pin = field_pin_positions(data)
    # Open strictly by path. No HWI scan, no features refresh: either would
    # send the Trezor a reset and cancel the PIN request it is showing.
    client = hwi.client(path)
    try:
        accepted = client.send_pin(pin)
    except hwi.errors.DeviceAlreadyUnlockedError:
        return {'ok': True, 'status': 'unlocked', 'path': path}
    finally:
        pin = None
        client.close()
    if not accepted:
        raise Fail('wrong_pin', 'The Trezor did not accept that PIN. It makes you wait a little '
                                'longer after each wrong try. Start the PIN entry again.')
    return {'ok': True, 'status': 'unlocked', 'path': path}


def open_unlocked(hwi):
    path = single_path(hwi)
    client = hwi.client(path)
    try:
        info = check_trezor_one(client)
        if info['locked']:
            raise Fail('locked', MSG_LOCKED)
        return client, path, info
    except BaseException:
        client.close()
        raise


def do_pair(hwi, data):
    want_xfp = field_xfp(data)
    want_xpub = field_xpub(data)
    client, path, info = open_unlocked(hwi)
    try:
        got_xfp, got_xpub = identity(client)
    finally:
        client.close()
    if got_xfp != want_xfp:
        raise Fail('wrong_device', 'The connected Trezor (fingerprint %s) is not the one you just '
                                   'confirmed (%s). Nothing was saved.' % (got_xfp.upper(), want_xfp.upper()))
    if got_xpub != want_xpub:
        raise Fail('wrong_device', 'The connected Trezor has the same fingerprint (%s) but a different '
                                   'key than the one you just confirmed. Nothing was saved.' % got_xfp.upper())
    record = {'xfp': got_xfp, 'id_xpub': got_xpub,
              'paired_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    try:
        write_pairing(record)
    except OSError as e:
        raise Fail('error', 'Could not save the pairing (%s).' % (e.strerror or type(e).__name__))
    return dict({'ok': True, 'status': 'paired'}, **record)


def do_unpair(hwi, data):
    try:
        os.remove(pairing_path())
    except FileNotFoundError:
        pass
    except OSError as e:
        raise Fail('error', 'Could not remove the pairing (%s).' % (e.strerror or type(e).__name__))
    return {'ok': True, 'status': 'unpaired'}


def do_sign(hwi, data):
    psbt_b64 = field_psbt(data)
    pairing = read_pairing()
    if pairing is None:
        raise Fail('not_paired', 'No Trezor is paired with SafeKeep yet. Pair it first.')
    client, path, info = open_unlocked(hwi)
    try:
        got_xfp, got_xpub = identity(client)
        if got_xfp != pairing['xfp']:
            hint = (' If you use a passphrase on this Trezor, note that SafeKeep only supports the '
                    'standard wallet (no passphrase).') if info['passphrase_protection'] else ''
            raise Fail('wrong_device', 'This Trezor (fingerprint %s) is not the one paired with SafeKeep '
                                       '(%s). Nothing was sent to it.%s'
                       % (got_xfp.upper(), pairing['xfp'].upper(), hint))
        if got_xpub != pairing['id_xpub']:
            raise Fail('wrong_device', 'This Trezor has the paired fingerprint (%s) but a different key, '
                                       'so it is not the paired device. Nothing was sent to it.' % got_xfp.upper())
        tx = hwi.PSBT()
        try:
            tx.deserialize(psbt_b64)
        except Exception:
            raise Fail('bad_request', 'The transaction could not be read.')
        signed = client.sign_tx(tx).serialize()   # never finalizes, never broadcasts
    finally:
        client.close()
    try:
        out = base64.b64decode(signed, validate=True)
    except (binascii.Error, ValueError, TypeError):
        raise Fail('error', 'The Trezor returned something that is not a PSBT.')
    if not out.startswith(PSBT_MAGIC):
        raise Fail('error', 'The Trezor returned something that is not a PSBT.')
    return {'ok': True, 'status': 'signed', 'xfp': got_xfp, 'changed': signed != psbt_b64,
            'psbt_b64': base64.b64encode(out).decode('ascii')}


ACTIONS = {
    'detect': (do_detect, SHORT_TIMEOUT_S),
    'prompt_pin': (do_prompt_pin, SHORT_TIMEOUT_S),
    'send_pin': (do_send_pin, SHORT_TIMEOUT_S),
    'pair': (do_pair, SHORT_TIMEOUT_S),
    'unpair': (do_unpair, SHORT_TIMEOUT_S),
    'sign': (do_sign, SIGN_TIMEOUT_S),
}


def run_limited(fn, hwi, data, limit):
    """Run fn in a thread; a stuck USB call cannot be interrupted, so give up
    on it after `limit` seconds (the caller then exits the process)."""
    box = {}

    def work():
        try:
            box['result'] = fn(hwi, data)
        except BaseException as e:   # noqa: B902 - reported, not swallowed
            box['error'] = e

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(limit)
    if t.is_alive():
        return None, True
    if 'error' in box:
        raise box['error']
    return box['result'], False


def main(argv):
    if len(argv) != 3:
        print('usage: safekeep-trezor.py REQUEST.json RESULT.json', file=sys.stderr)
        return 2
    req_path, res_path = argv[1], argv[2]
    request_id = None
    stuck = False
    hwi = None
    try:
        data = load_request(req_path)
        rid = data.get('request_id')
        if isinstance(rid, str) and REQUEST_ID_RE.match(rid):
            request_id = rid
        entry = ACTIONS.get(data.get('action'))
        if entry is None:
            raise Fail('bad_request', 'Unknown Trezor request.')
        fn, limit = entry
        if fn is not do_unpair:
            hwi = Hwi()
        result, stuck = run_limited(fn, hwi, data, limit)
        data = None   # drop the request (may hold PIN positions)
        if stuck:
            raise Fail('timeout', 'No answer from the Trezor in time. Unplug it, plug it back in, '
                                  'and try again.')
    except Exception as e:
        f = translate(hwi, e) if hwi is not None else (e if isinstance(e, Fail) else None)
        if f is None:
            f = Fail('error', 'Unexpected Trezor error (%s): %s' % (type(e).__name__, str(e)[:200]))
        result = {'ok': False, 'status': f.status, 'error': f.message}
    if request_id:
        result['request_id'] = request_id
    write_result(res_path, result)
    rc = 0 if result.get('ok') else 3
    if stuck:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(rc)   # the USB call is still stuck in its thread
    return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""
safekeep-coldcard — talk to a paired Coldcard over USB for the SafeKeep app.

    safekeep-coldcard.py REQUEST.json RESULT.json

Run by the Coldcard Watcher in safekeep-boot.sh, using the pinned
ckcc-protocol install in /opt/safekeep-ckcc (see config/ckcc-requirements.txt).

SECURITY MODEL
  * The request file is UNTRUSTED DATA written by the browser. It is read
    once, deleted immediately, size-limited and validated field by field.
    Nothing in it is ever run as a command.
  * Only two actions exist:
      detect -> report the single connected Coldcard (serial, fingerprint,
                master xpub) so the app can PAIR with it.
      sign   -> send a PSBT to the PAIRED Coldcard and return the result.
  * "sign" refuses unless the connected Coldcard's fingerprint AND master
    xpub match the pairing, then runs Coinkite's anti-MiTM check against
    the PAIRED xpub (not the one the device just presented, which would
    prove nothing).
  * USB link encryption is always on (ckcc default). Nothing is broadcast:
    this helper has no network code and never asks the Coldcard to finalize.
  * The user must approve on the Coldcard's own screen; refusal is reported.
  * The result is always written (ok or error) so the app never hangs.

Result JSON: {"ok": true/false, "status": "...", ...}
  ok statuses   : detected, signed
  error statuses: bad_request, not_installed, not_connected,
                  multiple_devices, no_seed, wrong_device, mitm_failed,
                  refused, busy, timeout, rejected, error
"""
import base64
import binascii
import json
import os
import re
import struct
import sys
import time

COINKITE_VID = 0xD13E
CKCC_PID = 0xCC10
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_PSBT_BYTES = 2 * 1024 * 1024
APPROVAL_TIMEOUT_S = int(os.environ.get('SAFEKEEP_CC_TIMEOUT', '600'))
POLL_INTERVAL_S = 0.25
PSBT_MAGIC = b'psbt\xff'
XFP_RE = re.compile(r'^[0-9a-f]{8}$')
XPUB_RE = re.compile(r'^[xt]pub[1-9A-HJ-NP-Za-km-z]{100,112}$')

MSG_NOT_CONNECTED = ('No Coldcard found. Plug it in, unlock it with your PIN, and make '
                     'sure USB is turned on (Settings > Hardware On/Off > USB).')


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
        raise Fail('bad_request', 'Could not read the Coldcard request.')
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    if len(raw) > MAX_REQUEST_BYTES:
        raise Fail('bad_request', 'Coldcard request is too large.')
    try:
        data = json.loads(raw.decode('utf-8'))
    except Exception:
        raise Fail('bad_request', 'Coldcard request is not valid JSON.')
    if not isinstance(data, dict):
        raise Fail('bad_request', 'Coldcard request has the wrong format.')
    return data


def xfp_to_str(xfp_int):
    # Same byte order Coinkite (and Sparrow) display: 4 bytes, little-endian int.
    return binascii.b2a_hex(struct.pack('<I', xfp_int)).decode('ascii')


def field_xfp(data):
    v = data.get('expected_xfp')
    if not isinstance(v, str) or not XFP_RE.match(v.lower()):
        raise Fail('bad_request', 'Request is missing the paired Coldcard fingerprint.')
    return v.lower()


def field_xpub(data):
    v = data.get('expected_xpub')
    if not isinstance(v, str) or not XPUB_RE.match(v):
        raise Fail('bad_request', 'Request is missing the paired Coldcard master key.')
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
    return psbt


def load_ckcc():
    try:
        import hid
        from ckcc.client import ColdcardDevice
        from ckcc import protocol
    except ImportError:
        raise Fail('not_installed', 'Coldcard support is not installed on this SafeKeep build.')
    return hid, ColdcardDevice, protocol


def open_single_device(hid, ColdcardDevice):
    serials = []
    for info in hid.enumerate(COINKITE_VID, CKCC_PID):
        sn = info.get('serial_number')
        if sn and sn not in serials:
            serials.append(sn)
    if not serials:
        raise Fail('not_connected', MSG_NOT_CONNECTED)
    if len(serials) > 1:
        raise Fail('multiple_devices', 'More than one Coldcard is connected. Unplug all but one and try again.')
    try:
        dev = ColdcardDevice(sn=serials[0])   # encrypt=True by default
    except Exception as e:
        raise Fail('not_connected', 'Found a Coldcard but could not talk to it (%s). Unplug it, '
                                    'plug it back in, unlock it and try again.' % type(e).__name__)
    if not dev.master_fingerprint or not dev.master_xpub:
        dev.close()
        raise Fail('no_seed', 'The Coldcard has no seed loaded, or is not unlocked.')
    return dev


def do_detect(data):
    hid, ColdcardDevice, _ = load_ckcc()
    dev = open_single_device(hid, ColdcardDevice)
    try:
        return {'ok': True, 'status': 'detected', 'serial': dev.serial,
                'xfp': xfp_to_str(dev.master_fingerprint), 'master_xpub': dev.master_xpub}
    finally:
        dev.close()


def do_sign(data):
    psbt = field_psbt(data)
    want_xfp = field_xfp(data)
    want_xpub = field_xpub(data)
    hid, ColdcardDevice, protocol = load_ckcc()
    P = protocol.CCProtocolPacker

    dev = open_single_device(hid, ColdcardDevice)
    try:
        got_xfp = xfp_to_str(dev.master_fingerprint)
        if got_xfp != want_xfp or dev.master_xpub != want_xpub:
            raise Fail('wrong_device', 'This Coldcard (fingerprint %s) is not the one paired with '
                                       'SafeKeep (%s). Nothing was sent to it.' % (got_xfp.upper(), want_xfp.upper()))
        try:
            dev.check_mitm(expected_xpub=want_xpub)
        except Exception:
            raise Fail('mitm_failed', 'The Coldcard failed its authenticity check, so nothing was '
                                      'sent. Unplug it, check the cable, and try again.')
        try:
            length, sha = dev.upload_file(psbt)
            dev.send_recv(P.sign_transaction(length, sha), timeout=None)
            deadline = time.monotonic() + APPROVAL_TIMEOUT_S
            while True:
                time.sleep(POLL_INTERVAL_S)
                done = dev.send_recv(P.get_signed_txn(), timeout=None)
                if done is not None:
                    break
                if time.monotonic() > deadline:
                    raise Fail('timeout', 'No answer from the Coldcard in time. Cancel the request on '
                                          'its screen, then try again.')
            if not isinstance(done, (tuple, list)) or len(done) != 2:
                raise Fail('error', 'Unexpected reply from the Coldcard.')
            result_len, result_sha = done
            signed = dev.download_file(result_len, result_sha, file_number=1)
        except protocol.CCUserRefused:
            raise Fail('refused', 'You declined the transaction on the Coldcard. Nothing was signed.')
        except protocol.CCBusyError:
            raise Fail('busy', 'The Coldcard is busy. Finish or cancel what is on its screen, then try again.')
        except protocol.CCProtoError as e:
            raise Fail('rejected', 'The Coldcard would not sign this transaction: %s' % str(e)[:200])
        if not isinstance(signed, (bytes, bytearray)) or not bytes(signed).startswith(PSBT_MAGIC):
            raise Fail('error', 'The Coldcard returned something that is not a PSBT.')
        return {'ok': True, 'status': 'signed', 'xfp': got_xfp,
                'psbt_b64': base64.b64encode(bytes(signed)).decode('ascii')}
    finally:
        dev.close()


ACTIONS = {'detect': do_detect, 'sign': do_sign}


def main(argv):
    if len(argv) != 3:
        print('usage: safekeep-coldcard.py REQUEST.json RESULT.json', file=sys.stderr)
        return 2
    req_path, res_path = argv[1], argv[2]
    try:
        data = load_request(req_path)
        action = ACTIONS.get(data.get('action'))
        if action is None:
            raise Fail('bad_request', 'Unknown Coldcard request.')
        result = action(data)
    except Fail as f:
        result = {'ok': False, 'status': f.status, 'error': f.message}
    except Exception as e:
        result = {'ok': False, 'status': 'error',
                  'error': 'Unexpected Coldcard error (%s): %s' % (type(e).__name__, str(e)[:200])}
    write_result(res_path, result)
    return 0 if result.get('ok') else 3


if __name__ == '__main__':
    sys.exit(main(sys.argv))

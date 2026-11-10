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
                    With an optional "passphrase", the Trezor's passphrase
                    wallet signs: the pairing is checked on the standard
                    wallet first, then the passphrase wallet is opened (the
                    Trezor One takes its passphrase from the computer) and
                    must be one of the keys the PSBT's inputs name, or
                    nothing is sent. Refused if passphrase protection is off
                    (the Trezor would quietly use its standard wallet). The
                    passphrase is never logged or written to the result, and
                    the request file is overwritten before it is deleted.
      passphrase_setting -> turn the Trezor's passphrase protection on or
                    off ("enable"). The Trezor asks for confirmation on its
                    own screen.
      wipe       -> erase the Trezor (its seed, PIN and settings). Only the
                    Trezor whose fingerprint the user confirmed
                    ("expected_xfp"); the Trezor asks for confirmation on its
                    own screen. The pairing is removed.
      recover    -> set a wiped Trezor up from recovery words. Each word
                    reaches this helper as a reply file in the download
                    folder: RAM in a Temporary Session, the encrypted vault
                    otherwise (where Seed Vault seeds are stored anyway);
                    read once, overwritten and deleted. A Trezor One asks for the
                    words in a scrambled order, mixed with decoys, and shows
                    on its own screen which one to type; it also asks for a
                    new PIN on its scrambled grid. Each question goes to the
                    app through the dialog channel below.
      xpub       -> read the unlocked Trezor's fingerprint and its multisig
                    account key at ONE of the three BIP-48 paths
                    (m/48'/0'/0'/0', /1' or /2'), for building a multisig
                    descriptor. Read-only, no pairing needed, nothing stored.
  * DIALOG CHANNEL (passphrase_setting, wipe, recover): while the Trezor
    waits, each question is written to SAFEKEEP_TZ_DIALOG (RAM) as
      { request_id, seq, need: "button" | "pin" | "word", kind, ... }
    and, for "pin" and "word", the answer is read from a
    TREZOR_REPLY*.json in SAFEKEEP_TZ_REPLY_DIR (the download folder) as
      { request_id, seq, positions | word | cancel }
    It must name this request and question; it is read once, overwritten
    and deleted. Words are checked to be lower-case letters (the Trezor
    checks them against its word list); positions are digits 1-9.
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
  ok statuses   : detected, pin_requested, unlocked, paired, unpaired, signed, xpub
  error statuses: bad_request, not_installed, not_paired, not_connected,
                  multiple_devices, unsupported_model, no_seed, locked,
                  wrong_pin, wrong_device, outdated_firmware, refused, busy,
                  timeout, rejected, missing_prev_tx, passphrase_off,
                  wrong_passphrase, initialized, error
  ok statuses (also): passphrase_setting, wiped, recovered
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
import unicodedata

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
PASSPHRASE_MAX_BYTES = 50   # the Trezor One's limit
WORD_RE = re.compile(r'^[a-z]{3,8}$')
DIALOG_STEP_TIMEOUT_S = int(os.environ.get('SAFEKEEP_TZ_STEP_TIMEOUT', '600'))
RECOVER_TIMEOUT_S = int(os.environ.get('SAFEKEEP_TZ_RECOVER_TIMEOUT', '2700'))
DEFAULT_PAIRING = '/media/.safekeep-vault/settings/trezor-pairing.json'
# The only paths "xpub" will read: BIP-48 multisig accounts (mainnet, account 0)
# for P2SH (0'), P2SH-P2WSH (1') and P2WSH (2').
MULTISIG_DERIVS = {"m/48'/0'/0'/0'": 'm/48h/0h/0h/0h',
                   "m/48'/0'/0'/1'": 'm/48h/0h/0h/1h',
                   "m/48'/0'/0'/2'": 'm/48h/0h/0h/2h'}
IDENTITY_PATH = 'm/0h'   # the same key HWI reads to get the fingerprint

MSG_NOT_CONNECTED = ('No Trezor found. Plug it in and try again. If it is plugged in, '
                     'unplug it and plug it back in.')
MSG_GONE = ('The Trezor is no longer at the same USB connection (it may have been '
            'unplugged). Start the PIN entry again.')
MSG_LOCKED = 'The Trezor is locked. Unlock it with your PIN first.'
MSG_MISSING_PREV_TX = ('The Trezor needs the full previous transaction for each coin being spent, and this '
                       'transaction does not include them (some wallets leave them out of QR codes to keep '
                       'them short). Nothing was sent to the Trezor. In your wallet, save the transaction '
                       'as a file instead and load that file in SafeKeep. A Coldcard can sign it either way.')


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
        # It may hold a passphrase or PIN positions: overwrite it before deleting (best effort).
        try:
            size = os.path.getsize(path)
            with open(path, 'r+b') as f:
                f.write(b'\0' * size)
                f.flush()
                os.fsync(f.fileno())
        except OSError:
            pass
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


def field_deriv(data):
    v = data.get('deriv')
    if not isinstance(v, str) or v not in MULTISIG_DERIVS:
        raise Fail('bad_request', 'Only the BIP-48 multisig paths can be read (m/48\'/0\'/0\'/0\', 1\' or 2\').')
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

def field_passphrase(data):
    """'' for the standard wallet, or the passphrase (NFKD, as BIP-39 asks)."""
    v = data.get('passphrase')
    if v is None or v == '':
        return ''
    if not isinstance(v, str):
        raise Fail('bad_request', 'The passphrase has the wrong format.')
    v = unicodedata.normalize('NFKD', v)
    if re.search(r'[\x00-\x1f\x7f]', v):
        raise Fail('bad_request', 'The passphrase has characters a Trezor can\'t take (tabs, new lines).')
    if len(v.encode('utf-8')) > PASSPHRASE_MAX_BYTES:
        raise Fail('bad_request', 'A Trezor One takes a passphrase of at most %d bytes.' % PASSPHRASE_MAX_BYTES)
    return v


def psbt_fingerprints(tx):
    """The key fingerprints the PSBT's inputs name (lower-case hex)."""
    fps = set()
    for inp in getattr(tx, 'inputs', []) or []:
        for origin in (getattr(inp, 'hd_keypaths', None) or {}).values():
            fp = getattr(origin, 'fingerprint', b'')
            if isinstance(fp, (bytes, bytearray)) and len(fp) == 4:
                fps.add(binascii.hexlify(bytes(fp)).decode('ascii'))
        for entry in (getattr(inp, 'tap_bip32_paths', None) or {}).values():
            origin = entry[1] if isinstance(entry, (tuple, list)) and len(entry) == 2 else None
            fp = getattr(origin, 'fingerprint', b'')
            if isinstance(fp, (bytes, bytearray)) and len(fp) == 4:
                fps.add(binascii.hexlify(bytes(fp)).decode('ascii'))
    return fps


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
            from hwilib.devices.trezorlib import device as tzdevice
            from hwilib.devices.trezorlib import messages as tzmsg
        except ImportError:
            raise Fail('not_installed', 'Trezor support is not installed on this SafeKeep build.')
        self.errors, self.PSBT, self.tz, self.tzexc = errors, PSBT, tz, tzexc
        self.tzdevice, self.tzmsg = tzdevice, tzmsg

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

    def client(self, path, passphrase=''):
        # password '' = the standard wallet (no passphrase); matches HWI's default.
        # A Trezor One asks the computer for the passphrase; HWI answers with it.
        return self.tz.TrezorClient(path, password=passphrase)


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
        return Fail('error', 'This Trezor asked for a passphrase SafeKeep didn\'t send. Sign again and give it in the passphrase box.')
    if isinstance(e, E.BadArgumentError) and 'find device by path' in str(e):
        return Fail('not_connected', MSG_GONE)
    if isinstance(e, E.BadArgumentError) and 'Previous transaction' in str(e):
        return Fail('missing_prev_tx', MSG_MISSING_PREV_TX)
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
    passphrase = field_passphrase(data)
    data['passphrase'] = None
    pairing = read_pairing()
    if pairing is None:
        raise Fail('not_paired', 'No Trezor is paired with SafeKeep yet. Pair it first.')
    tx = hwi.PSBT()
    try:
        tx.deserialize(psbt_b64)
    except Exception:
        raise Fail('bad_request', 'The transaction could not be read.')
    # The Trezor insists on the FULL previous transaction for every input
    # (it checks the amounts itself). Check before anything reaches the
    # device, so it is never left waiting for data SafeKeep cannot give.
    missing = [i + 1 for i, inp in enumerate(tx.inputs) if not inp.non_witness_utxo]
    if missing:
        raise Fail('missing_prev_tx', MSG_MISSING_PREV_TX)

    # 1. The pairing is always checked on the Trezor's standard wallet.
    client, path, info = open_unlocked(hwi)
    try:
        got_xfp, got_xpub = identity(client)
        if got_xfp != pairing['xfp']:
            hint = (' If this Trezor has passphrase protection on, SafeKeep pairs it by its standard '
                    'wallet (no passphrase); a passphrase is given when signing.') if info['passphrase_protection'] else ''
            raise Fail('wrong_device', 'This Trezor (fingerprint %s) is not the one paired with SafeKeep '
                                       '(%s). Nothing was sent to it.%s'
                       % (got_xfp.upper(), pairing['xfp'].upper(), hint))
        if got_xpub != pairing['id_xpub']:
            raise Fail('wrong_device', 'This Trezor has the paired fingerprint (%s) but a different key, '
                                       'so it is not the paired device. Nothing was sent to it.' % got_xfp.upper())
        if passphrase and not info['passphrase_protection']:
            raise Fail('passphrase_off', 'Passphrase protection is off on this Trezor, so it would ignore the '
                                         'passphrase and sign with its standard wallet. Turn it on with Trezor '
                                         'Suite on another computer, or sign without a passphrase. Nothing was sent.')
        if passphrase:
            client.close()
            client = None
            # 2. A fresh session with the passphrase: the Trezor asks for it, HWI answers.
            client = hwi.client(path, passphrase)
            passphrase = None
            check_trezor_one(client)
            sign_xfp, _ = identity(client)
            needed = psbt_fingerprints(tx)
            if needed and sign_xfp not in needed:
                raise Fail('wrong_passphrase', 'This passphrase opens the Trezor\'s wallet %s, but this transaction '
                                               'needs %s. Check the passphrase (capitals and spaces count). '
                                               'Nothing was sent to sign.'
                           % (sign_xfp.upper(), ', '.join(sorted(x.upper() for x in needed))))
        else:
            sign_xfp = got_xfp
        try:
            signed = client.sign_tx(tx).serialize()   # never finalizes, never broadcasts
        except BaseException:
            # Don't leave the Trezor stuck mid-signing: cancel what it is doing.
            try:
                client.client.cancel()
            except Exception:
                pass
            raise
    finally:
        passphrase = None
        if client is not None:
            client.close()
    try:
        out = base64.b64decode(signed, validate=True)
    except (binascii.Error, ValueError, TypeError):
        raise Fail('error', 'The Trezor returned something that is not a PSBT.')
    if not out.startswith(PSBT_MAGIC):
        raise Fail('error', 'The Trezor returned something that is not a PSBT.')
    result = {'ok': True, 'status': 'signed', 'xfp': got_xfp, 'changed': signed != psbt_b64,
              'psbt_b64': base64.b64encode(out).decode('ascii')}
    if sign_xfp != got_xfp:
        result['passphrase_xfp'] = sign_xfp
    return result


def do_xpub(hwi, data):
    deriv = field_deriv(data)
    client, path, info = open_unlocked(hwi)
    try:
        xfp, _ = identity(client)
        key = client.get_pubkey_at_path(MULTISIG_DERIVS[deriv])
    finally:
        client.close()
    xpub = key.to_string()
    if not isinstance(xpub, str) or not xpub.startswith('xpub') or not XPUB_RE.match(xpub):
        raise Fail('error', 'The Trezor returned a key SafeKeep cannot use (it must be a mainnet xpub).')
    if getattr(key, 'depth', None) != 4:
        raise Fail('error', 'The Trezor returned a key from the wrong level of the wallet.')
    return {'ok': True, 'status': 'xpub', 'xfp': xfp, 'deriv': deriv, 'xpub': xpub,
            'passphrase_protection': info['passphrase_protection']}


# ---------------------------------------------------------------- dialog

class Dialog:
    """Questions to the app while the Trezor waits (see DIALOG CHANNEL above)."""

    def __init__(self, request_id):
        self.request_id = request_id
        self.seq = 0
        self.path = os.environ.get('SAFEKEEP_TZ_DIALOG') or ''
        self.reply_dir = os.environ.get('SAFEKEEP_TZ_REPLY_DIR') or ''
        if not self.path or not self.reply_dir or not request_id:
            raise Fail('error', 'This SafeKeep build cannot ask questions for the Trezor (no dialog channel).')

    def _write(self, obj):
        tmp = self.path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(obj, f)
        os.replace(tmp, self.path)

    def say(self, need, **info):
        """Tell the app what the Trezor is waiting for; returns the question number."""
        self.seq += 1
        self._write(dict({'request_id': self.request_id, 'seq': self.seq, 'need': need}, **info))
        return self.seq

    def _take_reply(self, seq):
        try:
            names = sorted(n for n in os.listdir(self.reply_dir) if n.startswith('TREZOR_REPLY') and n.endswith('.json'))
        except OSError:
            return None
        for n in names:
            p = os.path.join(self.reply_dir, n)
            try:
                with open(p, 'rb') as f:
                    raw = f.read(4097)
                with open(p, 'r+b') as f:      # it may hold a word or PIN positions
                    f.write(b'\0' * len(raw))
                    f.flush()
                    os.fsync(f.fileno())
            except OSError:
                raw = b''
            try:
                os.remove(p)
            except OSError:
                pass
            try:
                r = json.loads(raw.decode('utf-8')) if len(raw) <= 4096 else None
            except Exception:
                r = None
            if isinstance(r, dict) and r.get('request_id') == self.request_id and r.get('seq') == seq:
                return r
        return None

    def ask(self, need, **info):
        seq = self.say(need, **info)
        deadline = time.monotonic() + DIALOG_STEP_TIMEOUT_S
        while time.monotonic() < deadline:
            r = self._take_reply(seq)
            if r is not None:
                return r
            time.sleep(0.25)
        raise Fail('timeout', 'No answer in SafeKeep in time. The Trezor may still be waiting: unplug it to stop.')

    def close(self):
        for p in (self.path, self.path + '.tmp'):
            try:
                os.remove(p)
            except OSError:
                pass


class DialogUI:
    """trezorlib's UI: PIN grids and on-device confirmations go to the app."""
    PIN_KINDS = {1: 'current', 2: 'new_first', 3: 'new_second', 4: 'wipe_code_first', 5: 'wipe_code_second'}

    def __init__(self, dialog, cancelled_exc, step=''):
        self.dialog, self.Cancelled, self.step = dialog, cancelled_exc, step

    def button_request(self, br):
        self.dialog.say('button', step=self.step)

    def get_pin(self, code=None):
        kind = self.PIN_KINDS.get(int(code or 1), 'current')
        r = self.dialog.ask('pin', kind=kind, step=self.step)
        if r.get('cancel'):
            raise self.Cancelled()
        pos = r.get('positions')
        if not isinstance(pos, str) or not PIN_POS_RE.match(pos):
            raise self.Cancelled()
        return pos

    def get_passphrase(self, available_on_device=False):
        return ''   # these steps never open a passphrase wallet


def open_dialog_client(hwi, data, step):
    """An unlocked-or-new Trezor One with the dialog UI, and the dialog."""
    dialog = Dialog(data.get('request_id') if isinstance(data.get('request_id'), str) else '')
    path = single_path(hwi)
    client = hwi.client(path)
    client.client.ui = DialogUI(dialog, hwi.tzexc.Cancelled, step)
    return client, dialog


def forget_pairing():
    try:
        os.remove(pairing_path())
    except OSError:
        pass


def field_bool(data, key):
    v = data.get(key)
    if not isinstance(v, bool):
        raise Fail('bad_request', 'Request field %s must be true or false.' % key)
    return v


def do_passphrase_setting(hwi, data):
    enable = field_bool(data, 'enable')
    client, dialog = open_dialog_client(hwi, data, 'passphrase_setting')
    try:
        info = check_trezor_one(client)
        if info['locked']:
            raise Fail('locked', MSG_LOCKED)
        if info['passphrase_protection'] == enable:
            return {'ok': True, 'status': 'passphrase_setting', 'passphrase_protection': enable, 'changed': False}
        try:
            hwi.tzdevice.apply_settings(client.client, use_passphrase=enable)
        except hwi.tzexc.Cancelled:
            raise Fail('refused', 'Canceled. The setting is unchanged.')
        except hwi.tzexc.TrezorFailure as e:
            if 'cancel' in str(e).lower():
                raise Fail('refused', 'You declined on the Trezor. The setting is unchanged.')
            raise
        now = bool(client.client.features.passphrase_protection)
    finally:
        dialog.close()
        client.close()
    return {'ok': True, 'status': 'passphrase_setting', 'passphrase_protection': now, 'changed': now == enable}


def do_wipe(hwi, data):
    want = data.get('expected_xfp')
    if want is not None:
        want = field_xfp(data)
    client, dialog = open_dialog_client(hwi, data, 'wipe')
    try:
        f = check_trezor_one_any(client)
        if f['initialized']:
            if f['locked']:
                raise Fail('locked', MSG_LOCKED)
            got_xfp, _ = identity(client)
            if want is None or got_xfp != want:
                raise Fail('wrong_device', 'This Trezor (fingerprint %s) is not the one you confirmed. Nothing was erased.'
                           % got_xfp.upper())
        try:
            hwi.tzdevice.wipe(client.client)
        except hwi.tzexc.Cancelled:
            raise Fail('refused', 'Canceled. Nothing was erased.')
        except hwi.tzexc.TrezorFailure as e:
            if 'cancel' in str(e).lower():
                raise Fail('refused', 'You declined on the Trezor. Nothing was erased.')
            raise
    finally:
        dialog.close()
        client.close()
    pairing = read_pairing()
    if pairing is not None and (want is None or pairing['xfp'] == want):
        forget_pairing()
    return {'ok': True, 'status': 'wiped'}


def do_recover(hwi, data):
    words = data.get('word_count')
    if words not in (12, 18, 24):
        raise Fail('bad_request', 'The Trezor can recover a seed of 12, 18 or 24 words.')
    use_pp = field_bool(data, 'passphrase_protection')
    client, dialog = open_dialog_client(hwi, data, 'recover')
    try:
        f = check_trezor_one_any(client)
        if f['initialized']:
            raise Fail('initialized', 'This Trezor already has a seed. Erase it first (Wipe), then recover.')

        def word(kind):
            if int(kind or 0) != 0:   # only the scrambled-words method is used
                raise hwi.tzexc.Cancelled()
            r = dialog.ask('word', step='recover')
            if r.get('cancel'):
                raise hwi.tzexc.Cancelled()
            w = r.get('word')
            if not isinstance(w, str) or not WORD_RE.match(w):
                raise hwi.tzexc.Cancelled()
            return w

        try:
            hwi.tzdevice.recover(client.client, word_count=words, passphrase_protection=use_pp, pin_protection=True,
                                 label=None, input_callback=word, type=hwi.tzmsg.RecoveryDeviceType.ScrambledWords)
        except hwi.tzexc.Cancelled:
            raise Fail('refused', 'Recovery canceled. The Trezor has no seed: start the recovery again.')
        except hwi.tzexc.TrezorFailure as e:
            text = str(e).lower()
            if 'cancel' in text:
                raise Fail('refused', 'Recovery canceled. The Trezor has no seed: start the recovery again.')
            if 'checksum' in text or 'invalid' in text or 'mnemonic' in text:
                raise Fail('rejected', 'The Trezor did not accept those words (they don\'t form a valid seed). '
                                       'Check them against your backup and start again.')
            raise
        client.client.init_device()
        xfp, _ = identity(client)
    finally:
        dialog.close()
        client.close()
    forget_pairing()
    return {'ok': True, 'status': 'recovered', 'xfp': xfp, 'passphrase_protection': use_pp}


def check_trezor_one_any(client):
    """Like check_trezor_one, but a Trezor with no seed is fine (wipe / recover)."""
    client._prepare_device()
    f = client.client.features
    if 'trezor' not in (f.vendor or '').lower():
        raise Fail('unsupported_model', 'The connected device is not a Trezor.')
    if f.model != '1':
        raise Fail('unsupported_model', 'Only the Trezor One is supported for now.')
    return {'initialized': bool(f.initialized), 'locked': bool(f.pin_protection and not f.unlocked)}


ACTIONS = {
    'detect': (do_detect, SHORT_TIMEOUT_S),
    'prompt_pin': (do_prompt_pin, SHORT_TIMEOUT_S),
    'send_pin': (do_send_pin, SHORT_TIMEOUT_S),
    'pair': (do_pair, SHORT_TIMEOUT_S),
    'unpair': (do_unpair, SHORT_TIMEOUT_S),
    'sign': (do_sign, SIGN_TIMEOUT_S),
    'xpub': (do_xpub, SHORT_TIMEOUT_S),
    'passphrase_setting': (do_passphrase_setting, SIGN_TIMEOUT_S),
    'wipe': (do_wipe, SIGN_TIMEOUT_S),
    'recover': (do_recover, RECOVER_TIMEOUT_S),
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


def _log(msg):
    # Timing only: action names and statuses, never request contents (PIN positions).
    try:
        sys.stderr.write('%s trezor-helper: %s\n' % (time.strftime('%H:%M:%S'), msg))
        sys.stderr.flush()
    except Exception:
        pass


def main(argv):
    if len(argv) != 3:
        print('usage: safekeep-trezor.py REQUEST.json RESULT.json', file=sys.stderr)
        return 2
    req_path, res_path = argv[1], argv[2]
    request_id = None
    stuck = False
    hwi = None
    action_name = '?'
    t_start = time.monotonic()
    try:
        data = load_request(req_path)
        rid = data.get('request_id')
        if isinstance(rid, str) and REQUEST_ID_RE.match(rid):
            request_id = rid
        entry = ACTIONS.get(data.get('action'))
        if entry is None:
            raise Fail('bad_request', 'Unknown Trezor request.')
        fn, limit = entry
        action_name = data.get('action')
        _log('start %s' % action_name)
        if fn is not do_unpair:
            hwi = Hwi()
            _log('library loaded (%.1fs)' % (time.monotonic() - t_start))
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
    _log('done %s -> %s (%.1fs)' % (action_name, result.get('status'), time.monotonic() - t_start))
    rc = 0 if result.get('ok') else 3
    if stuck:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(rc)   # the USB call is still stuck in its thread
    return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv))

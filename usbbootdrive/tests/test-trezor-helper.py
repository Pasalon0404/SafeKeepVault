#!/usr/bin/env python3
"""
Tests for usbbootdrive/safekeep-trezor.py using a FAKE Trezor.

    PYTHONDONTWRITEBYTECODE=1 python3 usbbootdrive/tests/test-trezor-helper.py

No hardware needed. A fake `hwilib` package is generated in a temp dir and
put first on PYTHONPATH; its behaviour is chosen per test via the FAKE_TZ env
var. Real-hardware testing is separate (see the design plan).

Optional: also check the helper against the REAL pinned HWI library (still no
hardware): set SAFEKEEP_TEST_HWI_PYTHON to a python that has hwi 3.2.0, e.g.
    SAFEKEEP_TEST_HWI_PYTHON=/opt/safekeep-hwi/bin/python3 python3 usbbootdrive/tests/test-trezor-helper.py
"""
import base64, json, os, subprocess, sys, tempfile, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, '..', 'safekeep-trezor.py')
FIXTURE = os.path.join(HERE, '..', '..', 'test-fixtures', 'cctest2.psbt')

PAIRED_XFP = 'c0ffee01'
PAIRED_XPUB = 'xpub' + ('C' * 107)
OTHER_XPUB = 'xpub' + ('D' * 107)
PIN = '7359'          # grid positions the fake Trezor accepts
PATH0 = 'webusb:001:2'

FAKE_ERRORS = '''
class HWWError(Exception): pass
class ActionCanceledError(HWWError): pass
class DeviceNotReadyError(HWWError): pass
class DeviceBusyError(HWWError): pass
class DeviceConnectionError(HWWError): pass
class NoPasswordError(HWWError): pass
class BadArgumentError(HWWError): pass
class DeviceAlreadyUnlockedError(HWWError): pass
'''

FAKE_PSBT = '''
import base64, json, os
class _In:
    def __init__(self, prev): self.non_witness_utxo = object() if prev else None
class PSBT:
    def deserialize(self, s):
        self.data = base64.b64decode(s, validate=True)
        if not self.data.startswith(b'psbt\\xff'): raise ValueError('bad psbt')
        no_prev = json.loads(os.environ.get('FAKE_TZ', '{}')).get('no_prev')
        self.inputs = [_In(True), _In(not no_prev)]
    def serialize(self):
        return base64.b64encode(self.data).decode()
'''

FAKE_TZEXC = '''
class TrezorException(Exception): pass
class TrezorFailure(TrezorException): pass
class OutdatedFirmwareError(TrezorException): pass
'''

FAKE_TREZOR = '''
import json, os, time
from hwilib.errors import (ActionCanceledError, DeviceNotReadyError, DeviceBusyError,
                           BadArgumentError, DeviceAlreadyUnlockedError)
from hwilib.devices.trezorlib.exceptions import TrezorFailure, OutdatedFirmwareError
CFG = json.loads(os.environ.get('FAKE_TZ', '{}'))
LOG = os.environ['FAKE_TZ_LOG']
def log(x):
    with open(LOG, 'a') as f: f.write(x + '\\n')

class _Dev:
    def __init__(self, p): self.p = p
    def get_path(self): return self.p

class _Hid:
    class HidTransport:
        @staticmethod
        def enumerate(usb_ids=None):
            log('list-hid')
            return [_Dev('hid:1-%%d:1.0' %% i) for i in range(CFG.get('hid', 0))]
class _WebUsb:
    class WebUsbTransport:
        @staticmethod
        def enumerate(usb_reset=False, usb_ids=None):
            log('list-webusb')
            return [_Dev('webusb:001:%%d' %% (i + 2)) for i in range(CFG.get('devices', 1))]
class _Udp:
    class UdpTransport:
        @classmethod
        def enumerate(cls, path=None):
            log('udp'); return []
hid, webusb, udp = _Hid, _WebUsb, _Udp

def get_path_transport(path, hid_ids, webusb_ids, sim_path):
    log('ORIGINAL-get_path_transport')       # the helper must replace this
    udp.UdpTransport.enumerate(sim_path)
    raise BadArgumentError('Could not find device by path: ' + path)

class _Features: pass
class _Key:
    def __init__(self, fp, xpub): self.parent_fingerprint = bytes.fromhex(fp); self._x = xpub
    def to_string(self): return self._x
class _Inner:
    def cancel(self): log('cancel')

class TrezorClient:
    def __init__(self, path, password=None, **kw):
        assert password == '', 'helper must use the standard wallet (empty passphrase)'
        self.transport = get_path_transport(path, set(), set(), '127.0.0.1:21324')
        log('open ' + path)
        self.client = _Inner()
    def _prepare_device(self):
        log('init')                           # = Initialize: cancels a pending PIN request
        f = _Features()
        f.vendor = CFG.get('vendor', 'trezor.io'); f.model = CFG.get('model', '1')
        f.initialized = not CFG.get('no_seed'); f.pin_protection = True
        f.unlocked = not CFG.get('locked'); f.passphrase_protection = bool(CFG.get('passphrase'))
        f.major_version, f.minor_version, f.patch_version = 1, 12, 1
        self.client.features = f
    def get_pubkey_at_path(self, path):
        self._prepare_device()
        if CFG.get('locked'): raise DeviceNotReadyError('Trezor is locked')
        log('getxpub ' + path)
        return _Key(CFG.get('xfp', '%s'), CFG.get('xpub', '%s'))
    def prompt_pin(self):
        self._prepare_device()
        if not CFG.get('locked'): raise DeviceAlreadyUnlockedError('already')
        log('prompt')
    def send_pin(self, pin):
        log('sendpin len=%%d' %% len(pin))
        if CFG.get('already_unlocked'): raise DeviceAlreadyUnlockedError('already')
        return pin == '%s'
    def sign_tx(self, tx):
        self._prepare_device()
        log('sign')
        mode = CFG.get('sign', 'approve')
        if mode == 'cancel': raise ActionCanceledError('sign_tx canceled')
        if mode == 'busy': raise DeviceBusyError('busy')
        if mode == 'outdated': raise OutdatedFirmwareError('old')
        if mode == 'failure': raise TrezorFailure('DataError: Unsupported script type')
        if mode == 'prevmissing': raise BadArgumentError('Previous transaction abcd not available')
        if mode == 'hang': time.sleep(30)
        if mode == 'badresult':
            class _B:
                def serialize(self): return 'aGVsbG8='
            return _B()
        if mode != 'nochange': tx.data = tx.data + b'SIGNED-BY-FAKE-TREZOR'
        return tx
    def close(self): log('close')
''' % (PAIRED_XFP, PAIRED_XPUB, PIN)


def make_fakes(root):
    pkg = os.path.join(root, 'hwilib')
    os.makedirs(os.path.join(pkg, 'devices', 'trezorlib'))
    files = {
        'hwilib/__init__.py': '', 'hwilib/errors.py': FAKE_ERRORS, 'hwilib/psbt.py': FAKE_PSBT,
        'hwilib/devices/__init__.py': '', 'hwilib/devices/trezor.py': FAKE_TREZOR,
        'hwilib/devices/trezorlib/__init__.py': '', 'hwilib/devices/trezorlib/exceptions.py': FAKE_TZEXC,
    }
    for rel, text in files.items():
        with open(os.path.join(root, rel), 'w') as f:
            f.write(text)


def run(tmp, request, cfg=None, fakes=True, raw=None, env_extra=None):
    req = os.path.join(tmp, 'REQ.json'); res = os.path.join(tmp, 'RES.json'); logf = os.path.join(tmp, 'log.txt')
    for p in (res, logf):
        if os.path.exists(p): os.remove(p)
    with open(req, 'w') as f:
        f.write(raw if raw is not None else json.dumps(request))
    env = dict(os.environ, FAKE_TZ=json.dumps(cfg or {}), FAKE_TZ_LOG=logf, PYTHONDONTWRITEBYTECODE='1')
    env['PYTHONPATH'] = os.path.join(tmp, 'fakes') if fakes else os.path.join(tmp, 'empty')
    env['SAFEKEEP_TZ_PAIRING'] = os.path.join(tmp, 'settings', 'trezor-pairing.json')
    env.update(env_extra or {})
    p = subprocess.run([sys.executable, '-S', HELPER, req, res], env=env, capture_output=True, text=True, timeout=60)
    result = json.load(open(res))
    log = open(logf).read().split('\n') if os.path.exists(logf) else []
    return p.returncode, result, log, os.path.exists(req), p.stdout + p.stderr


def set_pairing(tmp, xfp=PAIRED_XFP, xpub=PAIRED_XPUB, raw=None):
    d = os.path.join(tmp, 'settings'); os.makedirs(d, exist_ok=True)
    path = os.path.join(d, 'trezor-pairing.json')
    if xfp is None and raw is None:
        if os.path.exists(path): os.remove(path)
        return
    with open(path, 'w') as f:
        f.write(raw if raw is not None else json.dumps({'xfp': xfp, 'id_xpub': xpub}))


def read_pairing(tmp):
    path = os.path.join(tmp, 'settings', 'trezor-pairing.json')
    return json.load(open(path)) if os.path.exists(path) else None


REAL_LIB_CHECK = textwrap.dedent('''
    import importlib.util, socket, sys
    def no_socket(*a, **k):
        raise AssertionError('helper opened a network socket')
    socket.socket = no_socket
    spec = importlib.util.spec_from_file_location('sk_trezor', sys.argv[1])
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    h = m.Hwi()
    import hwilib
    from hwilib.devices import trezor as tz
    assert tz.udp.UdpTransport.enumerate() == [], 'simulator probe still on'
    try:
        tz.TrezorClient('webusb:999:9', password='')
        print('FAIL opened a device that is not there')
    except h.errors.BadArgumentError as e:
        f = m.translate(h, e)
        print('OK', hwilib.__version__ if hasattr(hwilib, '__version__') else '?', f.status)
''')


def main():
    psbt = open(FIXTURE, 'rb').read() if os.path.exists(FIXTURE) else b'psbt\xff' + b'\x00' * 50
    psbt_b64 = base64.b64encode(psbt).decode()
    good = {'action': 'sign', 'psbt_b64': psbt_b64}
    pair_req = {'action': 'pair', 'expected_xfp': PAIRED_XFP, 'expected_xpub': PAIRED_XPUB}
    send_req = {'action': 'send_pin', 'path': PATH0, 'pin_positions': PIN}
    passed = failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        make_fakes(os.path.join(tmp, 'fakes')); os.makedirs(os.path.join(tmp, 'empty'))

        def check(name, cond, detail=''):
            nonlocal passed, failed
            if cond: passed += 1; print('  ok   ' + name)
            else: failed += 1; print('  FAIL ' + name + ('  -> ' + detail if detail else ''))

        def no_network(log):
            return not any(l in ('udp', 'ORIGINAL-get_path_transport') for l in log)

        print('detect')
        rc, r, log, left, out = run(tmp, {'action': 'detect'})
        check('detect unlocked Trezor One', r.get('status') == 'detected' and r.get('xfp') == PAIRED_XFP and r.get('id_xpub') == PAIRED_XPUB and r.get('path') == PATH0 and r.get('locked') is False and rc == 0, str(r))
        check('identity key read at m/0h', 'getxpub m/0h' in log, str(log))
        check('request file deleted', not left)
        check('no simulator/network probe', no_network(log), str(log))
        rc, r, log, *_ = run(tmp, {'action': 'detect'}, {'locked': True})
        check('locked Trezor -> detected, locked, path, no fingerprint', r.get('status') == 'detected' and r.get('locked') is True and r.get('path') == PATH0 and 'xfp' not in r, str(r))
        rc, r, *_ = run(tmp, {'action': 'detect'}, {'passphrase': True})
        check('passphrase protection reported', r.get('passphrase_protection') is True, str(r))
        rc, r, *_ = run(tmp, {'action': 'detect'}, {'devices': 0})
        check('no Trezor -> not_connected', r.get('status') == 'not_connected' and rc == 3, str(r))
        rc, r, *_ = run(tmp, {'action': 'detect'}, {'devices': 2})
        check('two Trezors -> multiple_devices', r.get('status') == 'multiple_devices', str(r))
        rc, r, *_ = run(tmp, {'action': 'detect'}, {'devices': 1, 'hid': 1})
        check('old-firmware HID Trezor + WebUSB Trezor -> multiple_devices', r.get('status') == 'multiple_devices', str(r))
        rc, r, *_ = run(tmp, {'action': 'detect'}, {'model': 'T'})
        check('Trezor Model T -> unsupported_model', r.get('status') == 'unsupported_model', str(r))
        rc, r, *_ = run(tmp, {'action': 'detect'}, {'vendor': 'keepkey.com'})
        check('not a Trezor -> unsupported_model', r.get('status') == 'unsupported_model', str(r))
        rc, r, *_ = run(tmp, {'action': 'detect'}, {'no_seed': True})
        check('no seed set up -> no_seed', r.get('status') == 'no_seed', str(r))

        print('PIN')
        rc, r, log, *_ = run(tmp, {'action': 'prompt_pin', 'path': PATH0}, {'locked': True})
        check('prompt_pin -> pin_requested', r.get('status') == 'pin_requested' and 'prompt' in log and rc == 0, str(r))
        rc, r, log, *_ = run(tmp, {'action': 'prompt_pin', 'path': PATH0})
        check('prompt_pin when already unlocked -> unlocked', r.get('status') == 'unlocked', str(r))
        rc, r, log, *_ = run(tmp, {'action': 'prompt_pin', 'path': 'webusb:001:9'}, {'locked': True})
        check('prompt_pin for a path that is gone -> not_connected, nothing sent', r.get('status') == 'not_connected' and 'prompt' not in log, str(r))
        rc, r, log, left, out = run(tmp, send_req, {'locked': True})
        check('send_pin correct positions -> unlocked', r.get('status') == 'unlocked' and rc == 0, str(r))
        check('send_pin did NOT reset the Trezor (no Initialize)', 'init' not in log, str(log))
        check('send_pin opened by path, USB listing only', ('open ' + PATH0) in log and no_network(log), str(log))
        check('request file (with PIN) deleted', not left)
        check('PIN positions not in result or output', PIN not in json.dumps(r) and PIN not in out, out[:200])
        rc, r, log, left, out = run(tmp, dict(send_req, pin_positions='1111'), {'locked': True})
        check('wrong PIN -> wrong_pin', r.get('status') == 'wrong_pin' and rc == 3, str(r))
        check('  ...positions not echoed', '1111' not in json.dumps(r) and '1111' not in out)
        rc, r, *_ = run(tmp, send_req, {'already_unlocked': True})
        check('send_pin when already unlocked -> unlocked', r.get('status') == 'unlocked', str(r))
        rc, r, log, *_ = run(tmp, dict(send_req, path='webusb:001:9'), {'locked': True})
        check('send_pin for a path that is gone -> not_connected, no PIN sent', r.get('status') == 'not_connected' and not any(l.startswith('sendpin') for l in log), str(r))
        for bad_pin in ('', '0', '12a', '1234567890', '7 3', 7359, None, '١٢٣'):
            rc, r, log, left, out = run(tmp, dict(send_req, pin_positions=bad_pin), {'locked': True})
            check('PIN %r -> bad_request, device untouched' % (bad_pin,), r.get('status') == 'bad_request' and not any(l.startswith('open') for l in log) and not left, str(r))
        set_pairing(tmp)
        rc, r, log, *_ = run(tmp, good, {'locked': True})
        check('sign while locked -> locked, nothing sent', r.get('status') == 'locked' and 'sign' not in log, str(r))

        print('pairing')
        set_pairing(tmp, None)
        rc, r, *_ = run(tmp, good)
        check('sign before pairing -> not_paired', r.get('status') == 'not_paired', str(r))
        rc, r, *_ = run(tmp, pair_req)
        pr = read_pairing(tmp)
        check('pair confirmed device -> paired + saved', r.get('status') == 'paired' and pr and pr.get('xfp') == PAIRED_XFP and pr.get('id_xpub') == PAIRED_XPUB, str(r))
        check('pairing file is private (0600)', pr is not None and (os.stat(os.path.join(tmp, 'settings', 'trezor-pairing.json')).st_mode & 0o077) == 0)
        set_pairing(tmp, None)
        rc, r, *_ = run(tmp, pair_req, {'xfp': 'deadbeef'})
        check('pair when a different Trezor is plugged in -> wrong_device, nothing saved', r.get('status') == 'wrong_device' and read_pairing(tmp) is None, str(r))
        rc, r, *_ = run(tmp, pair_req, {'xpub': OTHER_XPUB})
        check('pair: same fingerprint, different key -> wrong_device, nothing saved', r.get('status') == 'wrong_device' and read_pairing(tmp) is None, str(r))
        rc, r, *_ = run(tmp, pair_req, {'locked': True})
        check('pair while locked -> locked', r.get('status') == 'locked' and read_pairing(tmp) is None, str(r))
        set_pairing(tmp)
        rc, r, log, *_ = run(tmp, {'action': 'unpair'}, {'devices': 0})
        check('unpair -> unpaired + file removed (no device needed)', r.get('status') == 'unpaired' and read_pairing(tmp) is None, str(r))
        rc, r, *_ = run(tmp, {'action': 'unpair'})
        check('unpair when not paired -> still ok', r.get('status') == 'unpaired', str(r))
        rc, r, *_ = run(tmp, {'action': 'unpair'}, fakes=False)
        check('unpair works even without the library', r.get('status') == 'unpaired', str(r))
        set_pairing(tmp, raw='{"xfp": "zz"}')
        rc, r, log, *_ = run(tmp, good)
        check('damaged pairing file -> error, nothing sent', r.get('status') == 'error' and 'damaged' in r.get('error', '') and 'sign' not in log, str(r))
        set_pairing(tmp, raw='{"xfp": "c0ffee01", "master_xpub": "' + PAIRED_XPUB + '"}')
        rc, r, *_ = run(tmp, good)
        check('Coldcard-style pairing file is not accepted', r.get('status') == 'error', str(r))
        rc, r, *_ = run(tmp, dict(good, request_id='abc-123'))
        check('request_id echoed', r.get('request_id') == 'abc-123', str(r))
        rc, r, *_ = run(tmp, dict(good, request_id='bad id $(x)'))
        check('invalid request_id not echoed', 'request_id' not in r, str(r))

        print('sign')
        set_pairing(tmp)
        rc, r, log, left, out = run(tmp, good)
        res = base64.b64decode(r.get('psbt_b64', '')) if r.get('psbt_b64') else b''
        check('approve -> signed PSBT returned', r.get('status') == 'signed' and res == psbt + b'SIGNED-BY-FAKE-TREZOR' and r.get('changed') is True and rc == 0, str(r)[:200])
        check('device closed afterwards', 'close' in log)
        check('request file deleted', not left)
        check('no simulator/network probe', no_network(log), str(log))
        rc, r, *_ = run(tmp, good, {'sign': 'nochange'})
        check('Trezor not a cosigner -> signed, changed=false', r.get('status') == 'signed' and r.get('changed') is False, str(r)[:200])
        rc, r, *_ = run(tmp, good, {'sign': 'cancel'})
        check('declined on Trezor -> refused', r.get('status') == 'refused', str(r))
        rc, r, *_ = run(tmp, good, {'sign': 'busy'})
        check('Trezor busy -> busy', r.get('status') == 'busy', str(r))
        rc, r, *_ = run(tmp, good, {'sign': 'outdated'})
        check('old firmware -> outdated_firmware', r.get('status') == 'outdated_firmware', str(r))
        rc, r, *_ = run(tmp, good, {'sign': 'failure'})
        check('Trezor rejects PSBT -> rejected (with reason)', r.get('status') == 'rejected' and 'Unsupported' in r.get('error', ''), str(r))
        rc, r, *_ = run(tmp, good, {'sign': 'badresult'})
        check('non-PSBT result -> error', r.get('status') == 'error', str(r))
        rc, r, log, *_ = run(tmp, good, {'no_prev': True})
        check('input without full previous tx -> missing_prev_tx, nothing sent', r.get('status') == 'missing_prev_tx' and 'sign' not in log and 'file' in r.get('error', ''), str(r))
        rc, r, log, *_ = run(tmp, good, {'sign': 'prevmissing'})
        check('Trezor asks for a missing previous tx -> missing_prev_tx', r.get('status') == 'missing_prev_tx', str(r))
        check('  ...and the Trezor is told to cancel (not left stuck)', 'cancel' in log, str(log))
        rc, r, log, *_ = run(tmp, good, {'sign': 'cancel'})
        check('declined on Trezor -> Trezor told to cancel too', 'cancel' in log, str(log))
        rc, r, *_ = run(tmp, good, {'sign': 'hang'}, env_extra={'SAFEKEEP_TZ_TIMEOUT': '2'})
        check('stuck USB call -> timeout, result still written', r.get('status') == 'timeout' and rc == 3, str(r))

        print('device identity')
        rc, r, *_ = run(tmp, dict(good, expected_xfp='deadbeef', expected_xpub=OTHER_XPUB))
        check('browser cannot override pairing (ignored expected_* fields)', r.get('status') == 'signed', str(r)[:150])
        rc, r, log, *_ = run(tmp, good, {'xfp': 'deadbeef'})
        check('different fingerprint -> wrong_device', r.get('status') == 'wrong_device', str(r))
        check('  ...and nothing was sent to sign', 'sign' not in log, str(log))
        rc, r, log, *_ = run(tmp, good, {'xfp': 'deadbeef', 'passphrase': True})
        check('  ...with passphrase hint when passphrase protection is on', 'passphrase' in r.get('error', ''), str(r))
        rc, r, log, *_ = run(tmp, good, {'xpub': OTHER_XPUB})
        check('same fingerprint, different key -> wrong_device', r.get('status') == 'wrong_device' and 'sign' not in log, str(r))

        print('bad requests (nothing touches the device)')
        bad = [
            ('not JSON', None, 'garbage{'),
            ('JSON list', None, '[1,2]'),
            ('unknown action', {'action': 'run', 'command': 'id'}, None),
            ('Coldcard-only action', {'action': 'check_mitm'}, None),
            ('missing PSBT', dict(good, psbt_b64=''), None),
            ('PSBT not base64', dict(good, psbt_b64='@@notbase64@@'), None),
            ('base64 but not a PSBT', dict(good, psbt_b64=base64.b64encode(b'hello').decode()), None),
            ('pair: bad fingerprint', dict(pair_req, expected_xfp='zz; rm -rf /'), None),
            ('pair: missing xpub', dict(pair_req, expected_xpub=None), None),
            ('pair: xpub with junk', dict(pair_req, expected_xpub=PAIRED_XPUB + '$(id)'), None),
            ('prompt_pin: no path', {'action': 'prompt_pin'}, None),
            ('prompt_pin: simulator path', {'action': 'prompt_pin', 'path': 'udp:127.0.0.1:21324'}, None),
            ('prompt_pin: path with shell junk', {'action': 'prompt_pin', 'path': 'webusb:001:2;id'}, None),
            ('send_pin: no path', {'action': 'send_pin', 'pin_positions': PIN}, None),
        ]
        for name, req, raw in bad:
            rc, r, log, left, out = run(tmp, req, raw=raw)
            check(name + ' -> bad_request', r.get('status') == 'bad_request' and not any(l.startswith('open') for l in log) and not left, str(r))
        rc, r, *_ = run(tmp, None, raw='x' * (8 * 1024 * 1024 + 10))
        check('oversized request -> bad_request', r.get('status') == 'bad_request', str(r))

        print('install')
        rc, r, *_ = run(tmp, {'action': 'detect'}, fakes=False)
        check('library missing -> not_installed', r.get('status') == 'not_installed', str(r))

        real = os.environ.get('SAFEKEEP_TEST_HWI_PYTHON')
        if real:
            print('real HWI library (no hardware)')
            p = subprocess.run([real, '-c', REAL_LIB_CHECK, HELPER], capture_output=True, text=True, timeout=60,
                               env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
            outp = (p.stdout + p.stderr).strip()
            check('real HWI: simulator probe off, no socket opened, missing device -> not_connected',
                  p.returncode == 0 and outp.startswith('OK') and outp.endswith('not_connected'), outp[-300:])

    print('\nTREZOR HELPER: %d passed, %d failed' % (passed, failed))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())

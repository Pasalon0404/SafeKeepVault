#!/usr/bin/env python3
"""
Tests for usbbootdrive/safekeep-coldcard.py using a FAKE Coldcard.

    python3 usbbootdrive/tests/test-coldcard-helper.py

No hardware needed. A fake `hid` + `ckcc` package is generated in a temp dir
and put first on PYTHONPATH; its behaviour is chosen per test via the
FAKE_CC env var. Real-hardware testing is separate (see the design plan).
"""
import base64, json, os, struct, subprocess, sys, tempfile, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, '..', 'safekeep-coldcard.py')
FIXTURE = os.path.join(HERE, '..', '..', 'test-fixtures', 'cctest2.psbt')

PAIRED_XFP = 'decaf002'
PAIRED_XPUB = 'xpub' + ('A' * 107)
OTHER_XPUB = 'xpub' + ('B' * 107)

FAKE_HID = '''
import json, os
def enumerate(vid, pid):
    n = json.loads(os.environ.get('FAKE_CC', '{}')).get('devices', 1)
    return [{'serial_number': 'SN%d' % i, 'path': b'p%d' % i} for i in range(n)]
'''

FAKE_PROTOCOL = '''
class CCProtoError(RuntimeError): pass
class CCUserRefused(RuntimeError): pass
class CCBusyError(RuntimeError): pass
class CCProtocolPacker:
    @staticmethod
    def sign_transaction(length, sha, finalize=False, flags=0, miniscript_name=None):
        assert not finalize and flags == 0, 'helper must never ask to finalize'
        return ('stxn', length)
    @staticmethod
    def get_signed_txn():
        return ('stok',)
'''

FAKE_CLIENT = '''
import json, os, struct, hashlib
from ckcc.protocol import CCProtoError, CCUserRefused, CCBusyError
CFG = json.loads(os.environ.get('FAKE_CC', '{}'))
LOG = os.environ['FAKE_CC_LOG']
def log(x):
    with open(LOG, 'a') as f: f.write(x + '\\n')
class ColdcardDevice:
    def __init__(self, sn=None, encrypt=True, **kw):
        assert encrypt, 'USB encryption must stay on'
        log('open ' + str(sn))
        self.serial = sn
        self.master_fingerprint = None if CFG.get('no_seed') else struct.unpack('<I', bytes.fromhex(CFG.get('xfp', '%s')))[0]
        self.master_xpub = None if CFG.get('no_seed') else CFG.get('xpub', '%s')
        self.data = None
    def close(self): log('close')
    def check_mitm(self, expected_xpub=None, sig=None):
        log('mitm ' + str(expected_xpub)[:8])
        if CFG.get('mitm_fail'): raise RuntimeError('Possible active MiTM attack')
    def upload_file(self, data, verify=True, blksize=1024):
        log('upload %%d' %% len(data)); self.data = data
        return len(data), hashlib.sha256(data).digest()
    def send_recv(self, msg, timeout=Ellipsis, **kw):
        if msg[0] == 'stxn':
            log('sign'); return None
        mode = CFG.get('sign', 'approve')
        if mode == 'refuse': raise CCUserRefused()
        if mode == 'busy': raise CCBusyError()
        if mode == 'proto': raise CCProtoError('Coldcard Error: PSBT does not contain any key path information.')
        if mode == 'hang': return None
        if mode == 'garbage': return ('x',)
        self.signed = self.data + b'SIGNED-BY-FAKE'
        return (len(self.signed), hashlib.sha256(self.signed).digest())
    def download_file(self, length, checksum, blksize=1024, file_number=1):
        log('download'); return b'notpsbt' if CFG.get('sign') == 'badresult' else self.signed
''' % (PAIRED_XFP, PAIRED_XPUB)

def make_fakes(root):
    os.makedirs(os.path.join(root, 'ckcc'))
    open(os.path.join(root, 'hid.py'), 'w').write(FAKE_HID)
    open(os.path.join(root, 'ckcc', '__init__.py'), 'w').write('')
    open(os.path.join(root, 'ckcc', 'protocol.py'), 'w').write(FAKE_PROTOCOL)
    open(os.path.join(root, 'ckcc', 'client.py'), 'w').write(FAKE_CLIENT)

def run(tmp, request, cfg=None, fakes=True, raw=None, env_extra=None):
    req = os.path.join(tmp, 'REQ.json'); res = os.path.join(tmp, 'RES.json'); logf = os.path.join(tmp, 'log.txt')
    for p in (res, logf):
        if os.path.exists(p): os.remove(p)
    with open(req, 'w') as f:
        f.write(raw if raw is not None else json.dumps(request))
    env = dict(os.environ, FAKE_CC=json.dumps(cfg or {}), FAKE_CC_LOG=logf, PYTHONDONTWRITEBYTECODE='1')
    env['PYTHONPATH'] = os.path.join(tmp, 'fakes') if fakes else os.path.join(tmp, 'empty')
    env.update(env_extra or {})
    rc = subprocess.run([sys.executable, '-S', HELPER, req, res], env=env, capture_output=True, text=True, timeout=60).returncode
    result = json.load(open(res))
    log = open(logf).read().split('\n') if os.path.exists(logf) else []
    return rc, result, log, os.path.exists(req)

def main():
    psbt = open(FIXTURE, 'rb').read() if os.path.exists(FIXTURE) else b'psbt\xff' + b'\x00' * 50
    psbt_b64 = base64.b64encode(psbt).decode()
    good = {'action': 'sign', 'psbt_b64': psbt_b64, 'expected_xfp': PAIRED_XFP, 'expected_xpub': PAIRED_XPUB}
    passed = failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        make_fakes(os.path.join(tmp, 'fakes')); os.makedirs(os.path.join(tmp, 'empty'))

        def check(name, cond, detail=''):
            nonlocal passed, failed
            if cond: passed += 1; print('  ok   ' + name)
            else: failed += 1; print('  FAIL ' + name + ('  -> ' + detail if detail else ''))

        print('detect')
        rc, r, log, left = run(tmp, {'action': 'detect'})
        check('detect paired device', r.get('status') == 'detected' and r.get('xfp') == PAIRED_XFP and r.get('master_xpub') == PAIRED_XPUB and rc == 0, str(r))
        check('request file deleted', not left)
        rc, r, *_ = run(tmp, {'action': 'detect'}, {'devices': 0})
        check('no Coldcard -> not_connected', r.get('status') == 'not_connected' and rc == 3, str(r))
        rc, r, *_ = run(tmp, {'action': 'detect'}, {'devices': 2})
        check('two Coldcards -> multiple_devices', r.get('status') == 'multiple_devices', str(r))
        rc, r, *_ = run(tmp, {'action': 'detect'}, {'no_seed': True})
        check('locked / no seed -> no_seed', r.get('status') == 'no_seed', str(r))

        print('sign')
        rc, r, log, left = run(tmp, good)
        out = base64.b64decode(r.get('psbt_b64', '')) if r.get('psbt_b64') else b''
        check('approve -> signed PSBT returned', r.get('status') == 'signed' and out == psbt + b'SIGNED-BY-FAKE' and rc == 0, str(r)[:200])
        check('anti-MiTM check used the PAIRED xpub', ('mitm ' + PAIRED_XPUB[:8]) in log, str(log))
        check('device closed afterwards', 'close' in log)
        check('request file deleted', not left)
        rc, r, *_ = run(tmp, good, {'sign': 'refuse'})
        check('declined on device -> refused', r.get('status') == 'refused', str(r))
        rc, r, *_ = run(tmp, good, {'sign': 'busy'})
        check('device busy -> busy', r.get('status') == 'busy', str(r))
        rc, r, *_ = run(tmp, good, {'sign': 'proto'})
        check('device rejects PSBT -> rejected (with reason)', r.get('status') == 'rejected' and 'key path' in r.get('error', ''), str(r))
        rc, r, *_ = run(tmp, good, {'sign': 'hang'}, env_extra={'SAFEKEEP_CC_TIMEOUT': '1'})
        check('no answer -> timeout', r.get('status') == 'timeout', str(r))
        rc, r, *_ = run(tmp, good, {'sign': 'garbage'})
        check('odd reply -> error', r.get('status') == 'error', str(r))
        rc, r, *_ = run(tmp, good, {'sign': 'badresult'})
        check('non-PSBT result -> error', r.get('status') == 'error', str(r))

        print('device identity')
        rc, r, log, _ = run(tmp, good, {'xfp': 'deadbeef'})
        check('different fingerprint -> wrong_device', r.get('status') == 'wrong_device', str(r))
        check('  ...and nothing was uploaded', not any(l.startswith('upload') for l in log), str(log))
        rc, r, log, _ = run(tmp, good, {'xpub': OTHER_XPUB})
        check('same fingerprint, different xpub -> wrong_device', r.get('status') == 'wrong_device', str(r))
        rc, r, log, _ = run(tmp, good, {'mitm_fail': True})
        check('authenticity check fails -> mitm_failed', r.get('status') == 'mitm_failed', str(r))
        check('  ...and nothing was uploaded', not any(l.startswith('upload') for l in log), str(log))

        print('bad requests (nothing touches the device)')
        bad = [
            ('not JSON', None, 'garbage{'),
            ('JSON list', None, '[1,2]'),
            ('unknown action', {'action': 'run', 'command': 'id'}, None),
            ('old-style command field', {'action': 'sign', 'command': 'touch /tmp/pwned'}, None),
            ('missing PSBT', dict(good, psbt_b64=''), None),
            ('PSBT not base64', dict(good, psbt_b64='@@notbase64@@'), None),
            ('base64 but not a PSBT', dict(good, psbt_b64=base64.b64encode(b'hello').decode()), None),
            ('bad fingerprint', dict(good, expected_xfp='zz; rm -rf /'), None),
            ('missing xpub', dict(good, expected_xpub=None), None),
            ('xpub with junk', dict(good, expected_xpub=PAIRED_XPUB + '$(id)'), None),
        ]
        for name, req, raw in bad:
            rc, r, log, left = run(tmp, req, raw=raw)
            check(name + ' -> bad_request', r.get('status') == 'bad_request' and not any(l.startswith('open') for l in log) and not left, str(r))
        rc, r, *_ = run(tmp, None, raw='x' * (8 * 1024 * 1024 + 10))
        check('oversized request -> bad_request', r.get('status') == 'bad_request', str(r))

        print('install')
        rc, r, *_ = run(tmp, {'action': 'detect'}, fakes=False)
        check('library missing -> not_installed', r.get('status') == 'not_installed', str(r))

    print('\nCOLDCARD HELPER: %d passed, %d failed' % (passed, failed))
    return 1 if failed else 0

if __name__ == '__main__':
    sys.exit(main())

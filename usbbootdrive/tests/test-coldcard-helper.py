#!/usr/bin/env python3
"""
Tests for usbbootdrive/safekeep-coldcard.py using a FAKE Coldcard.

    python3 usbbootdrive/tests/test-coldcard-helper.py

No hardware needed. A fake `hid` + `ckcc` package is generated in a temp dir
and put first on PYTHONPATH; its behavior is chosen per test via the
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
    @staticmethod
    def get_xpub(subpath='m'):
        return ('xpub', subpath)
    @staticmethod
    def start_backup():
        return ('back',)
    @staticmethod
    def get_backup_file():
        return ('bkok',)
    @staticmethod
    def bip39_passphrase(pw):
        return ('pass', pw)
    @staticmethod
    def get_passphrase_done():
        return ('pwok',)
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
        if msg[0] == 'xpub':
            log('getxpub ' + msg[1])
            if CFG.get('xpub_mode') == 'busy': raise CCBusyError()
            if CFG.get('xpub_mode') == 'proto': raise CCProtoError('bad path')
            return CFG.get('ms_xpub', 'xpub' + 'M' * 107)
        if msg[0] == 'stxn':
            log('sign'); return None
        if msg[0] == 'back':
            log('backup-start'); return None
        if msg[0] == 'pass':
            log('pass ' + json.dumps(msg[1])); return None
        if msg[0] == 'pwok':
            pm = CFG.get('pass', 'approve')
            if pm == 'refuse': raise CCUserRefused()
            if pm == 'busy': raise CCBusyError()
            if pm == 'proto': raise CCProtoError('Coldcard Error: no seed')
            if pm == 'hang': return None
            if pm == 'garbage': return 'not an xpub'
            return 'xpub' + 'P' * 107
        if msg[0] == 'bkok':
            bm = CFG.get('backup', 'approve')
            if bm == 'refuse': raise CCUserRefused()
            if bm == 'busy': raise CCBusyError()
            if bm == 'proto': raise CCProtoError('Coldcard Error: no seed')
            if bm == 'hang': return None
            self.bk = b"7z\\xbc\\xaf'\\x1c" + b'\\x00\\x04' + b'ENCRYPTED' * 50
            if bm == 'not7z': self.bk = b'# Coldcard backup file! DO NOT CHANGE.\\n'
            if bm == 'huge': return (10 * 1024 * 1024, hashlib.sha256(b'x').digest())
            sha = hashlib.sha256(self.bk).digest()
            if bm == 'badsha': sha = hashlib.sha256(b'other').digest()
            return (len(self.bk), sha)
        mode = CFG.get('sign', 'approve')
        if mode == 'refuse': raise CCUserRefused()
        if mode == 'busy': raise CCBusyError()
        if mode == 'proto': raise CCProtoError('Coldcard Error: PSBT does not contain any key path information.')
        if mode == 'hang': return None
        if mode == 'garbage': return ('x',)
        self.signed = self.data + b'SIGNED-BY-FAKE'
        return (len(self.signed), hashlib.sha256(self.signed).digest())
    def download_file(self, length, checksum, blksize=1024, file_number=1):
        if file_number == 0:
            log('download-backup'); return self.bk
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
    env['SAFEKEEP_CC_PAIRING'] = os.path.join(tmp, 'settings', 'coldcard-pairing.json')
    env.update(env_extra or {})
    rc = subprocess.run([sys.executable, '-S', HELPER, req, res], env=env, capture_output=True, text=True, timeout=60).returncode
    result = json.load(open(res))
    log = open(logf).read().split('\n') if os.path.exists(logf) else []
    return rc, result, log, os.path.exists(req)

def set_pairing(tmp, xfp=PAIRED_XFP, xpub=PAIRED_XPUB, raw=None):
    d = os.path.join(tmp, 'settings'); os.makedirs(d, exist_ok=True)
    path = os.path.join(d, 'coldcard-pairing.json')
    if xfp is None and raw is None:
        if os.path.exists(path): os.remove(path)
        return
    with open(path, 'w') as f:
        f.write(raw if raw is not None else json.dumps({'xfp': xfp, 'master_xpub': xpub, 'serial': 'SN0'}))

def read_pairing(tmp):
    path = os.path.join(tmp, 'settings', 'coldcard-pairing.json')
    return json.load(open(path)) if os.path.exists(path) else None

def main():
    psbt = open(FIXTURE, 'rb').read() if os.path.exists(FIXTURE) else b'psbt\xff' + b'\x00' * 50
    psbt_b64 = base64.b64encode(psbt).decode()
    good = {'action': 'sign', 'psbt_b64': psbt_b64}
    pair_req = {'action': 'pair', 'expected_xfp': PAIRED_XFP, 'expected_xpub': PAIRED_XPUB}
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

        print('xpub (multisig cosigner import)')
        MS = 'xpub' + 'M' * 107
        for deriv in ("m/48'/0'/0'/2'", "m/48'/0'/0'/1'", "m/48'/0'/0'/0'"):
            rc, r, log, left = run(tmp, {'action': 'xpub', 'deriv': deriv})
            check('xpub %s: fingerprint + key' % deriv,
                  r.get('status') == 'xpub' and r.get('xfp') == PAIRED_XFP and r.get('xpub') == MS and r.get('deriv') == deriv
                  and ('getxpub ' + deriv) in log and 'close' in log and rc == 0 and not left, str(r) + ' ' + str(log))
        check('xpub needs no pairing and saves nothing', read_pairing(tmp) is None)
        for bad in ("m/84'/0'/0'", "m/48'/0'/1'/2'", "m/48'/1'/0'/2'", 'm/48h/0h/0h/2h', "m/48'/0'/0'/2'/0", '', None, 5):
            rc, r, log, left = run(tmp, {'action': 'xpub', 'deriv': bad})
            check('xpub refuses path %r' % (bad,), r.get('status') == 'bad_request' and not any(l.startswith('getxpub') for l in log), str(r))
        rc, r, *_ = run(tmp, {'action': 'xpub', 'deriv': "m/48'/0'/0'/2'"}, {'devices': 0})
        check('xpub with no Coldcard -> not_connected', r.get('status') == 'not_connected', str(r))
        rc, r, *_ = run(tmp, {'action': 'xpub', 'deriv': "m/48'/0'/0'/2'"}, {'no_seed': True})
        check('xpub on a locked Coldcard -> no_seed', r.get('status') == 'no_seed', str(r))
        rc, r, *_ = run(tmp, {'action': 'xpub', 'deriv': "m/48'/0'/0'/2'"}, {'ms_xpub': 'tpub' + 'M' * 107})
        check('xpub on a testnet Coldcard -> clear error', r.get('status') == 'error' and 'Testnet' in r.get('error', ''), str(r))
        rc, r, *_ = run(tmp, {'action': 'xpub', 'deriv': "m/48'/0'/0'/2'"}, {'ms_xpub': 'not-a-key'})
        check('xpub refuses a malformed key', r.get('status') == 'error', str(r))
        rc, r, *_ = run(tmp, {'action': 'xpub', 'deriv': "m/48'/0'/0'/2'"}, {'xpub_mode': 'busy'})
        check('xpub while busy -> busy', r.get('status') == 'busy', str(r))
        rc, r, *_ = run(tmp, {'action': 'xpub', 'deriv': "m/48'/0'/0'/2'"}, {'xpub_mode': 'proto'})
        check('xpub refused by the Coldcard -> rejected', r.get('status') == 'rejected', str(r))

        print('pairing')
        set_pairing(tmp, None)
        rc, r, *_ = run(tmp, good)
        check('sign before pairing -> not_paired', r.get('status') == 'not_paired', str(r))
        rc, r, log, left = run(tmp, pair_req)
        pr = read_pairing(tmp)
        check('pair confirmed device -> paired + saved', r.get('status') == 'paired' and pr and pr.get('xfp') == PAIRED_XFP and pr.get('master_xpub') == PAIRED_XPUB, str(r))
        check('pairing file is private (0600)', pr is not None and (os.stat(os.path.join(tmp, 'settings', 'coldcard-pairing.json')).st_mode & 0o077) == 0)
        set_pairing(tmp, None)
        rc, r, *_ = run(tmp, pair_req, {'xfp': 'deadbeef'})
        check('pair when a different device is plugged in -> wrong_device, nothing saved', r.get('status') == 'wrong_device' and read_pairing(tmp) is None, str(r))
        rc, r, *_ = run(tmp, dict(pair_req, expected_xfp='nothex!!'))
        check('pair with bad fingerprint -> bad_request', r.get('status') == 'bad_request', str(r))
        set_pairing(tmp)
        rc, r, *_ = run(tmp, {'action': 'unpair'})
        check('unpair -> unpaired + file removed', r.get('status') == 'unpaired' and read_pairing(tmp) is None, str(r))
        rc, r, *_ = run(tmp, {'action': 'unpair'})
        check('unpair when not paired -> still ok', r.get('status') == 'unpaired', str(r))
        set_pairing(tmp, raw='{"xfp": "zz"}')
        rc, r, *_ = run(tmp, good)
        check('damaged pairing file -> error, nothing sent', r.get('status') == 'error' and 'damaged' in r.get('error', ''), str(r))
        rc, r, *_ = run(tmp, dict(good, request_id='abc-123'))
        check('request_id echoed', r.get('request_id') == 'abc-123', str(r))
        rc, r, *_ = run(tmp, dict(good, request_id='bad id $(x)'))
        check('invalid request_id not echoed', 'request_id' not in r, str(r))

        print('sign')
        set_pairing(tmp)
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
        rc, r, log, _ = run(tmp, dict(good, expected_xfp='deadbeef', expected_xpub=OTHER_XPUB))
        check('browser cannot override pairing (ignored expected_* fields)', r.get('status') == 'signed', str(r)[:150])
        rc, r, log, _ = run(tmp, good, {'xfp': 'deadbeef'})
        check('different fingerprint -> wrong_device', r.get('status') == 'wrong_device', str(r))
        check('  ...and nothing was uploaded', not any(l.startswith('upload') for l in log), str(log))
        rc, r, log, _ = run(tmp, good, {'xpub': OTHER_XPUB})
        check('same fingerprint, different xpub -> wrong_device', r.get('status') == 'wrong_device', str(r))
        rc, r, log, _ = run(tmp, good, {'mitm_fail': True})
        check('authenticity check fails -> mitm_failed', r.get('status') == 'mitm_failed', str(r))
        check('  ...and nothing was uploaded', not any(l.startswith('upload') for l in log), str(log))

        print('backup')
        BK = b"7z\xbc\xaf'\x1c" + b'\x00\x04' + b'ENCRYPTED' * 50
        pairing_before = read_pairing(tmp)
        rc, r, log, left = run(tmp, {'action': 'backup'})
        check('backup -> the encrypted 7z, base64, with its size and SHA-256',
              rc == 0 and r.get('status') == 'backup' and base64.b64decode(r.get('backup_b64', '')) == BK
              and r.get('size') == len(BK) and r.get('xfp') == PAIRED_XFP and not left, str(r)[:200])
        import hashlib as _h
        check('  ...sha256 is of the downloaded bytes', r.get('sha256') == _h.sha256(BK).hexdigest())
        check('  ...after the authenticity check, then start, then download', [l.split(' ')[0] for l in log if l and not l.startswith(('open', 'close'))][:3] == ['mitm', 'backup-start', 'download-backup'], str(log))
        check('  ...no pairing needed, and the pairing file is untouched', read_pairing(tmp) == pairing_before)
        rc, r, log, _ = run(tmp, {'action': 'backup'}, {'mitm_fail': True})
        check('backup: authenticity check fails -> mitm_failed, nothing asked', r.get('status') == 'mitm_failed' and 'backup-start' not in log, str(r))
        for mode, status in (('refuse', 'refused'), ('busy', 'busy'), ('proto', 'rejected'), ('badsha', 'error'), ('not7z', 'error'), ('huge', 'error')):
            rc, r, log, _ = run(tmp, {'action': 'backup'}, {'backup': mode})
            check('backup: %s -> %s' % (mode, status), r.get('status') == status and 'backup_b64' not in r and rc != 0, str(r)[:200])
        rc, r, *_ = run(tmp, {'action': 'backup'}, {'backup': 'hang'}, env_extra={'SAFEKEEP_CC_TIMEOUT': '1'})
        check('backup: no answer -> timeout', r.get('status') == 'timeout', str(r))
        rc, r, *_ = run(tmp, {'action': 'backup'}, {'devices': 0})
        check('backup: no Coldcard -> not_connected', r.get('status') == 'not_connected', str(r))
        rc, r, *_ = run(tmp, {'action': 'backup'}, {'devices': 2})
        check('backup: two Coldcards -> multiple_devices', r.get('status') == 'multiple_devices', str(r))

        print('passphrase')
        PW = ' Savings 2026! ~`{}|'
        rc, r, log, left = run(tmp, {'action': 'passphrase', 'passphrase': PW})
        check('passphrase -> the new wallet\'s xpub and the fingerprint before',
              rc == 0 and r.get('status') == 'passphrase' and r.get('xpub') == 'xpub' + 'P' * 107 and r.get('xfp_before') == PAIRED_XFP and not left, str(r))
        check('  ...the exact passphrase was sent (spaces and symbols kept)', 'pass ' + json.dumps(PW) in log, str(log))
        check('  ...after the authenticity check against the PAIRED key (this is the paired Coldcard)',
              [l.split(' ')[0] for l in log if l and not l.startswith(('open', 'close'))][:2] == ['mitm', 'pass'] and 'mitm ' + PAIRED_XPUB[:8] in log, str(log))
        check('  ...the passphrase is not in the result', PW.strip() not in json.dumps(r))
        set_pairing(tmp, xfp=None)
        rc, r, log, _ = run(tmp, {'action': 'passphrase', 'passphrase': 'abc'})
        check('  ...no pairing needed (authenticity checked against the key it presents)', r.get('status') == 'passphrase' and 'mitm None' in log, str(log))
        set_pairing(tmp)
        rc, r, log, _ = run(tmp, {'action': 'passphrase', 'passphrase': 'abc'}, {'mitm_fail': True})
        check('passphrase: authenticity check fails -> mitm_failed, nothing sent', r.get('status') == 'mitm_failed' and not any(l.startswith('pass') for l in log), str(r))
        for mode, status in (('refuse', 'refused'), ('busy', 'busy'), ('proto', 'rejected'), ('garbage', 'error')):
            rc, r, log, _ = run(tmp, {'action': 'passphrase', 'passphrase': 'abc'}, {'pass': mode})
            check('passphrase: %s -> %s' % (mode, status), r.get('status') == status and 'xpub' not in r and rc != 0, str(r)[:200])
        rc, r, *_ = run(tmp, {'action': 'passphrase', 'passphrase': 'abc'}, {'pass': 'hang'}, env_extra={'SAFEKEEP_CC_TIMEOUT': '1'})
        check('passphrase: no answer -> timeout', r.get('status') == 'timeout', str(r))
        rc, r, *_ = run(tmp, {'action': 'passphrase', 'passphrase': 'abc'}, {'devices': 0})
        check('passphrase: no Coldcard -> not_connected', r.get('status') == 'not_connected', str(r))
        rc, r, *_ = run(tmp, {'action': 'passphrase', 'passphrase': 'x' * 99})
        check('passphrase: 99 characters are allowed', r.get('status') == 'passphrase', str(r))
        for name, pw in (('empty', ''), ('100 characters', 'x' * 100), ('an accented letter', 'café'), ('a tab', 'a\tb'),
                         ('a new line', 'a\nb'), ('not a string', 123), ('missing', None)):
            req = {'action': 'passphrase'}
            if pw is not None: req['passphrase'] = pw
            rc, r, log, left = run(tmp, req)
            check('passphrase: %s -> bad_request, device not opened, request gone' % name,
                  r.get('status') == 'bad_request' and not any(l.startswith('open') for l in log) and not left, str(r))

        print('bad requests (nothing touches the device)')
        bad = [
            ('not JSON', None, 'garbage{'),
            ('JSON list', None, '[1,2]'),
            ('unknown action', {'action': 'run', 'command': 'id'}, None),
            ('old-style command field', {'action': 'sign', 'command': 'touch /tmp/pwned'}, None),
            ('missing PSBT', dict(good, psbt_b64=''), None),
            ('PSBT not base64', dict(good, psbt_b64='@@notbase64@@'), None),
            ('base64 but not a PSBT', dict(good, psbt_b64=base64.b64encode(b'hello').decode()), None),
            ('pair: bad fingerprint', dict(pair_req, expected_xfp='zz; rm -rf /'), None),
            ('pair: missing xpub', dict(pair_req, expected_xpub=None), None),
            ('pair: xpub with junk', dict(pair_req, expected_xpub=PAIRED_XPUB + '$(id)'), None),
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

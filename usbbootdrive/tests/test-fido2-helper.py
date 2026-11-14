#!/usr/bin/env python3
"""
Tests for usbbootdrive/safekeep-fido2.py (SECURITY_KEY_DESIGN.md, Part 1).

    PYTHONDONTWRITEBYTECODE=1 python3 usbbootdrive/tests/test-fido2-helper.py

No hardware needed. The helper's real-key code runs unchanged, through
python-fido2, against a software FIDO2 key (virtual_fido2.py) that
answers CTAP2 like a real one, on a real LUKS2 file (cryptsetup). Needs
python3-fido2 and cryptsetup; says SKIP without them.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, '..', 'safekeep-fido2.py')
PASS = 'correct horse battery staple 2026'
PIN = '482916'

passed = failed = 0


def ck(name, ok, detail=''):
    global passed, failed
    if ok:
        passed += 1
    else:
        failed += 1
        print('FAIL', name, detail)


try:
    import fido2  # noqa: F401
    have_fido2 = True
except ImportError:
    have_fido2 = False
have_cryptsetup = shutil.which('cryptsetup') is not None
if not (have_fido2 and have_cryptsetup):
    print('SKIP: needs python3-fido2 and cryptsetup (fido2: %s, cryptsetup: %s)' % (have_fido2, have_cryptsetup))
    sys.exit(0)

tmp = tempfile.mkdtemp(prefix='fido2-')
RUNNER = os.path.join(tmp, 'runner.py')
with open(RUNNER, 'w') as f:
    f.write('''import runpy, sys
sys.path.insert(0, %r)
import virtual_fido2
virtual_fido2.install(sys.argv[1])
helper = sys.argv[2]
sys.argv = [helper] + sys.argv[3:]
runpy.run_path(helper, run_name="__main__")
''' % HERE)

# A cryptsetup stand-in, first on PATH: "open" (which needs device-mapper)
# is checked with --test-passphrase instead and logged; everything else
# goes to the real cryptsetup.
BIN = os.path.join(tmp, 'bin')
os.mkdir(BIN)
REAL_CS = shutil.which('cryptsetup')
with open(os.path.join(BIN, 'cryptsetup'), 'w') as f:
    f.write('''#!/bin/bash
if [ "$1" = open ] && [ "$2" != --test-passphrase ]; then
    dev=$2; mapper=$3; shift 3
    if %s open --test-passphrase "$dev" "$@"; then echo "opened $mapper $*" >> "%s/opens.log"; exit 0; fi
    exit 2
fi
exec %s "$@"
''' % (REAL_CS, tmp, REAL_CS))
os.chmod(os.path.join(BIN, 'cryptsetup'), 0o755)
ENV = {'PATH': BIN + ':' + os.environ['PATH'], 'SAFEKEEP_FIDO2_TEST': '1', 'SAFEKEEP_FIDO2_FAST': '1'}


def new_key(**state):
    path = os.path.join(tmp, 'key-%d.json' % len(os.listdir(tmp)))
    with open(path, 'w') as f:
        json.dump(state, f)
    return path


def key_state(path):
    with open(path) as f:
        return json.load(f)


def set_state(path, **kw):
    s = key_state(path)
    s.update(kw)
    with open(path, 'w') as f:
        json.dump(s, f)


def helper(key, *args, data=b'', env=None):
    e = dict(ENV)
    e.update(env or {})
    return subprocess.run([sys.executable, RUNNER, key, HELPER] + list(args), input=data,
                          capture_output=True, env=e, timeout=120)


def make_vault():
    path = os.path.join(tmp, 'vault-%d.luks' % len(os.listdir(tmp)))
    with open(path, 'wb') as f:
        f.truncate(20 * 1024 * 1024)
    r = subprocess.run(['cryptsetup', 'luksFormat', '-q', '--type', 'luks2', '--pbkdf', 'pbkdf2',
                        '--pbkdf-force-iterations', '1000', path, '--key-file=-'], input=PASS.encode(), capture_output=True)
    assert r.returncode == 0, r.stderr
    return path


def opens(vault, secret, slot=None):
    args = ['cryptsetup', 'open', '--test-passphrase', vault, '--key-file=-']
    if slot is not None:
        args += ['--key-slot', str(slot)]
    return subprocess.run(args, input=secret, capture_output=True).returncode == 0


def status(key, vault):
    r = helper(key, 'status', vault)
    return json.loads(r.stdout) if r.returncode == 0 else None


def secret(key, vault, pin=PIN):
    r = helper(key, 'secret', vault, data=pin.encode())
    if r.returncode != 0:
        return r, None, None
    slot, value = r.stdout.decode().split('\n')[:2]
    return r, int(slot), value.encode()


def code(r):
    return r.returncode


# --- probe and set-pin ---------------------------------------------------
none = new_key(count=0)
ck('probe: no key plugged in → 10', code(helper(none, 'probe')) == 10)
two = new_key(count=2)
ck('probe: two keys plugged in → 11', code(helper(two, 'probe')) == 11)
k1 = new_key(product='Key One')
r = helper(k1, 'probe')
p = json.loads(r.stdout) if r.returncode == 0 else {}
ck('probe: a new key has hmac-secret and no PIN', p.get('hmac') is True and p.get('pin') == 'unset', r)
ck('probe: names the product', p.get('product') == 'Key One', p)
ck('probe: asks for a PIN of at least 6', p.get('min_pin') == 6, p)
nohmac = new_key(hmac=False)
ck('probe: a key without hmac-secret says so', json.loads(helper(nohmac, 'probe').stdout).get('hmac') is False)

ck('set-pin: refuses a PIN under 6 characters → 19', code(helper(k1, 'set-pin', data=b'1234')) == 19)
r = helper(k1, 'set-pin', data=PIN.encode())
ck('set-pin: sets the PIN', r.returncode == 0 and key_state(k1).get('pin') == PIN, r.stderr)
p = json.loads(helper(k1, 'probe').stdout)
ck('probe: PIN set, 8 tries left', p['pin'] == 'set' and p['retries'] == 8, p)
ck('set-pin: refuses a key that already has a PIN', code(helper(k1, 'set-pin', data=b'999999')) == 1)

# --- enroll --------------------------------------------------------------
vault = make_vault()
st = status(k1, vault)
ck('status: a new vault has the passphrase and no keys', st == {'passphrase': True, 'keys': []}, st)
ck('enroll: wrong existing passphrase → 2',
   code(helper(k1, 'enroll', vault, data=b'wrong\0' + PIN.encode() + b'\0Blue')) == 2)
nopin = new_key()
ck('enroll: a key with no PIN → 18',
   code(helper(nopin, 'enroll', vault, data=PASS.encode() + b'\0' + PIN.encode() + b'\0X')) == 18)
ck('enroll: a key without hmac-secret → 12',
   code(helper(nohmac, 'enroll', vault, data=PASS.encode() + b'\0' + PIN.encode() + b'\0X')) == 12)
ck('enroll: the input must have three NUL-separated values', code(helper(k1, 'enroll', vault, data=PASS.encode())) == 1)
touches = key_state(k1).get('touches', 0)
r = helper(k1, 'enroll', vault, data=PASS.encode() + b'\0' + PIN.encode() + b'\0Blue YubiKey\x07')
ck('enroll: adds the key', r.returncode == 0 and r.stdout.strip().isdigit(), r.stderr)
slot1 = int(r.stdout.strip() or -1)
ck('enroll: prints only the slot', r.stdout.decode().strip() == str(slot1))
ck('enroll: two touches (make the credential, then read its secret)', key_state(k1)['touches'] - touches == 2)
st = status(k1, vault)
ck('status: passphrase and one key, named without control characters',
   st and st['passphrase'] and len(st['keys']) == 1 and st['keys'][0]['name'] == 'Blue YubiKey' and st['keys'][0]['slot'] == slot1, st)
meta = json.loads(subprocess.run(['cryptsetup', 'luksDump', '--dump-json-metadata', vault], capture_output=True).stdout)
types = sorted(t['type'] for t in meta['tokens'].values())
ck('header: one vault token (the salt) and one key token', types == ['safekeep-fido2', 'safekeep-vault'], types)
ck('header: the key token holds no secret, only the credential, name and date',
   all(set(t) <= {'type', 'keyslots', 'credential', 'name', 'added', 'salt'} for t in meta['tokens'].values()))
ck('enroll: the passphrase still opens the vault', opens(vault, PASS.encode()))
ck('enroll: the same key again → 22 (already added)',
   code(helper(k1, 'enroll', vault, data=PASS.encode() + b'\0' + PIN.encode() + b'\0Again')) == 22)

# --- secret, wrong PINs, touch -------------------------------------------
r, s1, sec1 = secret(k1, vault)
ck('secret: the key gives its slot and slot key', r.returncode == 0 and s1 == slot1 and len(sec1) == 44, r.stderr)
ck('secret: the slot key opens that slot', opens(vault, sec1, slot1))
ck('secret: the slot key is not the passphrase slot\'s key', not opens(vault, sec1, 0))
r2, _, sec1b = secret(k1, vault)
ck('secret: the same key gives the same slot key each time', sec1b == sec1)
r = helper(k1, 'secret', vault, data=b'000000')
ck('secret: a wrong PIN → 13 and the tries left', r.returncode == 13 and b'retries=7' in r.stderr, r.stderr)
other = new_key(pin=PIN)
ck('secret: a key that isn\'t one of this vault\'s → 17', code(helper(other, 'secret', vault, data=PIN.encode())) == 17)
set_state(k1, touch=False)
ck('secret: not touched → 16', code(helper(k1, 'secret', vault, data=PIN.encode())) == 16)
set_state(k1, touch=True)
ck('secret: an empty vault (no keys) → 17', code(helper(k1, 'secret', make_vault(), data=PIN.encode())) == 17)

# --- open ----------------------------------------------------------------
log = os.path.join(tmp, 'opens.log')
r = helper(k1, 'open', vault, 'vault', data=PIN.encode())
ck('open: opens the vault with the key\'s own slot', r.returncode == 0 and os.path.exists(log)
   and ('opened vault --key-slot %d' % slot1) in open(log).read(), r.stderr)
ck('open: refuses a bad mapper name', code(helper(k1, 'open', vault, '../x', data=PIN.encode())) == 1)
ck('open: a wrong PIN doesn\'t open → 13', code(helper(k1, 'open', vault, 'vault', data=b'111111')) == 13)

# --- a second key, Security key only, and back ---------------------------
k2 = new_key(pin=PIN, product='Spare')
r = helper(k2, 'enroll', vault, data=sec1 + b'\0' + PIN.encode() + b'\0Spare')
ck('enroll: a second key, confirmed with the first key\'s slot key', r.returncode == 0, r.stderr)
slot2 = int(r.stdout.strip() or -1)
_, s2, sec2 = secret(k2, vault)
ck('secret: each key opens only its own slot', s2 == slot2 and sec2 != sec1 and not opens(vault, sec2, slot1))
ck('remove-passphrase: refused with the passphrase itself → 2', code(helper(k1, 'remove-passphrase', vault, data=PASS.encode())) == 2)
r = helper(k1, 'remove-passphrase', vault, data=sec1)
ck('remove-passphrase: with a key\'s slot key', r.returncode == 0, r.stderr)
st = status(k1, vault)
ck('status: Security key only (no passphrase, two keys)', st and not st['passphrase'] and len(st['keys']) == 2, st)
ck('remove-passphrase: the passphrase no longer opens the vault', not opens(vault, PASS.encode()))
ck('remove-passphrase: both keys still do', opens(vault, sec1) and opens(vault, sec2))
ck('remove: refused with the removed key\'s own slot key → 21', code(helper(k1, 'remove', vault, str(slot1), data=sec1)) == 21)
r = helper(k2, 'remove', vault, str(slot1), data=sec2)
ck('remove: the first key, confirmed with the spare', r.returncode == 0, r.stderr)
st = status(k1, vault)
ck('remove: one key left', st and len(st['keys']) == 1 and st['keys'][0]['name'] == 'Spare', st)
ck('remove: the removed key no longer opens the vault', not opens(vault, sec1))
ck('remove: the last way in is refused → 21', code(helper(k2, 'remove', vault, str(slot2), data=sec2)) == 21)
ck('remove: the last key still opens it', opens(vault, sec2))
NEWPASS = 'a whole new passphrase 9!'
ck('add-passphrase: refused with a wrong key → 2',
   code(helper(k2, 'add-passphrase', vault, data=b'nope\0' + NEWPASS.encode())) == 2)
r = helper(k2, 'add-passphrase', vault, data=sec2 + b'\0' + NEWPASS.encode())
ck('add-passphrase: back to Passphrase or security key', r.returncode == 0 and status(k2, vault)['passphrase'], r.stderr)
ck('add-passphrase: the new passphrase opens the vault', opens(vault, NEWPASS.encode()))
ck('add-passphrase: refused when there already is one', code(helper(k2, 'add-passphrase', vault, data=sec2 + b'\0x')) == 1)
r = helper(k2, 'rename', vault, str(slot2), data='Drawer key'.encode())
ck('rename: renames a key', r.returncode == 0 and status(k2, vault)['keys'][0]['name'] == 'Drawer key', r.stderr)
r = helper(k2, 'remove', vault, str(slot2), data=NEWPASS.encode())
ck('remove: the last key, with the passphrase → Master Passphrase only',
   r.returncode == 0 and status(k2, vault) == {'passphrase': True, 'keys': []}, r.stderr)

# --- at most 4 keys --------------------------------------------------------
v4 = make_vault()
keys4 = [new_key(pin=PIN) for _ in range(5)]
results = [code(helper(k, 'enroll', v4, data=PASS.encode() + b'\0' + PIN.encode() + b'\0K')) for k in keys4]
ck('enroll: at most 4 keys → 20 for the 5th', results == [0, 0, 0, 0, 20], results)
ck('enroll: each key keeps the name it was given',
   [k['name'] for k in status(keys4[0], v4)['keys']] == ['K', 'K', 'K', 'K'])
v5 = make_vault()
k5 = new_key(pin=PIN)
helper(k5, 'enroll', v5, data=PASS.encode() + b'\0' + PIN.encode() + b'\0')
ck('enroll: no name → "Security key 1"', status(k5, v5)['keys'][0]['name'] == 'Security key 1')

# --- wrong PINs: 3 in a row, then 8 in total -------------------------------
k6 = new_key(pin=PIN)
helper(k6, 'enroll', v5, data=PASS.encode() + b'\0' + PIN.encode() + b'\0Six')
codes = [code(helper(k6, 'secret', v5, data=b'000000')) for _ in range(3)]
ck('PIN: two wrong → 13, the third in a row → 15 (unplug and replug)', codes == [13, 13, 15], codes)
ck('PIN: until replugged, even the right PIN → 15', code(helper(k6, 'secret', v5, data=PIN.encode())) == 15)
set_state(k6, row=0)     # unplugged and plugged back in
codes = [code(helper(k6, 'secret', v5, data=b'000000')) for _ in range(2)]
set_state(k6, row=0)
codes += [code(helper(k6, 'secret', v5, data=b'000000')) for _ in range(3)]
ck('PIN: the 8th wrong PIN in total → 14 (blocked for good)', codes[-1] == 14 and key_state(k6)['retries'] == 0, codes)
ck('PIN: blocked even with the right PIN → 14', code(helper(k6, 'secret', v5, data=PIN.encode())) == 14)

# --- a CTAP 2.0 key (PIN protocol 1, no permissions) ----------------------
k7 = new_key(pin=PIN, ctap21=False)
r = helper(k7, 'enroll', v5, data=PASS.encode() + b'\0' + PIN.encode() + b'\0Old key')
ck('CTAP 2.0 key: enroll', r.returncode == 0, r.stderr)
r, s7, sec7 = secret(k7, v5)
ck('CTAP 2.0 key: its slot key opens its slot', r.returncode == 0 and opens(v5, sec7, s7), r.stderr)

# --- a failed change puts the header back ----------------------------------
sys.path.insert(0, os.path.dirname(HELPER))
import importlib.util
spec = importlib.util.spec_from_file_location('skfido2', HELPER)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
os.environ.update(ENV)
v6 = make_vault()
before = mod.vault_state(v6)['slots']
try:
    with mod.HeaderBackup(v6):
        mod.add_slot(v6, PASS.encode(), b'temporary key')
        raise mod.Fail(1, 'simulated failure')
except mod.Fail:
    pass
ck('header backup: a failed change is undone', mod.vault_state(v6)['slots'] == before and not opens(v6, b'temporary key'))
leftover = [f for f in os.listdir('/dev/shm') if f.startswith('safekeep-header-')] if os.path.isdir('/dev/shm') else []
ck('header backup: the copy in RAM is deleted', leftover == [], leftover)

# --- the source -------------------------------------------------------------
src = open(HELPER).read()
ck('source: secrets reach cryptsetup through pipes', 'pass_fds=' in src and '"/dev/fd/%d"' in src)
ck('source: no test-only key code in the helper', 'virtual' not in src.lower().replace('virtual_fido2.py', ''))
ck('source: user verification (PIN) and presence (touch) are required',
   'pin_uv_param=' in src and '"up": True' in src and '"rk": False' in src)
ck('source: refuses anything but a /dev/loopN device outside tests',
   code(helper(k1, 'status', vault, env={'SAFEKEEP_FIDO2_TEST': ''})) == 1)

shutil.rmtree(tmp, ignore_errors=True)
print('%d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)

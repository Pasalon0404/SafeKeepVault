#!/usr/bin/env python3
"""
Tests for the Seed Vault Watcher in safekeep-boot.sh, run for real.

    python3 usbbootdrive/tests/test-seed-vault-watcher.py

Seed Management -> Seed Vault keeps other seeds beside the master seed.
The app downloads the whole list as SEED_VAULT.json; the watcher checks it
and stores it as seeds/seed-vault.json (mode 600). The watcher block is cut
out of safekeep-boot.sh and run against temporary folders:

  1. a good list is stored (mode 600, fingerprints upper-cased, names
     trimmed) and the request is removed;
  2. bad lists are refused and leave the stored list as it was: too many
     seeds, a bad name, bad words, a bad fingerprint, duplicates, too big,
     not JSON;
  3. an empty list removes the stored file;
  4. a flash drive set not to keep the seed refuses the list;
  5. the seed-free cleanups (boot loop, Seed Storage Watcher) and the note
     router cover the Seed Vault files.
"""
import json, os, shutil, signal, stat, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
BOOT = open(os.path.join(HERE, '..', 'safekeep-boot.sh')).read()

passed = failed = 0
def ck(name, cond, extra=''):
    global passed, failed
    if cond: passed += 1
    else: failed += 1
    print('  [%s] %s%s' % ('PASS' if cond else 'FAIL', name, ('  -> ' + str(extra)[:400]) if (extra and not cond) else ''))

A = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
B = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
C24 = ' '.join(['zoo'] * 23 + ['wrong'])

start = BOOT.index('    # SEED VAULT WATCHER')
block = BOOT[start:BOOT.index('    SEED_VAULT_WATCHER_PID=$!')]

tmp = tempfile.mkdtemp()
vault = os.path.join(tmp, 'vault')
dl = os.path.join(vault, 'seeds')
os.makedirs(dl); os.makedirs(os.path.join(vault, 'settings'))
stored = os.path.join(dl, 'seed-vault.json')
script = os.path.join(tmp, 'w.sh')
open(script, 'w').write('set -uo pipefail\nVAULT_MOUNT=%s\nCHROMIUM_DOWNLOAD_DIR=%s\nEPHEMERAL_MODE=0\n' % (json.dumps(vault), json.dumps(dl))
                        + block + '    wait\n')

def entry(name, words, fp, added='2026-11-08'):
    return {'name': name, 'mnemonic': words, 'fingerprint': fp, 'added': added}

def send(payload, raw=None):
    """Drop a request and wait until the watcher has removed it."""
    p = os.path.join(dl, 'SEED_VAULT.json')
    open(p, 'w').write(raw if raw is not None else json.dumps({'version': 1, 'seeds': payload}))
    for _ in range(40):
        if not os.path.exists(p): break
        time.sleep(0.25)
    time.sleep(0.2)
    return not os.path.exists(p)

def load():
    return json.load(open(stored))['seeds'] if os.path.exists(stored) else None

w = subprocess.Popen(['bash', script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
try:
    time.sleep(0.5)
    print('\n1. A good list is stored')
    gone = send([entry('  Mom  ', A, 'b8688df1'), entry('Old wallet', B, '73C5DA0A', '')])
    s = load()
    ck('the request is removed', gone)
    ck('seeds/seed-vault.json holds both seeds', s is not None and [e['mnemonic'] for e in s] == [A, B], s)
    ck('…names trimmed, fingerprints upper-cased', s and s[0]['name'] == 'Mom' and s[0]['fingerprint'] == 'B8688DF1', s)
    ck('…mode 600', os.path.exists(stored) and stat.S_IMODE(os.stat(stored).st_mode) == 0o600)
    ck('…no tmp file left', not os.path.exists(stored + '.tmp'))
    good = load()

    print('\n2. Bad lists are refused, the stored list stays')
    WORDS21 = 'able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress'.split()
    gone = send([entry('S%d' % i, ' '.join([w] * 12), '00000000') for i, w in enumerate(WORDS21[:20])])
    ck('20 seeds (the most): stored', gone and load() and len(load()) == 20)
    send(good)
    bad = {
        '21 seeds': [entry('S%d' % i, ' '.join([w] * 12), '00000000') for i, w in enumerate(WORDS21)],
        'an empty name': [entry('   ', A, '00000000')],
        'a 41-character name': [entry('x' * 41, A, '00000000')],
        'a control character in the name': [entry('a\nb', A, '00000000')],
        '11 words': [entry('a', ' '.join(A.split()[:11]), '00000000')],
        '13 words': [entry('a', A + ' zoo', '00000000')],
        'upper-case words': [entry('a', A.upper(), '00000000')],
        'a word with a digit': [entry('a', A.replace('legal', 'leg4l', 1), '00000000')],
        'a short fingerprint': [entry('a', A, 'ABC')],
        'a fingerprint that isn\'t hex': [entry('a', A, 'ZZZZZZZZ')],
        'two seeds with one name (any case)': [entry('Mom', A, '00000000'), entry('mom', B, '00000000')],
        'the same words twice': [entry('a', A, '00000000'), entry('b', A, '00000000')],
        'an entry that isn\'t an object': ['nope'],
    }
    for name, payload in bad.items():
        gone = send(payload)
        ck('%s: refused, request removed' % name, gone and load() == good, load())
    gone = send(None, raw='{"seeds": [' + ','.join(['{"name":"x","mnemonic":"%s","fingerprint":"00000000"}' % A] * 600) + ']}')
    ck('a file over 64 KB: refused', gone and load() == good)
    gone = send(None, raw='not json')
    ck('not JSON: refused', gone and load() == good)
    gone = send(None, raw='{"list": []}')
    ck('no seeds list: refused', gone and load() == good)
    gone = send([entry('Long', C24, 'AAAAAAAA')])
    ck('24 words are accepted (the app checks the checksum, the OS the shape)', gone and load() and load()[0]['name'] == 'Long')

    print('\n3. An empty list removes the file')
    gone = send([])
    ck('seed-vault.json is gone', gone and not os.path.exists(stored))

    print('\n4. A flash drive set not to keep the seed')
    open(os.path.join(vault, 'settings', 'seed-storage.json'), 'w').write('{"keepSeed": false}')
    gone = send([entry('Mom', A, 'B8688DF1')])
    ck('the list is refused and the request removed', gone and not os.path.exists(stored))
    os.remove(os.path.join(vault, 'settings', 'seed-storage.json'))
finally:
    os.killpg(w.pid, signal.SIGTERM)

print('\n5. Other wiring in safekeep-boot.sh')
ck('the watcher runs on normal boots only (EPHEMERAL_MODE check)', '[ "$EPHEMERAL_MODE" != "1" ]' in block)
ck('Python runs isolated (-I); the list is data, nothing in it is run', 'python3 -I - ' in block and 'eval' not in block)
ck('requests are shredded', 'shred -u -n 1 -z "$_svf"' in block)
ck('the boot-time seed-free cleanup covers seed-vault*.json', '"$VAULT_MOUNT"/seeds/master-seed*.json "$VAULT_MOUNT"/seeds/seed-vault*.json' in BOOT)
ck('the Seed Storage Watcher removes stored seeds and requests too', '"$SEED_DIR"/master-seed*.json "$SEED_DIR"/seed-vault*.json "$SEED_DIR"/SEED_VAULT*.json' in BOOT)
ck('the note router skips the Seed Vault files', 'SEED_VAULT*|seed-vault*|' in BOOT)
ck('the watcher is started and logged', 'echo "Seed Vault watcher daemon started (PID $SEED_VAULT_WATCHER_PID)"' in BOOT)

shutil.rmtree(tmp)
print('\n%d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)

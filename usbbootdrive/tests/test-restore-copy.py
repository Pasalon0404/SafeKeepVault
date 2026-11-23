"""
Tests for Restore's copy into the vault (the RESTORE_COPY_PY block in
usbbootdrive/safekeep-boot.sh, run here exactly as written there).

    PYTHONDONTWRITEBYTECODE=1 python3 usbbootdrive/tests/test-restore-copy.py

A restored backup must bring back data only. The extracted archive here
holds what a crafted backup could: a wipe request and other requests in
seeds/, links (to files, to folders, to outside the vault), a FIFO, and a
file at the top level; and the vault already holds a link where a folder
should be.
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BOOT = os.path.join(HERE, '..', 'safekeep-boot.sh')
src = open(BOOT, encoding='utf-8').read()
m = re.search(r"<<'RESTORE_COPY_PY'[^\n]*\n(.*?)\nRESTORE_COPY_PY\n", src, re.S)
if not m:
    print('FAIL: the RESTORE_COPY_PY block is missing from safekeep-boot.sh')
    sys.exit(1)
CODE = m.group(1)

passed = failed = 0


def ck(name, ok, detail=''):
    global passed, failed
    if ok:
        passed += 1
        print('  [PASS] ' + name)
    else:
        failed += 1
        print('  [FAIL] ' + name + ('  → ' + str(detail)[:300] if detail else ''))


def write(path, text='x'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)


root = tempfile.mkdtemp(prefix='restore-copy-')
ARC = os.path.join(root, 'extracted')        # what 7z unpacked (PROBE_ROOT)
VAULT = os.path.join(root, 'vault')
OUTSIDE = os.path.join(root, 'outside')
os.makedirs(OUTSIDE)
write(os.path.join(OUTSIDE, 'secret.txt'), 'not for the vault')

# --- The archive ---
write(os.path.join(ARC, 'seeds', 'master-seed.json'), '{"mnemonic": "abandon"}')
write(os.path.join(ARC, 'seeds', 'WIPE_TRIGGER.txt'), 'wipe')
write(os.path.join(ARC, 'seeds', 'UPDATE_REQUEST.json'), '{}')
write(os.path.join(ARC, 'seeds', 'SKXFER-W-1-41.skxfer'), 'x')
write(os.path.join(ARC, 'seeds', 'SKDOC-0123456789abcdef.skdel'), '')
write(os.path.join(ARC, 'seeds', 'note.html'), '<p>routed</p>')
write(os.path.join(ARC, 'seeds', 'sub', 'master-seed.json'), 'nested')
write(os.path.join(ARC, 'codex', 'letter.html'), '<p>hi</p>')
write(os.path.join(ARC, 'codex', '.codex-index.json'), '[]')
write(os.path.join(ARC, 'codex', 'WIPE_TRIGGER.txt'), 'wipe')
write(os.path.join(ARC, 'codex', 'POWER_ACTION.txt'), 'off')
os.symlink(os.path.join(OUTSIDE, 'secret.txt'), os.path.join(ARC, 'codex', 'linked.html'))
write(os.path.join(ARC, 'passphrases', 'p.json'), '{"passphrase": "x"}')
write(os.path.join(ARC, 'settings', 'saved-wallets.json'), '{"wallets": []}')
write(os.path.join(ARC, 'settings', 'coldcard', 'pairing.json'), '{}')
os.symlink(OUTSIDE, os.path.join(ARC, 'settings', 'escape'))
os.makedirs(os.path.join(ARC, 'documents'))
write(os.path.join(ARC, 'documents', '0123456789abcdef.pdf'), '%PDF-1.7')
os.mkfifo(os.path.join(ARC, 'documents', 'pipe'))
os.symlink(OUTSIDE, os.path.join(ARC, 'twofa'))          # a whole folder that's a link
write(os.path.join(ARC, 'top-level.json'), '{}')

# --- The vault before the restore: codex/ is a link out of the vault ---
os.makedirs(os.path.join(VAULT, 'seeds'))
os.symlink(OUTSIDE, os.path.join(VAULT, 'codex'))
write(os.path.join(VAULT, 'passphrases', 'p.json'), 'old')
os.makedirs(os.path.join(VAULT, 'settings'))
os.symlink(os.path.join(OUTSIDE, 'secret.txt'), os.path.join(VAULT, 'settings', 'saved-wallets.json'))

r = subprocess.run([sys.executable, '-I', '-', ARC, VAULT], input=CODE, capture_output=True, text=True)
out = r.stdout + r.stderr
ck('the copy runs', r.returncode == 0, out)


def exists(*p):
    return os.path.lexists(os.path.join(VAULT, *p))


def read(*p):
    return open(os.path.join(VAULT, *p)).read()


print('1. Data comes back')
ck('the master seed', read('seeds', 'master-seed.json') == '{"mnemonic": "abandon"}')
ck('notes and their index', read('codex', 'letter.html') == '<p>hi</p>' and exists('codex', '.codex-index.json'))
ck('passphrases (replacing the old copy)', read('passphrases', 'p.json') == '{"passphrase": "x"}')
ck('settings, including a subfolder', exists('settings', 'saved-wallets.json') and exists('settings', 'coldcard', 'pairing.json'))
ck('documents', read('documents', '0123456789abcdef.pdf') == '%PDF-1.7')
ck('restored files are private (0600)', (os.stat(os.path.join(VAULT, 'seeds', 'master-seed.json')).st_mode & 0o777) == 0o600)

print('2. Requests never come back')
for name in ('WIPE_TRIGGER.txt', 'UPDATE_REQUEST.json', 'SKXFER-W-1-41.skxfer', 'SKDOC-0123456789abcdef.skdel', 'note.html'):
    ck('seeds/%s is not restored' % name, not exists('seeds', name))
ck('seeds/ subfolders are ignored', not exists('seeds', 'sub'))
ck('request names are skipped in other folders too', not exists('codex', 'WIPE_TRIGGER.txt') and not exists('codex', 'POWER_ACTION.txt'))

print('3. Links and special files never come back, or get written through')
ck('a linked file is skipped', not exists('codex', 'linked.html'))
ck('a linked folder is skipped', not exists('settings', 'escape'))
ck('a folder that is itself a link is skipped', not exists('twofa'))
ck('a FIFO is skipped', not exists('documents', 'pipe'))
ck('nothing from the top level', not exists('top-level.json'))
ck('a link already in the vault where a folder belongs is replaced by a real folder',
   os.path.isdir(os.path.join(VAULT, 'codex')) and not os.path.islink(os.path.join(VAULT, 'codex')))
ck('a link already in the vault where a file belongs is replaced, not written through',
   not os.path.islink(os.path.join(VAULT, 'settings', 'saved-wallets.json'))
   and read('settings', 'saved-wallets.json') == '{"wallets": []}')
ck('nothing outside the vault was changed', sorted(os.listdir(OUTSIDE)) == ['secret.txt']
   and open(os.path.join(OUTSIDE, 'secret.txt')).read() == 'not for the vault', os.listdir(OUTSIDE))
ck('the log names what was skipped', 'WIPE_TRIGGER.txt (not seed data)' in out and 'a link' in out, out[-600:])

subprocess.run(['rm', '-rf', root])
print('\ntest-restore-copy: %d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)

"""
Tests for usbbootdrive/grow-transfer.sh (TRANSFER_DRIVE_DESIGN.md).

    PYTHONDONTWRITEBYTECODE=1 python3 usbbootdrive/tests/test-grow-transfer.py

The partition table work is real: an image laid out like build.sh's (with
small partitions) is "flashed" into a bigger sparse file, and the real
sgdisk changes it. What needs a real block device (lsblk, findmnt,
blockdev, partx, mount, mkfs.exfat) is played by small stand-ins on PATH,
so every check and refusal in the helper runs. Needs sgdisk (gdisk);
says SKIP without it.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, '..', 'grow-transfer.sh')
SECTOR = 512
MB = 1024 * 1024

if not shutil.which('sgdisk'):
    print('SKIP test-grow-transfer (sgdisk not installed: apt install gdisk)')
    sys.exit(0)

passed = failed = 0


def ck(name, ok, detail=''):
    global passed, failed
    if ok:
        passed += 1
        print('  [PASS] ' + name)
    else:
        failed += 1
        print('  [FAIL] ' + name + ('  → ' + str(detail)[:400] if detail else ''))


ROOT = tempfile.mkdtemp(prefix='grow-transfer-')
SHIMS = os.path.join(ROOT, 'bin')
os.makedirs(SHIMS)

# The stand-ins read and write one JSON state file: labels and file system
# types, what's mounted where, what the Transfer Drive holds, the kernel's
# idea of partition 5's size, and which steps should fail.
SHIM = r'''#!/usr/bin/env python3
import json, os, re, subprocess, sys
S = os.environ['GT_STATE']
st = json.load(open(S))
def save(): json.dump(st, open(S, 'w'))
me = os.path.basename(sys.argv[0]); a = sys.argv[1:]
st.setdefault('calls', []).append([me] + a); save()
def base(p): return os.path.basename(p)
if me == 'lsblk':
    field, dev = a[1], base(a[2])
    if field == 'PKNAME': print(st['parent'].get(dev, ''))
    elif field == 'LABEL': print(st['label'].get(dev, ''))
    elif field == 'FSTYPE': print(st['fstype'].get(dev, ''))
elif me == 'findmnt':
    dev = base(a[a.index('-S') + 1])
    for m in st['mounts'].get(dev, []): print(m)
elif me == 'blockdev':
    if a[0] == '--getss': print(512)
    else:
        dev = base(a[1])
        if dev == st['disk']: print(os.path.getsize(st['disk_path']))
        else: print(st['kernel_size'].get(dev, 0))
elif me == 'partx':
    if st['fail'].get('partx'): sys.exit(1)
    out = subprocess.run(['sgdisk', '-i', '5', st['disk_path']], capture_output=True, text=True).stdout
    first = int(re.search(r'First sector: (\d+)', out).group(1)); last = int(re.search(r'Last sector: (\d+)', out).group(1))
    st['kernel_size'][st['disk'] + st['psep'] + '5'] = (last - first + 1) * 512; save()
elif me == 'mount':
    dev, target = base(a[-2]), a[-1]
    if st['fail'].get('mount'): sys.exit(32)
    for n in st['transfer_files']:
        p = os.path.join(target, n)
        if n.endswith('/'): os.makedirs(p, exist_ok=True)
        else: open(p, 'w').write('x')
    st['mounts'].setdefault(dev, []).append(target); save()
elif me == 'umount':
    target = a[-1]
    if st['fail'].get('umount'): sys.exit(32)
    for dev, ms in st['mounts'].items():
        if target in ms:
            ms.remove(target)
            if os.path.isdir(target) and target.startswith('/tmp/grow-transfer.'):
                for n in os.listdir(target):
                    p = os.path.join(target, n)
                    (os.rmdir if os.path.isdir(p) and not os.listdir(p) else (lambda q: subprocess.run(['rm', '-rf', q])))(p)
    save()
elif me == 'mkfs.exfat':
    if st['fail'].get('mkfs'): sys.exit(1)
    dev = base(a[-1]); st['label'][dev] = a[a.index('-n') + 1]; st['fstype'][dev] = 'exfat'; st['mkfs'] = st.get('mkfs', 0) + 1; save()
elif me == 'udevadm':
    pass
'''
for name in ['lsblk', 'findmnt', 'blockdev', 'partx', 'mount', 'umount', 'mkfs.exfat', 'udevadm']:
    p = os.path.join(SHIMS, name)
    open(p, 'w').write(SHIM)
    os.chmod(p, 0o755)
# sgdisk is the real one; this stand-in only makes it report a failure after
# writing, as it may on a boot drive whose other partitions are in use.
REAL_SGDISK = shutil.which('sgdisk')
open(os.path.join(SHIMS, 'sgdisk'), 'w').write('''#!/bin/bash
"%s" "$@"; rc=$?
if [ "$rc" = 0 ] && [ "$1" = "-e" ] && grep -q '"sgdisk_rc": [1-9]' "$GT_STATE"; then
    echo "Warning: The kernel is still using the old partition table." >&2
    exit "$(python3 -c 'import json,os; print(json.load(open(os.environ["GT_STATE"]))["fail"]["sgdisk_rc"])')"
fi
exit "$rc"
''' % REAL_SGDISK)
os.chmod(os.path.join(SHIMS, 'sgdisk'), 0o755)

# The image: build.sh's layout and commands, with small partitions.
IMAGE_MB = 1 + 2 + 16 + 64 + 64 + 64 + 1
IMAGE = os.path.join(ROOT, 'safekeep.img')
with open(IMAGE, 'wb') as f:
    f.truncate(IMAGE_MB * MB)
for args in (['-Z'], ['-n', '1:2048:+2M', '-t', '1:EF02', '-c', '1:BIOS Boot'], ['-n', '2:0:+16M', '-t', '2:EF00', '-c', '2:EFI System'],
             ['-n', '3:0:+64M', '-t', '3:8300', '-c', '3:safekeep-os'], ['-n', '4:0:+64M', '-t', '4:8300', '-c', '4:safekeep-data'],
             ['-n', '5:0:0', '-t', '5:0700', '-c', '5:TRANSFER']):
    subprocess.run(['sgdisk'] + args + [IMAGE], check=True, capture_output=True)
# Some recognizable bytes in partitions 1 to 4, which must never change.
with open(IMAGE, 'r+b') as f:
    for i, off in enumerate([2048, 6144, 38912 + 100, 169984 + 50]):
        f.seek(off * SECTOR)
        f.write(hashlib.sha256(b'part%d' % i).digest() * 64)


def sgdisk_info(path, n):
    out = subprocess.run(['sgdisk', '-i', str(n), path], capture_output=True, text=True).stdout
    keep = ('Partition GUID code', 'Partition unique GUID', 'First sector', 'Last sector', 'Partition name')
    return {l.split(':')[0]: l.split(':', 1)[1].strip() for l in out.splitlines() if l.startswith(keep)}


def region_hash(path, start, end):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        f.seek(start * SECTOR)
        h.update(f.read((end - start) * SECTOR))
    return h.hexdigest()


def flash(disk_mb, disk='sdz', **over):
    """The image written to a bigger drive, as balenaEtcher or dd would."""
    devdir = tempfile.mkdtemp(prefix='dev-', dir=ROOT)
    path = os.path.join(devdir, disk)
    shutil.copyfile(IMAGE, path)
    with open(path, 'r+b') as f:
        f.truncate(disk_mb * MB)
    psep = 'p' if disk[-1].isdigit() else ''
    for n in (3, 4, 5):
        open(os.path.join(devdir, disk + psep + str(n)), 'w').close()
    state = {
        'disk': disk, 'disk_path': path, 'psep': psep,
        'parent': {disk + psep + str(n): disk for n in (3, 4, 5)},
        'label': {disk + psep + '3': 'safekeep-os', disk + psep + '4': 'safekeep-data', disk + psep + '5': 'TRANSFER'},
        'fstype': {disk + psep + '3': 'ext4', disk + psep + '4': 'ext4', disk + psep + '5': 'exfat'},
        'mounts': {disk + psep + '3': ['/run/live/medium'], disk + psep + '4': ['/mnt/safekeep-data']},
        'transfer_files': [], 'kernel_size': {}, 'fail': {},
    }
    for k, v in over.items():
        if isinstance(v, dict) and k in state:
            state[k].update(v)
        else:
            state[k] = v
    sp = os.path.join(devdir, 'state.json')
    json.dump(state, open(sp, 'w'))
    return devdir, path, sp


def run(devdir, sp, *args):
    env = dict(os.environ, PATH=SHIMS + ':' + os.environ['PATH'], GROW_TRANSFER_DEV_DIR=devdir, GT_STATE=sp)
    return subprocess.run(['bash', HELPER] + list(args), capture_output=True, text=True, env=env)


def state(sp):
    return json.load(open(sp))


DATA = lambda devdir, disk='sdz': os.path.join(devdir, disk + ('p' if disk[-1].isdigit() else '') + '4')

print('1. Growing a larger drive')
devdir, disk, sp = flash(3000)
before = {n: sgdisk_info(disk, n) for n in (1, 2, 3, 4, 5)}
data_before = region_hash(disk, 2048, int(before[5]['First sector'].split()[0]))
r = run(devdir, sp, '--check', DATA(devdir))
ck('--check says it can grow, and gives the drive\'s size in GB', r.returncode == 0 and r.stdout.strip().splitlines()[-1] == '3', r.stdout + r.stderr)
ck('--check changes nothing', sgdisk_info(disk, 5) == before[5] and not state(sp).get('mkfs'))
r = run(devdir, sp, DATA(devdir))
ck('it grows', r.returncode == 0 and 'done: the Transfer Drive is now' in r.stdout, r.stdout + r.stderr)
after = {n: sgdisk_info(disk, n) for n in (1, 2, 3, 4, 5)}
total = 3000 * MB // SECTOR
ck('partition 5 now ends at the end of the drive', after[5]['Last sector'].split()[0] == str(total - 34), after[5])
ck('...starting where it did, with the same GUID, type and name', all(after[5][k] == before[5][k] for k in ('First sector', 'Partition unique GUID', 'Partition GUID code', 'Partition name')), (before[5], after[5]))
ck('partitions 1 to 4 are unchanged in the table', all(after[n] == before[n] for n in (1, 2, 3, 4)))
ck('...and their bytes are unchanged', region_hash(disk, 2048, int(before[5]['First sector'].split()[0])) == data_before)
v = subprocess.run(['sgdisk', '-v', disk], capture_output=True, text=True).stdout
ck('the GPT is valid, with its backup copy at the end of the drive', 'No problems found' in v, v)
st = state(sp)
ck('a new exFAT labeled TRANSFER was made, once, after the kernel learned the new size',
   st.get('mkfs') == 1 and st['label']['sdz5'] == 'TRANSFER' and st['kernel_size'].get('sdz5') == (total - 34 - int(before[5]['First sector'].split()[0]) + 1) * SECTOR, st.get('kernel_size'))
calls = [c[0] for c in st['calls']]
ck('the order: look inside (read-only), unmount, change the table, partx, mkfs',
   calls.index('mount') < calls.index('umount') < calls.index('partx') < calls.index('mkfs.exfat'), calls)
ck('it looked inside read-only', any(c[0] == 'mount' and '-o' in c and c[c.index('-o') + 1] == 'ro' for c in st['calls']))
r = run(devdir, sp, DATA(devdir))
ck('a second run does nothing', r.returncode == 1 and 'nothing to do' in r.stdout and state(sp).get('mkfs') == 1, r.stdout)

print('2. When nothing is done')
devdir, disk, sp = flash(IMAGE_MB + 900)
before = sgdisk_info(disk, 5)
r = run(devdir, sp, DATA(devdir))
ck('less than 1 GB unused: nothing to do', r.returncode == 1 and 'nothing to do' in r.stdout and sgdisk_info(disk, 5) == before, r.stdout)
devdir, disk, sp = flash(IMAGE_MB)
r = run(devdir, sp, DATA(devdir))
ck('an 8 GB drive (no space left over): nothing to do', r.returncode == 1 and 'nothing to do' in r.stdout, r.stdout)

devdir, disk, sp = flash(3000, transfer_files=['Safekeep_backup_2026-11-19.7z'])
before = sgdisk_info(disk, 5)
r = run(devdir, sp, DATA(devdir))
ck('a file on the Transfer Drive (a backup to restore): left as it is',
   r.returncode == 1 and 'Safekeep_backup_2026-11-19.7z' in r.stdout and sgdisk_info(disk, 5) == before and not state(sp).get('mkfs'), r.stdout)
devdir, disk, sp = flash(3000, transfer_files=['.Spotlight-V100/', '.fseventsd/', '.Trashes/', '.DS_Store', '._.Trashes',
                                               'System Volume Information/', '$RECYCLE.BIN/'])
r = run(devdir, sp, DATA(devdir))
ck('only what a Mac or Windows adds on its own: it grows', r.returncode == 0, r.stdout + r.stderr)
devdir, disk, sp = flash(3000, transfer_files=['Notes/'])
r = run(devdir, sp, DATA(devdir))
ck('a folder of the user\'s counts as a file', r.returncode == 1 and '"Notes"' in r.stdout, r.stdout)

mounted = tempfile.mkdtemp(prefix='mnt-', dir=ROOT)
open(os.path.join(mounted, 'wallet.psbt'), 'w').write('x')
devdir, disk, sp = flash(3000, mounts={'sdz5': [mounted]})
r = run(devdir, sp, DATA(devdir))
ck('already mounted with a file in it: left as it is (and not unmounted)', r.returncode == 1 and 'wallet.psbt' in r.stdout
   and not any(c[0] == 'umount' for c in state(sp)['calls']), r.stdout)
empty_mnt = tempfile.mkdtemp(prefix='mnt-', dir=ROOT)
devdir, disk, sp = flash(3000, mounts={'sdz5': [empty_mnt]})
r = run(devdir, sp, DATA(devdir))
ck('already mounted and empty: unmounted first, then grown', r.returncode == 0 and ['umount', empty_mnt] in state(sp)['calls'], r.stdout + r.stderr)
devdir, disk, sp = flash(3000, mounts={'sdz5': [empty_mnt]}, fail={'umount': True})
before = sgdisk_info(disk, 5)
r = run(devdir, sp, DATA(devdir))
ck('can\'t unmount it: nothing is changed', r.returncode == 1 and 'in use' in r.stdout and sgdisk_info(disk, 5) == before, r.stdout)

print('3. The wrong drive or layout')
devdir, disk, sp = flash(3000)
r = run(devdir, sp, os.path.join(devdir, 'sdz3'))
ck('given a partition that isn\'t partition 4: refused', r.returncode == 1 and "isn't partition 4" in r.stdout, r.stdout)
for what, over, words in [
    ('partition 3 isn\'t safekeep-os', {'label': {'sdz3': 'other'}}, "isn't safekeep-os"),
    ('partition 4 isn\'t safekeep-data', {'label': {'sdz4': 'data'}}, "isn't safekeep-data"),
    ('partition 5 isn\'t TRANSFER', {'label': {'sdz5': 'USB'}}, "isn't TRANSFER"),
    ('partition 5 isn\'t exFAT', {'fstype': {'sdz5': 'vfat'}}, "isn't exFAT"),
    ('not the drive SafeKeep runs from (its OS partition isn\'t mounted)', {'mounts': {'sdz3': []}}, "isn't the drive SafeKeep is running from"),
    ('the drive can\'t be told', {'parent': {'sdz4': ''}}, "can't tell which drive"),
]:
    devdir, disk, sp = flash(3000, **over)
    before = sgdisk_info(disk, 5)
    r = run(devdir, sp, DATA(devdir))
    ck(what + ': refused, nothing changed', r.returncode == 1 and words in r.stdout and sgdisk_info(disk, 5) == before, r.stdout)
devdir, disk, sp = flash(3000)
subprocess.run(['sgdisk', '-e', '-d', '5', '-n', '5:301056:+60M', '-t', '5:0700', '-c', '5:TRANSFER', '-n', '6:0:+10M', disk], check=True, capture_output=True)
r = run(devdir, sp, DATA(devdir))
ck('partition 5 isn\'t the last: refused', r.returncode == 1 and "isn't the last" in r.stdout, r.stdout)
devdir, disk, sp = flash(3000)
subprocess.run(['sgdisk', '-t', '5:8300', disk], check=True, capture_output=True)
r = run(devdir, sp, DATA(devdir))
ck('partition 5 has another type: refused', r.returncode == 1 and 'unexpected type' in r.stdout, r.stdout)
r = run(devdir, sp, os.path.join(devdir, 'nothere4'))
ck('a data partition that doesn\'t exist: refused', r.returncode == 1)

devdir, disk, sp = flash(3000, disk='nvme0n1')
r = run(devdir, sp, DATA(devdir, 'nvme0n1'))
ck('NVMe-style names (nvme0n1p4) work', r.returncode == 0 and state(sp)['label']['nvme0n1p5'] == 'TRANSFER', r.stdout + r.stderr)

print('4. Stopping halfway')
devdir, disk, sp = flash(3000, fail={'partx': True})
r = run(devdir, sp, DATA(devdir))
ck('the kernel doesn\'t take the new size: exit 2, no new exFAT (the old one still works)',
   r.returncode == 2 and not state(sp).get('mkfs'), (r.returncode, r.stdout))
devdir, disk, sp = flash(3000, fail={'mkfs': True})
r = run(devdir, sp, DATA(devdir))
ck('the new exFAT can\'t be made: exit 2', r.returncode == 2 and "wasn't made" in r.stdout, (r.returncode, r.stdout))
devdir, disk, sp = flash(3000, fail={'sgdisk_rc': 4})
r = run(devdir, sp, DATA(devdir))
ck('sgdisk writes the table but reports the kernel kept the old one: it carries on and finishes',
   r.returncode == 0 and 'carrying on' in r.stdout and state(sp).get('mkfs') == 1, (r.returncode, r.stdout))
devdir, disk, sp = flash(3000, fail={'mount': True})
r = run(devdir, sp, DATA(devdir))
ck('can\'t look inside the Transfer Drive: nothing is done', r.returncode == 1 and "can't look inside" in r.stdout, r.stdout)

print('5. Wiring')
sv = open(os.path.join(HERE, '..', 'setup-vault.sh')).read()
i_check, i_grow, i_dd = sv.find('--check "$DATA_PART"'), sv.find('sudo "$GROW_TRANSFER" "$DATA_PART" 1>&2 ||'), sv.find('sudo dd if=/dev/zero of="$DATA_MOUNT/$VAULT_FILE"')
ck('setup-vault: checks first, grows inside the progress window, before the vault is written', 0 < i_check < i_grow < i_dd)
ck('setup-vault: its messages go to the log, and a failure never stops setup', '1>&2 || echo "setup-vault: growing the Transfer Drive didn\'t finish' in sv
   and 'GROW_OUT=$(sudo "$GROW_TRANSFER" --check "$DATA_PART" 2>&1) && GROW_GB=' in sv)
ck('setup-vault: the progress line names the drive\'s size', '# Using the rest of this ${GROW_GB} GB flash drive for the Transfer Drive...' in sv)
for f in ('build.sh', 'quick-update.sh'):
    ck(f + ' installs the helper', 'install -m 755 grow-transfer.sh "$CHROOT_DIR/usr/local/lib/safekeep/grow-transfer.sh"' in open(os.path.join(HERE, '..', f)).read())

shutil.rmtree(ROOT, ignore_errors=True)
print('\ntest-grow-transfer: %d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)

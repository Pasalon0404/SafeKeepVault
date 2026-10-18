#!/usr/bin/env python3
"""
safekeep-update — install a signed SafeKeep update from the Transfer Drive.

    safekeep-update.py REQUEST.json RESULT.json

Run by the Update Watcher in safekeep-boot.sh (as root, normal boots only),
for Device Options -> Update SafeKeep. See UPDATER_DESIGN.md.

THE UPDATE FILE
  SafeKeep-Update-v<version>[...].tar on the Transfer Drive, an uncompressed
  tar made by make-update.sh, holding:
    manifest.json       version, build stamp, app hash, and the size and
                        SHA-256 of every OS file below
    manifest.json.asc   the maintainer's detached signature of manifest.json
    filesystem.squashfs, vmlinuz, initrd   (required)
    filesystem.size, filesystem.manifest   (optional)

SECURITY MODEL
  * The request file is UNTRUSTED DATA written by the browser: read once,
    deleted, size-limited, validated field by field. It only chooses an
    action and names a file in the Transfer Drive's top folder.
  * The update file is untrusted until manifest.json passes gpgv against the
    maintainer key built into the image (/usr/local/share/safekeep/
    maintainer.gpg), and the signing key's fingerprint is the pinned one.
    Only then is anything else in the tar read, and every OS file must match
    the size and SHA-256 in that signed manifest.
  * Nothing from the tar is unpacked by name or path: the helper looks up
    exactly the allowed member names, requires regular files, and streams
    their bytes into files it names itself.
  * Only a NEWER build installs: a higher version, or the same version with
    a higher build number. An old update with a known bug can't be put back.
  * The new OS goes into the slot that is NOT running (two-slot layout,
    UPDATER_DESIGN.md), under a temporary name. It is read back from the
    stick and checked against the manifest, renamed into place, and only
    then does slot.cfg switch, by an atomic rename. A power cut at any point
    leaves a stick that boots; the running OS is never touched.
  * "install" repeats every check, and installs only the manifest the user
    was shown (manifest_sha256 from "check").
  * Refused in a temporary session: updating needs the vault unlocked.
  * No network code. No command from the request or the tar is ever run.

Actions:
  check    -> find update files, verify them, and describe the newest valid
              one: version, build stamp, app SHA-256, size.
  install  -> install that file; progress results ("working") are written
              while it runs, then "installed".

Result JSON: {"ok": true/false, "status": "...", "request_id": ..., ...}
  ok statuses   : none, ready, working, installed
  error statuses: bad_request, temporary, old_layout, no_valid_update,
                  not_newer, no_space, bad_signature, bad_update, changed,
                  write_failed, error
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

KEYRING = os.environ.get('SAFEKEEP_UPD_KEYRING', '/usr/local/share/safekeep/maintainer.gpg')
MAINTAINER_FPR = os.environ.get('SAFEKEEP_UPD_FPR', 'A333EB826F70A79A736F09948EA7DD8CEDBA86C2')
OS_MNT = os.environ.get('SAFEKEEP_UPD_OS', '/cdrom')
TRANSFER = os.environ.get('SAFEKEEP_TRANSFER', '/media/safekeep-transfer')
CMDLINE = os.environ.get('SAFEKEEP_UPD_CMDLINE', '/proc/cmdline')
RUNNING_APP = os.environ.get('SAFEKEEP_UPD_APP', '/opt/safekeep/boot.html')
REMOUNT = os.environ.get('SAFEKEEP_UPD_REMOUNT', '1') == '1'
TEMPORARY = os.environ.get('SAFEKEEP_EPHEMERAL', '0') == '1'

FILES_REQUIRED = ('filesystem.squashfs', 'vmlinuz', 'initrd')
FILES_ALLOWED = FILES_REQUIRED + ('filesystem.size', 'filesystem.manifest')
MAX_REQUEST = 4096
MAX_SMALL = 65536                 # manifest.json, manifest.json.asc
MAX_OS_FILE = 4 * 1024 ** 3
SPARE_BYTES = 50 * 1024 * 1024    # keep this much free on the OS partition
NAME_RE = re.compile(r'^SafeKeep-Update-[A-Za-z0-9._-]{1,80}( \(\d{1,3}\))?\.tar$')
STAMP_RE = re.compile(r'v(\d{1,3})\.(\d{1,3}) · build (\d{1,7}) · ([0-9a-f]{7,40})'
                      r'(?: · \d{4}-\d{2}-\d{2})?(?: \+ (?:local changes|shallow clone))*')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
CHUNK = 1024 * 1024


class Refuse(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---- result file ---------------------------------------------------------

_result_path = None
_request_id = None


def write_result(obj):
    obj = dict(obj)
    if _request_id:
        obj['request_id'] = _request_id
    tmp = _result_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f)
    os.replace(tmp, _result_path)


# ---- small helpers -------------------------------------------------------

def stamp_of_text(text):
    m = STAMP_RE.search(text)
    if not m:
        return None
    return {'major': int(m.group(1)), 'minor': int(m.group(2)),
            'build': int(m.group(3)), 'commit': m.group(4), 'text': m.group(0)}


def running_stamp():
    try:
        with open(RUNNING_APP, 'rb') as f:
            return stamp_of_text(f.read().decode('utf-8', 'replace'))
    except OSError:
        return None


def running_slot():
    try:
        with open(CMDLINE, encoding='utf-8') as f:
            m = re.search(r'(?:^|\s)live-media-path=/?casper-([ab])(?:\s|$)', f.read())
    except OSError:
        return None
    return m.group(1) if m else None


def other(slot):
    return 'b' if slot == 'a' else 'a'


def is_newer(upd, cur):
    return (upd['major'], upd['minor'], upd['build']) > (cur['major'], cur['minor'], cur['build'])


def file_sha256(path, progress=None):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(CHUNK)
            if not b:
                break
            h.update(b)
            if progress:
                progress(len(b))
    return h.hexdigest()


def dir_bytes(path):
    total = 0
    if os.path.isdir(path):
        for name in os.listdir(path):
            p = os.path.join(path, name)
            if os.path.isfile(p) and not os.path.islink(p):
                total += os.path.getsize(p)
    return total


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_slot_cfg(slot):
    tmp = os.path.join(OS_MNT, '.slot.cfg.new')
    with open(tmp, 'w', encoding='ascii') as f:
        f.write('set slot=%s\n' % slot)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, os.path.join(OS_MNT, 'slot.cfg'))
    fsync_dir(OS_MNT)


def slot_cfg():
    try:
        with open(os.path.join(OS_MNT, 'slot.cfg'), encoding='ascii') as f:
            return 'b' if f.read().strip() == 'set slot=b' else 'a'
    except OSError:
        return 'a'


# ---- reading and verifying an update file -------------------------------

def member(tf, name, max_size):
    try:
        m = tf.getmember(name)
    except KeyError:
        return None
    if not m.isreg() or m.size < 0 or m.size > max_size:
        raise Refuse('bad_update', '%s in the update file is not a plain file of a sensible size.' % name)
    return m


def verify_signature(manifest_bytes, sig_bytes):
    with tempfile.TemporaryDirectory(prefix='skupd-') as d:
        man = os.path.join(d, 'manifest.json')
        sig = os.path.join(d, 'manifest.json.asc')
        with open(man, 'wb') as f:
            f.write(manifest_bytes)
        with open(sig, 'wb') as f:
            f.write(sig_bytes)
        env = {'GNUPGHOME': d, 'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
        try:
            r = subprocess.run(['gpgv', '--status-fd', '1', '--keyring', KEYRING, sig, man],
                               capture_output=True, text=True, timeout=60, env=env)
        except (OSError, subprocess.TimeoutExpired):
            raise Refuse('error', 'The signature checker (gpgv) could not run.')
    valid = [l.split() for l in r.stdout.splitlines() if l.startswith('[GNUPG:] VALIDSIG ')]
    if r.returncode != 0 or not valid:
        raise Refuse('bad_signature', 'The update file is not signed by SafeKeep\'s maintainer, or it was changed after signing.')
    fields = valid[0]
    signer, primary = fields[2], fields[-1]
    if MAINTAINER_FPR not in (signer, primary):
        raise Refuse('bad_signature', 'The update file is signed by a different key.')


def parse_manifest(data):
    try:
        m = json.loads(data.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise Refuse('bad_update', 'The update\'s manifest is not valid JSON.')
    if not isinstance(m, dict) or m.get('format') != 1 or m.get('kind') != 'safekeep-os-update':
        raise Refuse('bad_update', 'This is not a SafeKeep OS update.')
    stamp = stamp_of_text(str(m.get('build', '')))
    version = m.get('version')
    if not stamp or not isinstance(version, str) or version != '%d.%d' % (stamp['major'], stamp['minor']):
        raise Refuse('bad_update', 'The update\'s version and build stamp don\'t agree.')
    if m.get('layout') != 'two-slot':
        raise Refuse('bad_update', 'The update is for a different stick layout.')
    app = m.get('app_sha256')
    if not isinstance(app, str) or not HEX64.match(app):
        raise Refuse('bad_update', 'The update\'s app hash is missing.')
    files = m.get('files')
    if not isinstance(files, dict) or not all(n in files for n in FILES_REQUIRED) \
            or not all(n in FILES_ALLOWED for n in files):
        raise Refuse('bad_update', 'The update\'s file list is wrong.')
    for name, info in files.items():
        if not isinstance(info, dict) or not isinstance(info.get('sha256'), str) \
                or not HEX64.match(info['sha256']) or not isinstance(info.get('size'), int) \
                or isinstance(info.get('size'), bool) or not 0 < info['size'] <= MAX_OS_FILE:
            raise Refuse('bad_update', 'The update lists %s wrongly.' % name)
    return m, stamp


def inspect(path):
    """Open one update file, verify its signature and contents list."""
    try:
        tf = tarfile.open(path, 'r:')
    except (tarfile.TarError, OSError):
        raise Refuse('bad_update', 'This is not a readable update file.')
    try:
        mm = member(tf, 'manifest.json', MAX_SMALL)
        sm = member(tf, 'manifest.json.asc', MAX_SMALL)
        if mm is None:
            raise Refuse('bad_update', 'The update file has no manifest.')
        if sm is None:
            raise Refuse('bad_signature', 'The update file is not signed.')
        manifest_bytes = tf.extractfile(mm).read(MAX_SMALL + 1)
        sig_bytes = tf.extractfile(sm).read(MAX_SMALL + 1)
        verify_signature(manifest_bytes, sig_bytes)
        manifest, stamp = parse_manifest(manifest_bytes)
        for name, info in manifest['files'].items():
            om = member(tf, name, MAX_OS_FILE)
            if om is None or om.size != info['size']:
                raise Refuse('bad_update', '%s in the update file is missing or the wrong size.' % name)
    finally:
        tf.close()
    return {
        'file': os.path.basename(path),
        'path': path,
        'version': manifest['version'],
        'build': stamp['text'],
        'stamp': stamp,
        'app_sha256': manifest['app_sha256'],
        'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
        'bytes': sum(i['size'] for i in manifest['files'].values()),
        'manifest': manifest,
    }


def candidates():
    try:
        names = os.listdir(TRANSFER)
    except OSError:
        return []
    out = []
    for n in names:
        p = os.path.join(TRANSFER, n)
        if NAME_RE.match(n) and os.path.isfile(p) and not os.path.islink(p):
            out.append(p)
    return sorted(out)


def preflight():
    """Checks that don't depend on the update file. Returns (running slot, current stamp)."""
    if TEMPORARY:
        raise Refuse('temporary', 'Updates need your vault: restart SafeKeep and unlock the vault, then update.')
    slot = running_slot()
    if not slot or not os.path.isdir(os.path.join(OS_MNT, 'casper-' + slot)):
        raise Refuse('old_layout', 'This stick has the older layout, which can\'t update in place. Back up, flash the new image and restore once; after that, updates work from here.')
    cur = running_stamp()
    if not cur:
        raise Refuse('error', 'SafeKeep could not read its own version.')
    return slot, cur


def public(info):
    return {k: info[k] for k in ('file', 'version', 'build', 'app_sha256', 'manifest_sha256', 'bytes')}


def check_space(info, slot):
    idle = os.path.join(OS_MNT, 'casper-' + other(slot))
    leftover = os.path.join(OS_MNT, '.casper-%s.new' % other(slot))
    st = os.statvfs(OS_MNT)
    free = st.f_bavail * st.f_frsize + dir_bytes(idle) + dir_bytes(leftover)
    if free < info['bytes'] + SPARE_BYTES:
        raise Refuse('no_space', 'There isn\'t room on the stick\'s system partition for this update.')


# ---- actions -------------------------------------------------------------

def do_check():
    slot, cur = preflight()
    found = candidates()
    if not found:
        return {'ok': True, 'status': 'none', 'current': cur['text'],
                'message': 'No update file on the Transfer Drive. Copy SafeKeep-Update-….tar onto it, then check again.'}
    valid, problems = [], []
    for p in found:
        try:
            valid.append(inspect(p))
        except Refuse as e:
            problems.append({'file': os.path.basename(p), 'status': e.status, 'error': e.message})
    if not valid:
        first = problems[0]
        return {'ok': False, 'status': first['status'] if len(problems) == 1 else 'no_valid_update',
                'error': first['error'] if len(problems) == 1 else 'None of the update files on the Transfer Drive can be used.',
                'problems': problems, 'current': cur['text']}
    best = max(valid, key=lambda v: (v['stamp']['major'], v['stamp']['minor'], v['stamp']['build']))
    if not is_newer(best['stamp'], cur):
        return {'ok': False, 'status': 'not_newer', 'current': cur['text'], 'update': public(best),
                'error': 'The update on the Transfer Drive (%s) is not newer than this SafeKeep (%s).' % (best['build'], cur['text'])}
    check_space(best, slot)
    return {'ok': True, 'status': 'ready', 'current': cur['text'], 'update': public(best),
            'slot': other(slot), 'problems': problems}


def do_install(req):
    slot, cur = preflight()
    name = req.get('file')
    want = req.get('manifest_sha256')
    if not isinstance(name, str) or not NAME_RE.match(name) or not isinstance(want, str) or not HEX64.match(want):
        raise Refuse('bad_request', 'The install request is invalid.')
    path = os.path.join(TRANSFER, name)
    if not os.path.isfile(path) or os.path.islink(path):
        raise Refuse('changed', 'The update file is no longer on the Transfer Drive.')
    info = inspect(path)
    if info['manifest_sha256'] != want:
        raise Refuse('changed', 'The update file changed since it was checked. Check again.')
    if not is_newer(info['stamp'], cur):
        raise Refuse('not_newer', 'The update is not newer than this SafeKeep.')
    check_space(info, slot)

    idle = other(slot)
    files = info['manifest']['files']
    total = info['bytes'] * 2          # write, then read back
    done = [0]
    last = [0.0]

    def progress(step):
        def tick(n):
            done[0] += n
            now = time.monotonic()
            if now - last[0] > 1.0:
                last[0] = now
                write_result({'ok': True, 'status': 'working', 'step': step,
                              'percent': min(99, int(done[0] * 100 / max(total, 1)))})
        return tick

    write_result({'ok': True, 'status': 'working', 'step': 'Preparing', 'percent': 0})
    remounted = False
    try:
        if REMOUNT:
            r = subprocess.run(['mount', '-o', 'remount,rw', OS_MNT], capture_output=True, text=True, timeout=60)
            if r.returncode != 0:
                raise Refuse('write_failed', 'SafeKeep could not open its system partition for writing.')
            remounted = True
        # If slot.cfg already names the idle slot (an update installed but
        # not yet restarted), point it back at the running slot first, so a
        # power cut while that slot is rewritten still boots this one.
        if slot_cfg() != slot:
            write_slot_cfg(slot)
        new = os.path.join(OS_MNT, '.casper-%s.new' % idle)
        dest = os.path.join(OS_MNT, 'casper-' + idle)
        shutil.rmtree(new, ignore_errors=True)
        shutil.rmtree(dest, ignore_errors=True)
        os.sync()
        os.mkdir(new, 0o755)
        tf = tarfile.open(path, 'r:')
        try:
            for fname, meta in files.items():
                m = member(tf, fname, MAX_OS_FILE)
                if m is None or m.size != meta['size']:
                    raise Refuse('changed', 'The update file changed while installing.')
                src = tf.extractfile(m)
                h = hashlib.sha256()
                tick = progress('Writing')
                with open(os.path.join(new, fname), 'wb') as out:
                    while True:
                        b = src.read(CHUNK)
                        if not b:
                            break
                        h.update(b)
                        out.write(b)
                        tick(len(b))
                    out.flush()
                    os.fsync(out.fileno())
                if h.hexdigest() != meta['sha256']:
                    raise Refuse('bad_update', '%s does not match the signed manifest.' % fname)
        finally:
            tf.close()
        os.sync()
        try:
            with open('/proc/sys/vm/drop_caches', 'w') as f:
                f.write('3\n')
        except OSError:
            pass
        tick = progress('Checking')
        for fname, meta in files.items():
            if file_sha256(os.path.join(new, fname), tick) != meta['sha256']:
                raise Refuse('write_failed', '%s did not read back correctly from the stick.' % fname)
        os.rename(new, dest)
        fsync_dir(OS_MNT)
        write_slot_cfg(idle)
        os.sync()
    except Refuse:
        raise
    except OSError as e:
        raise Refuse('write_failed', 'Writing the update failed (%s). This SafeKeep is unchanged.' % e.strerror)
    finally:
        if remounted:
            subprocess.run(['mount', '-o', 'remount,ro', OS_MNT], capture_output=True, timeout=60)
    removed = False
    try:
        os.remove(path)
        removed = True
    except OSError:
        pass
    return {'ok': True, 'status': 'installed', 'slot': idle, 'version': info['version'],
            'build': info['build'], 'app_sha256': info['app_sha256'], 'removed_file': removed}


def main():
    global _result_path, _request_id
    if len(sys.argv) != 3:
        print('usage: safekeep-update.py REQUEST.json RESULT.json', file=sys.stderr)
        return 2
    req_path, _result_path = sys.argv[1], sys.argv[2]
    try:
        with open(req_path, 'rb') as f:
            raw = f.read(MAX_REQUEST + 1)
    except OSError:
        raw = b''
    try:
        os.remove(req_path)
    except OSError:
        pass
    try:
        if len(raw) > MAX_REQUEST:
            raise Refuse('bad_request', 'The request is too large.')
        try:
            req = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise Refuse('bad_request', 'The request is not valid JSON.')
        if not isinstance(req, dict):
            raise Refuse('bad_request', 'The request is not an object.')
        rid = req.get('request_id')
        if isinstance(rid, str) and re.fullmatch(r'[0-9a-f]{8,64}', rid):
            _request_id = rid
        action = req.get('action')
        if action == 'check':
            result = do_check()
        elif action == 'install':
            result = do_install(req)
        else:
            raise Refuse('bad_request', 'Unknown action.')
    except Refuse as e:
        result = {'ok': False, 'status': e.status, 'error': e.message}
    except Exception:  # never leave the app waiting
        result = {'ok': False, 'status': 'error', 'error': 'The update helper stopped unexpectedly. This SafeKeep is unchanged.'}
    write_result(result)
    return 0


if __name__ == '__main__':
    sys.exit(main())

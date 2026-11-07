#!/usr/bin/env python3
"""
Tests for the release check in build.sh and make-update.sh (--release).

    python3 usbbootdrive/tests/test-release-check.py

v1.64 was first built with the app a quick update had left in src/dist
(stamped v1.63 · build 507), because the released boot.html hadn't been
copied over. `--release <version>` makes both scripts refuse that:

  1. build.sh: the check block, run for real against a fake src/dist,
     with the release app, a quick update's app, one with local changes,
     the online demo, no app stamp, a bad version, and no --release.
  2. make-update.sh, run for real on a fake build (a real squashfs made
     with mksquashfs): --release with the right app makes the release
     file; with the wrong app, local changes or the demo it stops and
     writes nothing; without --release it behaves as before.
"""
import os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OS_DIR = os.path.abspath(os.path.join(HERE, '..'))

passed = failed = 0
def ck(name, cond, extra=''):
    global passed, failed
    if cond: passed += 1
    else: failed += 1
    print('  [%s] %s%s' % ('PASS' if cond else 'FAIL', name, ('  -> ' + str(extra)[:400]) if (extra and not cond) else ''))

def app(stamp):
    return '<!doctype html><html><head><title>SafeKeep</title></head><body><span class="ver">%s</span></body></html>\n' % stamp

REL = 'v1.64 · build 510 · a880b0f · 2026-11-07'
QUICK = 'v1.63 · build 507 · f6d0205 · 2026-11-07'
LOCAL = 'v1.64 · build 510 · a880b0f · 2026-11-07 + local changes'
DEMO = 'v1.64 · build 510 · a880b0f · 2026-11-07 · demo'

print('\n1. build.sh --release')
src = open(os.path.join(OS_DIR, 'build.sh')).read()
start = src.index('# A release build names its version')
end = src.index('echo ""\n', src.index('(Not a release build.')) + len('echo ""\n')
block = src[start:end]
ck('the check comes before any slow step (Phase 1)', start < src.index('# PHASE 1: HOST DEPENDENCIES'))

def run_build(stamp, *args):
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, 'src', 'dist'))
    if stamp is not None:
        open(os.path.join(d, 'src', 'dist', 'boot.html'), 'w').write(app(stamp))
    script = os.path.join(d, 'check.sh')
    open(script, 'w').write('set -e\n' + block + 'echo CONTINUED\n')
    r = subprocess.run(['bash', script, *args], cwd=d, capture_output=True, text=True)
    shutil.rmtree(d)
    return r.returncode, r.stdout + r.stderr

rc, out = run_build(REL, '--release', '1.64')
ck('the v1.64 release app with --release 1.64: goes on, says so, shows its sha256', rc == 0 and 'CONTINUED' in out and 'OK: this is the v1.64 release app' in out and 'sha256: ' in out, out)
rc, out = run_build(REL, '--release', 'v1.64')
ck('…"v1.64" is accepted too', rc == 0 and 'CONTINUED' in out, out)
rc, out = run_build(REL, '--release=1.64')
ck('…and --release=1.64', rc == 0 and 'CONTINUED' in out, out)
rc, out = run_build(QUICK, '--release', '1.64')
ck('a quick update\'s app (v1.63 · build 507): stops, says it is v1.63, says how to fix it', rc == 1 and 'CONTINUED' not in out and 'it is v1.63, not v1.64' in out and 'gh release download v1.64' in out, out)
rc, out = run_build(LOCAL, '--release', '1.64')
ck('an app with local changes: stops', rc == 1 and 'local changes' in out and 'CONTINUED' not in out, out)
rc, out = run_build(DEMO, '--release', '1.64')
ck('the online demo: stops', rc == 1 and 'online demo' in out and 'CONTINUED' not in out, out)
rc, out = run_build('no stamp here', '--release', '1.64')
ck('an app with no build stamp: stops', rc == 1 and 'no build stamp' in out and 'CONTINUED' not in out, out)
rc, out = run_build(REL, '--release', '1.6x')
ck('a bad version: stops', rc == 1 and 'version like 1.64' in out, out)
rc, out = run_build(REL, '--release')
ck('--release with no version: stops', rc != 0 and 'CONTINUED' not in out, out)
rc, out = run_build(REL, '--bogus')
ck('an unknown option: stops', rc == 1 and 'unknown option --bogus' in out, out)
rc, out = run_build(QUICK)
ck('without --release: goes on with any app, and says which and how to make a release', rc == 0 and 'CONTINUED' in out and QUICK in out and 'Not a release build' in out, out)

print('\n2. make-update.sh --release')
have_tools = shutil.which('mksquashfs') and shutil.which('unsquashfs')
ck('mksquashfs and unsquashfs are available for this test', bool(have_tools))

def run_update(stamp, *args):
    d = tempfile.mkdtemp()
    shutil.copy(os.path.join(OS_DIR, 'make-update.sh'), d)
    open(os.path.join(d, 'build.sh'), 'w').write('# placeholder\n')
    tree = os.path.join(d, 'tree')
    os.makedirs(os.path.join(tree, 'opt', 'safekeep'))
    os.makedirs(os.path.join(tree, 'etc'))
    open(os.path.join(tree, 'opt', 'safekeep', 'boot.html'), 'w').write(app(stamp))
    open(os.path.join(tree, 'etc', 'safekeep-chromium'), 'w').write('pinned 155.0.8059.84-1 abc\n')
    st = os.path.join(d, 'workspace', 'staging', 'casper')
    os.makedirs(st)
    subprocess.run(['mksquashfs', tree, os.path.join(st, 'filesystem.squashfs'), '-noappend', '-quiet'], check=True, capture_output=True)
    for f, body in (('vmlinuz', b'k' * 64), ('initrd', b'i' * 64), ('filesystem.size', b'123'), ('filesystem.manifest', b'pkg 1\n')):
        open(os.path.join(st, f), 'wb').write(body)
    r = subprocess.run(['bash', 'make-update.sh', *args], cwd=d, capture_output=True, text=True)
    made = sorted(f for f in os.listdir(d) if f.endswith('.tar'))
    shutil.rmtree(d)
    return r.returncode, r.stdout + r.stderr, made

if have_tools:
    rc, out, made = run_update(REL, '--release', '1.64')
    ck('the v1.64 app with --release 1.64: SafeKeep-Update-v1.64.tar', rc == 0 and made == ['SafeKeep-Update-v1.64.tar'], (out, made))
    rc, out, made = run_update(QUICK, '--release', '1.64')
    ck('a quick update\'s app (v1.63): stops, writes nothing, says to copy the released boot.html and rebuild', rc != 0 and not made and 'is v1.63, not v1.64' in out and 'sudo bash build.sh --release 1.64' in out, (out, made))
    rc, out, made = run_update(LOCAL, '--release', '1.64')
    ck('local changes: stops, writes nothing', rc != 0 and not made and 'local changes' in out, (out, made))
    rc, out, made = run_update(DEMO, '--release', '1.64')
    ck('the online demo: stops, writes nothing', rc != 0 and not made and 'online demo' in out, (out, made))
    rc, out, made = run_update(REL, '--release', 'x')
    ck('a bad version: stops', rc != 0 and not made and 'version like 1.64' in out, (out, made))
    rc, out, made = run_update(QUICK)
    ck('without --release: as before (the v1.63 app makes SafeKeep-Update-v1.63.tar)', rc == 0 and made == ['SafeKeep-Update-v1.63.tar'], (out, made))
    rc, out, made = run_update(LOCAL)
    ck('without --release, local changes: a -build file, as before', rc == 0 and made == ['SafeKeep-Update-v1.64-build510.tar'], (out, made))

print('\n%d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)

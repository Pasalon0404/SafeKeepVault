/**
 * test-updater.mjs — the on-stick updater (UPDATER_DESIGN.md, Part 2).
 *   1. make-update.sh packs a build's OS (a real squashfs holding a test app)
 *      into SafeKeep-Update-v….tar + manifest.json; the app hash and build
 *      stamp come from inside the squashfs. (Skipped without squashfs-tools.)
 *   2. safekeep-update.py on a fake OS partition, with a throwaway signing
 *      key standing in for the maintainer's:
 *      - no file; unsigned; signed by another key; not newer; temporary
 *        session; older stick layout; bad requests;
 *      - check describes the update; install writes the idle slot, checks
 *        it, switches slot.cfg, removes the update file;
 *      - a file changed after "check", or OS bytes that don't match the
 *        signed manifest, leave the stick untouched;
 *      - a symlink posing as an OS file is refused;
 *      - the next update goes into the other slot.
 *   3. Wiring: build.sh / quick-update.sh install the helper, safekeep-boot.sh
 *      runs it, the app's request/result bridge.
 * Needs python3, gpg and gpgv (and squashfs-tools for part 1).
 * Run: node test-updater.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync, readdirSync, symlinkSync, copyFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OS = join(ROOT, 'usbbootdrive');
let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c || x === undefined ? '' : '  -> ' + x)); };
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const has = (c) => sh('bash', ['-c', `command -v ${c}`]).status === 0;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const T = mkdtempSync(join(tmpdir(), 'sk-upd-'));
const STAMP_OLD = 'v1.46 · build 279 · 9f79f09 · 2026-10-18';
const STAMP_NEW = 'v1.47 · build 290 · 1a2b3c4 · 2026-11-01';

// ---- 3. Wiring (static) first, so it always runs ----
console.log('3. Wiring');
{
  const b = read('usbbootdrive/build.sh'), q = read('usbbootdrive/quick-update.sh'), boot = read('usbbootdrive/safekeep-boot.sh');
  ck('build.sh installs the helper', b.includes('install -m 755 safekeep-update.py "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-update.py"'));
  ck('quick-update.sh installs the helper', q.includes('install -m 755 safekeep-update.py "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-update.py"'));
  ck('safekeep-boot.sh runs it with python3 -I', boot.includes('python3 -I "$UPDATE_HELPER" "$UPDATE_REQUEST" "$UPDATE_RESULT"'));
  ck('...passing the Transfer Drive and the session type', boot.includes('SAFEKEEP_TRANSFER="${TRANSFER_MOUNT:-/media/safekeep-transfer}"') && boot.includes('SAFEKEEP_EPHEMERAL="$EPHEMERAL_MODE"'));
  ck('result goes to RAM', boot.includes('UPDATE_RESULT="$SIGNAL_DIR/UPDATE_RESULT.json"'));
  ck('bash -n safekeep-boot.sh', sh('bash', ['-n', join(OS, 'safekeep-boot.sh')]).status === 0);
  ck('bash -n make-update.sh', sh('bash', ['-n', join(OS, 'make-update.sh')]).status === 0);
  const js = read('seed-xor-tool/shared/boot.js');
  ck('app: UPDATE_REQUEST / UPDATE_ACK are system trigger files', js.includes("'UPDATE_REQUEST', 'UPDATE_ACK'"));
  ck('app: reads UPDATE_RESULT from RAM', js.includes('/UPDATE_RESULT.json'));
  ck('app: exports updateCheck and updateInstall', /updateCheck,\s*\n\s*updateInstall,/.test(js));
}

if (!has('gpg') || !has('gpgv') || !has('python3')) {
  console.log('  (gpg, gpgv or python3 missing: helper tests skipped)');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---- keys: "maintainer" and "attacker" ----
const gh = join(T, 'gnupg'); mkdirSync(gh, { mode: 0o700 });
const gpg = (args, input) => sh('gpg', ['--homedir', gh, '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', '', ...args], { input });
gpg(['--quick-gen-key', 'Test Maintainer <m@test>', 'ed25519', 'sign', 'never']);
gpg(['--quick-gen-key', 'Attacker <a@test>', 'ed25519', 'sign', 'never']);
const fprOf = (uid) => (gpg(['--with-colons', '--list-keys', uid]).stdout.split('\n').find((l) => l.startsWith('fpr:')) || '').split(':')[9];
const MFPR = fprOf('m@test'), AFPR = fprOf('a@test');
ck('test keys made', /^[0-9A-F]{40}$/.test(MFPR) && /^[0-9A-F]{40}$/.test(AFPR));
const KEYRING = join(T, 'maintainer.gpg');
sh('bash', ['-c', `gpg --homedir "${gh}" --batch --export ${MFPR} > "${KEYRING}"`]);
ck('maintainer keyring for gpgv', statSync(KEYRING).size > 0);

// Make an OS staging folder whose squashfs holds a test app with a stamp.
function makeStaging(dir, stamp, tag, chromium) {
  mkdirSync(join(dir, 'tree/opt/safekeep'), { recursive: true });
  if (chromium) { mkdirSync(join(dir, 'tree/etc'), { recursive: true }); writeFileSync(join(dir, 'tree/etc/safekeep-chromium'), chromium + '\n'); }
  writeFileSync(join(dir, 'tree/opt/safekeep/boot.html'), `<span data-skv-version>${stamp}</span>${tag}`);
  const st = join(dir, 'workspace/staging/casper'); mkdirSync(st, { recursive: true });
  if (has('mksquashfs')) {
    sh('mksquashfs', [join(dir, 'tree'), join(st, 'filesystem.squashfs'), '-noappend', '-quiet']);
  } else {
    writeFileSync(join(st, 'filesystem.squashfs'), `squashfs ${tag}`);
  }
  writeFileSync(join(st, 'vmlinuz'), `kernel ${tag}`);
  writeFileSync(join(st, 'initrd'), `initrd ${tag}`);
  writeFileSync(join(st, 'filesystem.size'), '123');
  writeFileSync(join(st, 'filesystem.manifest'), `pkgs ${tag}`);
  writeFileSync(join(dir, 'build.sh'), '# stand-in\n');
  return st;
}

// Build an update file: with make-update.sh when squashfs-tools exist,
// otherwise the same format by hand.
function makeUpdate(dir, stamp, tag, chromium) {
  const st = makeStaging(dir, stamp, tag, chromium);
  if (has('unsquashfs') && has('mksquashfs')) {
    const r = sh('bash', [join(OS, 'make-update.sh')], { cwd: dir });
    const name = readdirSync(dir).find((n) => n.startsWith('SafeKeep-Update-') && n.endsWith('.tar'));
    return { r, tar: name && join(dir, name), manifest: join(dir, 'manifest.json'), staging: st };
  }
  const files = ['filesystem.squashfs', 'vmlinuz', 'initrd', 'filesystem.size', 'filesystem.manifest'];
  const ver = stamp.match(/^v(\d+\.\d+)/)[1];
  const man = { format: 1, kind: 'safekeep-os-update', version: ver, build: stamp,
    app_sha256: createHash('sha256').update(`<span data-skv-version>${stamp}</span>${tag}`).digest('hex'), layout: 'two-slot',
    files: Object.fromEntries(files.map((f) => [f, { size: statSync(join(st, f)).size, sha256: sha(join(st, f)) }])) };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(man, null, 2) + '\n');
  const tar = join(dir, `SafeKeep-Update-v${ver}.tar`);
  sh('tar', ['--format=ustar', '-cf', tar, '-C', dir, 'manifest.json', '-C', st, ...files]);
  return { r: { status: 0, stdout: '' }, tar, manifest: join(dir, 'manifest.json'), staging: st };
}

function sign(u, keyFpr) {
  rmSync(u.manifest + '.asc', { force: true });
  gpg(['--local-user', keyFpr, '--armor', '--detach-sign', u.manifest]);
  sh('tar', ['-rf', u.tar, '-C', dirname(u.manifest), 'manifest.json.asc']);
}

// ---- 1. make-update.sh ----
console.log('1. make-update.sh');
const B1 = join(T, 'build1'); mkdirSync(B1);
const U1 = makeUpdate(B1, STAMP_NEW, 'new');
if (has('unsquashfs')) {
  ck('make-update.sh succeeds', U1.r.status === 0, (U1.r.stderr || '') + U1.r.stdout);
  ck('names the file by version', U1.tar && U1.tar.endsWith('SafeKeep-Update-v1.47.tar'));
  const m = JSON.parse(readFileSync(U1.manifest, 'utf8'));
  ck('manifest: format, kind, version, build, layout', m.format === 1 && m.kind === 'safekeep-os-update' && m.version === '1.47' && m.build === STAMP_NEW && m.layout === 'two-slot');
  ck('app hash read from inside the squashfs', m.app_sha256 === createHash('sha256').update(`<span data-skv-version>${STAMP_NEW}</span>new`).digest('hex'));
  ck('every OS file listed with size + sha256', ['filesystem.squashfs', 'vmlinuz', 'initrd', 'filesystem.size', 'filesystem.manifest'].every((f) => m.files[f] && m.files[f].sha256 === sha(join(U1.staging, f)) && m.files[f].size === statSync(join(U1.staging, f)).size));
  const list = sh('tar', ['-tf', U1.tar]).stdout.trim().split('\n');
  ck('tar holds manifest first, then the OS files', list[0] === 'manifest.json' && list.length === 6);
  ck('prints the signing commands', U1.r.stdout.includes('--detach-sign manifest.json') && U1.r.stdout.includes('tar -rf SafeKeep-Update-v1.47.tar manifest.json.asc'));
  const B9 = join(T, 'build9'); mkdirSync(B9);
  const U9 = makeUpdate(B9, STAMP_NEW + ' + local changes', 'dev');
  ck('a build with local changes gets a -build<N> name and a warning', U9.tar && U9.tar.endsWith('SafeKeep-Update-v1.47-build290.tar') && U9.r.stdout.includes('NOT FOR A RELEASE'));
  // Chromium: chroot-setup.sh records the installed browser in /etc/safekeep-chromium.
  const B10 = join(T, 'build10'); mkdirSync(B10);
  const U10 = makeUpdate(B10, STAMP_NEW, 'pinned', 'pinned 155.0.8059.84-1 ' + 'b'.repeat(64));
  ck('a pinned Chromium: release name, and the version is printed', U10.tar && U10.tar.endsWith('SafeKeep-Update-v1.47.tar') && U10.r.stdout.includes('Chromium   : pinned 155.0.8059.84-1') && !U10.r.stdout.includes('NOT FOR A RELEASE'), U10.r.stdout);
  const B11 = join(T, 'build11'); mkdirSync(B11);
  const U11 = makeUpdate(B11, STAMP_NEW, 'unpinned', 'UNPINNED ' + 'c'.repeat(64));
  ck('an unpinned Chromium is never a release: -build<N> name and a warning', U11.tar && U11.tar.endsWith('-build290.tar') && /NOT FOR A RELEASE: Chromium was not pinned/.test(U11.r.stdout), U11.r.stdout);
  ck('an older build without the record still works and says so', U1.r.stdout.includes('Chromium   : not recorded'));
} else {
  console.log('  (squashfs-tools not installed: make-update.sh run skipped; update made by hand)');
}

// ---- 2. safekeep-update.py ----
console.log('2. safekeep-update.py');
function stick(runningSlot = 'a', cfgSlot = runningSlot) {
  const d = mkdtempSync(join(T, 'stick-'));
  const os = join(d, 'cdrom'), tr = join(d, 'transfer');
  mkdirSync(join(os, 'casper-' + runningSlot), { recursive: true }); mkdirSync(tr);
  for (const f of ['filesystem.squashfs', 'vmlinuz', 'initrd']) writeFileSync(join(os, 'casper-' + runningSlot, f), `running ${f}`);
  writeFileSync(join(os, 'slot.cfg'), `set slot=${cfgSlot}\n`);
  writeFileSync(join(d, 'cmdline'), `BOOT_IMAGE=/casper-${runningSlot}/vmlinuz boot=casper live-media-path=casper-${runningSlot} nopersistent noprompt quiet ---\n`);
  writeFileSync(join(d, 'app.html'), `<span data-skv-version>${STAMP_OLD}</span>`);
  return { d, os, tr, env: { SAFEKEEP_UPD_KEYRING: KEYRING, SAFEKEEP_UPD_FPR: MFPR, SAFEKEEP_UPD_OS: os, SAFEKEEP_TRANSFER: tr,
    SAFEKEEP_UPD_CMDLINE: join(d, 'cmdline'), SAFEKEEP_UPD_APP: join(d, 'app.html'), SAFEKEEP_UPD_REMOUNT: '0', SAFEKEEP_EPHEMERAL: '0' } };
}
let rid = 0;
function run(s, req, extraEnv = {}) {
  const reqPath = join(s.d, 'UPDATE_REQUEST.json'), resPath = join(s.d, 'UPDATE_RESULT.json');
  const id = (++rid).toString(16).padStart(24, '0');
  writeFileSync(reqPath, typeof req === 'string' ? req : JSON.stringify({ request_id: id, ...req }));
  const r = sh('python3', ['-I', join(OS, 'safekeep-update.py'), reqPath, resPath], { env: { PATH: process.env.PATH, ...s.env, ...extraEnv } });
  let res = null; try { res = JSON.parse(readFileSync(resPath, 'utf8')); } catch (_) {}
  return { res: res || {}, id, deleted: !existsSync(reqPath), stderr: r.stderr };
}
const put = (s, u, name) => copyFileSync(u.tar, join(s.tr, name || u.tar.split('/').pop()));

sign(U1, MFPR);
{
  const s = stick();
  let { res, id, deleted } = run(s, { action: 'check' });
  ck('no update file: status none', res.ok === true && res.status === 'none' && res.current === STAMP_OLD, JSON.stringify(res));
  ck('request deleted after reading, request_id echoed', deleted && res.request_id === id);

  put(s, U1);
  ({ res } = run(s, { action: 'check' }));
  ck('check: ready, with version, build, app hash, size', res.ok && res.status === 'ready' && res.update.version === '1.47' && res.update.build === STAMP_NEW
     && /^[0-9a-f]{64}$/.test(res.update.app_sha256) && res.update.bytes > 0 && res.slot === 'b', JSON.stringify(res));
  const checked = res.update;

  ({ res } = run(s, { action: 'install', file: checked.file, manifest_sha256: '0'.repeat(64) }));
  ck('install of a manifest other than the one shown: changed', !res.ok && res.status === 'changed', JSON.stringify(res));
  ck('...and nothing was written', !existsSync(join(s.os, 'casper-b')) && readFileSync(join(s.os, 'slot.cfg'), 'utf8') === 'set slot=a\n');

  ({ res } = run(s, { action: 'install', file: checked.file, manifest_sha256: checked.manifest_sha256 }));
  ck('install: installed into slot b', res.ok && res.status === 'installed' && res.slot === 'b' && res.version === '1.47', JSON.stringify(res));
  ck('slot b holds exactly the update\'s files', ['filesystem.squashfs', 'vmlinuz', 'initrd', 'filesystem.size', 'filesystem.manifest'].every((f) => sha(join(s.os, 'casper-b', f)) === sha(join(U1.staging, f))));
  ck('slot.cfg switched to b', readFileSync(join(s.os, 'slot.cfg'), 'utf8') === 'set slot=b\n');
  ck('running slot a untouched', readFileSync(join(s.os, 'casper-a', 'vmlinuz'), 'utf8') === 'running vmlinuz');
  ck('no temporary files left', !existsSync(join(s.os, '.casper-b.new')) && !existsSync(join(s.os, '.slot.cfg.new')));
  ck('update file removed from the Transfer Drive', res.removed_file === true && readdirSync(s.tr).length === 0);

  // Installed, not restarted: another newer update is checked against the running slot.
  const B2 = join(T, 'build2'); mkdirSync(B2);
  const U2 = makeUpdate(B2, 'v1.47 · build 295 · 5e6f7a8 · 2026-11-03', 'newer');
  sign(U2, MFPR); put(s, U2);
  ({ res } = run(s, { action: 'check' }));
  const c2 = res.update;
  ({ res } = run(s, { action: 'install', file: c2.file, manifest_sha256: c2.manifest_sha256 }));
  ck('same version, higher build installs (before restarting)', res.ok && res.status === 'installed' && res.slot === 'b', JSON.stringify(res));
  ck('...still into the idle slot b, slot a untouched', sha(join(s.os, 'casper-b', 'initrd')) === sha(join(U2.staging, 'initrd')) && readFileSync(join(s.os, 'casper-a', 'vmlinuz'), 'utf8') === 'running vmlinuz');
}

{
  // Restarted into b: the next update goes into slot a.
  const s = stick('b');
  put(s, U1);
  let { res } = run(s, { action: 'check' });
  ck('running slot b: the update targets slot a', res.ok && res.slot === 'a', JSON.stringify(res));
  ({ res } = run(s, { action: 'install', file: res.update.file, manifest_sha256: res.update.manifest_sha256 }));
  ck('...and installs there', res.ok && res.slot === 'a' && readFileSync(join(s.os, 'slot.cfg'), 'utf8') === 'set slot=a\n' && existsSync(join(s.os, 'casper-a', 'vmlinuz')));
}

{
  const s = stick();
  // Unsigned.
  const B3 = join(T, 'build3'); mkdirSync(B3);
  const U3 = makeUpdate(B3, STAMP_NEW, 'unsigned');
  put(s, U3);
  let { res } = run(s, { action: 'check' });
  ck('unsigned update refused', !res.ok && res.status === 'bad_signature', JSON.stringify(res));
  rmSync(join(s.tr, U3.tar.split('/').pop()));
  // Signed by another key.
  sign(U3, AFPR); put(s, U3);
  ({ res } = run(s, { action: 'check' }));
  ck('update signed by another key refused', !res.ok && res.status === 'bad_signature', JSON.stringify(res));
  ({ res } = run(s, { action: 'install', file: U3.tar.split('/').pop(), manifest_sha256: 'a'.repeat(64) }));
  ck('...install refused too, nothing written', !res.ok && res.status === 'bad_signature' && !existsSync(join(s.os, 'casper-b')));
  rmSync(join(s.tr, U3.tar.split('/').pop()));
  // Older than running.
  const B4 = join(T, 'build4'); mkdirSync(B4);
  const U4 = makeUpdate(B4, 'v1.46 · build 270 · 0000001 · 2026-10-10', 'old');
  sign(U4, MFPR); put(s, U4);
  ({ res } = run(s, { action: 'check' }));
  ck('older update refused (not_newer)', !res.ok && res.status === 'not_newer', JSON.stringify(res));
  rmSync(join(s.tr, U4.tar.split('/').pop()));
  // Same build as running.
  const B5 = join(T, 'build5'); mkdirSync(B5);
  const U5 = makeUpdate(B5, STAMP_OLD, 'same');
  sign(U5, MFPR); put(s, U5);
  ({ res } = run(s, { action: 'check' }));
  ck('same build refused (not_newer)', !res.ok && res.status === 'not_newer');
  rmSync(join(s.tr, U5.tar.split('/').pop()));
}

{
  // OS bytes that don't match the signed manifest (same size).
  const s = stick();
  const B6 = join(T, 'build6'); mkdirSync(B6);
  const U6 = makeUpdate(B6, STAMP_NEW, 'tamper');
  sign(U6, MFPR);
  const kpath = join(U6.staging, 'vmlinuz');
  const orig = readFileSync(kpath, 'utf8');
  writeFileSync(kpath, orig.replace(/.$/, orig.endsWith('X') ? 'Y' : 'X'));
  sh('tar', ['--delete', '-f', U6.tar, 'vmlinuz']);
  sh('tar', ['-rf', U6.tar, '-C', U6.staging, 'vmlinuz']);
  put(s, U6);
  let { res } = run(s, { action: 'check' });
  ck('tampered OS file: check still finds a signed update', res.ok && res.status === 'ready', JSON.stringify(res));
  ({ res } = run(s, { action: 'install', file: res.update.file, manifest_sha256: res.update.manifest_sha256 }));
  ck('...install refuses: does not match the signed manifest', !res.ok && res.status === 'bad_update' && /vmlinuz/.test(res.error), JSON.stringify(res));
  ck('...slot.cfg still a, slot a intact, no slot b', readFileSync(join(s.os, 'slot.cfg'), 'utf8') === 'set slot=a\n' && existsSync(join(s.os, 'casper-a', 'vmlinuz')) && !existsSync(join(s.os, 'casper-b')));
  ck('...the update file is kept', readdirSync(s.tr).length === 1);
}

{
  // A symlink posing as an OS file.
  const s = stick();
  const B7 = join(T, 'build7'); mkdirSync(B7);
  const U7 = makeUpdate(B7, STAMP_NEW, 'link');
  sh('tar', ['--delete', '-f', U7.tar, 'initrd']);
  rmSync(join(U7.staging, 'initrd'));
  symlinkSync('/etc/passwd', join(U7.staging, 'initrd'));
  sh('tar', ['-rf', U7.tar, '-C', U7.staging, 'initrd']);
  sign(U7, MFPR); put(s, U7);
  const { res } = run(s, { action: 'check' });
  ck('symlink member refused', !res.ok && res.status === 'bad_update', JSON.stringify(res));
}

{
  // The file is replaced between check and install.
  const s = stick();
  put(s, U1);
  let { res } = run(s, { action: 'check' });
  const shown = res.update;
  const B8 = join(T, 'build8'); mkdirSync(B8);
  const U8 = makeUpdate(B8, 'v1.48 · build 300 · abcdef0 · 2026-12-01', 'swap');
  sign(U8, MFPR); copyFileSync(U8.tar, join(s.tr, shown.file));
  ({ res } = run(s, { action: 'install', file: shown.file, manifest_sha256: shown.manifest_sha256 }));
  ck('file swapped after check: changed, nothing written', !res.ok && res.status === 'changed' && !existsSync(join(s.os, 'casper-b')), JSON.stringify(res));
}

{
  const s = stick();
  put(s, U1);
  let { res } = run(s, { action: 'check' }, { SAFEKEEP_EPHEMERAL: '1' });
  ck('temporary session refused', !res.ok && res.status === 'temporary');
  writeFileSync(join(s.d, 'cmdline'), 'BOOT_IMAGE=/casper/vmlinuz boot=casper nopersistent ---\n');
  ({ res } = run(s, { action: 'check' }));
  ck('older stick layout refused (old_layout)', !res.ok && res.status === 'old_layout');
  writeFileSync(join(s.d, 'cmdline'), 'BOOT_IMAGE=/casper-a/vmlinuz boot=casper live-media-path=casper-a ---\n');
  ({ res } = run(s, { action: 'reboot' }));
  ck('unknown action refused', !res.ok && res.status === 'bad_request');
  ({ res } = run(s, '{not json'));
  ck('broken request refused', !res.ok && res.status === 'bad_request');
  ({ res } = run(s, { action: 'install', file: '../../etc/passwd', manifest_sha256: 'a'.repeat(64) }));
  ck('install of a path outside the Transfer Drive refused', !res.ok && res.status === 'bad_request');
  ({ res } = run(s, { action: 'check' }, { SAFEKEEP_UPD_FPR: AFPR }));
  ck('pinned fingerprint enforced (keyring alone is not enough)', !res.ok && res.status === 'bad_signature', JSON.stringify(res));
}

{
  // A write that fails on the stick: the error names the step, the log has
  // the details, and the stick is unchanged.
  const s = stick();
  put(s, U1);
  writeFileSync(join(s.os, '.casper-b.new'), 'not a folder');   // mkdir will fail
  let { res } = run(s, { action: 'check' });
  const reqPath = join(s.d, 'UPDATE_REQUEST.json'), resPath = join(s.d, 'UPDATE_RESULT.json');
  writeFileSync(reqPath, JSON.stringify({ action: 'install', request_id: 'f'.repeat(24), file: res.update.file, manifest_sha256: res.update.manifest_sha256 }));
  const r = sh('python3', ['-I', join(OS, 'safekeep-update.py'), reqPath, resPath], { env: { PATH: process.env.PATH, ...s.env } });
  res = JSON.parse(readFileSync(resPath, 'utf8'));
  ck('failed write: write_failed, naming the step', !res.ok && res.status === 'write_failed' && /while creating the new slot folder/.test(res.error) && /Show update log/.test(res.error), JSON.stringify(res));
  ck('...the log has the step, the error and the system state', /FAILED while creating the new slot folder: errno \d+/.test(r.stderr) && /--- after the failure ---/.test(r.stderr) && /kernel messages/.test(r.stderr), r.stderr.slice(0, 400));
  ck('...slot.cfg and slot a unchanged, update file kept', readFileSync(join(s.os, 'slot.cfg'), 'utf8') === 'set slot=a\n' && existsSync(join(s.os, 'casper-a', 'vmlinuz')) && readdirSync(s.tr).length === 1);
}

{
  const ui = read('seed-xor-tool/boot.html');
  ck('Device Options has Show update log, reading the RAM log', ui.includes('onclick="updSettingsShowLog()">Show update log</button>') && ui.includes("read('file:///tmp/safekeep-update.log')"));
}

rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

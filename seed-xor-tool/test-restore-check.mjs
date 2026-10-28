import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
/**
 * test-restore-check.mjs — "Check a Backup" in the Restore Watcher
 * (usbbootdrive/safekeep-boot.sh, the CHECK_PY block), run for real against
 * .7z archives made the way the stick makes them (7z a -mhe=on, vault folders
 * at the archive root), and against the older layout with the full vault path:
 *  - right password: contents and counts; the seed matches the loaded seed's
 *    hash, or not, or there is nothing to compare;
 *  - wrong password, a missing file, a bad name: a clear error;
 *  - nothing is left behind: no unpacked folder in /tmp, no trigger file;
 *  - the backup's words never appear in the result.
 * Also the inspect-timeout cleanup, and the app wiring (shared/boot.js
 * checkReliquary, boot.html Check a Backup).
 * Needs python3 and 7z (p7zip-full); skips the archive cases without 7z.
 * Run: node test-restore-check.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSH = readFileSync(join(__dirname, '../usbbootdrive/safekeep-boot.sh'), 'utf8');
const BOOTJS = readFileSync(join(__dirname, 'shared/boot.js'), 'utf8');
const HTML = readFileSync(join(__dirname, 'boot.html'), 'utf8');
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

const m = /<<'CHECK_PY'\n([\s\S]*?)\nCHECK_PY\n/.exec(BOOTSH);
ck('check script found in safekeep-boot.sh', !!m, '');
const PY = m ? m[1] : '';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
function extract(src, name) {
  const mm = new RegExp('(^|\\n)(async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!mm) throw new Error('not found: ' + name);
  let p = src.indexOf('(', mm.index + mm[0].length - 1), depth = 0;
  for (; p < src.length; p++) { if (src[p] === '(') depth++; else if (src[p] === ')') { depth--; if (depth === 0) break; } }
  let i = src.indexOf('{', p), j = i, str = null; depth = 0;
  for (; j < src.length; j++) {
    const c = src[j], n = src[j + 1];
    if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
    if (c === '/' && n === '/') { j = src.indexOf('\n', j); continue; }
    if (c === '/' && n === '*') { j = src.indexOf('*/', j) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(mm.index, j + 1);
}
// The app's own code: the seed hash it sends, and the result display
const app = vm.createContext({ window: {}, crypto: globalThis.crypto, TextEncoder, Uint8Array, Array, String });
vm.runInContext(['_psbtEscape', '_rlqLoadedSeedHash', 'rlq_renderCheckResult'].map((n) => extract(HTML, n)).join('\n') +
  '\nthis.A = { hash: _rlqLoadedSeedHash, render: rlq_renderCheckResult };', app);
async function appHash(words) { app.window.SeedSession = { get: () => (words ? { mnemonic: words } : null) }; return app.A.hash(); }
const nodeHash = (w) => createHash('sha256').update(w.normalize('NFKD').toLowerCase().trim().split(/\s+/).join(' ')).digest('hex');
const HASHES = { [WORDS]: await appHash(WORDS) };
const hash = (w) => HASHES[w] || nodeHash(w);
ck('app seed hash = the watcher\'s normalization', HASHES[WORDS] === nodeHash(WORDS) && HASHES[WORDS].length === 64, HASHES[WORDS]);
ck('app seed hash: none when no seed is loaded', (await appHash('')) === '', '');
const has7z = spawnSync('7z', ['i'], { stdio: 'ignore' }).status === 0;

const W = mkdtempSync(join(tmpdir(), 'sk-check-'));
const usb = join(W, 'usb'); mkdirSync(usb);
const seeds = join(W, 'seeds'); mkdirSync(seeds);
const script = join(W, 'check.py'); writeFileSync(script, PY);
const VAULT = '/media/.safekeep-vault';

function makeVault(dir, { seed = WORDS, notes = 2, pass: pp = 1, settings = true } = {}) {
  mkdirSync(dir, { recursive: true });
  if (seed !== null) { mkdirSync(join(dir, 'seeds')); writeFileSync(join(dir, 'seeds/master-seed.json'), JSON.stringify({ mnemonic: seed, fingerprint: '73c5da0a' })); }
  if (notes) { mkdirSync(join(dir, 'codex')); for (let i = 0; i < notes; i++) writeFileSync(join(dir, `codex/note-${i}.html`), '<p>n</p>'); }
  if (pp) { mkdirSync(join(dir, 'passphrases')); for (let i = 0; i < pp; i++) writeFileSync(join(dir, `passphrases/p${i}.json`), '{}'); }
  if (settings) { mkdirSync(join(dir, 'settings')); writeFileSync(join(dir, 'settings/s.json'), '{}'); }
  return dir;
}
// As the stick makes them: 7z a with absolute folders → folders at the root
function makeArchive(name, pw, opts, { fullPath = false } = {}) {
  const src = mkdtempSync(join(W, 'src-'));
  const base = fullPath ? join(src, VAULT.slice(1)) : join(src, 'vault');
  makeVault(base, opts);
  const out = join(usb, name);
  const r = fullPath
    ? spawnSync('7z', ['a', '-t7z', '-mhe=on', '-p' + pw, out, 'media'], { cwd: src })
    : spawnSync('7z', ['a', '-t7z', '-m0=lzma2', '-mhe=on', '-p' + pw, out, ...readdirSync(base).map((d) => join(base, d))]);
  if (r.status !== 0) throw new Error('7z a failed: ' + r.stdout);
  rmSync(src, { recursive: true, force: true });
}
const checkDirs = () => readdirSync('/tmp').filter((n) => n.startsWith('reliquary-check-'));
function check(req, { usbDir = usb } = {}) {
  const trig = join(seeds, 'RESTORE_CHECK.json'), res = join(seeds, 'RESTORE_CHECK_RESULT.json');
  rmSync(res, { force: true });
  writeFileSync(trig, JSON.stringify(req));
  const before = checkDirs().length;
  const r = spawnSync('python3', ['-', trig, res, usbDir, VAULT], { input: PY });
  const raw = existsSync(res) ? readFileSync(res, 'utf8') : '';
  return { out: raw ? JSON.parse(raw) : null, raw, log: String(r.stdout) + String(r.stderr), trigLeft: existsSync(trig), leftover: checkDirs().length - before };
}

if (!has7z) {
  console.log('  SKIP archive cases (install p7zip-full)');
} else {
  makeArchive('good.7z', 'correct horse', {});
  makeArchive('other-seed.7z', 'pw2', { seed: OTHER });
  makeArchive('no-seed.7z', 'pw3', { seed: null, notes: 0, pp: 0 });
  makeArchive('old layout.7z', 'pw4', {}, { fullPath: true });

  let r = check({ id: 'a1', filename: 'good.7z', password: 'correct horse', seedHash: hash(WORDS) });
  ck('right password: ok', r.out && r.out.ok === true, r.raw + r.log);
  ck('result echoes the request id', r.out && r.out.id === 'a1', r.raw);
  ck('contents and counts', r.out && r.out.seed === true && r.out.codex && r.out.codexCount === 2 && r.out.cipher && r.out.cipherCount === 1 && r.out.settings, r.raw);
  ck('seed matches the loaded seed', r.out && r.out.seedMatch === true, r.raw);
  ck('the backup\'s words are not in the result', !/abandon/.test(r.raw), r.raw);
  ck('nothing left: unpacked folder deleted, trigger removed', r.leftover === 0 && !r.trigLeft, JSON.stringify({ left: r.leftover, trig: r.trigLeft }));

  r = check({ id: 'a2', filename: 'good.7z', password: 'correct horse', seedHash: hash(WORDS.toUpperCase().replace(/ /g, '   ')) });
  ck('seed match ignores case and spacing', r.out && r.out.seedMatch === true, r.raw);

  r = check({ id: 'a3', filename: 'other-seed.7z', password: 'pw2', seedHash: hash(WORDS) });
  ck('different seed: seedMatch false', r.out && r.out.ok && r.out.seed === true && r.out.seedMatch === false, r.raw);
  ck('different seed: its words are not in the result', !/zoo/.test(r.raw), r.raw);

  r = check({ id: 'a4', filename: 'good.7z', password: 'correct horse', seedHash: '' });
  ck('no seed loaded: seedMatch null', r.out && r.out.ok && r.out.seed === true && r.out.seedMatch === null, r.raw);

  r = check({ id: 'a5', filename: 'no-seed.7z', password: 'pw3', seedHash: hash(WORDS) });
  ck('backup without a seed: seed false, settings only', r.out && r.out.ok && r.out.seed === false && r.out.seedMatch === null && r.out.settings && !r.out.codex, r.raw);

  r = check({ id: 'a6', filename: 'old layout.7z', password: 'pw4', seedHash: hash(WORDS) });
  ck('older layout (full vault path) and a name with a space', r.out && r.out.ok && r.out.seedMatch === true && r.out.codexCount === 2, r.raw);

  r = check({ id: 'b1', filename: 'good.7z', password: 'wrong', seedHash: hash(WORDS) });
  ck('wrong password: error from 7z', r.out && r.out.ok === false && /7z extraction failed \(code 2\)/.test(r.out.error) && /Wrong password|Cannot open encrypted archive/i.test(r.out.error) && !/Igor Pavlov/.test(r.out.error), r.raw);
  ck('wrong password: nothing left behind', r.leftover === 0 && !r.trigLeft, '');

  r = check({ id: 'b2', filename: 'missing.7z', password: 'x' });
  ck('missing file: error', r.out && r.out.ok === false && /Archive not found/.test(r.out.error), r.raw);
  r = check({ id: 'b3', filename: '../good.7z', password: 'x' });
  ck('name with a folder: refused', r.out && r.out.ok === false && /Not a \.7z backup name/.test(r.out.error), r.raw);
  r = check({ id: 'b4', filename: 'good.7z', password: '' });
  ck('empty password: refused', r.out && r.out.ok === false && /Password is required/.test(r.out.error), r.raw);
  r = check({ id: 'b5', filename: 'good.7z', password: 'correct horse' }, { usbDir: '' });
  ck('no Transfer Drive: error', r.out && r.out.ok === false && /No USB transfer drive/.test(r.out.error), r.raw);
}

// ---- Result display ----
{
  const R = app.A.render;
  let h = R('b<x>.7z', { ok: true, seed: true, seedMatch: true, codex: true, codexCount: 3, settings: true });
  ck('display: opens, same seed, notes count', /opens with that password/.test(h) && /the same seed as the one loaded now/.test(h) && /Encrypted Notes: 3/.test(h) && /Nothing was restored or changed\./.test(h), h);
  ck('display: file name escaped', /b&lt;x&gt;\.7z/.test(h) && !/<x>/.test(h), h);
  h = R('a.7z', { ok: true, seed: true, seedMatch: false });
  ck('display: different seed warned', /a <strong>different<\/strong> seed/.test(h), h);
  h = R('a.7z', { ok: true, seed: true, seedMatch: null });
  ck('display: no seed loaded to compare', /no seed is loaded to compare/.test(h), h);
  h = R('a.7z', { ok: true, seed: false, settings: true });
  ck('display: no seed in the backup', /No Master Seed in this backup/.test(h), h);
  h = R('a.7z', { ok: false, error: 'Incorrect password or <b>corrupted</b> archive.' });
  ck('display: error, escaped', /did not open/.test(h) && /&lt;b&gt;corrupted&lt;\/b&gt;/.test(h), h);
}

// ---- The watcher around the script ----
ck('check runs before the inspect phase in the Restore Watcher', BOOTSH.indexOf('if [ -f "$RESTORE_CHECK_TRIGGER" ]') > 0 && BOOTSH.indexOf('if [ -f "$RESTORE_CHECK_TRIGGER" ]') < BOOTSH.indexOf('# ── Phase 1: INSPECT ──'), '');
ck('result removed after 30 s unless a newer check replaced it', /CHECK_SNAP=\$\(cksum < "\$RESTORE_CHECK_RESULT"/.test(BOOTSH) && /\[ "\$\(cksum < "\$RESTORE_CHECK_RESULT" 2>\/dev\/null\)" = "\$CHECK_SNAP" \] && rm -f "\$RESTORE_CHECK_RESULT"/.test(BOOTSH), '');
ck('inspect without Restore: unpacked backup deleted after the wait', /if \[ "\$ACK_SEEN" != true \]; then\s+rm -rf "\$RELIQUARY_TMP"/.test(BOOTSH), '');
ck('commit still re-extracts when the unpacked copy is gone', /extraction missing\/empty — re-extracting from archive/.test(BOOTSH), '');
const sh = spawnSync('bash', ['-n', join(__dirname, '../usbbootdrive/safekeep-boot.sh')]);
ck('safekeep-boot.sh parses', sh.status === 0, String(sh.stderr));

// ---- App wiring ----
ck('RESTORE_CHECK is an allowed trigger file', /'RESTORE_CHECK'/.test(BOOTJS), '');
ck('checkReliquary is exported', /\n\s+checkReliquary,/.test(BOOTJS), '');
ck("checkReliquary ignores a result with another id", /if \(result && result\.id === id\)/.test(BOOTJS), '');
ck('Check a Backup on the backup screen', /id="rlq-check-btn"[^>]*onclick="rlq_checkBackup\(\)"/.test(HTML), '');
ck('"Check this backup" on the Send with the Courier card', /onclick="rlq_checkThisBackup\(\)"/.test(HTML), '');

rmSync(W, { recursive: true, force: true });
console.log(`\ntest-restore-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

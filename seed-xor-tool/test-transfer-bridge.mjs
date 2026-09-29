import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process';
const RUNNER_SRC = "#!/bin/bash\nset -uo pipefail\nXT=\"$1\"; REQ=\"$2\"; STATE=\"$3\"\nfind_transfer_drive() { [ -d \"$XT\" ] && [ ! -e \"$XT/.unplugged\" ] && echo \"$XT\"; return 0; }\neval \"$(sed -n '/>>> SKX_TRANSFER_WATCHER_BEGIN/,/<<< SKX_TRANSFER_WATCHER_END/p' \"__BOOT_SH__\")\"\n_skx_transfer_watcher \"$REQ\" \"$STATE\"\n";
/**
 * test-transfer-bridge.mjs — end-to-end test of the prompt-free Transfer
 * Drive bridge: the REAL shared/transfer-drive.js module talking to the REAL
 * Transfer Watcher code extracted from usbbootdrive/safekeep-boot.sh
 * (between the SKX_TRANSFER_WATCHER_BEGIN/END markers), with Chromium's
 * download + file:// fetch simulated on the local filesystem.
 *
 * Needs GNU coreutils (stat -c, od); skipped automatically elsewhere (macOS).
 */
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import os from 'os';
const __here = path.dirname(fileURLToPath(import.meta.url));
try { execSync('stat -c %s /', { stdio: 'ignore' }); } catch { console.log('SKIP test-transfer-bridge (GNU stat not available)'); process.exit(0); }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'skx-'));
const RUNNER = path.join(WORK, 'run-watcher.sh');
fs.writeFileSync(RUNNER, RUNNER_SRC.replace('__BOOT_SH__', path.join(__here, '..', 'usbbootdrive', 'safekeep-boot.sh')), { mode: 0o755 });
const MOD = path.join(__here, "shared", "transfer-drive.js");
const { SKTransfer } = await import(MOD);
const base = fs.mkdtempSync(path.join(WORK, 'run-')); const T = base + '/transfer', REQ = base + '/seeds', ST = base + '/state';
fs.mkdirSync(T); fs.mkdirSync(REQ);
fs.writeFileSync(T + '/existing.psbt', 'cHNidP8B'); fs.writeFileSync(T + '/.hidden', 'x'); fs.writeFileSync(T+'/backup.7z', Buffer.alloc(3000, 7));
const w = spawn(RUNNER, [T, REQ, ST], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; w.stdout.on('data', d => log += d); w.stderr.on('data', d => log += 'ERR ' + d);
const fetchFn = async (url) => {
  let p = decodeURIComponent(url.replace(/^file:\/\//, '')).replace('/tmp/safekeep-signals/xfer', ST);
  try { return new Response(fs.readFileSync(p)); } catch { return new Response(null, { status: 404 }); }
};
const download = async (name, blob) => { const buf = Buffer.from(await blob.arrayBuffer());
  fs.writeFileSync(REQ + '/' + name + '.crdownload', buf); fs.renameSync(REQ + '/' + name + '.crdownload', REQ + '/' + name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
try {
  await sleep(1200);
  const be = await SKTransfer.daemonBackend({ fetch: fetchFn, download, pollMs: 50, timeoutMs: 8000 });
  ok(be && be.root === T, 'ready.txt → backend root = transfer mount');
  const dir = SKTransfer.makeHandle(be);
  const names = []; for await (const [n] of dir.entries()) names.push(n);
  ok(names.sort().join(',') === 'backup.7z,existing.psbt', 'listing hides dotfiles: ' + names);
  const fh = await dir.getFileHandle('existing.psbt'); const f = await fh.getFile();
  ok(await f.text() === 'cHNidP8B' && f.size === 8 && f.lastModified > 0, 'read existing file');
  // binary write
  const bytes = new Uint8Array(256).map((_, i) => i);
  let h = await dir.getFileHandle('signed tx ñ #1.psbt', { create: true });
  let wr = await h.createWritable(); await wr.write(bytes); await wr.close();
  ok(Buffer.compare(fs.readFileSync(T + '/signed tx ñ #1.psbt'), Buffer.from(bytes)) === 0, 'binary write w/ unicode, space, # in name');
  // string + multi-part write, overwrite
  h = await dir.getFileHandle('existing.psbt', { create: true }); wr = await h.createWritable();
  await wr.write('hello '); await wr.write({ type: 'write', data: 'world' }); await wr.close();
  ok(fs.readFileSync(T + '/existing.psbt', 'utf8') === 'hello world', 'multi-part overwrite');
  // listing reflects write immediately
  const vals = []; for await (const v of dir.values()) vals.push(v.name);
  ok(vals.includes('signed tx ñ #1.psbt'), 'listing updated after write');
  // _armResolveUniqueFilename semantics
  let nf = null; try { await dir.getFileHandle('nope.txt'); } catch (e) { nf = e.name; }
  ok(nf === 'NotFoundError', 'missing file → NotFoundError');
  // rename
  h = await dir.getFileHandle('existing.psbt'); await h.move('renamed.psbt');
  ok(!fs.existsSync(T + '/existing.psbt') && fs.readFileSync(T + '/renamed.psbt', 'utf8') === 'hello world' && h.name === 'renamed.psbt', 'rename (single request)');
  // delete
  await dir.removeEntry('renamed.psbt'); ok(!fs.existsSync(T + '/renamed.psbt'), 'delete');
  let de = null; try { await dir.removeEntry('renamed.psbt'); } catch (e) { de = e.name; } ok(de === 'NotFoundError', 'delete missing → NotFoundError');
  // client-side validation
  for (const bad of ['../etc/passwd', 'a/b', '.bashrc', '', 'x'.repeat(101)]) {
    let t = null; try { await dir.getFileHandle(bad, { create: true }); } catch (e) { t = e.name; } ok(t === 'TypeError', 'client rejects ' + JSON.stringify(bad.slice(0, 20)));
  }
  // server-side validation: forge malicious requests directly (bypass client)
  const hex = s => Buffer.from(s).toString('hex');
  const forge = async (fname, content) => { fs.writeFileSync(REQ + '/' + fname, content); const id = fname.split('-')[2].replace('.skxfer',''); for (let i = 0; i < 60; i++) { await sleep(100); try { return fs.readFileSync(ST + '/done-' + id + '.txt', 'utf8').trim(); } catch {} } return 'TIMEOUT'; };
  ok((await forge('SKXFER-W-evil1-' + hex('../pwned') + '.skxfer', 'x')).startsWith('error') && !fs.existsSync(base + '/pwned'), 'watcher rejects ../ traversal on write');
  ok((await forge('SKXFER-W-evil2-' + hex('.bashrc') + '.skxfer', 'x')).startsWith('error') && !fs.existsSync(T + '/.bashrc'), 'watcher rejects dotfile');
  ok((await forge('SKXFER-D-evil3.skxfer', hex('../transfer/backup.7z'))).startsWith('error') && fs.existsSync(T + '/backup.7z'), 'watcher rejects traversal on delete');
  ok((await forge('SKXFER-M-evil4.skxfer', hex('backup.7z') + '\n' + hex('../stolen.7z'))).startsWith('error') && fs.existsSync(T + '/backup.7z'), 'watcher rejects traversal on rename target');
  ok((await forge('SKXFER-W-evil5-' + hex('a\nb') + '.skxfer', 'x')).startsWith('error'), 'watcher rejects control chars');
  ok((await forge('SKXFER-X-evil6.skxfer', 'x')).startsWith('error'), 'watcher rejects unknown op');
  fs.writeFileSync(REQ + '/SKXFER-W-BAD$ID-' + hex('z') + '.skxfer', 'x'); await sleep(800);
  ok(!fs.existsSync(REQ + '/SKXFER-W-BAD$ID-' + hex('z') + '.skxfer') && !fs.existsSync(T + '/z'), 'bad request id dropped, no write');
  // external change picked up (e.g. backup watcher writes a .7z)
  fs.writeFileSync(T + '/new-backup.7z', 'abc'); await sleep(1000);
  const n2 = []; for await (const k of dir.keys()) n2.push(k); ok(n2.includes('new-backup.7z'), 'external change reflected in index');
  ok(fs.readdirSync(REQ).length === 0, 'request dir left clean');
  ok(!fs.readdirSync(T).some(n => n.startsWith('.skx-')), 'no temp files left on drive');
  // unplugged → not ready → backend null, ops error
  fs.writeFileSync(T + '/.unplugged', ''); await sleep(900);
  ok((await SKTransfer.daemonBackend({ fetch: fetchFn, download })) === null, 'drive gone → bridge unavailable');
  let ue = null; try { h = await dir.getFileHandle('q.txt', { create: true }); wr = await h.createWritable(); await wr.write('q'); await wr.close(); } catch (e) { ue = e.message; }
  ok(ue && /not mounted|not available/i.test(ue), 'write while unplugged → clear error: ' + ue);
} catch (e) { fail++; console.log('EXCEPTION', e); }
w.kill(); console.log(`\n${pass} passed, ${fail} failed`); if (fail) console.log('--- watcher log ---\n' + log);
process.exit(fail ? 1 : 0);

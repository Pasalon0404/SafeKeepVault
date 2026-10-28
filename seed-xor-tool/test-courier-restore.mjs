import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
/**
 * test-courier-restore.mjs — receive a .7z backup with The Courier on the
 * Welcome restore screen (boot.html rlq_courier*), so a new stick never has
 * to be plugged into another computer:
 *  - frames built with the Courier's own sender logic, scanned in any order,
 *    with duplicates and a damaged chunk, put the file back together;
 *  - the file is saved to the Transfer Drive (shared/transfer-drive.js
 *    memory backend), listed (rlq_mergeDriveListing adds files the boot-time
 *    index doesn't know yet) and selected for Unlock & Inspect;
 *  - an existing file with the same name is kept ("name (2).7z");
 *  - a file that isn't a 7-Zip archive is refused and not saved;
 *  - unsafe file names are cleaned; a non-Courier QR only shows a hint.
 * And the other way (rlq_sendWithCourier): after making a backup, "Send with
 * the Courier" reads it from the Transfer Drive (waiting for a listing that
 * trails the new file) and starts the Courier loop; frames from the stick's
 * own sender (xfr_sendChunk) put the backup back together on another stick.
 * Run: node test-courier-restore.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
const QRP = readFileSync(join(__dirname, 'shared/qr-parser.js'), 'utf8');
const { SKTransfer } = await import(join(__dirname, 'shared/transfer-drive.js'));
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

function extract(name) {
  const m = new RegExp('(^|\\n)(async\\s+)?function\\s+' + name + '\\s*\\(').exec(SRC);
  if (!m) throw new Error('not found: ' + name);
  let p = SRC.indexOf('(', m.index + m[0].length - 1), depth = 0;
  for (; p < SRC.length; p++) { if (SRC[p] === '(') depth++; else if (SRC[p] === ')') { depth--; if (depth === 0) break; } }
  let i = SRC.indexOf('{', p), j = i, str = null; depth = 0;
  for (; j < SRC.length; j++) {
    const c = SRC[j], n = SRC[j + 1];
    if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
    if (c === '/' && n === '/') { j = SRC.indexOf('\n', j); continue; }
    if (c === '/' && n === '*') { j = SRC.indexOf('*/', j) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(m.index, j + 1);
}

// ---- The Courier's sender, as in safekeep-companion/index.html ----
const b64 = (u8) => Buffer.from(u8).toString('base64');
const courierChecksum = (d) => { let s = 0; for (const x of d) s += x; return s.toString(16).padStart(8, '0'); };
function courierFrames(fileName, mime, bytes, chunkSize, loop = 0) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) { const c = bytes.slice(i, i + chunkSize); chunks.push({ data: b64(c), checksum: courierChecksum(c) }); }
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.substring(0, dot) : fileName, ext = dot > 0 ? fileName.substring(dot + 1) : '';
  return chunks.map((c, i) => loop + '/' + i + '/' + chunks.length + '~' + encodeURIComponent(base) + '~' + encodeURIComponent(ext) + '~' + mime + '~' + c.data + '~' + c.checksum);
}

// ---- A minimal page: the restore panel's elements, status line, scanner ----
function makeEl(id) { return { id, style: {}, textContent: '', innerHTML: '', value: '', focused: false, focus() { this.focused = true; }, querySelectorAll() { return []; } }; }
function setup(existing = []) {
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || makeEl(id)) };
  const backend = SKTransfer.memoryBackend('TRANSFER');
  for (const [n, bytes] of existing) backend.write(n, new Blob([bytes]));
  const handle = SKTransfer.makeHandle(backend);
  const statuses = [];
  const scanners = [];
  const window = { jsQR: () => null };
  window.vaultTransferDriveHandle = handle;
  window.SafeKeepOS = { listBackups: async () => ['old-index-backup.7z'] };
  const ctx = vm.createContext({
    window, document, console, Uint8Array, Blob, Promise, String, Array, Math,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    showStatus: (m, t) => statuses.push({ m, t }),
    SKScanner: { create: (id) => { const s = { id, stopped: false, start: async (o, cb) => { s.cb = cb; }, stop() { s.stopped = true; } }; scanners.push(s); return s; } },
    _transferAutoMount: async () => {},
  });
  vm.runInContext(QRP, ctx);
  const names = ['_psbtEscape', 'rlq_classifyEntry', 'rlq_renderEntryButton', 'rlq_refreshBackupList', 'rlq_pickBackup',
    'rlq_mergeDriveListing', 'rlq_courierStart', 'rlq_courierStop', '_rlqCourierOnScan', 'rlq_courierFileName', 'rlq_is7z', 'rlq_courierSave'];
  vm.runInContext('var _rlqCourierScanner = null, _rlqCourier = null, _rlqCourierBusy = false;\n' +
    names.map(extract).join('\n') + '\nthis.T = {' + names.map((n) => n + ':' + n).join(',') + '};', ctx);
  return { ctx, T: ctx.T, els, backend, statuses, scanners, window };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const read = async (backend, name) => new Uint8Array(await (await backend.read(name)).arrayBuffer());
const eq = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

// A real-looking .7z: the 7-Zip signature, then a body
const body = new Uint8Array(3000); for (let i = 0; i < body.length; i++) body[i] = (i * 131 + 7) & 255;
const SEVENZ = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, ...body]);

// ---- 1. Full receive: start, frames out of order, duplicates, a damaged chunk ----
{
  const t = setup();
  await t.T.rlq_courierStart();
  ck('camera opens in the restore panel', t.scanners.length === 1 && t.scanners[0].id === 'rlq-courier-reader', JSON.stringify(t.scanners.map((s) => s.id)));
  ck('start button hidden, receiver shown', t.els['rlq-courier-start-btn'].style.display === 'none' && t.els['rlq-courier-area'].style.display === 'block', '');
  const frames = courierFrames('SafeKeep_Backup_2026-10-27.7z', 'application/x-7z-compressed', SEVENZ, 400, 3);
  const order = [...frames.keys()].reverse();
  const scan = t.scanners[0].cb;
  scan(frames[order[0]]); scan(frames[order[0]]);                      // duplicate
  const bad = frames[order[1]].replace(/~([0-9a-f]{8})$/, '~00000000'); // damaged checksum
  scan(bad);
  ck('damaged chunk is reported, scanning goes on', /damaged chunk/.test(t.els['rlq-courier-status'].textContent), t.els['rlq-courier-status'].textContent);
  for (const k of order.slice(1)) scan(frames[k]);
  await settle();
  ck('camera stopped when the file is complete', t.scanners[0].stopped === true, '');
  ck('receiver hidden again', t.els['rlq-courier-area'].style.display === 'none', '');
  const saved = await read(t.backend, 'SafeKeep_Backup_2026-10-27.7z').catch(() => null);
  ck('backup saved to the Transfer Drive byte for byte', eq(saved, SEVENZ), saved && saved.length);
  ck('backup selected for Unlock & Inspect', t.els['rlq-restore-filename'].value === 'SafeKeep_Backup_2026-10-27.7z', t.els['rlq-restore-filename'].value);
  ck('selected-file line shown', t.els['rlq-selected-file'].style.display === 'block' && t.els['rlq-selected-file-name'].textContent === 'SafeKeep_Backup_2026-10-27.7z', '');
  ck('list shows the new backup and the indexed one', /SafeKeep_Backup_2026-10-27\.7z/.test(t.els['rlq-backup-list'].innerHTML) && /old-index-backup\.7z/.test(t.els['rlq-backup-list'].innerHTML), t.els['rlq-backup-list'].innerHTML.slice(0, 200));
  ck('success message, password field focused', t.statuses.some((s) => s.t === 'success' && /Backup received/.test(s.m)) && t.els['rlq-restore-password'].focused, JSON.stringify(t.statuses));
}

// ---- 2. Same name already on the drive: kept, new one saved as "(2)" ----
{
  const OLD = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 1, 2, 3]);
  const t = setup([['backup.7z', OLD]]);
  await t.T.rlq_courierStart();
  for (const f of courierFrames('backup.7z', 'application/x-7z-compressed', SEVENZ, 500)) t.scanners[0].cb(f);
  await settle();
  ck('existing file untouched', eq(await read(t.backend, 'backup.7z'), OLD), '');
  ck('new file saved as "backup (2).7z"', eq(await read(t.backend, 'backup (2).7z').catch(() => null), SEVENZ), '');
  ck('the new file is the one selected', t.els['rlq-restore-filename'].value === 'backup (2).7z', t.els['rlq-restore-filename'].value);
}

// ---- 3. Not a 7-Zip file: refused, nothing saved ----
{
  const t = setup();
  await t.T.rlq_courierStart();
  const notes = new TextEncoder().encode('{"not":"a backup"}');
  for (const f of courierFrames('wallet.json', 'application/json', notes, 200)) t.scanners[0].cb(f);
  await settle();
  ck('non-7z file refused with a message', t.statuses.some((s) => s.t === 'error' && /not a \.7z backup/.test(s.m)), JSON.stringify(t.statuses));
  ck('nothing written to the Transfer Drive', (await t.backend.list()).length === 0, '');
  ck('nothing selected', !t.els['rlq-restore-filename'] || t.els['rlq-restore-filename'].value === '', '');
}

// ---- 4. A 7z sent with another extension is saved as .7z ----
{
  const t = setup();
  await t.T.rlq_courierStart();
  for (const f of courierFrames('my-backup.bin', 'application/octet-stream', SEVENZ, 800)) t.scanners[0].cb(f);
  await settle();
  ck('saved with a .7z extension', eq(await read(t.backend, 'my-backup.7z').catch(() => null), SEVENZ), JSON.stringify((await t.backend.list()).map((f) => f.name)));
}

// ---- 5. A plain QR code (not a Courier loop) only shows a hint ----
{
  const t = setup();
  await t.T.rlq_courierStart();
  t.scanners[0].cb('correct horse battery staple');
  ck('hint shown, camera keeps running', /not a Courier file loop/.test(t.els['rlq-courier-status'].textContent) && !t.scanners[0].stopped, t.els['rlq-courier-status'].textContent);
  t.T.rlq_courierStop();
  ck('Cancel stops the camera and restores the button', t.scanners[0].stopped && t.els['rlq-courier-start-btn'].style.display === '' && t.els['rlq-courier-area'].style.display === 'none', '');
}

// ---- 6. File names ----
{
  const { T } = setup();
  ck('folders removed', T.rlq_courierFileName('../../etc/x.7z') === '_.._etc_x.7z', T.rlq_courierFileName('../../etc/x.7z'));
  ck('no hidden dot file', !T.rlq_courierFileName('.hidden.7z').startsWith('.'), T.rlq_courierFileName('.hidden.7z'));
  ck('exFAT-illegal characters replaced', T.rlq_courierFileName('a<b>:c"d|e?*.7z') === 'a_b__c_d_e__.7z', T.rlq_courierFileName('a<b>:c"d|e?*.7z'));
  const long = T.rlq_courierFileName('x'.repeat(300) + '.7z');
  ck('long name shortened, extension kept', long.length === 120 && long.endsWith('.7z'), long.length);
  ck('empty name gets a default', T.rlq_courierFileName('') === 'courier-backup.7z', T.rlq_courierFileName(''));
  ck('7-Zip signature check', T.rlq_is7z(SEVENZ) && !T.rlq_is7z(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])) && !T.rlq_is7z(new Uint8Array(2)), '');
}

// ---- 7. List merge without a Transfer Drive bridge (web build) ----
{
  const t = setup();
  t.window.vaultTransferDriveHandle = null;
  const out = await t.T.rlq_mergeDriveListing(['a.7z']);
  ck('falls back to the boot-time index', out.length === 1 && out[0] === 'a.7z', JSON.stringify(out));
}

// ---- 9. Send a new backup with the Courier ----
{
  const t = setup();
  const opened = [];
  vm.runInContext([extract('_rlqShowSendWithCourier'), extract('rlq_sendWithCourier')].join('\n') +
    '\nvar _rlqLastBackupName = "";\nthis.S = { show: _rlqShowSendWithCourier, send: rlq_sendWithCourier };', t.ctx);
  t.ctx._xfrOpenWithFile = (file, autoStart) => opened.push({ file, autoStart });
  t.ctx.setTimeout = setTimeout;
  t.ctx.S.show('SafeKeep_Backup_<b>x</b>.7z');
  const html = t.els['rlq-export-result'].innerHTML;
  ck('success card shown with the button', t.els['rlq-export-result'].style.display === 'block' && /onclick="rlq_sendWithCourier\(\)"/.test(html), html.slice(0, 120));
  ck('file name escaped in the card', /SafeKeep_Backup_&lt;b&gt;x&lt;\/b&gt;\.7z/.test(html) && !/<b>x<\/b>/.test(html), '');
  ck('file name not placed in inline JavaScript', !/onclick="[^"]*SafeKeep/.test(html), '');

  // The backup appears on the drive a moment after the button is pressed
  t.ctx.S.show('SafeKeep_Backup_2026-10-28.7z');
  setTimeout(() => t.backend.write('SafeKeep_Backup_2026-10-28.7z', new Blob([SEVENZ])), 500);
  await t.ctx.S.send();
  ck('Courier opened with the backup, loop started', opened.length === 1 && opened[0].autoStart === true && opened[0].file.name === 'SafeKeep_Backup_2026-10-28.7z', JSON.stringify(opened.map((o) => [o.file && o.file.name, o.autoStart])));
  ck('the file handed over is the backup', eq(new Uint8Array(await opened[0].file.arrayBuffer()), SEVENZ), '');

  // Missing file: a clear error, the Courier is not opened
  t.ctx.S.show('gone.7z');
  await t.ctx.S.send();
  ck('missing backup: error, Courier not opened', opened.length === 1 && t.statuses.some((x) => x.t === 'error' && /Could not read the backup/.test(x.m)), JSON.stringify(t.statuses.slice(-1)));
}

// ---- 10. Stick to stick: the stick's own sender → the Welcome receiver ----
{
  const frames = [];
  const sctx = vm.createContext({
    window: { btoa: (b) => Buffer.from(b, 'binary').toString('base64'), QRCode: { toCanvas: (c, text) => frames.push(text) } },
    document: { getElementById: () => ({ style: {} }) }, console, Uint8Array, String,
  });
  vm.runInContext(['xfr_checksum', 'xfr_checksumPad', 'xfr_arrayToBase64', 'xfr_sendChunk'].map(extract).join('\n') +
    '\nvar xfr_state = { currentLoop: 2 };\nthis.X = { st: xfr_state, b64: xfr_arrayToBase64, ck: xfr_checksumPad, send: xfr_sendChunk };', sctx);
  const X = sctx.X;
  X.st.originalFile = { name: 'SafeKeep_Backup_2026-10-28.7z', type: '' };
  const size = 450, chunks = [];
  for (let i = 0; i < SEVENZ.length; i += size) { const c = SEVENZ.slice(i, i + size); chunks.push({ data: X.b64(c), checksum: X.ck(c) }); }
  chunks.forEach((c, i) => X.send(c, i, chunks.length));
  const t = setup();
  await t.T.rlq_courierStart();
  for (const f of frames.slice(3).concat(frames.slice(0, 3))) t.scanners[0].cb(f);   // joined mid-loop
  await settle();
  ck('stick-to-stick: frames from the stick\'s sender restore the same bytes', eq(await read(t.backend, 'SafeKeep_Backup_2026-10-28.7z').catch(() => null), SEVENZ), frames.length);
}

// ---- 8. Wiring in boot.html and setup-vault.sh ----
ck('button on the restore panel', /id="rlq-courier-start-btn"[^>]*onclick="rlq_courierStart\(\)"/.test(SRC), '');
ck('leaving the screen stops the camera', /function showState[\s\S]{0,4000}rlq_courierStop\(\)/.test(SRC), '');
ck('the Send with the Courier card is scrolled into view', /function _rlqShowSendWithCourier[\s\S]{0,2000}skui_revealPanel\(resultDiv\)/.test(SRC), '');
ck('backup success shows Send with the Courier', /if \(!result\.demo\) _rlqShowSendWithCourier\(result\.filename\)/.test(SRC), '');
ck('Transfer Hub TRANSMIT still opens the Courier without starting it', /_xfrOpenWithFile\(file, false\)/.test(SRC), '');
ck('restore list uses the merged listing', /await rlq_mergeDriveListing\(await os\.listBackups\(\)\)/.test(SRC), '');
const SETUP = readFileSync(join(__dirname, '../usbbootdrive/setup-vault.sh'), 'utf8');
ck('Vault Created dialog mentions the Courier', /Receive a Backup with the Courier/.test(SETUP), '');

console.log(`\ntest-courier-restore: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

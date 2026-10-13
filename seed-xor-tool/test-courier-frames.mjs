import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
/**
 * test-courier-frames.mjs — files sent with The Courier, read by the PSBT signer.
 *  - shared/qr-parser.js: parseCourierFrame reads the Courier's frame format
 *    (loop/index/total~name~ext~mime~base64~checksum), including names with '~';
 *    createCourierCollector puts a file back together from frames in any order,
 *    starting mid-loop, skipping duplicates and damaged chunks, and restarting
 *    when a different file appears;
 *  - parseQRScan is unchanged (SeedQR, UR, BBQr, PSBT text and Courier frames);
 *  - boot.html _psbtHandleCourierFrame: progress text, binary / base64 / hex
 *    .psbt files load, anything else gets a clear (escaped) message, and the
 *    file name is cleaned before use.
 * Frames are built with the Courier's own sendChunk / splitFileToChunks logic.
 * Run: node test-courier-frames.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const QRP = readFileSync(join(__dirname, 'shared/qr-parser.js'), 'utf8');
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
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

const qctx = vm.createContext({ window: {}, atob: (s) => Buffer.from(s, 'base64').toString('binary'), Uint8Array });
vm.runInContext(QRP, qctx);
const QP = qctx.window.QRParser;

// A real-looking PSBT payload (magic + random body)
const body = new Uint8Array(1500); for (let i = 0; i < body.length; i++) body[i] = (i * 73 + 11) & 255;
const PSBT = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, ...body]);
const eq = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

// ---- parseCourierFrame ----
{
  const fr = courierFrames('trezor-unsigned.psbt', 'application/octet-stream', PSBT, 500, 3);
  const f = QP.parseCourierFrame(fr[1]);
  ck('frame fields', f && f.loop === 3 && f.index === 1 && f.total === 4 && f.name === 'trezor-unsigned' && f.ext === 'psbt' && f.mime === 'application/octet-stream', JSON.stringify(f));
  const t = QP.parseCourierFrame(courierFrames('tx~v2 (1).psbt', '', PSBT, 500)[0]);
  ck("name with '~' and spaces read from both ends", t && t.name === 'tx~v2 (1)' && t.ext === 'psbt' && t.total === 4, JSON.stringify(t));
  const noExt = QP.parseCourierFrame(courierFrames('README', 'text/plain', new Uint8Array([65]), 10)[0]);
  ck('file with no extension', noExt && noExt.name === 'README' && noExt.ext === '');
  for (const [label, s] of [['UR', 'UR:CRYPTO-PSBT/1-3/LPADAXCF'], ['BBQr', 'B$ZP0300FMUE4KXZV'], ['base64 PSBT', 'cHNidP8BAHUCAAAAAQ=='], ['xpub', 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz'],
                         ['3 parts', '0/0/1~a~b'], ['index ≥ total', '0/5/5~a~psbt~x~QQ==~00000041'], ['total 0', '0/0/0~a~psbt~x~QQ==~00000041'], ['bad checksum text', '0/0/1~a~psbt~x~QQ==~zz'], ['bad base64', '0/0/1~a~psbt~x~Q!Q=~00000041'], ['48 digits', '1'.repeat(48)]]) {
    ck(`not a Courier frame: ${label}`, QP.parseCourierFrame(s) === null);
  }
}

// ---- Collector ----
function collect(frames) {
  const c = QP.createCourierCollector(); let last;
  for (const fr of frames) { const f = QP.parseCourierFrame(fr); if (f) last = c.add(f); }
  return last;
}
{
  const fr = courierFrames('unsigned.psbt', 'application/octet-stream', PSBT, 200);   // 8 chunks
  const inOrder = collect(fr);
  ck('in order: done, file name, bytes identical', inOrder.done && inOrder.filename === 'unsigned.psbt' && inOrder.total === 8 && eq(inOrder.bytes, PSBT));
  const midLoop = [...fr.slice(5), ...courierFrames('unsigned.psbt', 'application/octet-stream', PSBT, 200, 1).slice(0, 5)];
  ck('starting mid-loop (5..7, then next loop 0..4)', collect(midLoop).done && eq(collect(midLoop).bytes, PSBT));
  const shuffled = [3, 7, 0, 3, 3, 5, 1, 7, 6, 2, 4].map((i) => fr[i]);
  const rs = collect(shuffled);
  ck('out of order with repeats', rs.done && eq(rs.bytes, PSBT));
  const c = QP.createCourierCollector();
  const r1 = c.add(QP.parseCourierFrame(fr[2])), r2 = c.add(QP.parseCourierFrame(fr[2]));
  ck('progress counts and duplicate detection', r1.status === 'added' && r1.received === 1 && r1.total === 8 && !r1.done && r2.status === 'duplicate' && r2.received === 1);
  const damaged = fr[4].replace(/~([0-9a-f]{8})$/, (m, h) => '~' + (parseInt(h, 16) + 1).toString(16).padStart(8, '0'));
  const r3 = c.add(QP.parseCourierFrame(damaged));
  ck('damaged chunk (checksum mismatch) skipped', r3.status === 'bad-checksum' && r3.received === 1);
  const r4 = c.add(QP.parseCourierFrame(fr[4]));
  ck('the good copy of that chunk is then accepted', r4.status === 'added' && r4.received === 2);
  const other = courierFrames('other.pdf', 'application/pdf', new Uint8Array(900).fill(7), 200);
  const r5 = c.add(QP.parseCourierFrame(other[0]));
  ck('a different file restarts collection', r5.status === 'new-file' && r5.received === 1 && r5.total === 5 && r5.filename === 'other.pdf');
  const one = collect(courierFrames('tiny.psbt', '', PSBT.slice(0, 40), 500));
  ck('single-chunk file', one.done && one.total === 1 && eq(one.bytes, PSBT.slice(0, 40)));
  c.reset();
  const r6 = c.add(QP.parseCourierFrame(fr[0]));
  ck('reset forgets everything', r6.status === 'added' && r6.received === 1 && r6.total === 8);
}

// ---- parseQRScan unchanged ----
{
  const fr = courierFrames('unsigned.psbt', 'application/octet-stream', PSBT, 200)[0];
  for (const s of [fr, 'UR:CRYPTO-PSBT/1-3/LPADAXCF', 'B$ZP0300FMUE4KXZV', 'cHNidP8BAHUCAAAAAQ==', '  padded text  ', 'hunter2']) {
    ck(`parseQRScan passes through: ${s.slice(0, 24)}`, QP.parseQRScan(s, null) === s);
  }
}

// ---- boot.html: the PSBT signer's Courier route ----
function signerEnv() {
  const els = {}; const el = (id) => (els[id] ||= { id, textContent: '', innerHTML: '', className: '', style: {}, classList: { remove() {}, add() {} } });
  const calls = { ingest: [], status: [], stopped: 0 };
  const ctx = vm.createContext({
    window: { QRParser: QP }, document: { getElementById: el }, TextDecoder, Uint8Array, String, console: { log() {}, warn() {} }, atob: qctx.atob,
    psbtStopCameraScan: () => { calls.stopped++; },
    _psbtIngestComplete: (bytes, name) => calls.ingest.push({ bytes, name }),
    psbtShowStatus: (m, t) => calls.status.push(t + ':' + m),
  });
  vm.runInContext(['let _psbtCourier = null; let _psbtScanProcessing = false;',
    extract('_psbtHandleCourierFrame'), extract('_psbtCourierFileName'), extract('_psbtNormalizeIngestBytes'), extract('_psbtEscape')].join('\n'), ctx);
  const feed = (frames) => { for (const fr of frames) ctx._psbtHandleCourierFrame(QP.parseCourierFrame(fr)); };
  return { ctx, el, calls, feed };
}
{
  const e = signerEnv();
  const fr = courierFrames('unsigned.psbt', 'application/octet-stream', PSBT, 300);   // 6 chunks
  e.feed([fr[4], fr[2]]);
  ck('progress text: chunk 2 / 6 with the file name', e.el('psbt-scan-status').textContent === 'Receiving file “unsigned.psbt” — chunk 2 / 6', e.el('psbt-scan-status').textContent);
  ck('nothing loaded until all chunks are in', e.calls.ingest.length === 0 && e.calls.stopped === 0);
  e.feed([fr[5], fr[0], fr[1], fr[3]]);
  ck('binary .psbt: camera stopped, loaded with its name and identical bytes', e.calls.stopped === 1 && e.calls.ingest.length === 1 && e.calls.ingest[0].name === 'unsigned.psbt' && eq(e.calls.ingest[0].bytes, PSBT));
}
for (const [label, text] of [['base64 text file', Buffer.from(PSBT).toString('base64')], ['base64 wrapped at 64 with CRLF', Buffer.from(PSBT).toString('base64').replace(/(.{64})/g, '$1\r\n')], ['hex text file', Buffer.from(PSBT).toString('hex')]]) {
  const e = signerEnv();
  e.feed(courierFrames('unsigned.txt', 'text/plain', new TextEncoder().encode(text), 250));
  ck(`${label}: loads as the same PSBT`, e.calls.ingest.length === 1 && eq(e.calls.ingest[0].bytes, PSBT) && e.calls.ingest[0].name === 'unsigned.txt');
}
{
  const e = signerEnv();
  e.feed(courierFrames('<img src=x onerror=alert(1)>.pdf', 'application/pdf', new Uint8Array(600).fill(37), 250));
  const msg = e.calls.status[0] || '';
  ck('not a PSBT: clear error, nothing loaded', e.calls.ingest.length === 0 && /^error:.*isn’t a PSBT/.test(msg), msg);
  ck('not a PSBT: file name escaped in the message', msg.includes('&lt;img src=x onerror=alert(1)&gt;.pdf') && !msg.includes('<img'), msg);
}
{
  const e = signerEnv();
  e.feed(courierFrames('../../etc/evil\u0001name.psbt', '', PSBT, 800));
  ck('file name cleaned before use (no path, no control chars)', e.calls.ingest.length === 1 && e.calls.ingest[0].name === '_.._etc_evil_name.psbt', e.calls.ingest[0] && e.calls.ingest[0].name);
}

// ---- boot.html: the return trip (signed PSBT as a Courier file) ----
{
  const ctx = vm.createContext({ btoa: (b) => Buffer.from(b, 'binary').toString('base64'), Uint8Array, Math, String, encodeURIComponent });
  vm.runInContext(['let _psbtLoadedFilename = "";', extract('_psbtCourierFrames'), extract('_psbtCourierExportName'), extract('_psbtStripExt')].join('\n'), ctx);
  const signed = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, ...body.slice(0, 1200)]);
  const out = ctx._psbtCourierFrames(signed, 'trezor-unsigned-signed.psbt', 500);
  const ref = courierFrames('trezor-unsigned-signed.psbt', 'application/octet-stream', signed, 500, 0);
  ck('vault frames are exactly what the Courier itself would send', out.length === ref.length && out.every((f, i) => f === ref[i]), out[0].slice(0, 80) + ' vs ' + ref[0].slice(0, 80));
  const back = collect(out);
  ck('vault frames reassemble to the signed bytes and name', back.done && eq(back.bytes, signed) && back.filename === 'trezor-unsigned-signed.psbt');
  for (const size of [50, 137, 800]) {
    const fr = ctx._psbtCourierFrames(signed, 'x-signed.psbt', size);
    const r = collect([...fr].reverse());
    ck(`chunk size ${size}: ${fr.length} frames, reassembles (reversed order)`, fr.length === Math.ceil(signed.length / size) && r.done && eq(r.bytes, signed));
  }
  ck('small file: a single frame', ctx._psbtCourierFrames(signed.slice(0, 30), 'a-signed.psbt', 500).length === 1);
  const names = [['trezor-unsigned.psbt', 'trezor-unsigned-signed.psbt'], ['scanned-psbt.psbt', 'scanned-psbt-signed.psbt'], ['', 'transaction-signed.psbt'],
                 ['weird~na<me>.txt', 'weird_na_me_-signed.psbt'], ['..hidden.psbt', 'hidden-signed.psbt']];
  for (const [loaded, want] of names) {
    vm.runInContext('_psbtLoadedFilename = ' + JSON.stringify(loaded), ctx);
    ck(`export name for "${loaded}" → ${want}`, ctx._psbtCourierExportName() === want, ctx._psbtCourierExportName());
  }
}

console.log(`\nCOURIER FRAMES: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * test-bbqr.mjs — BBQr (Coinkite's QR format, which Sparrow and COLDCARD
 * show) in the Output Descriptor tool and the PSBT Signer, and UR text
 * (UR:CRYPTO-OUTPUT/…, UR:BYTES/…) pasted or relayed into Output Descriptor
 *
 * Sparrow showed a 2-of-3 wallet as BBQr ("B$ZU0100…"), and Output
 * Descriptor said it didn't recognize it. This runs SafeKeep's BBQr
 * decoder for real, on codes made the way the BBQr reference does (raw
 * deflate with a 1 KB window, base32 without padding, part numbers in
 * base 36), and checks the wiring:
 *   1. _bbqrDecode: Z / 2 / H encodings, one or many parts, any order,
 *      missing parts, mixed codes, bad headers.
 *   2. Output Descriptor: pasted or relayed BBQr text is decoded first;
 *      the camera collects animated parts; a PSBT is pointed elsewhere.
 *   3. PSBT Signer: part numbers are base 36 (they were read as hex,
 *      which broke codes of 16 parts or more).
 *
 * Run:  node test-bbqr.mjs
 */
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
const fn = (name) => { const a = html.indexOf(name); return a < 0 ? '' : html.slice(a, html.indexOf('\n}\n', a) + 2); };

// The decoder and the helpers it uses, run as they are in the app.
const src = [fn('function _psbtBase32Decode'), fn('async function _psbtInflate'), fn('async function _psbtZlibDecompress'), fn('async function _bbqrDecode')].join('\n');
const decode = new Function(src + '\nreturn _bbqrDecode;')();

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const b36 = (n) => B36[Math.floor(n / 36)] + B36[n % 36];
const base32 = (buf) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0, out = '';
  for (const byte of buf) { v = (v << 8) | byte; bits += 8; while (bits >= 5) { out += A[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += A[(v << (5 - bits)) & 31];
  return out;
};
const frames = (enc, type, payload, size) => {
  const ch = []; for (let i = 0; i < payload.length; i += size) ch.push(payload.slice(i, i + size));
  return ch.map((c, i) => 'B$' + enc + type + b36(ch.length) + b36(i) + c);
};
const DESC = "wsh(sortedmulti(2,[5436d724/48h/0h/0h/2h]xpub6E7Ffp5ry6zKwJ5b8Tp9CMcVnA5vTRm2kLKXySHvPMmmQDQx2uNiEHf8yUyyy7xGt8XEu6LjRv1MbvmLHXrLgBh1jGRSjhNEsUfjWyYKZm4/<0;1>/*,[b8688df1/48h/0h/0h/2h]xpub6EhFq2rRs4bHz9T8yzpMhsaZiwWEGpdLb3vk5pByaUfCDbz8vFLYPZdxD8eo1Q3t2G7bbTNXxX5fvc5bUfaTh6xjESnCzBgWE7xybtuH2Ne/<0;1>/*))#abcdefgh";
const zData = base32(deflateRawSync(Buffer.from(DESC), { windowBits: 10 }));
const text = (r) => new TextDecoder().decode(r.bytes);

console.log('\n1. The decoder');
let r = await decode(frames('Z', 'U', zData, 100000).join(' '));
ck('one Z (zlib) part, Unicode text: decoded exactly, header "B$ZU0100"', text(r) === DESC && r.type === 'U' && frames('Z', 'U', zData, 100000)[0].startsWith('B$ZU0100'));
const many = frames('Z', 'U', zData, 20);
ck('…the test code has more than 16 parts (needs base 36 part numbers)', many.length > 16, many.length);
r = await decode(many.join('\n'));
ck('many parts, one per line: decoded', text(r) === DESC);
r = await decode(many.slice().reverse().join('  '));
ck('…in any order', text(r) === DESC);
r = await decode(frames('2', 'J', base32(Buffer.from('{"a":1}')), 100000).join(' '));
ck('base32 (2), JSON type', text(r) === '{"a":1}' && r.type === 'J');
r = await decode(frames('H', 'U', Buffer.from('hello').toString('hex').toUpperCase(), 4).join(' '));
ck('hex (H), several parts', text(r) === 'hello');
const reject = async (t, re) => { try { await decode(t); return false; } catch (e) { return re.test(e.message); } };
ck('a missing part is named, with what to do', await reject(many.filter((_, i) => i !== 3).join(' '), /has \d+ parts, and only \d+ arrived/));
ck('parts of two different codes are refused', await reject([many[0], frames('Z', 'J', zData, 20)[1]].join(' '), /different codes/));
ck('text that isn\'t BBQr is refused', await reject('wsh(sortedmulti(2,...))', /isn’t BBQr/));
ck('damaged hex is refused', await reject('B$HU0100XYZ', /damaged/));

console.log('\n2. Output Descriptor');
ck('pasted or relayed BBQr is decoded before the usual reading', html.includes("var conv = _descImportConvert(await _descImportUnwrap(document.getElementById('desc-verify-input').value));"));
const unwrap = fn('async function _descImportUnwrap');
ck('…anything else passes through unchanged', unwrap.includes("if (!/^B\\$[H2Z][A-Z][0-9A-Z]{4}/.test(t)) return raw;"));
ck('…a BBQr PSBT is sent to the PSBT Signer instead', unwrap.includes("P: 'a transaction to sign (PSBT): open it in the PSBT Signer'"));
const cam = fn('function _descvOnQrScanned');
ck('the camera collects every animated BBQr part, then reads them like pasted text', cam.includes('Route 1b: BBQr') && cam.includes("'Scanning BBQr… ' + have + ' / ' + total + ' parts'") && cam.includes("inp.value = all.join('\\n');"));
ck('…and starts again when a different code appears', cam.includes('if (_descvBbqr.head !== head) _descvBbqr = { head: head, parts: {} };'));

console.log('\n3. PSBT Signer');
const ps = fn('async function _psbtHandleBbqrFrame');
ck('part count and number are base 36', ps.includes('parseInt(text.substring(4, 6), 36)') && ps.includes('parseInt(text.substring(6, 8), 36)') && !ps.includes('parseInt(text.substring(4, 6), 16)'));
ck('…which matters from part 16 on ("0G" is 16, not 0)', parseInt('0G', 36) === 16 && parseInt('0G', 16) === 0);

console.log('\n4. UR text pasted or relayed (the Courier) into Output Descriptor');
const { UR, UREncoder, URDecoder } = require('@ngraveio/bc-ur');
const CBOR = require('cbor-sync');
globalThis.window = { URDecoder, CBOR };
globalThis.Buffer = Buffer;
let seenOutput = null;
const fromUr = new Function('descv_decodeCryptoOutput', fn('function _descImportFromUrText') + '\nreturn _descImportFromUrText;')((c) => { seenOutput = c; return 'wsh(DECODED)'; });
const bytesUr = (txt) => UR.fromBuffer(Buffer.from(txt));   // fromBuffer adds the CBOR byte-string wrapper
const setup = '# Sparrow multisig setup\nPolicy: 2 of 3\nFormat: P2WSH\n' + 'x'.repeat(600);
ck('UR:BYTES, one part: the text inside', fromUr(new UREncoder(bytesUr(setup), 5000).nextPart().toUpperCase()) === setup);
const enc = new UREncoder(bytesUr(setup), 60), parts = [];
for (let i = 0; i < enc.fragmentsLength + 3; i++) parts.push(enc.nextPart());
ck('UR:BYTES, animated, every part pasted: the text inside', fromUr(parts.join('\n')) === setup);
const urRej = (t, re) => { try { fromUr(t); return false; } catch (e) { return re.test(e.message); } };
ck('only part of an animated UR: says how much arrived and what to do', urRej(parts[0], /only part of it arrived \(\d+%\)\. Scan it with Scan QR \/ UR \/ Courier/));
const outUr = new UR(Buffer.from('d90191d90197a201020280', 'hex'), 'crypto-output');
ck('UR:CRYPTO-OUTPUT goes to the same decoder the camera uses', fromUr(new UREncoder(outUr, 5000).nextPart().toUpperCase()) === 'wsh(DECODED)' && Buffer.from(seenOutput).toString('hex') === 'd90191d90197a201020280');
const psbtUr = new UR(CBOR.encode(Buffer.from('70736274ff', 'hex')), 'crypto-psbt');
ck('UR:CRYPTO-PSBT is pointed to the PSBT Signer', urRej(new UREncoder(psbtUr, 5000).nextPart(), /PSBT Signer/));
ck('damaged UR text is refused', urRej('ur:crypto-output/notbytewords', /damaged|didn’t check out|only part/));
ck('the import unwraps UR text as well as BBQr', fn('async function _descImportUnwrap').includes('if (/^ur:/i.test(t)) return _descImportFromUrText(t);'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

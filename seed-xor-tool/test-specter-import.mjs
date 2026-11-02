import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
/**
 * test-specter-import.mjs — Output Descriptor's "For Specter" QR: Specter
 * Desktop's wallet import (Import from wallet software → Scan QR code) reads
 * one QR of {"label","descriptor"} JSON and accepts only keys ending /0/*.
 * SafeKeep's /<0;1>/* becomes /0/* with a fresh checksum. (Checked against
 * embit, Specter's own library: same checksums, same first addresses.)
 * Run: node test-specter-import.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, 'boot.html'), 'utf8');
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };
function extract(name) {
  const mm = new RegExp('(^|\\n)(async\\s+)?function\\s+' + name + '\\s*\\(').exec(HTML);
  let i = HTML.indexOf('{', HTML.indexOf(')', mm.index)), j = i, depth = 0, str = null;
  for (; j < HTML.length; j++) {
    const c = HTML[j], n = HTML[j + 1];
    if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
    if (c === '/' && n === '/' && HTML[j - 1] !== '\\' && !/[(\[,=!&|:?]\s*$/.test(HTML.slice(j - 3, j))) { j = HTML.indexOf('\n', j); continue; }
    if (c === '/' && n === '*') { j = HTML.indexOf('*/', j) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return HTML.slice(mm.index, j + 1);
}
const ctx = vm.createContext({ JSON, String });
vm.runInContext(extract('desc_checksum') + '\n' + extract('_descSpecterPayload'), ctx);
// abandon×11 about, m/84'/0'/0' (BIP-84 test vector account key)
const XPUB = 'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
const body = `wpkh([73c5da0a/84h/0h/0h]${XPUB}/<0;1>/*)`;
const d = body + '#' + ctx.desc_checksum(body);
const r = ctx._descSpecterPayload(d, '  Savings  ');
const j = r.json ? JSON.parse(r.json) : {};
ck('JSON with label and descriptor', j.label === 'Savings' && typeof j.descriptor === 'string', r.json || r.error);
ck('/<0;1>/* becomes /0/*', /\/0\/\*\)#/.test(j.descriptor) && !/<0;1>/.test(j.descriptor), j.descriptor);
ck('checksum recomputed for the new text', j.descriptor === `wpkh([73c5da0a/84h/0h/0h]${XPUB}/0/*)#` + ctx.desc_checksum(`wpkh([73c5da0a/84h/0h/0h]${XPUB}/0/*)`));
ck('empty name -> SafeKeep wallet', JSON.parse(ctx._descSpecterPayload(d, '').json).label === 'SafeKeep wallet');
ck('multisig: every key rewritten', (() => { const m = `wsh(sortedmulti(2,[73c5da0a/48h/0h/0h/2h]${XPUB}/<0;1>/*,[00000000/48h/0h/0h/2h]${XPUB}/<0;1>/*))`; const o = JSON.parse(ctx._descSpecterPayload(m + '#' + ctx.desc_checksum(m), 'x').json).descriptor; return (o.match(/\/0\/\*/g) || []).length === 2 && !/<0;1>/.test(o); })());
ck('Silent Payments refused', /Silent Payments/.test(ctx._descSpecterPayload('sp(x)#abcdefgh', 'x').error || ''));
ck('a key without /0/* refused', /\/0\/\*/.test(ctx._descSpecterPayload(`wpkh([73c5da0a/84h/0h/0h]${XPUB}/1/*)`, 'x').error || ''));
ck('UI: For Specter button and name field', /id="desc-qr-fmt-specter"/.test(HTML) && /id="desc-specter-name"/.test(HTML) && /Import from wallet software/.test(HTML));
console.log(`test-specter-import: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

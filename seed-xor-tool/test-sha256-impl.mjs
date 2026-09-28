import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import vm from 'node:vm';
/**
 * test-sha256-impl.mjs — boot.html's hand-rolled _sha256sync (used by base58check /
 * xpub conversion) vs node:crypto: NIST vectors, every length 0..300, random fuzz.
 * Run: node test-sha256-impl.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
process.env.BOOT = join(__dirname, 'boot.html');
// Extract a named top-level function from boot.html (brace matching, string/comment aware).
function extract(name) {
  const re = new RegExp('(^|\\n)([ \\t]*)(async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(SRC); if (!m) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', m.index + m[0].length - 1);
  // skip param list
  let p = m.index + m[0].length - 1, depth = 0;
  for (; p < SRC.length; p++) { const c = SRC[p]; if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) break; } }
  i = SRC.indexOf('{', p);
  depth = 0; let j = i, str = null;
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
function lineOf(name) { const i = SRC.search(new RegExp('function\\s+' + name + '\\s*\\(')); return SRC.slice(0, i).split('\n').length; }

// Permissive fake DOM: any element id returns a persistent stub; enough for tool functions.
function makeDom(values = {}) {
  const els = {};
  const mk = (id) => ({ id, value: values[id] ?? '', textContent: '', innerHTML: '', className: '', style: {}, dataset: {}, disabled: false, checked: false,
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } }, children: [],
    appendChild(c){ this.children.push(c); return c; }, setAttribute(){}, removeAttribute(){}, getAttribute(){ return null; }, addEventListener(){},
    querySelector(){ return mk('q'); }, querySelectorAll(){ return []; }, getContext(){ return null; }, focus(){}, remove(){} });
  const document = { getElementById: (id) => (els[id] ||= mk(id)), createElement: () => mk('new'), querySelector: () => mk('q'), querySelectorAll: () => [], body: mk('body') };
  return { document, els };
}


const ctx = vm.createContext({ Uint8Array, Uint32Array, Array, Math, Error });
const kdecl=SRC.slice(SRC.indexOf('var _sha256K = new Uint32Array(['), SRC.indexOf(']);', SRC.indexOf('var _sha256K = new Uint32Array(['))+3);
vm.runInContext(kdecl + '\n' + extract('_rr') + '\n' + extract('_sha256impl') + '\n' + extract('_sha256sync'), ctx);
const hex = u => Buffer.from(u).toString('hex');
let pass = 0, fail = 0;
function chk(buf, label) {
  const got = hex(ctx._sha256sync(new Uint8Array(buf)));
  const want = createHash('sha256').update(buf).digest('hex');
  if (got === want) pass++; else { fail++; if (fail < 6) console.log('FAIL', label, got, want); }
}
// NIST
chk(Buffer.from(''), 'empty'); chk(Buffer.from('abc'), 'abc');
chk(Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), 'nist448');
chk(Buffer.from('a'.repeat(1000000)), 'million-a');
// every length 0..300 (covers all padding boundaries 55/56/63/64/119/120...)
for (let n = 0; n <= 300; n++) chk(randomBytes(n), 'len' + n);
// random fuzz, incl. the 78-byte xpub payload + 82-byte checksum case
for (let k = 0; k < 5000; k++) chk(randomBytes(Math.floor(Math.random() * 2000)), 'fuzz');
for (let k = 0; k < 2000; k++) chk(randomBytes(78), 'xpub78');
console.log(`_sha256sync vs node:crypto — ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);

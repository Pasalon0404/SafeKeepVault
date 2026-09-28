import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as bip39 from '@scure/bip39'; import { wordlist } from '@scure/bip39/wordlists/english.js'; import { HDKey } from '@scure/bip32';
/**
 * test-bip85-vectors.mjs — BIP-85 child-seed derivation through the real bip85_generate
 * against the official BIP-85 test vectors (12- and 24-word, index 0), plus
 * determinism and index separation.
 * Run: node test-bip85-vectors.mjs
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

 import vm from 'node:vm';
const VECTOR_MASTER = 'xprv9s21ZrQH143K2LBWUUQRFXhucrQqBpKdRRxNVq2zBqsx8HVqFk2uYo8kmbaLLHRdqtQpUm98uKfu3vca1LqdGhUtyoFnCNkfmXRyPXLjbKb';
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  got: ' + x)); };
async function runBip85({ length, index, masterXprv, mnemonic }) {
  const els = {}; const el = (id) => (els[id] ||= { value: '', textContent: '', style: {}, innerHTML: '', appendChild(){}, querySelectorAll: () => [] });
  const words = mnemonic.split(' ');
  el('bip85-master-grid').querySelectorAll = () => words.map(w => ({ textContent: w }));
  el('bip85-passphrase').value = ''; el('bip85-child-length').value = String(length); el('bip85-child-index').value = String(index);
  let first = true;
  const HD = masterXprv ? { fromMasterSeed: (s, v) => { if (first) { first = false; return HDKey.fromExtendedKey(masterXprv); } return HDKey.fromMasterSeed(s, v); } } : HDKey;
  let status = '';
  const ctx = vm.createContext({ window: { BtcMath: { bip39, wordlist, HDKey: HD } }, document: { getElementById: el, createElement: () => ({ style: {} }) },
    crypto: globalThis.crypto, TextEncoder, Uint8Array, showStatus: (m) => { status = m; }, QRCode: undefined, console, _bip85HasWork: false, _bip85LastResult: null });
  vm.runInContext(extract('bip85_generate'), ctx);
  await ctx.bip85_generate();
  if (!ctx._bip85LastResult) throw new Error('no result: ' + status);
  return ctx._bip85LastResult;
}
const DUMMY = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const r12 = await runBip85({ length: 12, index: 0, masterXprv: VECTOR_MASTER, mnemonic: DUMMY });
ck('BIP-85 official 12-word idx0', r12.childMnemonic === 'girl mad pet galaxy egg matter matrix prison refuse sense ordinary nose', r12.childMnemonic);
ck('BIP-85 path', r12.derivPath === "m/83696968'/39'/0'/12'/0'", r12.derivPath);
const r24 = await runBip85({ length: 24, index: 0, masterXprv: VECTOR_MASTER, mnemonic: DUMMY });
ck('BIP-85 official 24-word idx0', r24.childMnemonic === 'puppy ocean match cereal symbol another shed magic wrap hammer bulb intact gadget divorce twin tonight reason outdoor destroy simple truth cigar social volcano', r24.childMnemonic);
// determinism + index separation on a real mnemonic (no substitution)
const a = await runBip85({ length: 12, index: 0, mnemonic: DUMMY }), b = await runBip85({ length: 12, index: 0, mnemonic: DUMMY }), c = await runBip85({ length: 12, index: 1, mnemonic: DUMMY });
ck('deterministic (same input -> same child)', a.childMnemonic === b.childMnemonic);
ck('index 0 != index 1', a.childMnemonic !== c.childMnemonic);
ck('child != parent', a.childMnemonic !== DUMMY);
ck('parent fp = 73c5da0a', a.parentFP === '73c5da0a', a.parentFP);
console.log(`\nBIP-85: ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);

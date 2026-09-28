import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as bip39 from '@scure/bip39'; import { wordlist } from '@scure/bip39/wordlists/english.js'; import { HDKey } from '@scure/bip32';
/**
 * test-seed-xor-vectors.mjs — Seed XOR through the real xor_handleSplit / xor_handleMerge /
 * xrr_combine: Coldcard's published A^B^C example, bad-checksum rejection, and 900
 * split->merge->recover round trips (subsets of shares must never recover the seed).
 * Run: node test-seed-xor-vectors.mjs
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

  import vm from 'node:vm'; import { randomBytes } from 'node:crypto';
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };
const CC = { A: 'romance wink lottery autumn shop bring dawn tongue range crater truth ability miss spice fitness easy legal release recall obey exchange recycle dragon room',
  B: 'lion misery divide hurry latin fluid camp advance illegal lab pyramid unaware eager fringe sick camera series noodle toy crowd jeans select depth lounge',
  C: 'vault nominee cradle silk own frown throw leg cactus recall talent worry gadget surface shy planet purpose coffee drip few seven term squeeze educate',
  R: 'silent toe meat possible chair blossom wait occur this worth option bag nurse find fish scene bench asthma bike wage world quit primary indoor' };
// sanity: vector is self-consistent under an independent XOR
{ const e = ['A','B','C'].map(k => bip39.mnemonicToEntropy(CC[k], wordlist)); const x = e[0].map((b,i)=>b^e[1][i]^e[2][i]);
  ck('Coldcard vector self-consistent (independent XOR)', bip39.entropyToMnemonic(x, wordlist) === CC.R); }
function ctxFor(values, extra = {}) { const { document } = makeDom(values); let status = '';
  const ctx = vm.createContext({ window: { BtcMath: { bip39, wordlist, HDKey }, crypto: globalThis.crypto, SafeKeepOS: null }, document, crypto: globalThis.crypto,
    Uint8Array, console, showStatus: (m, t) => { status = t + ':' + m; }, _xorHasWork: false, ...extra });
  return { ctx, status: () => status };
}
function merge(shares) { const vals = {}; shares.forEach((m, s) => m.split(' ').forEach((w, i) => vals['xor-mg-' + s + '-word-' + i] = w));
  const { ctx, status } = ctxFor(vals, { xor_state: { mergeShares: shares.length, mergeLength: shares[0].split(' ').length } });
  vm.runInContext(extract('xor_handleMerge'), ctx); ctx.xor_handleMerge(); return { seed: ctx.xor_state.mergedSeed, status: status() }; }
function recover(shares) { const vals = {}; shares.forEach((m, s) => m.split(' ').forEach((w, i) => vals['xrr-' + s + '-word-' + i] = w));
  const { ctx, status } = ctxFor(vals, { _xrrShareCount: shares.length, _xrrWordCount: shares[0].split(' ').length, _xrrRecoveredMnemonic: null });
  vm.runInContext(extract('xrr_combine'), ctx); ctx.xrr_combine(); return { seed: ctx._xrrRecoveredMnemonic, status: status() }; }
async function split(seed, n) { const { ctx } = ctxFor({}, { xor_state: { loadedSeed: seed, shares: n } });
  vm.runInContext(['function _xorRenderShareCards(){}', extract('xor_handleSplit')].join('\n'), ctx);
  await ctx.xor_handleSplit(); return ctx.xor_state.generatedShares; }
// ---- Official Coldcard vector through the app's merge + recovery code ----
ck('merge(): Coldcard A^B^C', merge([CC.A, CC.B, CC.C]).seed === CC.R, JSON.stringify(merge([CC.A, CC.B, CC.C])));
ck('merge(): order independent (C,A,B)', merge([CC.C, CC.A, CC.B]).seed === CC.R);
ck('recovery xrr_combine(): Coldcard A^B^C', recover([CC.A, CC.B, CC.C]).seed === CC.R, JSON.stringify(recover([CC.A, CC.B, CC.C])));
// wrong share -> must NOT silently return a seed that looks right
const wrong = recover([CC.A, CC.B, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art']);
ck('recovery with a wrong share != real seed', wrong.seed !== CC.R);
// bad-checksum share must be rejected (swap two words)
const bad = CC.C.split(' '); [bad[0], bad[1]] = [bad[1], bad[0]];
const rb = merge([CC.A, CC.B, bad.join(' ')]); ck('merge rejects bad-checksum share', !rb.seed && /error/.test(rb.status), JSON.stringify(rb));
// ---- Split -> merge round trips on random seeds, all share counts and lengths ----
const s0 = await split(CC.R, 3);
ck('split returns share mnemonics', Array.isArray(s0) && s0.length === 3, JSON.stringify(s0).slice(0, 200));
if (Array.isArray(s0) && s0.length === 3) {
  const shareStr = s0.map(x => typeof x === 'string' ? x : (x.mnemonic || x.words || x.phrase));
  ck('split shares are valid BIP-39', shareStr.every(m => bip39.validateMnemonic(m, wordlist)), JSON.stringify(s0[0]).slice(0,120));
  ck('no share equals the seed', shareStr.every(m => m !== CC.R));
  let rt = 0, rtFail = 0;
  for (const len of [16, 32]) for (const n of [2, 3, 4]) for (let t = 0; t < 150; t++) {
    const seed = bip39.entropyToMnemonic(randomBytes(len), wordlist);
    const sh = (await split(seed, n)).map(x => typeof x === 'string' ? x : (x.mnemonic || x.words || x.phrase));
    const m1 = merge(sh).seed, m2 = recover(sh).seed; (m1 === seed && m2 === seed) ? rt++ : rtFail++;
    const sub = merge(sh.slice(0, n - 1)).seed; if (sub === seed) { rtFail++; console.log('  subset of shares recovered the seed!'); }
  }
  ck(`split->merge->recover round trips (${rt}) 12/24w x 2/3/4 shares, subsets never recover`, rtFail === 0, rtFail + ' failures');
}
console.log(`\nSEED XOR: ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);

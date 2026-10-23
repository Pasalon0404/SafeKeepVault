import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as bip39 from '@scure/bip39'; import { wordlist } from '@scure/bip39/wordlists/english.js'; import { HDKey } from '@scure/bip32';
/**
 * test-seed-xor-vectors.mjs — Seed XOR through the real xor_handleSplit / _xorCombine /
 * xrr_combine: Coldcard's published 12- and 24-word A^B^C examples, bad-checksum, duplicate-share
 * and all-zero rejection, 900 split->combine->recover round trips (subsets of shares must never
 * recover the seed) plus 18-word round trips, the final check of typed shares (_xorVerifyTyped),
 * and the standalone seedxor/index.html combine + fingerprint helpers.
 * Run: node test-seed-xor-vectors.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
process.env.BOOT = join(__dirname, 'boot.html');
// Extract a named top-level function from boot.html (brace matching, string/comment aware).
function extract(name, src = SRC) {
  const re = new RegExp('(^|\\n)([ \\t]*)(async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src); if (!m) throw new Error('not found: ' + name);
  let i = src.indexOf('{', m.index + m[0].length - 1);
  // skip param list
  let p = m.index + m[0].length - 1, depth = 0;
  for (; p < src.length; p++) { const c = src[p]; if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) break; } }
  i = src.indexOf('{', p);
  depth = 0; let j = i, str = null;
  for (; j < src.length; j++) {
    const c = src[j], n = src[j + 1];
    if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
    if (c === '/' && n === '/') { j = src.indexOf('\n', j); continue; }
    if (c === '/' && n === '*') { j = src.indexOf('*/', j) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, j + 1);
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
// _xorCombine: the tool's combine (used by the final check). Returns { seed } or { error }.
async function merge(shares) { const { ctx } = ctxFor({});
  vm.runInContext([extract('_xorCheckShares'), extract('_xorCombine')].join('\n'), ctx);
  try { return { seed: ctx._xorCombine(shares), status: '' }; } catch (e) { return { seed: null, status: 'error:' + e.message }; } }
// xrr_combine reads the shared word boxes; stand-ins return the typed words.
async function recover(shares) {
  const _xrrBoxes = shares.map((m) => ({ getWords: () => m.split(' '), markWrong() {} }));
  const { ctx, status } = ctxFor({}, { _xrrBoxes, _xrrShareCount: shares.length, _xrrWordCount: shares[0].split(' ').length, _xrrRecoveredMnemonic: null });
  vm.runInContext([extract('_xorCheckShares'), extract('_recoveryFingerprint'), extract('xrr_combine')].join('\n'), ctx); await ctx.xrr_combine(); return { seed: ctx._xrrRecoveredMnemonic, status: status() }; }
async function split(seed, n) { let flowStarted = false, locked = false;
  const { ctx, status } = ctxFor({}, { xor_state: { loadedSeed: seed, shares: n } });
  ctx.window.ShareFlow = {}; ctx._xorStartFlow = () => { flowStarted = true; }; ctx._shardLockEngage = () => { locked = true; };
  vm.runInContext(['_xorCheckShares', '_xorCombine', '_xorSplitEntropy', '_xorFingerprint', 'xor_handleSplit'].map((f) => extract(f)).join('\n'), ctx);
  await ctx.xor_handleSplit();
  if (!flowStarted || !locked) throw new Error('split did not start the flow: ' + status());
  return ctx.xor_state.generatedShares; }
// ---- Official Coldcard vector through the app's merge + recovery code ----
{ const r = await merge([CC.A, CC.B, CC.C]); ck('merge(): Coldcard A^B^C', r.seed === CC.R, JSON.stringify(r)); }
ck('merge(): order independent (C,A,B)', (await merge([CC.C, CC.A, CC.B])).seed === CC.R);
{ const r = await recover([CC.A, CC.B, CC.C]); ck('recovery xrr_combine(): Coldcard A^B^C', r.seed === CC.R, JSON.stringify(r)); }
// wrong share -> must NOT silently return a seed that looks right
const wrong = await recover([CC.A, CC.B, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art']);
ck('recovery with a wrong share != real seed', wrong.seed !== CC.R);
// bad-checksum share must be rejected (swap two words)
const bad = CC.C.split(' '); [bad[0], bad[1]] = [bad[1], bad[0]];
const rb = await merge([CC.A, CC.B, bad.join(' ')]); ck('merge rejects bad-checksum share', !rb.seed && /error/.test(rb.status), JSON.stringify(rb));
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
    const m1 = (await merge(sh)).seed, m2 = (await recover(sh)).seed; (m1 === seed && m2 === seed) ? rt++ : rtFail++;
    const sub = (await merge(sh.slice(0, n - 1))).seed; if (sub === seed) { rtFail++; console.log('  subset of shares recovered the seed!'); }
  }
  ck(`split->merge->recover round trips (${rt}) 12/24w x 2/3/4 shares, subsets never recover`, rtFail === 0, rtFail + ' failures');
}

// ---- Coldcard's 12-word example (docs/seed-xor.md) ----
const C12 = { A: 'romance wink lottery autumn shop bring dawn tongue range crater truth ability',
  B: 'boat unfair shell violin tree robust open ride visual forest vintage approve',
  C: 'lion misery divide hurry latin fluid camp advance illegal lab pyramid unhappy',
  R: 'cannon opinion leader nephew found yard metal galaxy crouch between real trade' };
ck('merge(): Coldcard 12-word A^B^C', (await merge([C12.A, C12.B, C12.C])).seed === C12.R);
ck('recovery xrr_combine(): Coldcard 12-word A^B^C', (await recover([C12.A, C12.B, C12.C])).seed === C12.R);
// ---- 18-word seeds through the core functions (the UI only offers 12/24) ----
{ let ok = 0, bad = 0;
  for (const n of [2, 3, 4]) for (let t = 0; t < 20; t++) {
    const seed = bip39.entropyToMnemonic(randomBytes(24), wordlist);
    const sh = await split(seed, n);
    (sh.every(m => m.split(' ').length === 18) && (await merge(sh)).seed === seed && (await recover(sh)).seed === seed) ? ok++ : bad++;
  }
  ck(`18-word split->merge->recover round trips (${ok})`, bad === 0, bad + ' failures'); }
// ---- The tool has no Merge tab any more: recovery is Restore via Seed XOR ----
ck('no Merge tab or merge function in the tool', !/xor_handleMerge|xor-tab-btn-merge|Merge Shares/.test(SRC));
// ---- Duplicate shares and all-zero results are rejected ----
{ const r = await merge([CC.A, CC.A, CC.B]); ck('merge rejects duplicate share (A,A,B)', !r.seed && /identical/.test(r.status), JSON.stringify(r)); }
{ const r = await merge([CC.C, CC.B, CC.C]); ck('merge rejects non-adjacent duplicate (C,B,C)', !r.seed && /Share 1 and Share 3/.test(r.status), JSON.stringify(r)); }
{ const r = await recover([CC.A, CC.B, CC.A]); ck('recovery rejects duplicate share', !r.seed && /identical/.test(r.status), JSON.stringify(r)); }
{ // three distinct shares that XOR to zero: X, Y, X^Y
  const x = randomBytes(32), y = randomBytes(32), z = x.map((b, i) => b ^ y[i]);
  const sh = [x, y, z].map(e => bip39.entropyToMnemonic(e, wordlist));
  const r = await merge(sh); ck('merge rejects shares that cancel to all-zero', !r.seed && /all-zero/.test(r.status), JSON.stringify(r));
  const q = await recover(sh); ck('recovery rejects shares that cancel to all-zero', !q.seed && /all-zero/.test(q.status), JSON.stringify(q)); }
// ---- Final check of the typed shares (_xorVerifyTyped) ----
async function verifyTyped(typed, loadedSeed = CC.R, targetBip32FP = null) {
  let released = false;
  const { ctx } = ctxFor({}, { xor_state: { loadedSeed }, _shardLockRelease: () => { released = true; } });
  vm.runInContext(['_xorCheckShares', '_xorCombine', '_xorFingerprint', '_xorVerifyTyped'].map((f) => extract(f)).join('\n'), ctx);
  ctx.xor_state.targetBip32FP = targetBip32FP || await ctx._xorFingerprint(loadedSeed);
  const r = await ctx._xorVerifyTyped(typed);
  return { ...r, released };
}
{ const r = await verifyTyped([CC.A, CC.B, CC.C]); ck('final check: the right shares pass and release the warning', r.ok && r.released, JSON.stringify(r)); }
{ const r = await verifyTyped([CC.C, CC.A, CC.B]); ck('final check: share order does not matter', r.ok); }
{ const other = bip39.entropyToMnemonic(new Uint8Array(32).fill(1), wordlist);   // valid, but not share C
  const r = await verifyTyped([CC.A, CC.B, other]);
  ck('final check: a wrong but valid share fails and keeps the warning', !r.ok && !r.released && /different seed/.test(r.message), JSON.stringify(r)); }
{ const r = await verifyTyped([CC.A, CC.B, bad.join(' ')]);
  ck('final check: a bad-checksum share fails with the share number', !r.ok && /Share 3/.test(r.message), JSON.stringify(r)); }
{ const r = await verifyTyped([CC.A, CC.B, CC.C], CC.R, 'deadbeef');
  ck('final check: a fingerprint mismatch fails', !r.ok && /deadbeef/.test(r.message), JSON.stringify(r)); }
{ const r = await verifyTyped([CC.A, CC.A, CC.B]); ck('final check: a share entered twice fails', !r.ok && /different seed/.test(r.message)); }
{ // the all-zero "abandon … art" seed (the dev app's test seed) still splits and checks
  const zero = bip39.entropyToMnemonic(new Uint8Array(32), wordlist);
  const sh = await split(zero, 3); const r = await verifyTyped(sh, zero);
  ck('the all-zero test seed splits and its shares pass the final check', sh.length === 3 && r.ok, JSON.stringify(r)); }
// ---- Check shares I already have (_xorCheckExisting) ----
async function checkExisting(typed, loadedSeed = CC.R) {
  const { ctx } = ctxFor({}, { xor_state: { loadedSeed } });
  vm.runInContext(['_xorCheckShares', '_xorCombine', '_xorFingerprint', '_xorCheckExisting'].map((f) => extract(f)).join('\n'), ctx);
  return ctx._xorCheckExisting(typed);
}
{ const r = await checkExisting([CC.B, CC.C, CC.A]);
  ck('check shares: the right shares rebuild the vault seed', r.ok && /rebuild your vault seed/.test(r.message), JSON.stringify(r));
  ck('check shares: the message never holds a seed word', !CC.R.split(' ').some((w) => new RegExp('\\b' + w + '\\b').test(r.message))); }
{ const r = await checkExisting([CC.A, CC.B]); ck('check shares: a missing share → a different seed, both fingerprints named', !r.ok && /different seed/.test(r.message) && (r.message.match(/[0-9a-f]{8}/g) || []).length === 2, JSON.stringify(r)); }
{ const r = await checkExisting([CC.A, CC.A, CC.B]); ck('check shares: a share entered twice is named', !r.ok && /identical/.test(r.message), JSON.stringify(r)); }
{ const r = await checkExisting([CC.A, CC.B, bad.join(' ')]); ck('check shares: a bad-checksum share is named', !r.ok && /Share 3/.test(r.message)); }
{ const zero = bip39.entropyToMnemonic(new Uint8Array(32), wordlist); const sh = await split(zero, 2);
  ck('check shares: works for the all-zero test seed', (await checkExisting(sh, zero)).ok); }

// ---- Standalone page (seedxor/index.html) helpers ----
{ const PAGE = readFileSync(join(__dirname, 'seedxor', 'index.html'), 'utf8');
  const ctx = vm.createContext({ window: { BtcMath: { bip39, wordlist, HDKey } }, Uint8Array });
  vm.runInContext([extract('xorCombineShares', PAGE), extract('xorMasterFingerprint', PAGE)].join('\n'), ctx);
  ck('standalone: Coldcard 24-word A^B^C', ctx.xorCombineShares([CC.A, CC.B, CC.C]) === CC.R);
  ck('standalone: Coldcard 12-word A^B^C', ctx.xorCombineShares([C12.A, C12.B, C12.C]) === C12.R);
  const throws = (sh, re) => { try { ctx.xorCombineShares(sh); return false; } catch (e) { return re.test(e.message); } };
  ck('standalone: rejects duplicate share', throws([CC.A, CC.B, CC.A], /identical/));
  const x = randomBytes(16), y = randomBytes(16);
  ck('standalone: rejects all-zero result', throws([x, y, x.map((b, i) => b ^ y[i])].map(e => bip39.entropyToMnemonic(e, wordlist)), /all-zero/));
  const fp = await ctx.xorMasterFingerprint(CC.R);
  const { ctx: c2 } = ctxFor({}); vm.runInContext(extract('_xorFingerprint'), c2);
  ck('standalone: fingerprint matches the tool\'s fingerprint', /^[0-9A-F]{8}$/.test(fp) && (await c2._xorFingerprint(CC.R)).toUpperCase() === fp, fp); }
console.log(`\nSEED XOR: ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);

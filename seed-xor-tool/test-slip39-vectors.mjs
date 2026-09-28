import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateMnemonics, combineMnemonics } from 'shamir-mnemonic-ts';
import * as bip39 from '@scure/bip39'; import { wordlist } from '@scure/bip39/wordlists/english.js'; import { HDKey } from '@scure/bip32';
import { randomBytes } from 'node:crypto';
/**
 * test-slip39-vectors.mjs — SLIP-39 via shamir-mnemonic-ts (the library the app bundles):
 * official Trezor vectors, in-app round trips 2-of-2..5-of-16, under-threshold rejection.
 * Also DOCUMENTS the design fact behind the UI warning: shares encode BIP-39 entropy, so a
 * Trezor restoring them opens a DIFFERENT wallet (fingerprints printed below).
 * Run: node test-slip39-vectors.mjs
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

let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + n + (x !== undefined ? '  -> ' + x : '')); };
const hex = u => Buffer.from(u).toString('hex'); const fp = k => k.fingerprint.toString(16).padStart(8, '0');
// ---- Library vs official Trezor SLIP-39 vectors (vectors.json #1 and #4) ----
const v1 = await combineMnemonics(['duckling enlarge academic academic agency result length solution fridge kidney coal piece deal husband erode duke ajar critical decision keyboard'], 'TREZOR');
ck('official vector #1 (1-of-1, 128-bit)', hex(v1) === 'bb54aac4b89dc868ba37d9cc21b2cece', hex(v1));
const v4 = await combineMnemonics(['shadow pistol academic always adequate wildlife fancy gross oasis cylinder mustang wrist rescue view short owner flip making coding armed',
  'shadow pistol academic acid actress prayer class unknown daughter sweater depict flip twice unkind craft early superior advocate guest smoking'], 'TREZOR');
ck('official vector #4 (2-of-3, 128-bit)', hex(v4) === 'b43ceb7e57a0ea8766221624d01b0864', hex(v4));
// ---- App-equivalent round trip (same call shape as s39_generateShares / s39r_recover) ----
let rt = 0, bad = 0;
for (const len of [16, 32]) for (const [m, n] of [[2,3],[3,5],[4,7],[2,2],[5,16]]) for (let t = 0; t < 8; t++) {
  const mnemonic = bip39.entropyToMnemonic(randomBytes(len), wordlist); const ent = Buffer.from(bip39.mnemonicToEntropy(mnemonic, wordlist));
  const shares = (await generateMnemonics(1, [[m, n]], ent, '', 1))[0];
  const pick = shares.slice().sort(() => Math.random() - 0.5).slice(0, m);
  const back = bip39.entropyToMnemonic(new Uint8Array(await combineMnemonics(pick, '')), wordlist);
  back === mnemonic ? rt++ : bad++;
  let under = false; if (m > 1) { try { await combineMnemonics(pick.slice(0, m - 1), ''); under = true; } catch {} } if (under) bad++;
}
ck(`in-app round trip x${rt} (12/24w, 2-of-2 .. 5-of-16); m-1 shares always rejected`, bad === 0, bad ? bad + ' bad' : undefined);
// ---- Finding 2: what a Trezor (standard SLIP-39) would restore ----
const mnT = bip39.entropyToMnemonic(randomBytes(16), wordlist);
const entT = Buffer.from(bip39.mnemonicToEntropy(mnT, wordlist));
const sharesT = (await generateMnemonics(1, [[2, 3]], entT, '', 1))[0];
const ms = new Uint8Array(await combineMnemonics(sharesT.slice(0, 2), ''));
const walletFp = fp(HDKey.fromMasterSeed(await bip39.mnemonicToSeed(mnT, '')));   // the user's real wallet
const trezorFp = fp(HDKey.fromMasterSeed(ms));                                        // SLIP-39 standard: master secret IS the BIP-32 seed
console.log(`\n  user's real wallet fingerprint : ${walletFp}`);
console.log(`  Trezor restore fingerprint     : ${trezorFp}   ${walletFp === trezorFp ? '(same)' : '<-- DIFFERENT WALLET'}`);
console.log(`\nSLIP-39: ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);

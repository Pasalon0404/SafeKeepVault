/**
 * test-psbt-change-audit.mjs — security regression tests for the PSBT Signer's
 * change-output audit (_psbtAuditOutputs + _psbtMultisigWalletBinding).
 *
 * A compromised coordinator's goal is to get an attacker-controlled output
 * displayed as "change" so the user signs without scrutinising it. Every attack
 * below must end up BLOCKED (hijack), ACK-GATED (unverified-change + explicit
 * acknowledgment), or shown as a DESTINATION (mandatory "I verified" checkbox) —
 * never as passive/verified change. Legitimate change must still verify.
 *
 * Run: node test-psbt-change-audit.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
process.env.BOOT = join(__dirname, 'boot.html');
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

const FNS = ['_psbtAuditOutputs','_psbtExpectedScript','_psbtScriptsEqual','_psbtGetDerivEntries','_psbtNormalizeFp','_psbtPurposeToType','_psbtFormatPath','_psbtDetectMultisig','_psbtVerifyMultisigChange','_psbtMultisigWalletBinding'];
const ctx = vm.createContext({ window: { BtcMath: { btcSigner: btc, HDKey } }, console: { log(){}, warn(){}, error(){} }, Uint8Array, BigInt, Number, String, Array, Object, Map, Set, Math, Error, ArrayBuffer,
  PSBT_NETWORK: btc.NETWORK, PSBT_WILDCARD_FP: '00000000', _psbtLoadedBytes: null, _psbtSnapshotSpOutputs: () => [], _psbtVerifySilentPayments: () => null });
vm.runInContext(FNS.map(extract).join('\n'), ctx);
const b58c = createBase58check(sha256);
const H = 0x80000000;
const me = HDKey.fromMasterSeed(await bip39.mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', ''));
const FP = me.fingerprint, myFp = (FP >>> 0).toString(16).toUpperCase().padStart(8, '0');
const rnd = () => HDKey.fromMasterSeed(randomBytes(32));
let pass = 0, fail = 0;
function expect(name, r, idx, want) {
  const o = r.outputs.find(x => x.index === idx); const ok = o.category === want; ok ? pass++ : fail++;
  const gate = r.hijackDetected ? 'BLOCKED' : r.unverifiedChangeDetected ? 'ACK-GATED' : '';
  console.log((ok ? '  PASS ' : '  FAIL ') + name.padEnd(62) + o.category.padEnd(18) + gate + (ok ? '' : '   (want ' + want + ') ' + o.auditDetail));
}
const audit = (t) => ctx._psbtAuditOutputs(btc.Transaction.fromPSBT(t.toPSBT()), me, myFp);

// ---------------- Single-sig ----------------
console.log('Single-sig (BIP-84) — output 1 is the claimed change:');
const inKey = me.derive("m/84'/0'/0'/0/0"), mine = me.derive("m/84'/0'/0'/1/0"), att = rnd().derive("m/84'/0'/0'/0/0");
const merchant = { script: btc.p2wpkh(rnd().publicKey).script, amount: 10_000_000n };
function ss(out) { const t = new btc.Transaction();
  t.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: btc.p2wpkh(inKey.publicKey).script, amount: 100_000_000n },
    bip32Derivation: [[inKey.publicKey, { fingerprint: FP, path: [84+H, 0+H, 0+H, 0, 0] }]] });
  t.addOutput(merchant); t.addOutput(out); return audit(t); }
const P = (a, ...r) => [a + H, 0 + H, 0 + H, ...r];
expect('legit change', ss({ script: btc.p2wpkh(mine.publicKey).script, amount: 89_000_000n, bip32Derivation: [[mine.publicKey, { fingerprint: FP, path: P(84, 1, 0) }]] }), 1, 'verified-change');
expect('ATTACK my fp + change path, attacker script', ss({ script: btc.p2wpkh(att.publicKey).script, amount: 89_000_000n, bip32Derivation: [[att.publicKey, { fingerprint: FP, path: P(84, 1, 0) }]] }), 1, 'hijack');
expect('ATTACK wildcard fingerprint 00000000', ss({ script: btc.p2wpkh(att.publicKey).script, amount: 89_000_000n, bip32Derivation: [[att.publicKey, { fingerprint: 0, path: P(84, 1, 0) }]] }), 1, 'unverified-change');
expect('ATTACK foreign fingerprint deadbeef', ss({ script: btc.p2wpkh(att.publicKey).script, amount: 89_000_000n, bip32Derivation: [[att.publicKey, { fingerprint: 0xdeadbeef, path: P(84, 1, 0) }]] }), 1, 'destination');
expect("ATTACK my fp + unknown purpose 99'", ss({ script: btc.p2wpkh(att.publicKey).script, amount: 89_000_000n, bip32Derivation: [[att.publicKey, { fingerprint: FP, path: P(99, 1, 0) }]] }), 1, 'destination');
expect('external output, no derivation', ss({ script: btc.p2wpkh(att.publicKey).script, amount: 89_000_000n }), 1, 'destination');

// ---------------- Multisig ----------------
console.log('\nMultisig — inputs are 2-of-3 {me, B, C}; output 1 is the claimed change:');
const acct = [48+H, 0+H, 0+H, 2+H], B = rnd(), C = rnd(), X = rnd(), Y = rnd(), W = [me, B, C];
const sortPk = a => a.slice().sort((p, q) => Buffer.compare(Buffer.from(p), Buffer.from(q)));
const leaf = (k, ch, i) => k.derive("m/48'/0'/0'/2'/" + ch + '/' + i);
const gxOf = (keys) => keys.map(k => [b58c.decode(k.derive("m/48'/0'/0'/2'").publicExtendedKey), { fingerprint: k.fingerprint, path: acct }]);
function msOut(keys, m, ch, i, amount, fps) { const pubs = keys.map(k => leaf(k, ch, i).publicKey); const ms = btc.p2ms(m, sortPk(pubs)); const w = btc.p2wsh(ms);
  return { script: w.script, amount, witnessScript: ms.script, bip32Derivation: keys.map((k, j) => [leaf(k, ch, i).publicKey, { fingerprint: fps ? fps[j] : k.fingerprint, path: [...acct, ch, i] }]) }; }
function ms(change, globalKeys, nIn = 1) { const t = new btc.Transaction();
  for (let n = 0; n < nIn; n++) { const inp = msOut(W, 2, 0, n, 50_000_000n);
    t.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: inp.script, amount: inp.amount }, witnessScript: inp.witnessScript, bip32Derivation: inp.bip32Derivation }); }
  t.addOutput(merchant); t.addOutput(change); if (globalKeys) t.global.xpub = gxOf(globalKeys); return audit(t); }
expect('legit change, global xpubs present', ms(msOut(W, 2, 1, 0, 89_000_000n), W), 1, 'verified-change');
expect('legit change, 3 inputs', ms(msOut(W, 2, 1, 7, 89_000_000n), W, 3), 1, 'verified-change');
expect('legit change, cosigner entry listed first', ms(msOut([B, C, me], 2, 1, 0, 89_000_000n), [C, me, B]), 1, 'verified-change');
expect('legit change, no global xpubs (unprovable)', ms(msOut(W, 2, 1, 0, 89_000_000n), null), 1, 'unverified-change');
expect('ATTACK 2-of-3 {me,X,Y}', ms(msOut([me, X, Y], 2, 1, 0, 89_000_000n), W), 1, 'hijack');
expect('ATTACK 2-of-3 {me,X,Y} + attacker adds X,Y xpubs', ms(msOut([me, X, Y], 2, 1, 0, 89_000_000n), [me, B, C, X, Y]), 1, 'hijack');
expect('ATTACK 2-of-3 {me,X,Y} + attacker strips xpubs', ms(msOut([me, X, Y], 2, 1, 0, 89_000_000n), null), 1, 'unverified-change');
expect('ATTACK 1-of-2 {me,X}', ms(msOut([me, X], 1, 1, 0, 89_000_000n), W), 1, 'hijack');
expect('ATTACK 1-of-2 {me,X} + attacker strips xpubs', ms(msOut([me, X], 1, 1, 0, 89_000_000n), null), 1, 'hijack');
expect('ATTACK 1-of-3 {me,B,C} (weakened threshold)', ms(msOut(W, 1, 1, 0, 89_000_000n), W), 1, 'hijack');
expect('ATTACK {me,X,Y} relabelled with B,C fingerprints', ms(msOut([me, X, Y], 2, 1, 0, 89_000_000n, [me.fingerprint, B.fingerprint, C.fingerprint]), W), 1, 'hijack');

console.log(`\nPSBT CHANGE AUDIT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

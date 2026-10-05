/**
 * test-psbt-fee-rate.mjs — the PSBT Signer review's fee rate for unsigned PSBTs.
 *
 * @scure/btc-signer's tx.vsize / tx.weight throw "Transaction is not finalized"
 * on an unsigned PSBT, which used to leave feeRate null and the review showing
 * "? sat/vB". _psbtAuditOutputs now falls back to _psbtEstimateVsize, which
 * predicts the signed size from the input script types. These tests extract
 * the real functions from boot.html, check the single-sig P2WPKH example
 * exactly, and compare the estimate against really signed transactions.
 *
 * Run: node test-psbt-fee-rate.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
function extract(name) {
  const re = new RegExp('(^|\\n)([ \\t]*)(async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(SRC); if (!m) throw new Error('not found: ' + name);
  let p = m.index + m[0].length - 1, depth = 0;
  for (; p < SRC.length; p++) { const c = SRC[p]; if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) break; } }
  let i = SRC.indexOf('{', p), j = i, str = null;
  depth = 0;
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

const FNS = ['_psbtEstimateVsize', '_psbtAuditOutputs', '_psbtExpectedScript', '_psbtScriptsEqual', '_psbtGetDerivEntries', '_psbtNormalizeFp', '_psbtPurposeToType', '_psbtFormatPath', '_psbtDetectMultisig', '_psbtVerifyMultisigChange', '_psbtMultisigWalletBinding'];
const ctx = vm.createContext({ window: { BtcMath: { btcSigner: btc, HDKey } }, console: { log() {}, warn() {}, error() {} }, Uint8Array, BigInt, Number, String, Array, Object, Map, Set, Math, Error, ArrayBuffer,
  PSBT_NETWORK: btc.NETWORK, PSBT_WILDCARD_FP: '00000000', _psbtLoadedBytes: null, _psbtSnapshotSpOutputs: () => [], _psbtVerifySilentPayments: () => null });
vm.runInContext(FNS.map(extract).join('\n'), ctx);

let pass = 0, fail = 0;
function check(name, ok, detail = '') { ok ? pass++ : fail++; console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '   ' + detail : '')); }

const H = 0x80000000;
const me = HDKey.fromMasterSeed(await bip39.mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', ''));
const FP = me.fingerprint, myFp = (FP >>> 0).toString(16).toUpperCase().padStart(8, '0');
const rnd = () => HDKey.fromMasterSeed(randomBytes(32));
const reparse = (t) => btc.Transaction.fromPSBT(t.toPSBT());

// ---------------- Single-sig P2WPKH: exact estimate + audit feeRate ----------------
console.log('Single-sig P2WPKH, 1 input -> 2 outputs (payment + change):');
const inKey = me.derive("m/84'/0'/0'/0/0"), chg = me.derive("m/84'/0'/0'/1/0");
function p2wpkhTx() {
  const t = new btc.Transaction();
  t.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: btc.p2wpkh(inKey.publicKey).script, amount: 100_000n },
    bip32Derivation: [[inKey.publicKey, { fingerprint: FP, path: [84 + H, 0 + H, 0 + H, 0, 0] }]] });
  t.addOutput({ script: btc.p2wpkh(rnd().publicKey).script, amount: 50_000n });
  t.addOutput({ script: btc.p2wpkh(chg.publicKey).script, amount: 47_190n,
    bip32Derivation: [[chg.publicKey, { fingerprint: FP, path: [84 + H, 0 + H, 0 + H, 1, 0] }]] });
  return t;
}
const unsigned = reparse(p2wpkhTx());
let threw = false; try { unsigned.vsize; } catch (_) { threw = true; }
check('btc-signer tx.vsize throws on the unsigned PSBT (the original bug)', threw);
// 10.5 vB overhead (incl. segwit marker/flag) + 68 vB input + 2 x 31 vB P2WPKH outputs
const est = ctx._psbtEstimateVsize(unsigned);
check('estimate is 140.5 vB', est === 140.5, 'got ' + est);
const r = ctx._psbtAuditOutputs(unsigned, me, myFp);
check('fee is 2,810 sats', r.fee === 2810n, 'got ' + r.fee);
check('feeRate is "20.0" (no longer null / "?")', r.feeRate === '20.0', 'got ' + r.feeRate);

// Compare with the really signed transaction.
const signedT = p2wpkhTx();
signedT.signIdx(inKey.privateKey, 0); signedT.finalize();
const realV = signedT.vsize;
check('estimate within 1 vB of the signed tx (' + realV + ' vB)', Math.abs(est - realV) <= 1, 'est ' + est);
const fin = reparse(signedT);
const rFin = ctx._psbtAuditOutputs(fin, me, myFp);
check('finalized PSBT uses the measured vsize', rFin.feeRate === (2810 / realV).toFixed(1), 'got ' + rFin.feeRate);

// ---------------- Other script types vs. really signed transactions ----------------
console.log('\nOther input types, estimate vs. signed size:');
function compare(name, addInput, signers, expectedEst) {
  const build = () => { const t = new btc.Transaction({ allowLegacyWitnessUtxo: true }); addInput(t); t.addOutput({ script: btc.p2wpkh(rnd().publicKey).script, amount: 10_000n }); return t; };
  const e = ctx._psbtEstimateVsize(reparse(build()));
  const t = build(); for (const k of signers) t.signIdx(k.privateKey, 0); t.finalize();
  const v = t.vsize;
  const ok = e !== null && Math.abs(e - v) <= signers.length && (expectedEst === undefined || e === expectedEst);
  check(name.padEnd(28) + ' est ' + String(e).padEnd(6) + ' signed ' + v, ok);
}
const k1 = rnd(), k2 = rnd(), k3 = rnd();
const txid = randomBytes(32);
compare('P2TR key path', (t) => { const p = btc.p2tr(btc.utils.pubSchnorr(k1.privateKey)); t.addInput({ txid, index: 0, witnessUtxo: { script: p.script, amount: 20_000n }, tapInternalKey: p.tapInternalKey }); }, [k1], 10.5 + 57.5 + 31);
compare('P2SH-P2WPKH', (t) => { const p = btc.p2sh(btc.p2wpkh(k1.publicKey)); t.addInput({ txid, index: 0, witnessUtxo: { script: p.script, amount: 20_000n }, redeemScript: p.redeemScript }); }, [k1], 10.5 + 91 + 31);
compare('P2PKH (legacy)', (t) => { const p = btc.p2pkh(k1.publicKey); t.addInput({ txid, index: 0, witnessUtxo: { script: p.script, amount: 20_000n } }); }, [k1]);
const ms = btc.p2ms(2, [k1.publicKey, k2.publicKey, k3.publicKey]);
compare('P2WSH 2-of-3', (t) => { const p = btc.p2wsh(ms); t.addInput({ txid, index: 0, witnessUtxo: { script: p.script, amount: 20_000n }, witnessScript: p.witnessScript }); }, [k1, k2]);
compare('P2SH-P2WSH 2-of-3', (t) => { const p = btc.p2sh(btc.p2wsh(ms)); t.addInput({ txid, index: 0, witnessUtxo: { script: p.script, amount: 20_000n }, redeemScript: p.redeemScript, witnessScript: p.witnessScript }); }, [k1, k2]);

// ---------------- Unknown script type: no guess ----------------
console.log('\nUnknown input type:');
{
  const t = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  t.addInput({ txid, index: 0, witnessUtxo: { script: btc.p2wsh(btc.p2pk(k1.publicKey)).script, amount: 20_000n } });
  t.addOutput({ script: btc.p2wpkh(rnd().publicKey).script, amount: 10_000n });
  check('P2WSH without a witnessScript -> null (UI shows "?")', ctx._psbtEstimateVsize(reparse(t)) === null);
}

console.log(`\nPSBT FEE RATE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

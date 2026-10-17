/**
 * test-psbt-legacy-inputs.mjs — fee and amounts for legacy inputs (nonWitnessUtxo).
 *
 * A legacy signature doesn't commit to the amount being spent, so a legacy input's amount
 * comes from the full previous transaction the PSBT includes. It must be the transaction the
 * input's txid names: otherwise a PSBT could claim a bigger input and hide part of the fee.
 * @scure/btc-signer only checks this when the previous transaction is "final" (signed inputs),
 * so a forged one with empty signatures gets through it. SafeKeep checks it itself.
 *
 *  1. _psbtNonWitnessTxidOk / _psbtPrevOut / _psbtPrevTxMismatches: honest legacy and segwit
 *     previous transactions are accepted (the txid ignores witness data); a forged one is not,
 *     even though btc-signer parses it; witnessUtxo is used as given.
 *  2. The audit: a fee and fee rate for legacy-only and mixed transactions; a forged previous
 *     transaction leaves the fee unknown and is reported.
 *  3. The review: the input list shows no amount for a forged input; the fee section says
 *     not to sign; the sign gate and psbtDoSign block it with no override.
 * Run: node test-psbt-legacy-inputs.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'boot.html'), 'utf8');
function extractBlock(start) {
  let i = SRC.indexOf('{', start), j = i, depth = 0, str = null;
  for (; j < SRC.length; j++) {
    const c = SRC[j], n = SRC[j + 1];
    if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
    if (c === '/' && n === '/') { j = SRC.indexOf('\n', j); continue; }
    if (c === '/' && n === '*') { j = SRC.indexOf('*/', j) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return j + 1;
}
function extract(name) {
  const m = new RegExp('(^|\\n)(async\\s+)?function\\s+' + name + '\\s*\\(').exec(SRC);
  if (!m) throw new Error('not found: ' + name);
  let p = SRC.indexOf('(', m.index + m[0].length - 1), depth = 0;
  for (; p < SRC.length; p++) { if (SRC[p] === '(') depth++; else if (SRC[p] === ')') { depth--; if (depth === 0) break; } }
  return SRC.slice(m.index, extractBlock(p));
}
let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c || x === undefined ? '' : '  -> ' + x)); };

const ctx = vm.createContext({
  window: { BtcMath: { btcSigner: btc, HDKey } }, console: { log() {}, warn() {}, error() {} },
  Uint8Array, BigInt, Number, String, Array, Object, Map, Set, Math, Error, Date, ArrayBuffer,
  PSBT_NETWORK: btc.NETWORK, PSBT_WILDCARD_FP: '00000000', _psbtLoadedBytes: null, _psbtHwMode: false,
  _psbtSnapshotSpOutputs: () => [], _psbtVerifySilentPayments: () => null,
});
vm.runInContext(['_psbtNonWitnessTxidOk', '_psbtPrevOut', '_psbtPrevTxMismatches', '_psbtEstimateVsize', '_psbtAuditOutputs', '_psbtExpectedScript',
  '_psbtScriptsEqual', '_psbtGetDerivEntries', '_psbtNormalizeFp', '_psbtPurposeToType', '_psbtFormatPath', '_psbtDetectMultisig',
  '_psbtVerifyMultisigChange', '_psbtMultisigWalletBinding', '_psbtTxSummary', '_psbtBtc', '_psbtSummaryHtml', '_psbtDuration', '_psbtLockRowsHtml',
  '_psbtSavedWalletBannerHtml', '_psbtBuildReviewHtml', '_psbtEscape', '_psbtAddressChecksum'].map(extract).join('\n'), ctx);

const H = 0x80000000;
const me = HDKey.fromMasterSeed(await bip39.mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', ''));
const myFp = (me.fingerprint >>> 0).toString(16).toUpperCase().padStart(8, '0');
const PAY = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const lk = (i) => me.derive(`m/44'/0'/0'/0/${i}`);

// A previous transaction paying `amount` to legacy key i at output 1; signed (final) or not.
function prevTx(i, amount, { signed = false } = {}) {
  const p = new btc.Transaction();
  const src = HDKey.fromMasterSeed(randomBytes(32));
  p.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: btc.p2wpkh(src.publicKey).script, amount: amount + 10_000n } });
  p.addOutput({ script: btc.p2wpkh(src.publicKey).script, amount: 1_000n });
  p.addOutput({ script: btc.p2pkh(lk(i).publicKey).script, amount });
  if (signed) { p.sign(src.privateKey); p.finalize(); }
  return p;
}
const legacyIn = (prev, i, utxo = prev) => ({ txid: prev.id, index: 1, nonWitnessUtxo: utxo.toBytes(true, true),
  bip32Derivation: [[lk(i).publicKey, { fingerprint: me.fingerprint, path: [44 + H, H, H, 0, i] }]] });
const parse = (t) => btc.Transaction.fromPSBT(t.toPSBT());

// ======== 1. Helpers ========
console.log('Previous-transaction check:');
{
  const real = prevTx(0, 400_000n), fake = prevTx(0, 4_000_000n);
  const t = new btc.Transaction();
  t.addInput(legacyIn(real, 0));
  t.addInput(legacyIn(real, 0, fake));   // claims to spend `real` but carries `fake`
  t.addOutputAddress(PAY, 300_000n, btc.NETWORK);
  const tx = parse(t);
  ck('(setup) btc-signer accepts the forged previous transaction', tx.inputs[1].nonWitnessUtxo.outputs[1].amount === 4_000_000n);
  ck('honest unsigned previous transaction matches its txid', ctx._psbtNonWitnessTxidOk(tx.inputs[0]) === true);
  ck('forged previous transaction does not', ctx._psbtNonWitnessTxidOk(tx.inputs[1]) === false);
  ck('prevOut: honest legacy input gives its amount and script', ctx._psbtPrevOut(tx.inputs[0])?.amount === 400_000n && ctx._psbtPrevOut(tx.inputs[0]).script[0] === 0x76);
  ck('prevOut: forged legacy input gives nothing', ctx._psbtPrevOut(tx.inputs[1]) === null);
  ck('mismatches lists the forged input only', ctx._psbtPrevTxMismatches(tx).join() === '1');
  const signedReal = prevTx(1, 700_000n, { signed: true });
  const t2 = new btc.Transaction(); t2.addInput(legacyIn(signedReal, 1)); t2.addOutputAddress(PAY, 600_000n, btc.NETWORK);
  ck('a signed segwit previous transaction (with witness data) matches its txid', ctx._psbtNonWitnessTxidOk(parse(t2).inputs[0]) === true);
  const k = me.derive("m/84'/0'/0'/0/0");
  const t3 = new btc.Transaction(); t3.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: btc.p2wpkh(k.publicKey).script, amount: 55_000n } }); t3.addOutputAddress(PAY, 50_000n, btc.NETWORK);
  ck('witnessUtxo is used as given', ctx._psbtPrevOut(parse(t3).inputs[0])?.amount === 55_000n && ctx._psbtPrevTxMismatches(parse(t3)).length === 0);
  ck('no input data: nothing', ctx._psbtPrevOut({ txid: new Uint8Array(32), index: 0 }) === null);
}

// ======== 2. Audit ========
console.log('Fee:');
{
  const a = prevTx(0, 400_000n), b = prevTx(2, 250_000n, { signed: true });
  const t = new btc.Transaction();
  t.addInput(legacyIn(a, 0)); t.addInput(legacyIn(b, 2));
  t.addOutputAddress(PAY, 600_000n, btc.NETWORK);
  const r = ctx._psbtAuditOutputs(parse(t), me, myFp);
  ck('legacy-only: fee is now known (650,000 - 600,000)', r.fee === 50_000n && r.totalIn === 650_000n, String(r.fee));
  ck('legacy-only: fee rate estimated (two P2PKH inputs)', Number(r.feeRate) > 0 && Number(r.feeRate) < 200, r.feeRate);
  ck('nothing reported as mismatched', r.prevTxMismatchInputs.length === 0);
  const k = me.derive("m/84'/0'/0'/0/0");
  t.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: btc.p2wpkh(k.publicKey).script, amount: 100_000n }, bip32Derivation: [[k.publicKey, { fingerprint: me.fingerprint, path: [84 + H, H, H, 0, 0] }]] });
  const r2 = ctx._psbtAuditOutputs(parse(t), me, myFp);
  ck('mixed legacy + segwit: fee includes both', r2.fee === 150_000n, String(r2.fee));
}
{
  const real = prevTx(0, 400_000n), fake = prevTx(0, 4_000_000n);
  const t = new btc.Transaction();
  t.addInput(legacyIn(real, 0, fake));
  t.addOutputAddress(PAY, 300_000n, btc.NETWORK);
  const tx = parse(t);
  const r = ctx._psbtAuditOutputs(tx, me, myFp);
  ck('forged: fee unknown, not the 3,700,000 the PSBT would suggest', r.fee === null && !r.canCalcFee);
  ck('forged: reported for the sign gate', r.prevTxMismatchInputs.join() === '0');
  const s = ctx._psbtTxSummary(tx, r);
  ck('forged: the input list shows no amount for it', s.inputs[0].amount === null && s.totalIn === null && s.leaving === null);
  const html = ctx._psbtBuildReviewHtml(tx, r);
  ck('forged: the fee section says not to sign', /doesn&rsquo;t add up/.test(html.feeHtml) && /input 0 is not the one it spends/.test(html.feeHtml), html.feeHtml);
  ck('forged: the input list shows "amount unknown"', /amount unknown/.test(html.outputsHtml));
}
{
  const t = new btc.Transaction(); t.addInput({ txid: randomBytes(32), index: 0 }); t.addOutputAddress(PAY, 1_000n, btc.NETWORK);
  const tx = parse(t); const r = ctx._psbtAuditOutputs(tx, me, myFp);
  const html = ctx._psbtBuildReviewHtml(tx, r);
  ck('input data missing (not forged): plain "can’t calculate the fee" note', /doesn&rsquo;t include the amount of every input/.test(html.feeHtml) && r.prevTxMismatchInputs.length === 0);
}

// ======== 3. Sign gate wiring ========
console.log('Signing:');
{
  const gate = SRC.slice(SRC.indexOf('function _psbtUpdateSignGate'), SRC.indexOf('function _psbtUpdateSignGate') + 9000);
  ck('the sign gate blocks a mismatch before any Force Sign branch', gate.indexOf('} else if (prevMismatch.length) {') > 0 &&
     gate.indexOf('} else if (prevMismatch.length) {') < gate.indexOf('} else if (hijack && !forceSign) {'));
  ck('… and disables the button', /else if \(prevMismatch\.length\) \{\s*signBtn\.disabled = true;/.test(gate));
  const sign = SRC.slice(SRC.indexOf('async function psbtDoSign()'), SRC.indexOf('async function psbtDoSign()') + 4000);
  ck('psbtDoSign refuses on its own too (before the hardware-wallet hand-off)', sign.indexOf('_psbtPrevTxMismatches(') > 0 && sign.indexOf('_psbtPrevTxMismatches(') < sign.indexOf('if (_psbtHwMode)'));
  ck('no other code reads input amounts straight from nonWitnessUtxo', !/nonWitnessUtxo\.outputs\[inp\.index\]\.amount/.test(SRC));
}

console.log(`\nPSBT LEGACY INPUTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

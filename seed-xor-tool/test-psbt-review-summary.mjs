/**
 * test-psbt-review-summary.mjs — the PSBT Signer's review screen additions:
 *  1. _psbtTxSummary on real PSBTs: totals (sending, fee, total leaving, change back, change to
 *     check), the inputs being spent (amount from witnessUtxo or nonWitnessUtxo, address, saved
 *     wallet, multisig signatures so far, already-signed inputs), nLockTime (block, time, or no
 *     effect when every input is final), BIP-68 relative locks (blocks / 512-second units, version 2
 *     only) and whether replace-by-fee is signalled.
 *  2. The HTML: summary card, input list, lock time and RBF rows, time-lock warning, escaping.
 *  3. Comparing a destination with the address the recipient gave: identical (case-insensitive for
 *     bech32, bitcoin: links accepted), a lookalike address with the differing characters marked,
 *     and invalid input. It never ticks the verification checkbox.
 *  4. The full review builder carries the summary, the comparison box and the lock rows.
 * Run: node test-psbt-review-summary.mjs
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

const els = {};
// Like the DOM: setting textContent replaces innerHTML, and the reverse.
const el = (id) => (els[id] ||= { id, value: '', _t: '', className: '', style: { display: 'none' },
  get textContent() { return this._t; }, set textContent(v) { this._t = String(v); },
  get innerHTML() { return this._t; }, set innerHTML(v) { this._t = String(v); } });
const ctx = vm.createContext({
  window: { BtcMath: { btcSigner: btc, HDKey } }, document: { getElementById: el, querySelectorAll: () => [] },
  console: { log() {}, warn() {}, error() {} }, Uint8Array, BigInt, Number, String, Array, Object, Map, Set, Math, Error, Date, ArrayBuffer,
  PSBT_NETWORK: btc.NETWORK, PSBT_WILDCARD_FP: '00000000', _psbtLoadedBytes: null, _psbtHwMode: false,
  _psbtSnapshotSpOutputs: () => [], _psbtVerifySilentPayments: () => null, _psbtEstimateVsize: () => 200,
  _psbtVerifyState: { destinations: [] }, showStatus() {},
});
vm.runInContext(['_psbtAuditOutputs', '_psbtExpectedScript', '_psbtScriptsEqual', '_psbtGetDerivEntries', '_psbtNormalizeFp', '_psbtPurposeToType', '_psbtFormatPath',
  '_psbtDetectMultisig', '_psbtVerifyMultisigChange', '_psbtMultisigWalletBinding', '_psbtSavedWalletCheck',
  '_psbtTxSummary', '_psbtBtc', '_psbtSummaryHtml', '_psbtDuration', '_psbtLockRowsHtml', '_psbtSavedWalletBannerHtml', '_psbtBuildReviewHtml',
  '_psbtEscape', '_psbtAddressChecksum', '_psbtCompareAddresses', 'psbtCompareAddress', '_descRecvNormalize'].map(extract).join('\n'), ctx);

const H = 0x80000000;
const me = HDKey.fromMasterSeed(await bip39.mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', ''));
const myFp = (me.fingerprint >>> 0).toString(16).toUpperCase().padStart(8, '0');
const other = () => HDKey.fromMasterSeed(randomBytes(32));
const ssKey = (c, i) => me.derive(`m/84'/0'/0'/${c}/${i}`);
const ssDer = (k, c, i) => [[k.publicKey, { fingerprint: me.fingerprint, path: [84 + H, H, H, c, i] }]];
const PAY = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';   // a fixed destination (BIP-84 vector, receive 0)

function build({ version = 2, lockTime = 0, seqs = [0xfffffffd, 0xfffffffd], change = true } = {}) {
  const t = new btc.Transaction({ version, lockTime });
  seqs.forEach((sequence, n) => {
    const k = ssKey(0, n);
    t.addInput({ txid: randomBytes(32), index: 0, sequence, witnessUtxo: { script: btc.p2wpkh(k.publicKey).script, amount: 1_000_000n }, bip32Derivation: ssDer(k, 0, n) });
  });
  t.addOutputAddress(PAY, 600_000n, btc.NETWORK);
  if (change) { const c = ssKey(1, 0); t.addOutput({ script: btc.p2wpkh(c.publicKey).script, amount: BigInt(seqs.length) * 1_000_000n - 610_000n, bip32Derivation: ssDer(c, 1, 0) }); }
  return t;
}
const run = (t, mutate) => { const tx = btc.Transaction.fromPSBT(t.toPSBT()); if (mutate) mutate(tx); const a = ctx._psbtAuditOutputs(tx, me, myFp); return { tx, a, s: ctx._psbtTxSummary(tx, a) }; };

// ======== 1. Summary facts ========
console.log('Summary:');
{
  const { s } = run(build({ lockTime: 912345 }));
  ck('total in = 0.02 BTC', s.totalIn === 2_000_000n, String(s.totalIn));
  ck('sending 600,000 sats to 1 destination', s.sending === 600_000n && s.destinations === 1);
  ck('fee 10,000 sats', s.fee === 10_000n, String(s.fee));
  ck('total leaving = sending + fee', s.leaving === 610_000n);
  ck('change back 1,390,000 sats, nothing to check', s.changeBack === 1_390_000n && s.changeUnverified === 0n);
  ck('inputs listed with amount and address', s.inputs.length === 2 && s.inputs[0].amount === 1_000_000n && /^bc1q/.test(s.inputs[0].address));
  ck('single-sig input: needs 1 signature, has none', s.inputs[0].sigs.need === 1 && s.inputs[0].sigs.have === 0 && !s.inputs[0].sigs.multisig);
  ck('lock time: not before block 912,345', s.lockTime.kind === 'height' && s.lockTime.value === 912345 && !s.lockTime.ignored);
  ck('sequence 0xfffffffd signals replace-by-fee', s.rbf === true);
  ck('no relative locks', s.inputs.every((x) => x.relLock === null));
}
{
  const { s } = run(build({ lockTime: 912345, seqs: [0xffffffff, 0xffffffff] }));
  ck('lock time with every input final has no effect', s.lockTime.ignored === true);
  ck('final sequences: no RBF', s.rbf === false);
  const { s: s2 } = run(build({ seqs: [0xfffffffe] }));
  ck('0xfffffffe: no RBF, lock time none', s2.rbf === false && s2.lockTime.kind === 'none');
  const { s: s3 } = run(build({ lockTime: 1800000000 }));
  ck('lock time ≥ 500,000,000 is a date', s3.lockTime.kind === 'time' && s3.lockTime.value === 1800000000);
}
{
  const { s } = run(build({ seqs: [144, 0x00400000 | 10] }));
  ck('relative lock 144 blocks (version 2)', s.inputs[0].relLock?.blocks === 144, JSON.stringify(s.inputs[0].relLock));
  ck('relative lock 10 × 512 s (type flag)', s.inputs[1].relLock?.seconds === 5120, JSON.stringify(s.inputs[1].relLock));
  ck('a relative lock also signals RBF', s.rbf === true);
  const { s: v1 } = run(build({ version: 1, seqs: [144] }));
  ck('version 1: sequence is not a relative lock', v1.inputs[0].relLock === null);
  const { s: dis } = run(build({ seqs: [(0x80000000 | 144) >>> 0] }));
  ck('disable flag (bit 31) set: no relative lock', dis.inputs[0].relLock === null);
}
{
  // Multisig 2-of-3 input with one partial signature; plus a legacy nonWitnessUtxo input.
  const keys = [me, other(), other()].map((k) => k.derive("m/48'/0'/0'/2'/0/0"));
  const pubs = keys.map((k) => k.publicKey).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const ms = btc.p2wsh(btc.p2ms(2, pubs));
  const prev = new btc.Transaction(); prev.addInput({ txid: randomBytes(32), index: 0 });
  const lk = me.derive("m/44'/0'/0'/0/1");
  prev.addOutput({ script: btc.p2pkh(lk.publicKey).script, amount: 250_000n });
  const t = new btc.Transaction();
  t.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: ms.script, amount: 3_000_000n }, witnessScript: ms.witnessScript });
  t.addInput({ txid: prev.id, index: 0, nonWitnessUtxo: prev.toBytes(true, false) });
  t.addOutputAddress(PAY, 3_000_000n, btc.NETWORK);
  const { s } = run(t, (tx) => { tx.inputs[0].partialSig = [[keys[1].publicKey, Uint8Array.from([0x30, ...randomBytes(70), 1])]]; });
  ck('multisig input: 2-of-3, 1 of 2 signatures so far', s.inputs[0].sigs.multisig === '2-of-3' && s.inputs[0].sigs.have === 1 && s.inputs[0].sigs.need === 2, JSON.stringify(s.inputs[0].sigs));
  ck('legacy input: amount and address from nonWitnessUtxo', s.inputs[1].amount === 250_000n && s.inputs[1].address.startsWith('1'), String(s.inputs[1].amount) + ' ' + s.inputs[1].address);
  ck('no change: everything sent; fee unknown with a legacy input (as the audit reports)', s.changeBack === 0n && s.sending === 3_000_000n && s.totalIn === 3_250_000n && s.fee === null && s.leaving === null);
}
{
  // An input with no UTXO data: total in and fee unknown.
  const t = new btc.Transaction();
  t.addInput({ txid: randomBytes(32), index: 0 });
  t.addOutputAddress(PAY, 1000n, btc.NETWORK);
  const { s } = run(t);
  ck('missing UTXO: total in, fee and total leaving are unknown', s.totalIn === null && s.fee === null && s.leaving === null);
}
{
  // Hijacked "change" counts as leaving; unverified change is shown separately.
  const t = build();
  const att = other().derive('m/0');
  t.addOutput({ script: btc.p2wpkh(att.publicKey).script, amount: 5_000n, bip32Derivation: [[att.publicKey, { fingerprint: me.fingerprint, path: [84 + H, H, H, 1, 9] }]] });
  t.addOutput({ script: btc.p2wpkh(att.publicKey).script, amount: 7_000n, bip32Derivation: [[att.publicKey, { fingerprint: 0, path: [84 + H, H, H, 1, 9] }]] });
  const { a, s } = run(t);
  ck('(setup) audit flags a hijack and an unverified change', a.hijackDetected && a.unverifiedChangeDetected);
  ck('hijacked output counts as leaving', s.sending === 605_000n && s.destinations === 2, String(s.sending));
  ck('unverified change shown separately', s.changeUnverified === 7_000n);
}

// ======== 2. HTML ========
console.log('Summary HTML:');
{
  const { a, tx } = run(build({ lockTime: 912345, seqs: [144, 0xfffffffd] }));
  a.savedWallets = { count: 1, inputs: [{ index: 0, wallet: '<b>Daily</b>', chain: 0, child: 0 }, { index: 1, wallet: null }], unmatchedInputs: [1] };
  const s = ctx._psbtTxSummary(tx, a);
  const h = ctx._psbtSummaryHtml(s);
  ck('shows the four totals', /Sending to 1 destination/.test(h) && /Mining fee/.test(h) && /Total leaving your wallet/.test(h) && /Coming back as change/.test(h));
  ck('total leaving in BTC and sats', /0\.00610000 BTC/.test(h) && /610,000 sats/.test(h), h);
  ck('input list with count and total', /Spending 2 inputs &middot; 0\.02000000 BTC/.test(h));
  ck('input names its saved wallet (escaped)', /Saved wallet &ldquo;&lt;b&gt;Daily&lt;\/b&gt;&rdquo; &middot; receive #0/.test(h) && !h.includes('<b>Daily'), h);
  ck('input shows its relative lock', /Locked until 144 blocks after these coins confirmed/.test(h));
  const r = ctx._psbtLockRowsHtml(s);
  ck('lock row: not before block 912,345', /Not before block 912,345/.test(r));
  ck('RBF row: yes', /Replace-by-fee<\/span><span class="psbt-review-value">Yes/.test(r));
  ck('time-locked input warning', /psbt-alert warning/.test(r) && /input 0 can&rsquo;t be mined until 144 blocks/.test(r), r);
  const s2 = ctx._psbtTxSummary(...(() => { const x = run(build({ lockTime: 1800000000, seqs: [0xffffffff] })); return [x.tx, x.a]; })());
  const r2 = ctx._psbtLockRowsHtml(s2);
  ck('time lock shown as UTC date, with no effect when final', /2027-01-15 08:00 UTC/.test(r2) && /has no effect/.test(r2), r2);
  ck('RBF row: not signalled', /Not signalled/.test(r2));
  ck('no time-lock warning without relative locks', !/Time-locked/.test(r2));
}

// ======== 3. Compare with the recipient's address ========
console.log('Address comparison:');
{
  ctx._psbtVerifyState.destinations = [{ address: PAY }];
  const cmp = (v) => { el('psbt-compare-input-0').value = v; ctx.psbtCompareAddress(0); return el('psbt-compare-result-0'); };
  let r = cmp(PAY);
  ck('identical address: OK', /is-ok/.test(r.className) && /Identical/.test(r.innerHTML));
  r = cmp(PAY.toUpperCase());
  ck('bech32 compared without case', /is-ok/.test(r.className));
  r = cmp('bitcoin:' + PAY + '?amount=0.006');
  ck('bitcoin: link with amount accepted', /is-ok/.test(r.className));
  const look = btc.p2wpkh(other().publicKey).address;
  r = cmp(PAY.slice(0, 6) + look.slice(6, -6) + PAY.slice(-6));
  ck('spliced lookalike (same start and end) is refused', /is-bad/.test(r.className) && !/Identical/.test(r.innerHTML), r.innerHTML || r.textContent);
  r = cmp(look);
  ck('a different valid address: marked, don’t sign', /is-bad/.test(r.className) && /<mark>/.test(r.innerHTML) && /Don&rsquo;t sign/.test(r.innerHTML), r.innerHTML);
  const d = ctx._psbtCompareAddresses('bc1qabcd', 'bc1qabXd');
  ck('only the differing character is marked', d.same === false && d.expected === 'bc1qab<mark>c</mark>d' && d.given === 'bc1qab<mark>X</mark>d', JSON.stringify(d));
  ck('compared text is escaped', ctx._psbtCompareAddresses('a', '<').given === '<mark>&lt;</mark>');
  r = cmp(PAY.slice(0, -1) + (PAY.endsWith('u') ? 'v' : 'u'));
  ck('invalid input: error, no match', /is-bad/.test(r.className) && /isn’t a valid Bitcoin address/.test(r.textContent), r.textContent);
  r = cmp('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  ck('testnet address refused', /is-bad/.test(r.className) && /testnet/.test(r.textContent));
  ck('comparison never ticks the checkbox', !/checked/.test(SRC.slice(SRC.indexOf('function psbtCompareAddress('), SRC.indexOf('async function psbtCompareScan('))));
}

// ======== 4. Full review builder ========
console.log('Review screen:');
{
  const { tx, a } = run(build({ lockTime: 912345 }));
  const out = ctx._psbtBuildReviewHtml(tx, a);
  ck('review carries the summary and input list', /class="psbt-summary"/.test(out.outputsHtml) && /class="psbt-inputs"/.test(out.outputsHtml));
  ck('each destination card has a comparison box', /id="psbt-compare-input-0"/.test(out.outputsHtml) && /psbtCompareScan\(0\)/.test(out.outputsHtml));
  ck('fee section carries lock time and RBF rows', /Lock time/.test(out.feeHtml) && /Replace-by-fee/.test(out.feeHtml) && /Mining Fee/.test(out.feeHtml));
  const noTx = ctx._psbtBuildReviewHtml(null, { outputs: [], fee: 1n, totalIn: 10n, totalOut: 9n, feeRate: '1.0', hijackDetected: false });
  ck('without a transaction the review still renders (no summary)', !/psbt-summary/.test(noTx.outputsHtml) && /Mining Fee/.test(noTx.feeHtml));
  ck('compare scanner stopped when the review resets or closes', (SRC.match(/psbtCompareStopScan\(\);/g) || []).length >= 3);
}

console.log(`\nPSBT REVIEW SUMMARY: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

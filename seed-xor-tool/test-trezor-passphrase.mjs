/**
 * test-trezor-passphrase.mjs — signing with a Trezor's passphrase wallet
 *
 * The helper (safekeep-trezor.py "sign" with a passphrase: pairing checked on
 * the standard wallet, then a passphrase session whose fingerprint must be
 * one of the PSBT's keys) is tested against a fake Trezor by
 * usbbootdrive/tests/test-trezor-helper.py. This checks the app side:
 *   1. The passphrase rules, run for real: confirmed (typed twice, from the
 *      Library, or applied on the Dashboard), Trezor One limits.
 *   2. The PSBT Signer's co-signing card: the box under the Trezor button,
 *      the offer when the paired Trezor isn't a listed key, the passphrase
 *      forgotten after signing and on a new transaction.
 *   3. The bridge and the helper agree.
 *   4. Single-signature transactions: the co-signing card's status, run
 *      for real on PSBTs built with the app's Bitcoin library (Native
 *      SegWit and Taproot, unsigned and signed; multisig unchanged), so a
 *      Trezor or Coldcard can sign them too.
 *   5. The new functions parse.
 *
 * Run:  node test-trezor-passphrase.mjs
 */
import { readFileSync } from 'node:fs';
import * as btc from '@scure/btc-signer';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const read = (u) => readFileSync(new URL(u, import.meta.url), 'utf8');
const html = read('./boot.html');
const bridge = read('./shared/boot.js');
const helper = read('../usbbootdrive/safekeep-trezor.py');
const fn = (name) => { const a = html.indexOf(name); return a < 0 ? '' : html.slice(a, html.indexOf('\n}\n', a) + 2); };

console.log('\n1. The passphrase rules');
const rules = new Function(['let _psbtTzPp;', fn('function _psbtTzPpReset'), fn('function _psbtTzPpValue'), fn('function _psbtTzPpProblem'),
  'return { set: (o) => { _psbtTzPpReset(); Object.assign(_psbtTzPp, o); }, value: _psbtTzPpValue, problem: _psbtTzPpProblem };'].join('\n'))();
rules.set({});
ck('off: no passphrase, no problem (the standard wallet signs, as before)', rules.value() === '' && rules.problem() === '');
rules.set({ on: true });
ck('on but empty: not ready, says what to do', rules.value() === null && /Type the Trezor’s passphrase/.test(rules.problem()));
rules.set({ on: true, value: 'Savings 2026!' });
ck('typed once: not ready, asks for the second box', rules.value() === null && /again in the second box/.test(rules.problem()));
rules.set({ on: true, value: 'Savings 2026!', confirm: 'savings 2026!' });
ck('typed twice, different case: not ready (capitals count)', rules.value() === null && /don’t match/.test(rules.problem()));
rules.set({ on: true, value: ' Savings 2026! ', confirm: ' Savings 2026! ' });
ck('typed twice the same: ready, exactly as typed (spaces kept)', rules.value() === ' Savings 2026! ' && rules.problem() === '');
rules.set({ on: true, value: 'from-library', trusted: 'from-library' });
ck('from the Library or the Dashboard: ready without a second box', rules.value() === 'from-library' && rules.problem() === '');
rules.set({ on: true, value: 'x'.repeat(51), trusted: 'x'.repeat(51) });
ck('more than 50 bytes: refused (the Trezor One limit)', /at most 50 bytes/.test(rules.problem()));
rules.set({ on: true, value: 'é'.repeat(25), trusted: 'é'.repeat(25) });
ck('…counted after NFKD, as the helper sends it (25 × é = 75 bytes)', /at most 50 bytes/.test(rules.problem()));
rules.set({ on: true, value: 'a\tb', trusted: 'a\tb' });
ck('a tab: refused', /tabs or new lines/.test(rules.problem()));

console.log('\n2. The co-signing card');
const card = fn('async function _psbtUpdateCosignCard');
ck('the passphrase box sits under the Trezor button (hardware-only mode too)', card.includes('if (tzOk) await _psbtTzPpRender(card);') && card.includes('await _psbtTzPpRender(card, tzPpOffer'));
ck('offered when the paired Trezor isn\'t a listed key but unnamed keys still need to sign', card.includes('const tzPpOffer = !!(tzPairing && !(tzCosigner && !tzCosigner.signed) && unknownUnsigned.length);') && card.includes("'Sign with the paired Trezor’s passphrase wallet (it may be one of the keys above)'"));
ck('…the button appears once the box is ticked, labelled for the passphrase wallet', card.includes('(tzPpOffer && _psbtTzPp.on)') && card.includes("'Sign with Trezor (passphrase wallet)'"));
const render = fn('async function _psbtTzPpRender');
ck('the box: typed twice, Show/Hide, or the Passphrase Library (read only)', render.includes("'psbt-tz-pp-input'") && render.includes("'psbt-tz-pp-confirm'") && render.includes("'psbt-tz-pp-eye'") && render.includes('os.listPassphrases()') && render.includes('os.loadPassphrase(sel.value)') && !render.includes('savePassphrase'));
ck('…filled in once with the passphrase applied on the Dashboard', render.includes('os.getPassphrase()') && render.includes("'Filled in with the passphrase applied on the Dashboard.'"));
ck('…says what SafeKeep checks, and that passphrase protection must be on', render.includes('checks the Trezor first by its standard wallet, then opens the passphrase wallet and signs only if it is one of this transaction’s keys'));
const sign = fn('async function psbtCosignTrezor');
ck('signing refuses an unconfirmed passphrase before touching the Trezor', sign.indexOf('if (tzPassphrase === null || _psbtTzPpProblem())') < sign.indexOf('tzEnsureUnlocked'));
ck('…sends it with the transaction, and names the passphrase wallet that signed', sign.includes('os.trezorSign(_psbtSignedBytes, tzPassphrase)') && sign.includes("' (its passphrase wallet ' + r.passphraseXfp + ')'"));
ck('…and forgets it once the Trezor has signed', sign.includes('_psbtTzPpReset();   // forget the passphrase once it has signed'));
ck('a new transaction forgets it too', fn('function psbtResetToIngest').includes('_psbtTzPpReset();') && fn('async function psbtDoSign').includes('_psbtTzPpReset();'));

console.log('\n3. The bridge and the helper');
const ts = bridge.slice(bridge.indexOf('async function trezorSign'), bridge.indexOf('async function trezorXpub'));
ck('trezorSign sends a passphrase only when one is given', ts.includes("if (typeof passphrase === 'string' && passphrase !== '') req.passphrase = passphrase;") && ts.includes('r.passphraseXfp'));
ck('the helper: 50-byte limit, NFKD, no control characters', helper.includes('PASSPHRASE_MAX_BYTES = 50') && helper.includes("unicodedata.normalize('NFKD', v)"));
ck('the helper checks the pairing on the standard wallet before the passphrase session', helper.indexOf("if got_xfp != pairing['xfp']:") < helper.indexOf('client = hwi.client(path, passphrase)'));
ck('…refuses when passphrase protection is off, and a passphrase wallet that isn\'t one of the keys', helper.includes("raise Fail('passphrase_off'") && helper.includes("raise Fail('wrong_passphrase'") && helper.includes('needed = psbt_fingerprints(tx)'));
ck('…overwrites the request before deleting it', helper.includes("f.write(b'\\0' * size)"));
ck('the dev build has a pretend Trezor for it', html.includes('trezorSign: async function (bytes, passphrase)'));

console.log('\n4. Single-signature transactions');
const netSrc = html.slice(html.indexOf('const PSBT_NETWORK = {'), html.indexOf('};', html.indexOf('const PSBT_NETWORK = {')) + 2);
const statusFns = new Function('window', [netSrc, fn('function _psbtHex'), fn('function _psbtPartialSigPubkeys'), fn('function _psbtGetDerivEntries'),
  fn('function _psbtMultisigStatus'), fn('function _psbtSingleSigStatus'), fn('function _psbtSigningStatus'),
  'return { single: _psbtSingleSigStatus, any: _psbtSigningStatus, multi: _psbtMultisigStatus };'].join('\n'))({ BtcMath: { btcSigner: btc } });
const H = 0x80000000;
const root = HDKey.fromMasterSeed(await bip39.mnemonicToSeed('legal winner thank year wave sausage worth useful legal winner thank yellow', ''));
const FP = (root.fingerprint >>> 0).toString(16).padStart(8, '0').toUpperCase();
function spend(kind) {
  const k = root.derive(kind === 'tr' ? "m/86'/0'/0'/0/0" : "m/84'/0'/0'/0/0");
  const pay = kind === 'tr' ? btc.p2tr(k.publicKey.slice(1)) : btc.p2wpkh(k.publicKey);
  const prev = new btc.Transaction({ allowUnknownOutputs: true });
  prev.addInput({ txid: new Uint8Array(32).fill(2), index: 0 });
  prev.addOutput({ script: pay.script, amount: 50000n });
  const tx = new btc.Transaction();
  const inp = { txid: prev.id, index: 0, witnessUtxo: { script: pay.script, amount: 50000n }, nonWitnessUtxo: prev.unsignedTx };
  if (kind === 'tr') { inp.tapInternalKey = k.publicKey.slice(1); inp.tapBip32Derivation = [[k.publicKey.slice(1), { hashes: [], der: { fingerprint: root.fingerprint >>> 0, path: [86 + H, H, H, 0, 0] } }]]; }
  else inp.bip32Derivation = [[k.publicKey, { fingerprint: root.fingerprint >>> 0, path: [84 + H, H, H, 0, 0] }]];
  tx.addInput(inp); tx.addOutput({ script: pay.script, amount: 40000n });
  return { tx, k };
}
const w = spend('wpkh'), t = spend('tr');
let st = statusFns.any(w.tx.toPSBT());
ck('Native SegWit single-sig: 1-of-1, not yet signed, its key named', st && st.single && st.required === 1 && st.signed === 0 && !st.complete && st.cosigners.length === 1 && st.cosigners[0].fp === FP, JSON.stringify(st));
st = statusFns.any(t.tx.toPSBT());
ck('Taproot single-sig: recognized from its Taproot key origin', st && st.single && st.cosigners[0].fp === FP && !st.complete, JSON.stringify(st));
w.tx.signIdx(w.k.privateKey, 0);
st = statusFns.any(w.tx.toPSBT());
ck('…after signing: complete', st && st.single && st.complete && st.signed === 1 && st.cosigners[0].signed, JSON.stringify(st));
t.tx.signIdx(t.k.privateKey, 0);
st = statusFns.any(t.tx.toPSBT());
ck('…Taproot after signing (key-path signature): complete', st && st.complete, JSON.stringify(st));
const noOrigin = new btc.Transaction(); const k0 = root.derive("m/84'/0'/0'/0/0"); const pay0 = btc.p2wpkh(k0.publicKey);
noOrigin.addInput({ txid: new Uint8Array(32).fill(3), index: 0, witnessUtxo: { script: pay0.script, amount: 1000n } }); noOrigin.addOutput({ script: pay0.script, amount: 500n });
ck('an input that names no key: not treated as single-sig (SafeKeep can\'t tell who signs)', statusFns.single(noOrigin.toPSBT()) === null);
// a 2-of-2 multisig still reads as multisig
const ka = root.derive("m/48'/0'/0'/2'/0/0"), kb = HDKey.fromMasterSeed(await bip39.mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '')).derive("m/48'/0'/0'/2'/0/0");
const ms = btc.p2wsh(btc.p2ms(2, [ka.publicKey, kb.publicKey].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)))));
const mtx = new btc.Transaction();
mtx.addInput({ txid: new Uint8Array(32).fill(4), index: 0, witnessUtxo: { script: ms.script, amount: 1000n }, witnessScript: ms.witnessScript,
  bip32Derivation: [[ka.publicKey, { fingerprint: root.fingerprint >>> 0, path: [48 + H, H, H, 2 + H, 0, 0] }], [kb.publicKey, { fingerprint: 0x73c5da0a, path: [48 + H, H, H, 2 + H, 0, 0] }]] });
mtx.addOutput({ script: ms.script, amount: 500n });
st = statusFns.any(mtx.toPSBT());
ck('a multisig spend still reads as multisig (2 of 2, not single)', st && !st.single && st.required === 2 && st.cosigners.length === 2 && statusFns.single(mtx.toPSBT()) === null, JSON.stringify(st));
const cardSrc = fn('async function _psbtUpdateCosignCard');
ck('the co-signing card, the device check and both sign buttons use the combined status', (html.match(/_psbtSigningStatus\(/g) || []).length >= 7 && cardSrc.includes('const st = _psbtSigningStatus(_psbtSignedBytes);') && fn('async function psbtCosignTrezor').includes('_psbtSigningStatus(r.psbtBytes)') && fn('async function psbtCosignColdcard').includes('_psbtSigningStatus(r.psbtBytes)'));
ck('a single-sig spend SafeKeep signed itself shows no card (as before)', cardSrc.includes("if (st.single && st.complete && !_psbtHwMode && !(_psbtCosignMessage && _psbtCosignMessage.kind === 'success'))"));
ck('single-sig title', cardSrc.includes("'Signature: not yet signed (single signature)'"));
ck('hardware-only mode: with a passphrase, the Trezor\'s standard wallet needn\'t be one of the keys (the helper checks the passphrase wallet)', fn('async function _psbtHwConfirmAndPair').includes("const viaPassphrase = kind === 'trezor' && _psbtTzPp.on;") && fn('async function _psbtHwConfirmAndPair').includes('if (!c && !viaPassphrase)'));

console.log('\n5. Parsing');
for (const name of ['function _psbtSingleSigStatus', 'function _psbtSigningStatus', 'async function _psbtHwConfirmAndPair', 'async function psbtCosignColdcard', 'function _psbtTzPpReset', 'function _psbtTzPpValue', 'function _psbtTzPpProblem', 'async function _psbtTzPpRender', 'function _psbtTzPpRefreshNote', 'async function _psbtUpdateCosignCard', 'async function psbtCosignTrezor']) {
  let ok = true, err = '';
  try { new Function(fn(name).replace(/^async function/, 'return async function').replace(/^function/, 'return function')); } catch (x) { ok = false; err = x.message; }
  ck(`${name.replace(/^(async )?function /, '')} parses`, ok, err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

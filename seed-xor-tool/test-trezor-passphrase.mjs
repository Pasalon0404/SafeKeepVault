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
 *   4. The new functions parse.
 *
 * Run:  node test-trezor-passphrase.mjs
 */
import { readFileSync } from 'node:fs';

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

console.log('\n4. Parsing');
for (const name of ['function _psbtTzPpReset', 'function _psbtTzPpValue', 'function _psbtTzPpProblem', 'async function _psbtTzPpRender', 'function _psbtTzPpRefreshNote', 'async function _psbtUpdateCosignCard', 'async function psbtCosignTrezor']) {
  let ok = true, err = '';
  try { new Function(fn(name).replace(/^async function/, 'return async function').replace(/^function/, 'return function')); } catch (x) { ok = false; err = x.message; }
  ck(`${name.replace(/^(async )?function /, '')} parses`, ok, err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

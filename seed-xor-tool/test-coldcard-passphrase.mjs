/**
 * test-coldcard-passphrase.mjs — Device Options → Coldcard → Send a
 * Passphrase to the Coldcard
 *
 * The helper (safekeep-coldcard.py "passphrase", against a fake Coldcard)
 * is tested by usbbootdrive/tests/test-coldcard-helper.py. This checks:
 *   1. The character rule matches the Coldcard firmware and the helper
 *      (1–99 printable ASCII), run for real.
 *   2. The expected fingerprint is worked out correctly (run for real with
 *      the same libraries as the app).
 *   3. The bridge, the panel, and the safety wording.
 *   4. Every ccpp_ function parses.
 *
 * Run:  node test-coldcard-passphrase.mjs
 */
import { readFileSync } from 'node:fs';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const read = (u) => readFileSync(new URL(u, import.meta.url), 'utf8');
const html = read('./boot.html');
const bridge = read('./shared/boot.js');
const helper = read('../usbbootdrive/safekeep-coldcard.py');
const boot = read('../usbbootdrive/safekeep-boot.sh');
const fn = (name) => { const a = html.indexOf(name); return a < 0 ? '' : html.slice(a, html.indexOf('\n}\n', a)); };

console.log('\n1. Which passphrases the Coldcard takes');
const problem = new Function('CCPP_RE', fn('function _ccppProblem') + '\n}\nreturn _ccppProblem;')(/^[\x20-\x7e]{1,99}$/);
ck('plain letters, digits, spaces and US-keyboard symbols: fine', problem(' Savings 2026! ~`{}|<>"\'\\') === '');
ck('99 characters: fine', problem('x'.repeat(99)) === '');
ck('100 characters: too long', /Too long/.test(problem('x'.repeat(100))));
ck('an accented letter is named', /“é”/.test(problem('café')));
ck('a tab and a new line are named', /Tab/.test(problem('a\tb')) && /new line/.test(problem('a\nb')));
ck('an emoji is refused', problem('wallet 🔑') !== '');
ck('the app, the bridge and the helper use the same rule', html.includes('var CCPP_RE = /^[\\x20-\\x7e]{1,99}$/;') && bridge.includes('/^[\\x20-\\x7e]{1,99}$/.test(passphrase)') && helper.includes("PASSPHRASE_RE = re.compile(r'^[\\x20-\\x7e]{1,99}$')"));

console.log('\n2. The expected fingerprint');
globalThis.window = { BtcMath: { bip39, HDKey } };
const fpFn = new Function(fn('async function _ccppFingerprint').replace(/^async function/, 'return async function') + '\n}')();
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
ck('no passphrase: the known fingerprint 73C5DA0A', await fpFn(ABANDON, '') === '73C5DA0A');
const direct = (HDKey.fromMasterSeed(await bip39.mnemonicToSeed(ABANDON, 'TREZOR')).fingerprint >>> 0).toString(16).padStart(8, '0').toUpperCase();
ck('with a passphrase: the BIP-32 fingerprint of the passphrase seed', await fpFn(ABANDON, 'TREZOR') === direct && direct !== '73C5DA0A', direct);
ck('a space matters', await fpFn(ABANDON, 'TREZOR ') !== direct);
ck('the new wallet\'s fingerprint is read from the xpub the Coldcard returns', fn('async function ccpp_send').includes('HDKey.fromExtendedKey(r.xpub).fingerprint'));
ck('the check is made only when the Coldcard was on SafeKeep\'s seed', fn('async function ccpp_send').includes('if (base && r.xfpBefore === base && expect)'));

console.log('\n3. Bridge, OS and panel');
ck('coldcardSendPassphrase is exported and waits up to 11 minutes', /coldcardDetect,\s*coldcardSendPassphrase,/.test(bridge) && bridge.includes("_coldcardRequest({ action: 'passphrase', passphrase }, 11 * 60 * 1000)"));
ck('the helper overwrites the request before deleting it', helper.includes("f.write(b'\\0' * size)") && helper.includes('os.fsync(f.fileno())'));
ck('the helper checks authenticity first, against the paired key when it is the paired Coldcard', helper.includes("anchor = pairing['master_xpub'] if pairing and pairing['xfp'] == xfp_before else None") && helper.indexOf('dev.check_mitm(expected_xpub=anchor)') < helper.indexOf('P.bip39_passphrase(pw)'));
ck('the Coldcard Watcher documents the action', boot.includes('| "passphrase" | "seed", "request_id": ... }'));
ck('the panel sits in Device Options → Coldcard', html.indexOf('id="ccpp-block"') > html.indexOf('id="settings-coldcard-section"') && html.indexOf('id="ccpp-block"') < html.indexOf('id="settings-trezor-section"'));
ck('the Passphrase Library has no Coldcard button (it stays general): one Send button, in Device Options', (html.match(/onclick="ccpp_(send|open)\(\)"/g) || []).length === 2 && html.indexOf('onclick="ccpp_open()"') > html.indexOf('id="ccpp-block"'));
ck('two sources: typed (twice) or the Passphrase Library (read only)', html.includes('value="type" checked onchange="ccpp_setSource(\'type\')"> Type a passphrase') && html.includes("Choose from the Passphrase Library") && html.includes('id="ccpp-pass2"') && fn('async function ccpp_setSource').includes('os.listPassphrases()') && fn('async function ccpp_pickLibrary').includes('os.loadPassphrase(slug)'));
ck('Send stays off until the two entries match', fn('function ccpp_check').includes("'The two entries don’t match.'") && fn('function ccpp_check').includes("_ccppEl('ccpp-send').disabled = !ok || _ccpp.busy;"));
ck('a space at the start or end is pointed out', fn('function ccpp_check').includes('It starts or ends with a space.'));
ck('saving to the library is optional, off by default, needs a nickname', html.includes('<input type="checkbox" id="ccpp-save" onchange="ccpp_check()"> Also save it in the Passphrase Library') && fn('function ccpp_check').includes('Give it a nickname'));
ck('the steps on the Coldcard: check the length, 2 to see it, OK, 1 for Seed Vault', ['Check the length it shows:', 'Press <b>2</b> to see the passphrase itself', 'Press <b>OK</b> to switch to that wallet', 'press <b>1</b> to keep this wallet there'].every((t) => html.includes(t)));
ck('start from the main wallet, and keep a written copy', html.includes('Start from the Coldcard&rsquo;s main wallet') && fn('async function ccpp_send').includes('Keep a written copy of the passphrase'));
ck('closing forgets the passphrase', fn('function ccpp_close').includes("['ccpp-pass', 'ccpp-pass2', 'ccpp-nick'].forEach(function (id) { _ccppEl(id).value = ''; });") && fn('function ccpp_close').includes("_ccpp.libPass = ''"));
ck('…and a successful send closes and reopens the panel empty', fn('async function ccpp_send').includes('ccpp_close();                 // forget the passphrase'));
ck('not in the online demo', fn('function ccpp_open').includes('if (_skvDemoActive())') && fn('async function ccSettingsRefresh').includes('ccppBlock.hidden = _skvDemoActive()'));
ck('hidden rows stay hidden (a flex row would override [hidden])', html.includes('.ccpp-panel [hidden], #ccpp-block[hidden], #ccsd-block[hidden], #desc-ms-custody[hidden] { display: none !important; }'));
ck('the dev build has a pretend Coldcard for it', html.includes('coldcardSendPassphrase: async function (pw)'));
ck('American English: "check", no "tick"', !/\b[Tt]ick/.test(html.slice(html.indexOf('id="ccpp-block"'), html.indexOf('id="settings-trezor-section"'))));

console.log('\n4. Every ccpp_ function parses');
const names = [...html.matchAll(/\n((?:async )?function (?:ccpp_|_ccpp)\w+)\(/g)].map((m) => m[1]);
ck('there are ccpp_ functions', names.length >= 10, names.length);
for (const name of names) {
  let ok = true, err = '';
  try { new Function(fn(name + '(').replace(/^async function/, 'return async function').replace(/^function/, 'return function') + '\n}'); } catch (x) { ok = false; err = x.message; }
  ck(`${name.replace(/^(async )?function /, '')} parses`, ok, err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

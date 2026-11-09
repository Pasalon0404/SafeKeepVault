/**
 * test-coldcard-seed.mjs — Device Options → Coldcard → Send a Seed to the
 * Coldcard, and the order of the Coldcard and Trezor sections
 *
 * The helper (safekeep-coldcard.py "seed": the one-seed backup decoded the
 * way the firmware does, the plaintext + temporary flags, against a fake
 * Coldcard) is tested by usbbootdrive/tests/test-coldcard-helper.py. This
 * checks the app side:
 *   1. Device Options keeps every Coldcard feature together, then Trezor.
 *   2. The bridge and the helper accept 12, 18 or 24 words only.
 *   3. The panel: sources, checks, steps, Check the Coldcard, clean-up.
 *   4. Every ccsd_ function parses.
 *
 * Run:  node test-coldcard-seed.mjs
 */
import { readFileSync } from 'node:fs';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const read = (u) => readFileSync(new URL(u, import.meta.url), 'utf8');
const html = read('./boot.html');
const bridge = read('./shared/boot.js');
const helper = read('../usbbootdrive/safekeep-coldcard.py');
const fn = (name) => { const a = html.indexOf(name); return a < 0 ? '' : html.slice(a, html.indexOf('\n}\n', a)); };
const at = (id) => html.indexOf(`id="${id}"`);

console.log('\n1. Device Options: Coldcard features together, then Trezor');
ck('Coldcard (pair, passphrase, seed), then Import from a COLDCARD backup, then Trezor',
  at('settings-coldcard-section') < at('ccpp-block') && at('ccpp-block') < at('ccsd-block') && at('ccsd-block') < at('settings-ccb-section') && at('settings-ccb-section') < at('settings-trezor-section'));
ck('nothing COLDCARD-related after the Trezor section', !/ccb_|ccpp_|ccsd_|ccSettings/.test(html.slice(at('settings-trezor-section'), at('settings-seed-section'))));
ck('the Import button keeps its id (the online demo hides it by id)', html.includes('<div id="settings-ccb-section"') && html.includes("['welcome-opt-coldcard', 'settings-ccb-section'].forEach"));

console.log('\n2. 12, 18 or 24 words only');
const re = /^(?:[0-9a-f]{32}|[0-9a-f]{48}|[0-9a-f]{64})$/;
for (const n of [12, 18, 24]) {
  const m = bip39.generateMnemonic(wordlist, n * 32 / 3);
  const hex = Buffer.from(bip39.mnemonicToEntropy(m, wordlist)).toString('hex');
  ck(`${n} words → ${hex.length / 2} bytes of entropy, accepted`, re.test(hex));
}
for (const n of [15, 21]) {
  const m = bip39.generateMnemonic(wordlist, n * 32 / 3);
  const hex = Buffer.from(bip39.mnemonicToEntropy(m, wordlist)).toString('hex');
  ck(`${n} words: refused (a Coldcard can't store them)`, !re.test(hex));
}
ck('the app, the bridge and the helper use the same rule', html.includes('var CCSD_WORD_COUNTS = [12, 18, 24];') && bridge.includes('/^(?:[0-9a-f]{32}|[0-9a-f]{48}|[0-9a-f]{64})$/.test(entropyHex)') && helper.includes("ENTROPY_RE = re.compile(r'^(?:[0-9a-f]{32}|[0-9a-f]{48}|[0-9a-f]{64})$')"));
ck('coldcardSendSeed is exported; the seed travels as its entropy', /coldcardSendPassphrase,\s*coldcardSendSeed,/.test(bridge) && bridge.includes("_coldcardRequest({ action: 'seed', entropy_hex: entropyHex }, 60000)") && fn('async function ccsd_send').includes('btc.bip39.mnemonicToEntropy(mn, btc.wordlist)'));
ck('the helper loads it as a TEMPORARY seed from a plaintext backup', helper.includes('P.restore_backup(length, sha, custom_pwd=False, plaintext=True, tmp=True)'));

console.log('\n3. The panel');
ck('two sources: SafeKeep\'s Seed Vault, or typed/scanned words', html.includes('value="vault" onchange="ccsd_setSource(\'vault\')"> From SafeKeep&rsquo;s Seed Vault') && html.includes("Type or scan the words") && html.includes('onclick="ccsd_startScan()">Scan a SeedQR'));
ck('Seed Vault seeds the Coldcard can\'t store are listed but disabled', fn('async function ccsd_open').includes("(the Coldcard can’t store ' + n + ' words)") && fn('async function ccsd_open').includes('o.disabled = !ok;'));
ck('no Seed Vault choice when SafeKeep\'s Seed Vault is off (Temporary Session, seed storage off)', fn('async function ccsd_open').includes("_ccsdEl('ccsd-src-vault-label').hidden = !avail;"));
ck('the words must be a valid seed; the fingerprint is shown before sending', fn('async function ccsd_check').includes('btc.bip39.validateMnemonic(mn, btc.wordlist)') && fn('async function ccsd_check').includes("'Seed fingerprint ' + fp"));
ck('the steps name the Coldcard\'s own prompts and the fingerprint to check', html.includes('&ldquo;Restore uploaded backup as a temporary seed?&rdquo; Press <b>OK</b>.') && html.includes('check it is <b id="ccsd-step-fp"></b>') && html.includes('press <b>1</b> to keep the seed there'));
ck('…and say how the Coldcard goes back to its own seed', html.includes('until you switch back in its Seed Vault menu or turn it off and on'));
const verify = fn('async function ccsd_verify');
ck('Check the Coldcard reads which wallet it is using, and tells the three cases apart', verify.includes('os.coldcardDetect()') && verify.includes('d.xfp === _ccsd.sentFp') && verify.includes('d.xfp === _ccsd.before') && verify.includes('not the seed you sent'));
ck('the words are cleared once sent; closing clears everything and stops the camera', fn('async function ccsd_send').includes('_ccsd.boxes.clear()') && fn('function ccsd_close').includes('ccsd_stopScan();') && fn('function ccsd_close').includes('_ccsd.boxes.destroy()'));
ck('not in the online demo', fn('async function ccsd_open').includes('if (_skvDemoActive())') && fn('async function ccSettingsRefresh').includes('ccsdBlock.hidden = _skvDemoActive()'));
ck('the dev build has a pretend Coldcard for it', html.includes('coldcardSendSeed: async function (entropyHex)'));
ck('American English: no "tick" in the Coldcard sections', !/\b[Tt]ick/.test(html.slice(at('settings-coldcard-section'), at('settings-trezor-section'))));

console.log('\n4. Every ccsd_ function parses');
const names = [...html.matchAll(/\n((?:async )?function (?:ccsd_|_ccsd)\w+)\(/g)].map((m) => m[1]);
ck('there are ccsd_ functions', names.length >= 10, names.length);
for (const name of names) {
  let ok = true, err = '';
  try { new Function(fn(name + '(').replace(/^async function/, 'return async function').replace(/^function/, 'return function') + '\n}'); } catch (x) { ok = false; err = x.message; }
  ck(`${name.replace(/^(async )?function /, '')} parses`, ok, err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

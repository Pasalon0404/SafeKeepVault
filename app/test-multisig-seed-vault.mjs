/**
 * test-multisig-seed-vault.mjs — Output Descriptor's multisig builder with
 * keys from SafeKeep's Seed Vault, the "keys in one place" warning, and
 * the Coldcard naming tips
 *
 *   1. The warning runs for real: shown when this vault holds M keys or
 *      more (Key 1 plus any Seed Vault seed, picked or pasted), with how
 *      many keys to keep elsewhere; hidden otherwise.
 *   2. The builder: a Seed Vault button per cosigner slot (only when the
 *      Seed Vault is on), the seed in use isn't offered, picked keys follow
 *      the address type, the warning is cleared for single-sig.
 *   3. Coldcard: the firmware names Seed Vault entries by fingerprint and
 *      the USB commands carry no name, so SafeKeep says how to rename the
 *      entry on the Coldcard and suggests the name.
 *   4. The new functions parse.
 *
 * Run:  node test-multisig-seed-vault.mjs
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
const fn = (name) => { const a = html.indexOf(name); return a < 0 ? '' : html.slice(a, html.indexOf('\n}\n', a) + 2); };

console.log('\n1. The warning');
const box = { hidden: true, innerHTML: '', get textContent() { return this.innerHTML.replace(/<[^>]+>/g, ''); } };
const vault = [{ name: 'Mom', fingerprint: 'B8688DF1' }, { name: 'Spare', fingerprint: '73C5DA0A' }];
const custody = new Function('document', 'window', '_wrecEscape', fn('async function _descMsCustody') + '\nreturn _descMsCustody;')(
  { getElementById: () => box }, { SafeKeepOS: { loadSeedVault: async () => vault } }, (t) => t);
const K = (fp) => '[' + fp + "/48'/0'/0'/2']xpub6Fake";
await custody([K('5436d724'), K('b8688df1'), K('11111111')], 2);
ck('2-of-3, Key 1 and a Seed Vault seed here: warns that 2 are enough to spend', !box.hidden && /holds 2 of the 3 keys, and 2 are enough to spend/.test(box.textContent) && /Key 2 \(Mom\)/.test(box.textContent));
ck('…and says to keep at least one elsewhere (another device or a Coldcard)', /keep at least one of these keys only somewhere else: another device, or a Coldcard/.test(box.textContent));
await custody([K('5436d724'), K('b8688df1'), K('73c5da0a')], 2);
ck('all 3 keys here: "All 3 keys of this wallet are in this vault", keep at least 2 elsewhere', /All 3 keys of this wallet are in this vault\./.test(box.textContent) && /keep at least 2 of these keys/.test(box.textContent));
await custody([K('5436d724'), K('22222222'), K('11111111')], 2);
ck('only Key 1 here in a 2-of-3: no warning', box.hidden && box.innerHTML === '');
await custody([K('5436d724'), K('B8688DF1'), K('11111111')], 3);
ck('3-of-3 with 2 keys here: no warning (the vault alone can\'t spend)', box.hidden);
ck('a pasted key counts too (matched by fingerprint, any case)', (await custody([K('5436d724'), K('B8688DF1'), K('11111111')], 2), !box.hidden));
ck('the warning box sits at the top of the result, and single-sig clears it', html.includes('<div id="desc-ms-custody" class="psbt-alert warning" role="alert" hidden') && fn('async function desc_generate()').includes("if (custodyBox) { custodyBox.hidden = true; custodyBox.innerHTML = ''; }") && /#desc-ms-custody\[hidden\][^{]*\{ display: none !important; \}/.test(html));
ck('the multisig path runs it before showing the result', fn('async function desc_generateMulti').includes('await _descMsCustody(keyOrigins, m);'));

console.log('\n2. The builder');
const render = fn('function desc_renderCosignerInputs');
ck('each cosigner slot gets a Seed Vault button, only when the Seed Vault is on', render.includes("var svOn = typeof _svAvailable === 'function' && _svAvailable();") && render.includes('onclick="desc_msPickSeedVault(\' + i + \')"'));
ck('the seed in use (Key 1) is listed but can\'t be picked', fn('async function desc_msPickSeedVault').includes("o.disabled = e.mnemonic === inUse;"));
ck('a picked seed gives the same key origin as Key 1 would (no passphrase)', fn('async function desc_msUseSeedVault').includes("await _descLocalKeyOrigin(e.mnemonic, '', addrType)"));
ck('picked keys follow the address type; a key changed by hand is left alone', fn('function desc_updateMsAddrType').includes('desc_msRefreshSeedVaultKeys();') && fn('async function desc_msRefreshSeedVaultKeys').includes("if (!input || input.value.trim() !== pick.origin || !e) { delete _descMsSv[idx]; continue; }"));
ck('the same seed twice is still refused by the builder', fn('async function desc_generateMulti').includes('are the same key. Each cosigner needs its own seed'));

console.log('\n3. Coldcard names');
ck('Send a Seed: rename tip with the fingerprint, suggesting the SafeKeep name', html.includes('<li id="ccsd-step-name">The Coldcard names it by its fingerprint.') && fn('async function ccsd_send').includes("', and type ' + nameSug.slice(0, 40) + ' (its name in SafeKeep)'"));
ck('Send a Passphrase: rename tip, suggesting the library or saved nickname', fn('async function ccpp_send').includes('(the Coldcard names entries by fingerprint)') && fn('async function ccpp_send').includes("_ccpp.source === 'library'"));

console.log('\n4. Parsing');
for (const name of ['async function desc_msPickSeedVault', 'async function desc_msUseSeedVault', 'async function desc_msRefreshSeedVaultKeys', 'async function _descMsCustody', 'async function ccsd_send', 'async function ccpp_send']) {
  let ok = true, err = '';
  try { new Function(fn(name).replace(/^async function/, 'return async function')); } catch (x) { ok = false; err = x.message; }
  ck(`${name.replace(/^async function /, '')} parses`, ok, err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

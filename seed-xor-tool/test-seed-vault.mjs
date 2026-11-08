/**
 * test-seed-vault.mjs — Seed Vault: other seeds beside the master seed
 *
 * The OS side (the Seed Vault Watcher, run for real) is tested by
 * usbbootdrive/tests/test-seed-vault-watcher.py. This checks:
 *   1. The bridge: the list rules (run for real, the same as the watcher's),
 *      where it's stored, when it's off, Back to Master Seed.
 *   2. Seed Management's Seed Vault card: add (typed, scanned, the
 *      temporary seed), rename, show words, delete, the 20-seed limit.
 *   3. Switching: the Dashboard's Seed Vault button, the banner, the
 *      passphrase cleared, the labels, Back to Master Seed.
 *   4. COLDCARD backups: ticked Seed Vault entries are kept.
 *   5. Every sv_ function parses.
 *
 * Run:  node test-seed-vault.mjs
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const read = (u) => readFileSync(new URL(u, import.meta.url), 'utf8');
const html = read('./boot.html');
const bridge = read('./shared/boot.js');
const boot = read('../usbbootdrive/safekeep-boot.sh');
const fn = (name) => { const a = html.indexOf(name); return a < 0 ? '' : html.slice(a, html.indexOf('\n}\n', a)); };
const bfn = (name) => { const a = bridge.indexOf(name); return a < 0 ? '' : bridge.slice(a, bridge.indexOf('\n  }\n', a) + 4); };

const A = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const B = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

console.log('\n1. The bridge');
// Run _cleanSeedVault for real.
const clean = new Function('SEED_VAULT_MAX', 'SEED_VAULT_WORD_COUNTS', bfn('function _cleanSeedVault') + '\nreturn _cleanSeedVault;')(20, [12, 15, 18, 21, 24]);
const e = (name, mnemonic, fingerprint, added) => ({ name, mnemonic, fingerprint, added });
const ok = clean([e(' Mum ', '  LEGAL winner thank year wave sausage worth useful legal winner thank yellow ', 'b8688df1', '2026-11-08'), e('Old', B, '73C5DA0A')]);
ck('a good list: names trimmed, words lower-cased and single-spaced, fingerprints upper-cased', ok && ok[0].name === 'Mum' && ok[0].mnemonic === A && ok[0].fingerprint === 'B8688DF1' && ok[1].added === '', JSON.stringify(ok));
ck('an empty list is allowed (it removes the file)', Array.isArray(clean([])) && clean([]).length === 0);
const words20 = 'able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress'.split(' ');
ck('20 seeds: allowed', clean(words20.slice(0, 20).map((w, i) => e('S' + i, Array(12).fill(w).join(' '), '00000000'))) !== null);
ck('21 seeds: refused', clean(words20.map((w, i) => e('S' + i, Array(12).fill(w).join(' '), '00000000'))) === null);
for (const [why, list] of [
    ['no name', [e('  ', A, '00000000')]],
    ['a 41-character name', [e('x'.repeat(41), A, '00000000')]],
    ['a control character in the name', [e('a\nb', A, '00000000')]],
    ['11 words', [e('a', A.split(' ').slice(0, 11).join(' '), '00000000')]],
    ['a word with a digit', [e('a', A.replace('legal', 'leg4l'), '00000000')]],
    ['a bad fingerprint', [e('a', A, 'XYZ')]],
    ['one name twice (any case)', [e('Mum', A, '00000000'), e('MUM', B, '00000000')]],
    ['the same words twice', [e('a', A, '00000000'), e('b', A, '00000000')]],
    ['not a list', 'nope'],
]) ck(`${why}: refused`, clean(list) === null);
ck('stored beside the master seed as seeds/seed-vault.json, sent as SEED_VAULT.json', bridge.includes("const SEED_VAULT_FILE = 'SEED_VAULT.json';") && bridge.includes("`${MASTER_SEED_URL.replace(MASTER_SEED_FILE, '')}seed-vault.json`"));
ck('the watcher has the same rules (20 seeds, 40-character names, 12–24 words, 8-hex fingerprints)', boot.includes('MAX_BYTES, MAX_SEEDS = 65536, 20') && boot.includes('len(name.strip()) > 40') && boot.includes("len(words.split(' ')) not in (12, 15, 18, 21, 24)") && boot.includes("re.fullmatch(r'[0-9A-Fa-f]{8}', fp)"));
ck('SEED_VAULT is vault data, not a system file: it is written only with the vault verified', !/_SYSTEM_TRIGGER_PREFIXES = \[[^\]]*SEED_VAULT/.test(bridge));
ck('off in a Temporary Session and on a flash drive that doesn\'t keep the seed', bfn('function seedVaultAvailable').includes('if (_ccTemporarySession()) return false;') && bfn('function seedVaultAvailable').includes('return _keepSeed !== false;'));
ck('saveSeedVault refuses in both cases, and waits for the watcher to confirm', bfn('async function saveSeedVault').includes("'A Temporary Session has no vault to keep seeds in.'") && bfn('async function saveSeedVault').includes('_keepSeed === false') && bfn('async function saveSeedVault').includes('for (let i = 0; i < 16; i++)'));
ck('reloadMasterSeed reads master-seed.json again and makes it the default session seed', bfn('async function reloadMasterSeed').includes('fetch(MASTER_SEED_URL') && bfn('async function reloadMasterSeed').includes('default: true'));
ck('all four are exported', /seedVaultAvailable, loadSeedVault, saveSeedVault, reloadMasterSeed/.test(bridge.replace(/\s+/g, ' ')));
ck('the dev build has a pretend Seed Vault', html.includes('var _devSeedVault = [];'));

console.log('\n2. Seed Management\'s Seed Vault card');
ck('the card sits in Seed Management, outside the printable seed page', html.includes('<div class="skb-card arm-no-print" id="sv-card"'));
ck('opening Seed Management draws it', /state-armory[\s\S]{0,600}sv_render\(\);/.test(html));
ck('Add a Seed: name, 12 or 24 standard word boxes, Scan a SeedQR', ['id="sv-add-name" maxlength="40"', 'onclick="sv_setLength(12)"', 'onclick="sv_setLength(24)"', 'onclick="sv_startScan()"'].every((t) => html.includes(t)) && fn('function sv_setLength').includes('SF.createWordBoxes(') && fn('function sv_setLength').includes('wordlist: SF.wordlists.bip39'));
ck('…the words must be a valid seed (checksum)', fn('async function sv_saveAdd').includes('btc.bip39.validateMnemonic(mnemonic, btc.wordlist)'));
ck('…not one already kept, and not the master seed', fn('async function sv_saveAdd').includes('This seed is already in the Seed Vault.') && fn('async function sv_saveAdd').includes('it’s already kept in this vault.'));
ck('…its fingerprint is the seed\'s own (no passphrase)', fn('async function sv_saveAdd').includes('await _recoveryFingerprint(mnemonic)'));
ck('Keep the Temporary Seed Here: shown only with a temporary seed loaded on a normal boot', html.includes('id="sv-keep-temp-btn" hidden onclick="sv_openAdd(true)"') && fn('async function sv_render').includes("getElementById('sv-keep-temp-btn').hidden = !(_vaultVolatile && !temp"));
ck('names: 1–40 characters, no control characters, unique in any case', fn('function _svNameOk').includes('name.length > 40') && fn('function _svNameOk').includes('.toLowerCase() === name.toLowerCase()'));
ck('the 20-seed limit: count shown, Add disabled at 20', fn('async function sv_render').includes("_svList.length + ' of 20'") && fn('async function sv_render').includes("getElementById('sv-add-btn').disabled = _svList.length >= 20"));
ck('Show words asks first (nobody and no camera can see the screen)', fn('async function sv_render').includes("'confirm-words'") && fn('async function sv_render').includes('Make sure nobody and no camera can see the screen.'));
ck('Delete asks first, and warns without a written backup the wallet is lost', fn('async function sv_render').includes('Without a written backup of its words, that wallet is lost.'));
ck('the seed in use can\'t be deleted', fn('async function sv_delete').includes('This seed is in use. Switch back to the master seed first.'));
ck('renaming the seed in use updates the session label', fn('async function sv_rename').includes('label: SV_PREFIX + name'));
ck('off: says why (Temporary Session / seed storage off) and hides the buttons', fn('async function sv_render').includes('A Temporary Session has no vault, so the Seed Vault is off.') && fn('async function sv_render').includes('so the Seed Vault is off.') && fn('async function sv_render').includes("getElementById('sv-main-actions').hidden = !avail"));
ck('names and words are escaped when drawn', fn('async function sv_render').includes('_svEsc(e.name)') && fn('async function sv_render').includes('_svEsc(w)'));
ck('closing the form stops the camera and clears the word boxes', fn('function sv_closeAdd').includes('sv_stopScan();') && fn('function sv_closeAdd').includes('_svBoxes.destroy()'));

console.log('\n3. Switching');
ck('the Dashboard has a Seed Vault button and menu (shown once a seed is kept)', html.includes('id="dashv2-switch-btn" hidden aria-expanded="false" aria-controls="dashv2-switcher" onclick="sv_toggleSwitcher()">Seed Vault &#9662;</button>') && fn('async function sv_refreshSwitcher').includes('btn.hidden = !_svList.length && !sv_activeName();'));
ck('…the menu lists Master Seed and every stored seed, marking the one in use', fn('function sv_toggleSwitcher').includes('onclick="sv_backToMaster()"><span>Master Seed') && fn('function sv_toggleSwitcher').includes("aria-current=\"true\"") && fn('function sv_toggleSwitcher').includes("onclick=\"sv_use(' + i + ')\""));
ck('the Dashboard refreshes it after every seed change', /function transitionToDashboard[\s\S]*?sv_refreshSwitcher\(\)/.test(html));
const act = fn('function _svActivate');
ck('switching clears any applied passphrase first', act.indexOf('dash_clearPassphrase()') >= 0 && act.indexOf('dash_clearPassphrase()') < act.indexOf('SeedSession.set'));
ck('…labels the session "Seed Vault: <name>", not the default seed', fn('async function sv_use').includes('SV_PREFIX + e.name') && act.includes("default: label === 'Master Seed'"));
ck('…lifts a temporary seed\'s lock-down (the vault is in use again)', act.includes('_vaultVolatile = false') && act.includes('_updateVolatileFirewall()'));
ck('…and redraws through transitionToDashboard', act.includes('transitionToDashboard({ mnemonic: seed.mnemonic'));
ck('the banner says which seed is in use, with Back to Master Seed', html.includes('id="sv-banner" role="status" hidden') && html.includes('onclick="sv_backToMaster()"') && fn('function sv_syncBanner').includes('banner.hidden = !name;'));
ck('…kept in step with the seed status', /function _globalSeedStatusUpdate[\s\S]*?sv_syncBanner\(\)/.test(html));
ck('Back to Master Seed reads it again; if it can\'t, says to lock and unlock', fn('async function sv_backToMaster').includes('os.reloadMasterSeed()') && fn('async function sv_backToMaster').includes('Lock and unlock the vault to return to it.'));
ck('the wallet card and Seed Management name the stored seed', html.includes("'Seed Vault \\u00b7 ' + svName") && html.includes("armTitle.textContent = sv_activeName() ? 'Seed Vault: ' + sv_activeName()"));

console.log('\n4. COLDCARD backups');
const review = fn('function _ccbRenderReview');
ck('Seed Vault entries with words get a "keep" tick when the Seed Vault is on', review.includes('class="ccb-sv-pick"') && review.includes("var canKeepSeeds = canStore && typeof _svAvailable === 'function' && _svAvailable();"));
ck('…the old "SafeKeep keeps one seed per vault" text is gone', !html.includes('SafeKeep keeps one seed per vault'));
ck('…ticks survive a redraw', review.includes("#ccb-review .ccb-sv-pick').forEach"));
ck('Import keeps the ticked seeds, and accepts seeds alone', fn('async function ccb_importSelected').includes("_ccbPicked('ccb-sv-pick', s.seedVaultItems)") && fn('async function ccb_importSelected').includes('!svPicks.length') && fn('async function ccb_importSelected').includes('await sv_addFromColdcard(svPicks)'));
ck('Restore keeps them too (normal boot), except the seed being restored', fn('async function ccb_restore').includes('.filter(function (e) { return e.mnemonic !== chosen.mnemonic; })') && fn('async function ccb_restore').includes('note += await sv_addFromColdcard(svPicks);'));
const add = fn('async function sv_addFromColdcard');
ck('a name already used gets " (COLDCARD)", then a number; seeds already kept and the master seed are skipped; 20 at most', add.includes("' (COLDCARD)'") && add.includes("' (' + (n++) + ')'") && add.includes('mn === master') && add.includes('list.length >= 20'));

console.log('\n5. Every sv_ function parses');
const names = [...html.matchAll(/\n((?:async )?function (?:sv_|_sv)\w+)\(/g)].map((m) => m[1]);
ck('there are sv_ functions', names.length >= 20, names.length);
for (const name of names) {
    let ok2 = true, err = '';
    try { new Function(fn(name + '(').replace(/^async function/, 'return async function').replace(/^function/, 'return function') + '\n}'); } catch (x) { ok2 = false; err = x.message; }
    ck(`${name.replace(/^(async )?function /, '')} parses`, ok2, err);
}
for (const id of ['sv-banner', 'sv-banner-name', 'sv-banner-fp', 'dashv2-switch-btn', 'dashv2-switcher', 'sv-card', 'sv-count', 'sv-off', 'sv-list', 'sv-main-actions', 'sv-add-btn', 'sv-keep-temp-btn', 'sv-add', 'sv-add-name', 'sv-add-words-wrap', 'sv-len-12', 'sv-len-24', 'sv-add-grid', 'sv-scan', 'sv-qr-reader', 'sv-add-temp-note', 'sv-add-temp-fp', 'sv-add-save', 'sv-status']) {
    const n = html.split(`id="${id}"`).length - 1;
    if (n !== 1) ck(`#${id} exists once`, false, n);
}
ck('every element the code uses exists once', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

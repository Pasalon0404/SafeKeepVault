/**
 * test-demo-mode.mjs — safeguards of the public online demo (shared/demo-mode.js).
 *
 * Checks that only the public demo seeds can become keys, entropy or the
 * active seed; that freshly generated seeds are swapped for a demo seed;
 * that the demo switch never turns on from the USB stick (file:); and that
 * the safeguards are wired into boot-entry.js, seed-session.js, the dev
 * mock in boot.html and the build (release must never carry the flag).
 *
 * Run: node test-demo-mode.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  DEMO_SEEDS, REFUSAL_MESSAGE, isDemoActive, isDemoSeed, normalizeMnemonic,
  replaceGenerated, wrapBip39,
} from './shared/demo-mode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dirname, f), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail = '') { ok ? pass++ : fail++; console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '   ' + detail : '')); }

const REAL_12 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const REAL_24 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote';

console.log('Demo seeds:');
check('one demo seed for each length (12, 15, 18, 21, 24)', JSON.stringify(Object.keys(DEMO_SEEDS)) === '["12","15","18","21","24"]');
for (const [n, m] of Object.entries(DEMO_SEEDS)) {
  const ent = bip39.mnemonicToEntropy(m, wordlist);
  check(`${n} words: valid BIP-39 and all-zero entropy`, bip39.validateMnemonic(m, wordlist) && ent.length === (Number(n) * 4) / 3 && ent.every(b => b === 0));
}
check('isDemoSeed: demo seed', isDemoSeed(DEMO_SEEDS[24]));
check('isDemoSeed: ignores case and extra spaces', isDemoSeed('  ' + DEMO_SEEDS[12].toUpperCase().split(' ').join('   ') + ' '));
check('isDemoSeed: real seeds refused', !isDemoSeed(REAL_12) && !isDemoSeed(REAL_24));
check('isDemoSeed: empty / null refused', !isDemoSeed('') && !isDemoSeed(null));
check('normalizeMnemonic collapses whitespace', normalizeMnemonic(' a\tb\n c ') === 'a b c');

console.log('Wrapped bip39:');
let refusals = 0;
const w = wrapBip39(bip39, () => { refusals++; });
const refuses = async (fn) => { try { await fn(); return false; } catch (e) { return e.message === REFUSAL_MESSAGE; } };
check('mnemonicToSeed refuses a real seed', await refuses(() => w.mnemonicToSeed(REAL_12)));
check('mnemonicToSeedSync refuses a real seed', await refuses(() => w.mnemonicToSeedSync(REAL_24, 'passphrase')));
check('mnemonicToEntropy refuses a real seed', await refuses(() => w.mnemonicToEntropy(REAL_12, wordlist)));
check('each refusal calls the notice', refusals === 3, String(refusals));
const s1 = await w.mnemonicToSeed(DEMO_SEEDS[12], 'TREZOR');
check('mnemonicToSeed: demo seed gives the same bytes as the library (with passphrase)', Buffer.from(s1).equals(Buffer.from(await bip39.mnemonicToSeed(DEMO_SEEDS[12], 'TREZOR'))));
check('mnemonicToSeedSync: demo seed works', Buffer.from(w.mnemonicToSeedSync(DEMO_SEEDS[24])).equals(Buffer.from(bip39.mnemonicToSeedSync(DEMO_SEEDS[24]))));
check('mnemonicToEntropy: demo seed works', w.mnemonicToEntropy(DEMO_SEEDS[18], wordlist).every(b => b === 0));
check('other functions untouched (validateMnemonic, entropyToMnemonic)', w.validateMnemonic === bip39.validateMnemonic && w.entropyToMnemonic === bip39.entropyToMnemonic);
check('wrapper is frozen', Object.isFrozen(w));

console.log('Generated seeds are replaced:');
let notices = 0;
for (const n of [12, 15, 18, 21, 24]) {
  const generated = bip39.generateMnemonic(wordlist, (n * 32) / 3);
  check(`${n}-word generated seed -> ${n}-word demo seed`, replaceGenerated(generated, () => notices++) === DEMO_SEEDS[n]);
}
check('unusual length falls back to the 24-word demo seed', replaceGenerated('one two three', () => notices++) === DEMO_SEEDS[24]);
check('each replacement shows the notice', notices === 6, String(notices));

console.log('Demo switch:');
const win = (flag, protocol) => ({ SKV_DEMO: flag, location: { protocol } });
check('on: flag set, https', isDemoActive(win(true, 'https:')));
check('on: flag set, http', isDemoActive(win(true, 'http:')));
check('off: USB stick (file:) even with the flag', !isDemoActive(win(true, 'file:')));
check('off: no flag', !isDemoActive(win(undefined, 'https:')));
check('off: flag not exactly true', !isDemoActive(win('true', 'https:')) && !isDemoActive(win(1, 'https:')));
check('off: no window', !isDemoActive(undefined));

console.log('Wiring:');
const entry = read('boot-entry.js');
check('boot-entry wraps bip39 only when the demo is active', /window\.BtcMath = demoActive \? \{ \.\.\.realBtcMath, bip39: wrapBip39\(bip39\) \} : realBtcMath;/.test(entry));
check('boot-entry self-check uses the unwrapped libraries', /buildSelfTests\(realBtcMath,/.test(entry));
const session = read('shared/seed-session.js');
check('seed-session.js refuses non-demo seeds in the demo', /window\.SKV_DEMO === true && window\.location\.protocol !== 'file:'[\s\S]{0,120}isDemoSeed\(seedData\.mnemonic\)/.test(session));
const boot = read('boot.html');
check('dev mock SeedSession refuses non-demo seeds in the demo', /isDemo && s && s\.mnemonic &&\s*!\(window\.SKVDemo && window\.SKVDemo\.isDemoSeed\(s\.mnemonic\)\)/.test(boot));
check('dev mock restore refuses non-demo seeds in the demo', /isDemo && !\(window\.SKVDemo && window\.SKVDemo\.isDemoSeed\(mn\)\)/.test(boot));
check('generated seeds pass through _skvDemoGenerated at all three sites', (boot.match(/mnemonic = _skvDemoGenerated\(mnemonic/g) || []).length === 3);
check('the Entropy Generator also zeroes its raw entropy', /mnemonic = _skvDemoGenerated\(mnemonic, entropy\);/.test(boot));
check('the dev drawer is not shown in the demo', /if \(!isDemo\) _injectDrawer\(\);/.test(boot));
check('boot.html never sets the demo flag itself', !/window\.SKV_DEMO\s*=\s*true/.test(boot));
const build = read('build-offline.mjs');
check('release build refuses a file carrying the demo flag', /if \(DEMO_FLAG_RE\.test\(stripped\)\)/.test(build));
check('demo build blocks network connections (connect-src none)', /"connect-src 'none'"/.test(build));
check('demo build removes the unflagged boot.html', /unlinkSync\(bootHtmlPath\)/.test(build));
const pkg = JSON.parse(read('package.json'));
check('npm run build:demo exists', pkg.scripts['build:demo'] === 'node build-offline.mjs --demo');
check('no gh-pages deploy script', !pkg.scripts.deploy && !/gh-pages/.test(JSON.stringify(pkg.scripts)));

console.log(`\nDEMO MODE: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

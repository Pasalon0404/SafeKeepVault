import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
/**
 * test-connect-app.mjs — "Connect a wallet app" gives each app the export it
 * was tested with (boot.html _CN_APPS):
 *  - Sparrow: BC-UR Account (ur:crypto-account), all four address types,
 *    single-sig or multisig;
 *  - Nunchuk: Hardware Wallet JSON played animated (ur:bytes), added as a
 *    Passport; Native SegWit; single-sig or multisig;
 *  - Blue Wallet: the BIP-380 output descriptor; single-sig;
 *  - Specter: BIP-32 Watch-Only JSON as a file (Download JSON);
 *  - Electrum: the SLIP-132 key (zpub/ypub/xpub) as a QR, read with the
 *    Courier and pasted; no Taproot;
 *  - each format exists in Seed Management's Key Format menu;
 *  - the steps name the right script type; the guide in Seed Management
 *    shows only when this flow opened it; Taproot multisig is refused.
 * Run: node test-connect-app.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, 'boot.html'), 'utf8');
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

const m = /\nvar _CN_TYPE_NAMES = [\s\S]*?\nvar _CN_APPS = \{[\s\S]*?\n\};\n/.exec(HTML);
ck('app table found', !!m, '');
const ctx = vm.createContext({});
vm.runInContext(m[0] + '\nthis.A = _CN_APPS;', ctx);
const A = ctx.A;
ck('Sparrow: BC-UR Account, not animated, all types, multisig allowed', A.sparrow.format === 'bcur' && !A.sparrow.animate && A.sparrow.types.length === 4 && A.sparrow.multi);
ck('Nunchuk: Hardware Wallet JSON, animated, Native SegWit', A.nunchuk.format === 'coldcard_json' && A.nunchuk.animate && JSON.stringify(A.nunchuk.types) === '["84"]' && A.nunchuk.multi);
ck('Blue Wallet: output descriptor, single-sig', A.bluewallet.format === 'descriptor_text' && !A.bluewallet.animate && !A.bluewallet.multi);
ck('Another wallet: no preset format', A.other.format === null);
ck('Specter: the UR:CRYPTO-ACCOUNT QR (Add device -> Other -> Scan QR code reads it), not a file', A.specter.format === 'bcur' && !A.specter.file && A.specter.multi);
ck('Specter steps: Add new device, Other, Scan QR code; file only as a fallback', (function (t) { return /Add new device/.test(t) && /Other/.test(t) && /Scan QR code/.test(t) && /No camera/.test(t) && /Upload from SD/.test(t); })(A.specter.steps('84', false).join(' ')));
ck('Electrum: SLIP-132 key as a QR, no Taproot', A.electrum.format === 'slip132' && !A.electrum.file && A.electrum.types.indexOf('86') === -1 && A.electrum.multi);
ck('Electrum steps: Courier, Use a master key', /Courier/.test(A.electrum.steps('84', false).join(' ')) && /Use a master key/.test(A.electrum.steps('84', false).join(' ')));
for (const f of ['bcur', 'coldcard_json', 'descriptor_text', 'electrum_json', 'slip132']) ck('Seed Management offers ' + f, new RegExp('<option value="' + f + '"').test(HTML));
ck('Sparrow steps name the chosen script type', /Script Type: Taproot/.test(A.sparrow.steps('86', false).join(' ')) && /Multi Signature/.test(A.sparrow.steps('84', true).join(' ')));
ck('Nunchuk steps: add as Passport, scan the animated code', /Passport/.test(A.nunchuk.steps('84', false).join(' ')) && /animated/.test(A.nunchuk.steps('84', false).join(' ')));
ck('Blue Wallet steps: Import Wallet, scan', /Import Wallet/.test(A.bluewallet.steps().join(' ')) && /Scan/.test(A.bluewallet.steps().join(' ')));
ck('Taproot multisig refused', /if \(multi && t === '86'\)/.test(HTML));
ck('guide only when this flow opened Seed Management', /if \(!\(typeof _cn !== 'undefined' && _cn\.pending\)\) \{ var cg = document\.getElementById\('arm-connect-guide'\); if \(cg\) cg\.hidden = true; \}/.test(HTML));
ck('waits for the app\'s format before showing the QR', /bcur: \/\^UR:CRYPTO-ACCOUNT\\\//.test(HTML));
ck('Dashboard tile and sidebar card open the flow', (HTML.match(/onclick="connect_open\('state-connect'\)"/g) || []).length === 2);
ck('screen registered', /'state-receive', 'state-connect'/.test(HTML));

console.log(`\ntest-connect-app: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

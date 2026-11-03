import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { encodeSilentPaymentAddress } from './shared/silentpayments.js';
/**
 * test-receive-sp.mjs — Show an address offers this seed's Silent Payment
 * address (BIP-352): one reusable sp1q address, worked out from the same
 * paths as Output Descriptor (scan m/352'/0'/0'/1'/0, spend m/352'/0'/0'/0'/0),
 * with no New address and no address numbers.
 * Run: node test-receive-sp.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, 'boot.html'), 'utf8');
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };
const fn = (name) => { const i = HTML.search(new RegExp('\\n(async )?function ' + name + '\\s*\\(')); return HTML.slice(i, HTML.indexOf('\n}\n', i) + 2); };

const MN = 'abandon '.repeat(23) + 'art';
for (const pp of ['', 'test pp']) {
  const seed = mnemonicToSeedSync(MN, pp);
  const root = HDKey.fromMasterSeed(seed);
  const want = encodeSilentPaymentAddress(root.derive("m/352'/0'/0'/1'/0").publicKey, root.derive("m/352'/0'/0'/0'/0").publicKey);
  const ctx = vm.createContext({ window: { SilentPayments: { encodeSilentPaymentAddress }, BtcMath: { HDKey } } });
  vm.runInContext(fn('_rcvSilentPayment') + '; this.r = _rcvSilentPayment;', ctx);
  const got = ctx.r(seed);
  ck(`sp1q address from the BIP-352 paths${pp ? ' (with a passphrase)' : ''}`, got.address === want && /^sp1q/.test(got.address), got.address);
  ck(`fingerprint is the (passphrase) wallet's root${pp ? ' (with a passphrase)' : ''}`, got.fingerprint === root.fingerprint.toString(16).padStart(8, '0'));
}
ck('same paths as Output Descriptor', /derive\("m\/352'\/0'\/0'\/1'\/0"\)/.test(fn('_rcvSilentPayment')) && /scanNode = spRoot\.derive\("m\/352'\/0'\/0'\/1'\/0"\)/.test(HTML));
ck('listed for this seed after the four address types', /'This seed' \+ \(pp \? ' \(passphrase\)' : ''\) \+ ' · Silent Payment \(sp1q\\u2026\)'/.test(HTML));
ck('only public keys are used (no spscan / scan private key on this screen)', !/encodeSpscan|privateKey/.test(fn('_rcvSilentPayment')) && !/encodeSpscan|privateKey/.test(fn('_rcvShowStatic')));
ck('New address and the number box are hidden for it', /newBtn\.hidden = !!w\.sp/.test(fn('rcv_selectWallet')) && /more\.hidden = !!w\.sp/.test(fn('rcv_selectWallet')));
ck('New address / the number box do nothing for it', /_rcv\.cur\.sp\) return/.test(fn('rcv_new')) && /_rcv\.cur\.sp\) return/.test(fn('rcv_goto')) && /_rcv\.cur\.sp\) return/.test(fn('rcv_gotoLive')));
ck('no address position is stored for it', !/rcv_record/.test(fn('_rcvShowStatic')));
console.log(`test-receive-sp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

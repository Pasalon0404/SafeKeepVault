import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import * as btcSigner from '@scure/btc-signer';
/**
 * test-multisig-builder.mjs — Output Descriptor "Build multisig" (desc_generateMulti) in boot.html:
 *  - Key 1 is this device's BIP-48 key; the Key 1 box shows the same key origin string that goes
 *    into the descriptor;
 *  - a 2-of-3 builds the right descriptor and first addresses (checked against an independent
 *    derivation), with cosigners given as [fp/path]xpub, bare xpub, or with a trailing /<0;1>/* or /0/*;
 *  - the same key twice (two cosigners, or a cosigner equal to Key 1) is refused, as is an unusable path
 *    and a key from another BIP-48 script type than the chosen address type;
 *  - nothing is reported as a success when an address can't be worked out.
 * Run: node test-multisig-builder.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
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
function extractVar(name) {
  const m = new RegExp('\\nvar ' + name + '\\s*=').exec(SRC);
  if (!m) throw new Error('var not found: ' + name);
  const after = SRC.slice(m.index + m[0].length).trimStart();
  if (after[0] === '{') { const s = m.index + m[0].length + SRC.slice(m.index + m[0].length).indexOf('{'); return SRC.slice(m.index, extractBlock(s)) + ';'; }
  return SRC.slice(m.index, SRC.indexOf(';', m.index) + 1);
}
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const mk = async (m, pp = '') => HDKey.fromMasterSeed(await bip39.mnemonicToSeed(m, pp));
const r1 = await mk(ABANDON);
const r2 = await mk('legal winner thank year wave sausage worth useful legal winner thank yellow');
const r3 = await mk('letter advice cage absurd amount doctor acoustic avoid letter advice cage above');
const fpHex = (r) => r.fingerprint.toString(16).padStart(8, '0');
const PATH = "48'/0'/0'/2'";
const origin = (r) => `[${fpHex(r)}/${PATH.replace(/'/g, 'h')}]${r.derive('m/' + PATH).publicExtendedKey}`;

function makeEnv(cosigners, extra = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { id, value: '', textContent: '', innerHTML: '', disabled: false, style: {} });
  cosigners.forEach((v, i) => { el('desc-ms-xpub-' + (i + 2)).value = v; });
  el('desc-ms-passphrase').value = extra.passphrase || '';
  el('desc-ms-addr-type').value = '84';
  const statuses = [];
  const ctx = vm.createContext({
    window: { BtcMath: { bip39, wordlist, HDKey, btcSigner }, SeedSession: { get: () => ({ mnemonic: ABANDON }) } },
    document: { getElementById: el }, Uint8Array, Math, Number, String, parseInt, setTimeout, console, Promise,
    showStatus: (m, t) => statuses.push(t + ':' + m), _descShowAddrExport() {}, desc_recvReset() {},
  });
  vm.runInContext([
    ...['DESC_BIP32_PUBLIC_MAINNET', 'DESC_BIP32_PUBLIC_TESTNET', '_DESC_MAINNET_VERS', '_DESC_TESTNET_VERS', '_sha256K', '_B58_ALPHABET'].map(extractVar),
    `var desc_state = { mode: 'multi', msM: ${extra.m || 2}, msN: ${cosigners.length + 1}, msAddrType: '84', currentDescriptor: null };`,
    'var _descLocalKeySeq = 0, _descLocalKey = "";',
    ...['desc_checksum', '_base58decode', '_base58checkDecode', '_base58check', '_base58encode', '_sha256sync', '_sha256impl', '_rr', '_descNormalizeXpub',
        'desc_arraysEqual', '_descLocalKeyOrigin', 'desc_updateLocalKeyStatus', 'desc_generateMulti', 'desc_generate'].map(extract),
  ].join('\n'), ctx);
  return { ctx, el, statuses, last: () => statuses[statuses.length - 1] || '' };
}
const sortB = (a) => a.slice().sort((x, y) => { for (let k = 0; k < 33; k++) if (x[k] !== y[k]) return x[k] - y[k]; return 0; });
const expectAddr = (i) => btcSigner.p2wsh(btcSigner.p2ms(2, sortB([r1, r2, r3].map((r) => r.derive('m/' + PATH).deriveChild(0).deriveChild(i).publicKey)))).address;

// ---- Key 1 box ----
{
  const env = makeEnv([origin(r2), origin(r3)]);
  env.ctx.desc_updateLocalKeyStatus();
  await new Promise((r) => setTimeout(r, 50));
  const want = `[${fpHex(r1)}/48'/0'/0'/2']${r1.derive('m/' + PATH).publicExtendedKey}`;
  ck('Key 1 box shows this device\'s key origin and xpub', env.el('desc-ms-local-status').textContent === want && env.ctx._descLocalKey === want, env.el('desc-ms-local-status').textContent);
  ck('Key 1 fingerprint shown, Copy enabled', env.el('desc-ms-local-fp').textContent === '73C5DA0A' && env.el('desc-ms-local-copy').disabled === false);
  const ppEnv = makeEnv([origin(r2), origin(r3)], { passphrase: 'TREZOR' });
  ppEnv.ctx.desc_updateLocalKeyStatus();
  await new Promise((r) => setTimeout(r, 50));
  const rpp = await mk(ABANDON, 'TREZOR');
  ck('Key 1 box follows the passphrase', ppEnv.ctx._descLocalKey.startsWith('[' + fpHex(rpp) + '/') && ppEnv.ctx._descLocalKey.endsWith(rpp.derive('m/' + PATH).publicExtendedKey), ppEnv.ctx._descLocalKey.slice(0, 40));
  await env.ctx.desc_generate();
  ck('the Key 1 string is the key used in the descriptor', env.ctx.desc_state.currentDescriptor.includes(want + '/<0;1>/*'));
}

// ---- 2-of-3 with different cosigner input formats ----
const formats = {
  '[fp/path]xpub': [origin(r2), origin(r3)],
  'bare xpub': [r2.derive('m/' + PATH).publicExtendedKey, r3.derive('m/' + PATH).publicExtendedKey],
  'trailing /<0;1>/*': [origin(r2) + '/<0;1>/*', origin(r3) + '/<0;1>/*'],
  'trailing /0/*': [origin(r2) + '/0/*', origin(r3) + '/0/*'],
};
for (const [name, cos] of Object.entries(formats)) {
  const env = makeEnv(cos);
  await env.ctx.desc_generate();
  const d = env.ctx.desc_state.currentDescriptor || '';
  const list = env.el('desc-address-list').innerHTML;
  ck(`${name}: success, 3 keys, one /<0;1>/* each`, /^success:/.test(env.last()) && (d.match(/\]/g) || []).length === 3 && (d.match(/<0;1>/g) || []).length === 3 && !/\/0\/\*/.test(d), env.last() + ' ' + d.slice(0, 80));
  ck(`${name}: first addresses match an independent derivation`, [0, 1, 4].every((i) => list.includes(expectAddr(i))), list.slice(0, 120));
}

// ---- Refusals ----
{
  const env = makeEnv([origin(r2), origin(r2)]);
  await env.ctx.desc_generate();
  ck('same cosigner twice: refused, names both keys', /^error:.*Key 2 and Key 3 are the same key/.test(env.last()) && env.el('desc-output').style.display === 'none', env.last());
}
{
  const env = makeEnv([origin(r1), origin(r3)]);
  await env.ctx.desc_generate();
  ck('cosigner equal to Key 1: refused', /^error:.*Key 2 is the same key as Key 1/.test(env.last()), env.last());
}
{
  const env = makeEnv([origin(r2) + '/1/*', origin(r3)]);
  await env.ctx.desc_generate();
  ck('unusable path after the xpub: refused', /^error:.*path after the xpub/.test(env.last()), env.last());
}
{
  // A cosigner key from another BIP-48 script type is refused.
  const nested = (r) => `[${fpHex(r)}/48h/0h/0h/1h]${r.derive("m/48'/0'/0'/1'").publicExtendedKey}`;
  const env = makeEnv([nested(r2), origin(r3)]);
  await env.ctx.desc_generate();
  ck('Nested SegWit key (…/1h) in a Native SegWit wallet: refused', /^error:.*Key 2 is a Nested SegWit \(P2SH-P2WSH\) key.*address type is Native SegWit/.test(env.last()), env.last());
  const apo = (r) => `[${fpHex(r)}/48'/0'/0'/2']${r.derive('m/' + PATH).publicExtendedKey}`;
  const env2 = makeEnv([apo(r2), origin(r3)]);
  await env2.ctx.desc_generate();
  ck("matching key written with ' (as imported from a device): accepted", /^success:/.test(env2.last()) && env2.el('desc-address-list').innerHTML.includes(expectAddr(0)), env2.last());
}
{
  // Address derivation failure is never reported as success.
  const env = makeEnv([origin(r2), origin(r3)]);
  const real = env.ctx.window.BtcMath.btcSigner;
  env.ctx.window.BtcMath.btcSigner = { ...real, p2wsh: () => { throw new Error('boom'); } };
  await env.ctx.desc_generate();
  ck('address error: reported as an error, output hidden', /^error:.*Address 0 couldn’t be worked out/.test(env.last()) && env.el('desc-output').style.display === 'none', env.last());
}

console.log(`\nMULTISIG BUILDER: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

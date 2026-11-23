import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import * as btcSigner from '@scure/btc-signer';
/**
 * test-receive-address.mjs — Output Descriptor "Receive" panel in boot.html:
 *  - Show: the address for any index (BIP-84/86 test vectors, multisig against an independent
 *    derivation), grouped in fours, with a safety check against the on-screen list; Silent
 *    Payments show their one static address;
 *  - Check: finds a pasted/scanned address among the first 1,000 receive and change addresses
 *    (bitcoin: URIs and uppercase bech32 accepted), and refuses typos, testnet and other wallets.
 * Run: node test-receive-address.mjs
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
const mk = async (m) => HDKey.fromMasterSeed(await bip39.mnemonicToSeed(m, ''));
const r1 = await mk(ABANDON);
const r2 = await mk('legal winner thank year wave sausage worth useful legal winner thank yellow');
const r3 = await mk('letter advice cage absurd amount doctor acoustic avoid letter advice cage above');
const fpHex = (r) => r.fingerprint.toString(16).padStart(8, '0');
const acct = (r, path) => `[${fpHex(r)}/${path.replace(/'/g, 'h')}]${r.derive('m/' + path).publicExtendedKey}`;

function makeEnv(descriptor, screen) {
  const els = {};
  const el = (id) => (els[id] ||= { id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, style: {},
    getContext: () => ({ clearRect() {} }), querySelectorAll: () => (screen || []).map((t) => ({ textContent: t })) });
  el('desc-recv-index').value = '0';
  const ctx = vm.createContext({
    window: { BtcMath: { HDKey, btcSigner } }, document: { getElementById: el }, Uint8Array, Math, Number, String, parseInt, isNaN, setTimeout, Promise, console,
    showStatus() {}, SKScanner: null,
  });
  vm.runInContext([
    ...['DESC_BIP32_PUBLIC_MAINNET', 'DESC_BIP32_PUBLIC_TESTNET', '_DESC_MAINNET_VERS', '_DESC_TESTNET_VERS', '_WREC_SCRIPTS', '_sha256K', '_B58_ALPHABET', 'DESC_RECV_SEARCH'].map(extractVar),
    `var desc_state = { currentDescriptor: ${JSON.stringify(descriptor)} };`,
    'var _descRecv = { parsed: null, nodes: {}, address: "" }; var _descRecvScanner = null;',
    ...['desc_checksum', 'desc_parseKeyOrigin', '_base58decode', '_base58checkDecode', '_base58check', '_base58encode', '_sha256sync', '_sha256impl', '_rr', '_descNormalizeXpub',
        '_wrecSplitArgs', '_wrecCall', '_wrecParseDescriptor', '_wrecIndexZeroPubkey', '_wrecCompareBytes', '_wrecFirstAddress', '_wrecAddressFromPubkeys',
        '_descChainNodes', '_descScreenAddresses', '_descRecvWallet', '_descRecvAddressAt', '_descRecvGroups', 'desc_recvReset', 'desc_recvStep', 'desc_recvShow',
        '_descRecvNormalize', '_descRecvResult', 'desc_recvCheck', 'desc_recvStopScan'].map(extract),
  ].join('\n'), ctx);
  const shown = () => el('desc-recv-addr').innerHTML.replace(/<\/?span>/g, '').replace(/ /g, '');
  const show = (i) => { el('desc-recv-index').value = String(i); ctx.desc_recvShow(); return shown(); };
  const check = async (v) => { el('desc-recv-check-input').value = v; await ctx.desc_recvCheck(); return el('desc-recv-result').className + ' ' + el('desc-recv-result').innerHTML; };
  return { ctx, el, show, check, shown };
}
const cs = (body) => body + '#' + makeEnv('').ctx.desc_checksum(body);
const WPKH = cs(`wpkh(${acct(r1, "84'/0'/0'")}/<0;1>/*)`);
const TR = cs(`tr(${acct(r1, "86'/0'/0'")}/<0;1>/*)`);

// ---- Show ----
{
  const e = makeEnv(WPKH);
  ck('BIP-84 #0', e.show(0) === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', e.shown());
  ck('BIP-84 #1', e.show(1) === 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', e.shown());
  ck('label names the index, path and fingerprint', /^Receive #1 · path 0\/1 · single-sig · 73C5DA0A$/.test(e.el('desc-recv-label').textContent), e.el('desc-recv-label').textContent);
  ck('address shown in groups of four', e.el('desc-recv-addr').innerHTML.startsWith('<span>bc1q</span> <span>njg0</span> '), e.el('desc-recv-addr').innerHTML.slice(0, 40));
  e.ctx.desc_recvStep(-1); e.ctx.desc_recvStep(-1);
  ck('Previous stops at 0', e.el('desc-recv-index').value === '0' && e.shown() === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  e.ctx.desc_recvStep(1);
  ck('Next goes to #1', e.el('desc-recv-index').value === '1');
  ck('bad index refused', e.show('x') === '' || /Enter an address number/.test(e.el('desc-recv-addr').textContent), e.el('desc-recv-addr').textContent);
  const t = makeEnv(TR);
  ck('BIP-86 #0 and #1', t.show(0) === 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr' && t.show(1) === 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh');
  const bad = makeEnv(WPKH, ['m/0/0   bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'm/0/1   bc1qSOMETHINGELSE']);
  bad.show(1);
  ck('safety net: mismatch with the on-screen list is refused', /doesn’t match address 1/.test(bad.el('desc-recv-addr').textContent), bad.el('desc-recv-addr').textContent);
}
const sortB = (a) => a.slice().sort((x, y) => { for (let k = 0; k < 33; k++) if (x[k] !== y[k]) return x[k] - y[k]; return 0; });
const MSP = "48'/0'/0'/2'";
const MS = cs(`wsh(sortedmulti(2,${[r1, r2, r3].map((r) => acct(r, MSP) + '/<0;1>/*').join(',')}))`);
const msAddr = (chain, i) => btcSigner.p2wsh(btcSigner.p2ms(2, sortB([r1, r2, r3].map((r) => r.derive('m/' + MSP).deriveChild(chain).deriveChild(i).publicKey)))).address;
{
  const e = makeEnv(MS);
  ck('2-of-3 #0 and #42 match an independent derivation', e.show(0) === msAddr(0, 0) && e.show(42) === msAddr(0, 42));
  ck('2-of-3 label', /2-of-3 multisig · 73C5DA0A, B8688DF1, 28645006/.test(e.el('desc-recv-label').textContent), e.el('desc-recv-label').textContent);
}

// ---- Check ----
{
  const e = makeEnv(WPKH);
  ck('receive #1 found', /is-ok.*receive address #1/.test(await e.check('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g')));
  ck('found receive address becomes the shown address', e.el('desc-recv-index').value === '1' && e.shown() === 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
  ck('uppercase bech32 found', /is-ok.*receive address #1/.test(await e.check('BC1QNJG0JD8228AQ7EGYZACY8CYS3KNF9XVRERKF9G')));
  ck('bitcoin: URI with amount found', /is-ok.*receive address #1/.test(await e.check('bitcoin:bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g?amount=0.01')));
  ck('change #0 found and flagged as change', /is-ok.*change address #0.*normally used by your wallet/.test(await e.check('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el')));
  const a999 = e.ctx._descRecvAddressAt(e.ctx._descRecvWallet(), 0, 999);
  ck('receive #999 found (end of the search window)', /is-ok.*receive address #999/.test(await e.check(a999)));
  const a1000 = e.ctx._descRecvAddressAt(e.ctx._descRecvWallet(), 0, 1000);
  ck('receive #1000 is outside the window: not found', /is-bad.*Not found/.test(await e.check(a1000)));
  ck('typo refused as invalid', /is-bad.*isn’t a valid Bitcoin address/.test(await e.check('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9h')));
  ck('testnet refused', /is-bad.*testnet/.test(await e.check('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')));
  ck('another wallet: not found', /is-bad.*Not found.*swapped in by malware/.test(await e.check(msAddr(0, 0))));
  ck('legacy base58 from another wallet: not found', /is-bad.*Not found/.test(await e.check('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA')));
  ck('empty refused', /is-bad.*Paste or scan/.test(await e.check('   ')));
}
{
  const e = makeEnv(MS);
  ck('2-of-3: change #3 found', /is-ok.*change address #3/.test(await e.check(msAddr(1, 3))));
  ck('2-of-3: single-sig address not found', /is-bad.*Not found/.test(await e.check('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')));
}

console.log(`\nRECEIVE ADDRESS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

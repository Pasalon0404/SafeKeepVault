import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import * as btcSigner from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as SP from './shared/silentpayments.js';
import { createRequire } from 'node:module';
const CBOR = createRequire(import.meta.url)('cbor-sync');
/**
 * test-address-export.mjs — Output Descriptor "Export Addresses (.csv)" in boot.html:
 *  - addresses for any index on the receive and change chains, for every descriptor shape the tool
 *    builds (wpkh, tr, sh(wpkh), pkh; sortedmulti in wsh, sh(wsh), sh) and plain multi, checked
 *    against the BIP-84/86 test vectors and an independent derivation;
 *  - desc_exportAddresses: CSV layout, count limits, the change-chain option, Silent Payments and
 *    unranged descriptors refused, and nothing saved if the on-screen addresses don't match;
 *  - _descSaveFile: exports land on the Transfer Drive (never in the vault), with unique names,
 *    and the Transfer Hub lists and accepts .csv files.
 * Run: node test-address-export.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');

// Extract a named top-level function from boot.html (brace matching, string/comment aware).
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
// Extract a top-level `var NAME = …;` statement (object literals included).
function extractVar(name) {
  const m = new RegExp('\\nvar ' + name + '\\s*=').exec(SRC);
  if (!m) throw new Error('var not found: ' + name);
  const after = SRC.slice(m.index + m[0].length).trimStart();
  if (after[0] === '{') { const s = m.index + m[0].length + SRC.slice(m.index + m[0].length).indexOf('{'); return SRC.slice(m.index, extractBlock(s)) + ';'; }
  return SRC.slice(m.index, SRC.indexOf(';', m.index) + 1);
}

let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

function makeEnv() {
  const els = {};
  const el = (id) => (els[id] ||= { id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
    style: { display: '' }, _rows: [], focus() {}, querySelectorAll() { return this._rows.map((t) => ({ textContent: t })); } });
  const saved = [], statuses = [];
  const ctx = vm.createContext({
    window: { BtcMath: { bip39, wordlist, HDKey, btcSigner, secp256k1 }, SilentPayments: SP },
    document: { getElementById: el }, Buffer, DataView, Uint8Array, Uint32Array, BigInt, Math, Number, String, parseInt, isNaN,
    setTimeout, clearTimeout, console, Promise, Date,
    showStatus: (m, t) => statuses.push(t + ':' + m),
    _descSaveFile: (name, content, mime) => saved.push({ name, content, mime }),
  });
  vm.runInContext([
    ...['DESC_BIP32_PUBLIC_MAINNET', 'DESC_BIP32_PUBLIC_TESTNET', '_DESC_MAINNET_VERS', '_DESC_TESTNET_VERS', '_WREC_SCRIPTS', '_sha256K', '_B58_ALPHABET', 'DESC_ADDR_EXPORT_MAX'].map(extractVar),
    'var desc_state = { currentDescriptor: null };',
    ...['desc_checksum', 'desc_parseKeyOrigin', '_base58decode', '_base58checkDecode', '_base58check', '_base58encode', '_sha256sync', '_sha256impl', '_rr',
        '_descNormalizeXpub', '_wrecSplitArgs', '_wrecCall', '_wrecParseDescriptor', '_wrecIndexZeroPubkey', '_wrecCompareBytes', '_wrecFirstAddress',
        '_wrecAddressFromPubkeys', '_descShowAddrExport', '_descChainNodes', '_descChainAddresses', '_descScreenAddresses', 'desc_exportAddresses'].map(extract),
  ].join('\n'), ctx);
  return { ctx, el, saved, statuses, last: () => statuses[statuses.length - 1] || '' };
}

const env = makeEnv();
const cs = (body) => body + '#' + env.ctx.desc_checksum(body);

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = HDKey.fromMasterSeed(await bip39.mnemonicToSeed(ABANDON, ''));
const fpHex = (r) => r.fingerprint.toString(16).padStart(8, '0');
const acct = (r, path) => `[${fpHex(r)}/${path.replace(/'/g, 'h')}]${r.derive('m/' + path).publicExtendedKey}`;

async function rows(desc, chain, count) {
  const p = env.ctx._wrecParseDescriptor(desc);
  if (!p.ok) throw new Error(p.error);
  return env.ctx._descChainAddresses(p, chain, count);
}

// ---- Published BIP-84 / BIP-86 test vectors (receive 0, receive 1, change 0) ----
const WPKH = cs(`wpkh(${acct(root, "84'/0'/0'")}/<0;1>/*)`);
const TR = cs(`tr(${acct(root, "86'/0'/0'")}/<0;1>/*)`);
{
  const r = await rows(WPKH, 0, 2), c = await rows(WPKH, 1, 1);
  ck('BIP-84 receive 0', r[0][3] === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', r[0][3]);
  ck('BIP-84 receive 1', r[1][3] === 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', r[1][3]);
  ck('BIP-84 change 0', c[0][3] === 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el', c[0][3]);
  ck('row layout: index, chain, path, address', JSON.stringify(r[1].slice(0, 3)) === '[1,"receive","0/1"]' && JSON.stringify(c[0].slice(0, 3)) === '[0,"change","1/0"]', JSON.stringify([r[1], c[0]]));
  const t = await rows(TR, 0, 2), tc = await rows(TR, 1, 1);
  ck('BIP-86 receive 0', t[0][3] === 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', t[0][3]);
  ck('BIP-86 receive 1', t[1][3] === 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh', t[1][3]);
  ck('BIP-86 change 0', tc[0][3] === 'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7', tc[0][3]);
}

// ---- Every shape vs an independent derivation, deep into both chains ----
const r2 = HDKey.fromMasterSeed(await bip39.mnemonicToSeed('legal winner thank year wave sausage worth useful legal winner thank yellow', ''));
const r3 = HDKey.fromMasterSeed(await bip39.mnemonicToSeed('letter advice cage absurd amount doctor acoustic avoid letter advice cage above', ''));
const roots = [root, r2, r3];
const pub = (r, path, chain, i) => r.derive('m/' + path).deriveChild(chain).deriveChild(i).publicKey;
const sortB = (a) => a.slice().sort((x, y) => { for (let k = 0; k < 33; k++) if (x[k] !== y[k]) return x[k] - y[k]; return 0; });
const single = [
  ['wpkh', "84'/0'/0'", (b) => `wpkh(${b})`, (p) => btcSigner.p2wpkh(p).address],
  ['tr', "86'/0'/0'", (b) => `tr(${b})`, (p) => btcSigner.p2tr(p.slice(1)).address],
  ['sh(wpkh)', "49'/0'/0'", (b) => `sh(wpkh(${b}))`, (p) => btcSigner.p2sh(btcSigner.p2wpkh(p)).address],
  ['pkh', "44'/0'/0'", (b) => `pkh(${b})`, (p) => btcSigner.p2pkh(p).address],
];
for (const [name, path, wrap, addr] of single) {
  const d = cs(wrap(`${acct(root, path)}/<0;1>/*`));
  for (const chain of [0, 1]) {
    const got = await rows(d, chain, 260);
    const ok = [0, 7, 199, 200, 259].every((i) => got[i][3] === addr(pub(root, path, chain, i)) && got[i][0] === i);
    ck(`${name} chain ${chain}: 260 addresses match an independent derivation`, ok && got.length === 260, got.length);
  }
}
const multi = [
  ['wsh(sortedmulti)', "48'/0'/0'/2'", (k) => `wsh(sortedmulti(2,${k}))`, (ms) => btcSigner.p2wsh(ms).address, true],
  ['sh(wsh(sortedmulti))', "48'/0'/0'/1'", (k) => `sh(wsh(sortedmulti(2,${k})))`, (ms) => btcSigner.p2sh(btcSigner.p2wsh(ms)).address, true],
  ['sh(sortedmulti)', "48'/0'/0'/0'", (k) => `sh(sortedmulti(2,${k}))`, (ms) => btcSigner.p2sh(ms).address, true],
  ['wsh(multi), key order kept', "48'/0'/0'/2'", (k) => `wsh(multi(2,${k}))`, (ms) => btcSigner.p2wsh(ms).address, false],
];
for (const [name, path, wrap, addr, sorted] of multi) {
  const d = cs(wrap(roots.map((r) => `${acct(r, path)}/<0;1>/*`).join(',')));
  for (const chain of [0, 1]) {
    const got = await rows(d, chain, 25);
    const ok = [0, 1, 24].every((i) => {
      const pubs = roots.map((r) => pub(r, path, chain, i));
      return got[i][3] === addr(btcSigner.p2ms(2, sorted ? sortB(pubs) : pubs));
    });
    ck(`${name} chain ${chain}: addresses match an independent derivation`, ok, got[0][3]);
  }
}
{
  // Fixed receive-only paths (…/0/*) have no change chain.
  const p = env.ctx._wrecParseDescriptor(cs(`wpkh(${acct(root, "84'/0'/0'")}/0/*)`));
  ck('…/0/* descriptor: receive works, change chain reported missing',
    (await env.ctx._descChainAddresses(p, 0, 1))[0][3] === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' && (await env.ctx._descChainAddresses(p, 1, 1)) === null);
}

// ---- desc_exportAddresses: the button ----
const screen = async (desc) => (await rows(desc, 0, 5)).map((r) => `m/0/${r[0]}   ${r[3]}`);
async function run(desc, count, change, screenRows) {
  env.saved.length = 0; env.statuses.length = 0;
  env.ctx.desc_state.currentDescriptor = desc;
  env.el('desc-addr-count').value = String(count);
  env.el('desc-addr-change').checked = !!change;
  env.el('desc-addr-export-btn').textContent = 'Export Addresses (.csv)';
  env.el('desc-address-list')._rows = screenRows || (desc ? await screen(desc) : []);
  await env.ctx.desc_exportAddresses();
  return env.saved[0];
}
{
  const f = await run(WPKH, 100, false);
  const lines = f ? f.content.trimEnd().split('\n') : [];
  ck('100 receive: saves a .csv with a header and 100 rows', f && /^SAFEKEEP-ADDRESSES-\d{14}\.csv$/.test(f.name) && f.mime === 'text/csv' && lines.length === 101, f && f.name + ' ' + lines.length);
  ck('CSV header and first rows', lines[0] === 'index,chain,path,address' && lines[1] === '0,receive,0/0,bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' && lines[2] === '1,receive,0/1,bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', lines.slice(0, 3).join(' | '));
  ck('CSV ends with a newline, no descriptor or keys in it', f.content.endsWith('\n') && !/pub|prv|\[/.test(f.content));
  ck('button label restored and re-enabled', env.el('desc-addr-export-btn').textContent === 'Export Addresses (.csv)' && !env.el('desc-addr-export-btn').disabled);
}
{
  const f = await run(WPKH, 3, true);
  const lines = f.content.trimEnd().split('\n');
  ck('with change: receive rows then change rows', lines.length === 7 && lines[3].startsWith('2,receive,0/2,') && lines[4] === '0,change,1/0,bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el', lines.join(' | '));
}
{
  const f = await run(WPKH, 2, false);
  ck('count below the 5 on screen: only that many rows, still checked', f && f.content.trimEnd().split('\n').length === 3);
}
for (const bad of ['0', '-5', '10001', '2.5', 'abc', '']) {
  const f = await run(WPKH, bad, false);
  ck(`count "${bad}" refused with nothing saved`, !f && /1 to 10,000/.test(env.last()), env.last());
}
{
  const f = await run(WPKH, 10000, false);
  ck('10,000 accepted', f && f.content.trimEnd().split('\n').length === 10001);
}
{
  const f = await run(null, 10, false);
  ck('no descriptor yet: refused', !f && /Generate one first/.test(env.last()), env.last());
}
{
  const good = await screen(WPKH);
  const tampered = good.slice(); tampered[2] = 'm/0/2   bc1qnotthesameaddress';
  const f = await run(WPKH, 50, false, tampered);
  ck('on-screen address mismatch: nothing saved', !f && /doesn’t match/.test(env.last()), env.last());
}
{
  const f = await run(cs(`wpkh(${acct(root, "84'/0'/0'")}/0/*)`), 5, true);
  ck('change ticked on a receive-only descriptor: refused', !f && /no change chain/.test(env.last()), env.last());
}
{
  const f = await run(cs(`wpkh(${acct(root, "84'/0'/0'")})`), 5, false, []);
  ck('unranged descriptor (no /<0;1>/*): refused', !f && /missing/.test(env.last()), env.last());
}
{
  const scan = root.derive("m/352'/0'/0'/1'/0"), spend = root.derive("m/352'/0'/0'/0'/0");
  const sp = cs(`sp([${fpHex(root)}/352h/0h/0h]${SP.encodeSpscan(scan.privateKey, spend.publicKey)})`);
  const f = await run(sp, 5, false, []);
  ck('Silent Payment descriptor: refused (one static address)', !f && /Silent Payment/.test(env.last()), env.last());
}
{
  const d = cs(`wsh(sortedmulti(2,${roots.map((r) => `${acct(r, "48'/0'/0'/2'")}/<0;1>/*`).join(',')}))`);
  const f = await run(d, 20, true);
  ck('2-of-3 multisig export: 40 rows', f && f.content.trimEnd().split('\n').length === 41);
}


// ---- _descSaveFile: exports go to the Transfer Drive, never into the vault ----
{
  const files = new Map();
  const nf = () => { const e = new Error('nf'); e.name = 'NotFoundError'; return e; };
  const drive = {
    async getFileHandle(name, opts) {
      if (!files.has(name) && !(opts && opts.create)) throw nf();
      return { async createWritable() { let buf = ''; return { async write(d) { buf += d; }, async close() { files.set(name, buf); } }; } };
    },
  };
  const statuses = [];
  let anchors = 0;
  const ctx = vm.createContext({
    window: {}, Blob, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, setTimeout, Date, String,
    document: { getElementById: () => null, createElement: () => ({ style: {}, click() { anchors++; } }), body: { appendChild() {} } },
    showStatus: (m, t) => statuses.push(t + ':' + m),
  });
  vm.runInContext([extract('_armResolveUniqueFilename'), extract('_descSaveFile')].join('\n'), ctx);
  const last = () => statuses[statuses.length - 1] || '';

  ctx.window.vaultTransferDriveHandle = drive;
  ctx.window.SafeKeepOS = { isBootDrive: () => true };
  ck('drive mounted: file written to the Transfer Drive', await ctx._descSaveFile('A.csv', 'x,y\n', 'text/csv') === true && files.get('A.csv') === 'x,y\n' && /Transfer Drive/.test(last()), last());
  ck('same name again: saved as A-1.csv, first file kept', await ctx._descSaveFile('A.csv', 'z\n', 'text/csv') === true && files.get('A.csv') === 'x,y\n' && files.get('A-1.csv') === 'z\n', [...files.keys()].join());
  ck('drive mounted: no browser download', anchors === 0);

  ctx.window.vaultTransferDriveHandle = null;
  ck('boot drive, drive not mounted: refused, nothing downloaded into the vault',
    await ctx._descSaveFile('B.csv', 'b\n', 'text/csv') === false && anchors === 0 && /not mounted/.test(last()), last());

  ctx.window.SafeKeepOS = { isBootDrive: () => false };
  ck('not the boot drive, no drive mounted: browser download', await ctx._descSaveFile('C.csv', 'c\n', 'text/csv') === true && anchors === 1, last());
}
{
  // The Transfer Hub lists and accepts .csv files.
  const ext = new Function(extractVar('XFR_ALLOWED_EXT') + ' return XFR_ALLOWED_EXT;')();
  ck('Transfer Hub lists .csv files', ext.test('SAFEKEEP-ADDRESSES-20261012.csv') && ext.test('a.PSBT') && !ext.test('a.exe'));
  ck('Transfer Hub file picker accepts .csv', /id="xfr-file-input" accept="[^"]*\.csv/.test(SRC));
}

console.log(`\nADDRESS EXPORT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

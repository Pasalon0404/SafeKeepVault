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
 * test-wallet-record.mjs — Wallet Record (wrec_*) in boot.html, descriptor-first:
 *  - _wrecParseDescriptor reads type / threshold / script / keys from every descriptor shape the
 *    app produces, verifies the BIP-380 checksum, refuses private keys, and works out the first
 *    receiving address (checked against the BIP-44/49/84/86 test vectors, multisig via an
 *    independent derivation, Silent Payments via the BIP-352 helpers).
 *  - The form: key rows follow the descriptor, names/passphrases feed the printed record in the
 *    same shape as before (identical document to the old Pull flow), manual fallback, Pull
 *    assigns the passphrase to the right multisig key, and nothing is saved to localStorage.
 *  - Scanned wallet QR codes (ur:crypto-output) through the app's decoder, including Sparrow-style
 *    exports that omit the derivation path, and the safety net for descriptors missing /<0;1>/*.
 * Run: node test-wallet-record.mjs
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

// ---- Minimal DOM: persistent elements by id, an escaping createElement, a spying localStorage ----
function makeEnv() {
  const els = {};
  const el = (id) => (els[id] ||= { id, value: '', textContent: '', innerHTML: '', readOnly: false, open: false, checked: false,
    style: { display: '' }, _wrecAuto: false, addEventListener() {}, focus() {} });
  const escape = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const document = { getElementById: el, querySelector: () => null,
    createElement: () => { let t = ''; return { set textContent(v) { t = v; }, get innerHTML() { return escape(t); } }; } };
  const store = {}, writes = [];
  const localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { writes.push(k); store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const statuses = [];
  const ctx = vm.createContext({
    window: { BtcMath: { bip39, wordlist, HDKey, btcSigner, secp256k1 }, SilentPayments: SP, SafeKeepOS: { getPassphrase: () => '' }, CBOR },
    document, localStorage, Buffer, DataView, Uint8Array, Uint32Array, BigInt, Math, Number, String, parseInt, isNaN, setTimeout, clearTimeout, console,
    showStatus: (m, t) => statuses.push(t + ':' + m), alert: (m) => statuses.push('alert:' + m), confirm: () => true,
    lib_openDropdown: () => {}, _wrecRenderQR: () => Promise.resolve(),
  });
  vm.runInContext([
    ...['DESC_BIP32_PUBLIC_MAINNET', 'DESC_BIP32_PUBLIC_TESTNET', '_DESC_MAINNET_VERS', '_DESC_TESTNET_VERS', '_WREC_LS_KEY', '_WREC_SCRIPTS', '_sha256K', '_B58_ALPHABET'].map(extractVar),
    'var _wrecMeta = null, _wrecKeys = [], _wrecDescDebounce = null, _wrecQrScanner = null, _wrecUrDecoder = null, _wrecScanDone = false, _cborTagsRegistered = false;',
    ...['desc_checksum', 'desc_parseKeyOrigin', '_base58decode', '_base58checkDecode', '_base58check', '_base58encode', '_sha256sync', '_sha256impl', '_rr',
        '_descNormalizeXpub', '_ppFingerprint', '_wrecEscape', '_wrecSplitArgs', '_wrecCall', '_wrecParseDescriptor', '_wrecIndexZeroPubkey', '_wrecCompareBytes',
        '_wrecFirstAddress', '_wrecManualShape', '_wrecBlankKey', '_wrecResizeManualKeys', '_wrecSyncKeysToMeta', '_wrecKeyTarget', '_wrecCollectFormData',
        '_wrecRenderKeys', 'wrec_onKeyInput', 'wrec_onKeyPassphraseToggle', 'wrec_onManualShapeChange', 'wrec_onDescriptorInput', '_wrecApplyDescriptor',
        'wrec_init', 'wrec_pullDescriptor', 'wrec_stopQR', '_wrecRenderDocument', 'wrec_buildPreview',
        '_cborRegisterTags', 'descv_decodeCryptoOutput', '_cborTagToDescriptor', '_cborDecodeMulti', '_cborDecodeKey', '_cborDecodeHDKey', '_cborDecodeKeypath',
        '_cborResolveFingerprint', 'descv_reconstructXpub', '_bytesToHex'].map(extract),
  ].join('\n'), ctx);
  return { ctx, el, store, writes, statuses, last: () => statuses[statuses.length - 1] || '' };
}

const env0 = makeEnv();
const cs = (body) => body + '#' + env0.ctx.desc_checksum(body);
const parse = (d) => env0.ctx._wrecParseDescriptor(d);

// ---- Keys from the BIP-84/86/49/44 test-vector seed ----
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = HDKey.fromMasterSeed(await bip39.mnemonicToSeed(ABANDON, ''));
const fpHex = (r) => r.fingerprint.toString(16).padStart(8, '0');
const acct = (r, path) => `[${fpHex(r)}/${path.replace(/'/g, 'h')}]${r.derive('m/' + path).publicExtendedKey}`;

// Published first receiving addresses (BIP-44/49/84/86 test vectors for this seed)
const VEC = [
  ['wpkh', `wpkh(${acct(root, "84'/0'/0'")}/<0;1>/*)`, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'Native Segwit (P2WPKH)'],
  ['tr', `tr(${acct(root, "86'/0'/0'")}/<0;1>/*)`, 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', 'Taproot (P2TR)'],
  ['sh(wpkh)', `sh(wpkh(${acct(root, "49'/0'/0'")}/<0;1>/*))`, '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf', 'Nested Segwit (P2SH-P2WPKH)'],
  ['pkh', `pkh(${acct(root, "44'/0'/0'")}/<0;1>/*)`, '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA', 'Legacy (P2PKH)'],
];
for (const [name, body, addr, script] of VEC) {
  const r = parse(cs(body));
  ck(`${name}: reads single-sig, ${script}, fingerprint`, r.ok && !r.isMulti && r.script === script && r.keys.length === 1 && r.keys[0].fingerprint === '73c5da0a', JSON.stringify(r).slice(0, 200));
  ck(`${name}: first address matches the BIP test vector`, r.firstAddress === addr, r.firstAddress + ' ' + r.addressNote);
}
// SLIP-132 zpub (as some wallets still export) and a /0/* suffix
{ const zpub = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
  const r = parse(cs(`wpkh([73c5da0a/84h/0h/0h]${zpub}/0/*)`));
  ck('zpub key with /0/* suffix gives the BIP-84 first address', r.ok && r.firstAddress === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', r.firstAddress + ' ' + r.addressNote); }

// ---- Multisig: every wrapper the Output Descriptor tool (and others) produce ----
const seeds = ['legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'];
const roots = await Promise.all(seeds.map(async (m) => HDKey.fromMasterSeed(await bip39.mnemonicToSeed(m, ''))));
const msKeys = roots.map((r) => acct(r, "48'/0'/0'/2'") + '/<0;1>/*');
const pubs0 = roots.map((r) => r.derive("m/48'/0'/0'/2'/0/0").publicKey);
const sortedPubs = pubs0.slice().sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const MS = [
  ['wsh(sortedmulti)', `wsh(sortedmulti(2,${msKeys.join(',')}))`, 'Native Segwit (P2WSH)', btcSigner.p2wsh(btcSigner.p2ms(2, sortedPubs)).address],
  ['wsh(multi)', `wsh(multi(2,${msKeys.join(',')}))`, 'Native Segwit (P2WSH)', btcSigner.p2wsh(btcSigner.p2ms(2, pubs0)).address],
  ['sh(wsh(sortedmulti))', `sh(wsh(sortedmulti(2,${msKeys.join(',')})))`, 'Nested Segwit (P2SH-P2WSH)', btcSigner.p2sh(btcSigner.p2wsh(btcSigner.p2ms(2, sortedPubs))).address],
  ['sh(sortedmulti)', `sh(sortedmulti(2,${msKeys.join(',')}))`, 'Legacy (P2SH)', btcSigner.p2sh(btcSigner.p2ms(2, sortedPubs)).address],
];
for (const [name, body, script, addr] of MS) {
  const r = parse(cs(body));
  ck(`${name}: 2-of-3, ${script}, 3 fingerprints in order`, r.ok && r.isMulti && r.msM === 2 && r.msN === 3 && r.script === script &&
     r.keys.map((k) => k.fingerprint).join() === roots.map(fpHex).join(), JSON.stringify({ ok: r.ok, e: r.error, m: r.msM, n: r.msN, s: r.script }));
  ck(`${name}: first address`, r.firstAddress === addr, r.firstAddress + ' vs ' + addr + ' ' + r.addressNote);
}
// Cross-check wsh(sortedmulti) against the Output Descriptor tool's own derivation code
{ vm.runInContext(extract('desc_deriveAddress'), env0.ctx);
  const viaTool = env0.ctx.desc_deriveAddress('wsh-sortedmulti', pubs0, 2, btcSigner);
  ck('wsh(sortedmulti) address agrees with desc_deriveAddress', parse(cs(MS[0][1])).firstAddress === viaTool, viaTool); }
// The old reader called these single-sig P2WPKH; make sure that's fixed
ck('sh(wsh(...)) multisig is no longer mistaken for single-sig', parse(cs(MS[2][1])).isMulti && parse(cs(MS[3][1])).isMulti);

// ---- Silent Payments ----
{ const sr = root;
  const scan = sr.derive("m/352'/0'/0'/1'/0"), spend = sr.derive("m/352'/0'/0'/0'/0");
  const spscan = SP.encodeSpscan(scan.privateKey, spend.publicKey);
  const expected = SP.encodeSilentPaymentAddress(scan.publicKey, spend.publicKey);
  const r = parse(cs(`sp([${fpHex(sr)}/352h/0h/0h]${spscan})`));
  ck('sp(): Silent Payment, single key, fingerprint', r.ok && r.script === 'Silent Payment (sp1q)' && r.keys.length === 1 && r.keys[0].fingerprint === fpHex(sr), JSON.stringify(r).slice(0, 160));
  ck('sp(): address is the wallet’s sp1q address', r.firstAddress === expected && expected.startsWith('sp1q'), r.firstAddress);
  const rb = parse(cs(`sp([${fpHex(sr)}/352'/0'/0']${spscan}, 840000)`));
  ck('sp() with a birthday argument still reads one key', rb.ok && rb.keys.length === 1 && rb.firstAddress === expected); }

// ---- Errors and warnings ----
{ const good = cs(VEC[0][1]);
  const bad = good.slice(0, 20) + (good[20] === 'a' ? 'b' : 'a') + good.slice(21);
  const r = parse(bad);
  ck('mistyped character is caught by the checksum', !r.ok && /checksum/.test(r.error), r.error);
  const nocs = parse(VEC[0][1]);
  ck('no checksum: still read, with a warning', nocs.ok && nocs.warnings.some((w) => /No checksum/.test(w)) && nocs.firstAddress === VEC[0][2]);
  const upperCs = parse(VEC[0][1] + '#' + env0.ctx.desc_checksum(VEC[0][1]).toUpperCase());
  ck('checksum comparison ignores case', upperCs.ok);
  const xprv = parse(cs(`wpkh([73c5da0a/84h/0h/0h]${root.derive("m/84'/0'/0'").privateExtendedKey}/<0;1>/*)`));
  ck('a private key (xprv) is refused', !xprv.ok && /private key/.test(xprv.error));
  const trTree = parse(cs(`tr(${acct(root, "86'/0'/0'")}/<0;1>/*,{pk(${acct(roots[0], "86'/0'/0'")}/<0;1>/*)})`));
  ck('taproot with script paths is refused, not misread', !trTree.ok && /script paths/.test(trTree.error));
  const addrDesc = parse(cs('addr(bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu)'));
  ck('unsupported descriptor kinds point to manual entry', !addrDesc.ok && /by hand/.test(addrDesc.error));
  const silly = parse(cs(`wsh(sortedmulti(4,${msKeys.join(',')}))`));
  ck('impossible threshold (4-of-3) is refused', !silly.ok && /threshold/.test(silly.error));
  const change = parse(cs(`wpkh(${acct(root, "84'/0'/0'")}/1/*)`));
  ck('change-chain descriptor gets a warning', change.ok && change.warnings.some((w) => /change/.test(w)));
  const nofp = parse(cs(`wpkh(${root.derive("m/84'/0'/0'").publicExtendedKey}/<0;1>/*)`));
  ck('key without origin: read, warned, address still worked out', nofp.ok && nofp.warnings.some((w) => /no fingerprint/.test(w)) && nofp.firstAddress === VEC[0][2]);
  const hard = parse(cs(`wpkh([73c5da0a/84h/0h/0h]${root.derive("m/84'/0'/0'").publicExtendedKey}/0h/*)`));
  ck('hardened step after an xpub: read, but address left for the user to type', hard.ok && hard.firstAddress === '' && /type it in/.test(hard.addressNote)); }

// ---- Scanned QR codes (ur:crypto-output, BCR-2020-010) through the app's real decoder ----
// Minimal CBOR encoder for building wallet-export payloads.
const cborHead = (mt, n) => n < 24 ? [mt << 5 | n] : n < 256 ? [mt << 5 | 24, n] : n < 65536 ? [mt << 5 | 25, n >> 8, n & 255]
  : [mt << 5 | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const cborEnc = (x) => {
  if (x && x.tag !== undefined) return [...cborHead(6, x.tag), ...cborEnc(x.v)];
  if (typeof x === 'boolean') return [x ? 0xf5 : 0xf4];
  if (typeof x === 'number') return cborHead(0, x);
  if (x instanceof Uint8Array) return [...cborHead(2, x.length), ...x];
  if (Array.isArray(x)) return [...cborHead(4, x.length), ...x.flatMap(cborEnc)];
  const ks = Object.keys(x); return [...cborHead(5, ks.length), ...ks.flatMap((k) => [...cborEnc(+k), ...cborEnc(x[k])])];
};
// crypto-hdkey for an account key; `children` omitted = how Sparrow exports a multisig wallet QR
const urKey = (r, path, components, children) => {
  const a = r.derive('m/' + path);
  return { tag: 40303, v: Object.assign({ 3: a.publicKey, 4: a.chainCode, 6: { tag: 40304, v: { 1: components, 2: r.fingerprint, 3: components.length / 2 } }, 8: a.parentFingerprint },
    children ? { 7: children } : {}) };
};
const BIP48 = [48, true, 0, true, 0, true, 2, true];
const sortedAddr0 = btcSigner.p2wsh(btcSigner.p2ms(2, sortedPubs)).address;   // wsh(sortedmulti) receive address 0
const scanCases = [
  ['Sparrow-style multisig QR (no derivation path on the keys)', { tag: 401, v: { tag: 407, v: { 1: 2, 2: roots.map((r) => urKey(r, "48'/0'/0'/2'", BIP48, null)) } } }],
  ['multisig QR with an explicit /0/* path', { tag: 401, v: { tag: 407, v: { 1: 2, 2: roots.map((r) => urKey(r, "48'/0'/0'/2'", BIP48, { tag: 40304, v: { 1: [0, false, [], false] } })) } } }],
];
for (const [label, payload] of scanCases) {
  const desc = env0.ctx.descv_decodeCryptoOutput(Uint8Array.from(cborEnc(payload)));
  const r = parse(desc);
  ck(`${label}: decodes with a valid checksum`, r.ok && !r.warnings.some((w) => /checksum/.test(w)), desc.slice(-40) + ' ' + r.error);
  ck(`${label}: fingerprints match the wallet`, r.keys.map((k) => k.fingerprint).join() === roots.map(fpHex).join());
  ck(`${label}: first address is the wallet’s receive address 0`, r.firstAddress === sortedAddr0, r.firstAddress + ' vs ' + sortedAddr0);
}
{ const desc = env0.ctx.descv_decodeCryptoOutput(Uint8Array.from(cborEnc(scanCases[0][1])));
  ck('missing derivation path is written out as /<0;1>/* on every key', (desc.match(/\/<0;1>\/\*/g) || []).length === 3, desc);
  const xpubs = parse(desc).keys.map((k) => k.xpub);
  ck('decoded xpubs are byte-identical to the wallet’s own account xpubs', xpubs.join() === roots.map((r) => r.derive("m/48'/0'/0'/2'").publicExtendedKey).join(), xpubs[0]);
  const single = env0.ctx.descv_decodeCryptoOutput(Uint8Array.from(cborEnc({ tag: 404, v: urKey(root, "84'/0'/0'", [84, true, 0, true, 0, true], null) })));
  ck('single-sig QR without a path gives the BIP-84 first address', parse(single).firstAddress === VEC[0][2], single + ' ' + parse(single).firstAddress); }
// Safety net: an xpub with no …/<0;1>/* never produces an address
{ const r = parse(cs(`wsh(sortedmulti(2,${roots.map((x) => acct(x, "48'/0'/0'/2'")).join(',')}))`));
  ck('descriptor missing the /<0;1>/* path: read, warned, and no address worked out', r.ok && r.firstAddress === '' &&
     r.warnings.some((w) => /no …\/<0;1>\/\* after the xpub/.test(w)) && /missing/.test(r.addressNote), JSON.stringify({ a: r.firstAddress, w: r.warnings, n: r.addressNote }));
  const { ctx, el } = makeEnv(); ctx.wrec_init();
  el('wrec-descriptor').value = cs(`wpkh(${acct(root, "84'/0'/0'")})`); ctx._wrecApplyDescriptor();
  ck('…and the form leaves the address field empty and editable with the reason shown', el('wrec-first-address').value === '' && !el('wrec-first-address').readOnly &&
     /missing/.test(el('wrec-first-address-note').textContent) && /check the export/.test(el('wrec-detected').innerHTML)); }

// ---- The form ----
const MS_DESC = cs(MS[0][1]);
{ const { ctx, el, store, writes } = makeEnv();
  store['safekeepWalletRecord'] = JSON.stringify({ passphrases: [{ target: 'Set 1', value: 'old secret' }] });
  ctx.wrec_init();
  ck('opening the tool deletes a draft (with passphrase) left by an older version', !('safekeepWalletRecord' in store));
  ck('fresh form: one blank key row, manual fallback available but closed', ctx._wrecKeys.length === 1 && el('wrec-manual').style.display === 'block' && !el('wrec-manual').open);

  el('wrec-descriptor').value = MS_DESC; ctx._wrecApplyDescriptor();
  ck('pasted descriptor is read (2-of-3)', ctx._wrecMeta && ctx._wrecMeta.isMulti && ctx._wrecMeta.msN === 3);
  ck('detected summary shown, manual fields hidden', el('wrec-detected').style.display === 'block' && /2-of-3 multisig/.test(el('wrec-detected').innerHTML) &&
     /checksum OK/.test(el('wrec-detected').innerHTML) && el('wrec-manual').style.display === 'none');
  ck('one key row per descriptor key, with fingerprints', ctx._wrecKeys.length === 3 && ctx._wrecKeys.map((k) => k.fp).join() === roots.map(fpHex).join() &&
     /fingerprint <span[^>]*>[0-9A-F]{8}<\/span>/.test(el('wrec-keys-wrap').innerHTML));
  ck('first address filled in and locked', el('wrec-first-address').value === MS[0][3] && el('wrec-first-address').readOnly && /Worked out/.test(el('wrec-first-address-note').textContent));

  el('wrec-title').value = 'Family vault'; el('wrec-purpose').value = 'Long-term savings';
  ctx.wrec_onKeyInput(0, 'name', 'Dave’s Coldcard — home safe');
  ctx.wrec_onKeyInput(2, 'name', 'Seed plate — bank box');
  ctx.wrec_onKeyPassphraseToggle(2, true); ctx.wrec_onKeyInput(2, 'pp', 'Correct-Horse');
  ctx.wrec_onKeyPassphraseToggle(1, true);   // needed, but not written down
  const data = ctx._wrecCollectFormData();
  const FP = roots.map((r) => fpHex(r).toUpperCase());
  ck('record type/threshold/script come from the descriptor', data.type === 'multisig' && data.msM === '2' && data.msN === '3' && data.script === 'Native Segwit (P2WSH)');
  ck('key labels: the user’s name only, unnamed keys keep "Set N"', JSON.stringify(data.seedSets) === JSON.stringify([
     'Dave’s Coldcard — home safe', 'Set 2', 'Seed plate — bank box']), JSON.stringify(data.seedSets));
  ck('no descriptor fingerprint is printed as a key’s identity', !data.seedSets.concat(data.passphrases.map((p) => p.target)).some((t) => FP.some((f) => t.includes(f)) || /fingerprint/i.test(t)));
  ck('on screen, each row still shows its descriptor fingerprint, labelled as including any passphrase',
     FP.every((f) => el('wrec-keys-wrap').innerHTML.includes(f)) && /descriptor fingerprint/.test(el('wrec-keys-wrap').innerHTML) &&
     /includes the passphrase, if this key has one/.test(el('wrec-keys-wrap').innerHTML));
  ck('passphrases point at their keys; a blank one records only that it is needed', data.ppRequired && JSON.stringify(data.passphrases) === JSON.stringify([
     { target: 'Set 2', value: '' }, { target: 'Set 3 (Seed plate — bank box)', value: 'Correct-Horse' }]), JSON.stringify(data.passphrases));
  ck('descriptor and first address go on the record', data.descriptor === MS_DESC && data.firstAddress === MS[0][3]);
  ctx.wrec_buildPreview();
  const doc = el('wrec-preview').innerHTML;
  ck('preview shows the multisig record', /Multisignature 2-of-3/.test(doc) && /Set 1 &mdash; Dave’s Coldcard — home safe<\/div>/.test(doc) &&
     /Passphrase required:<\/strong> Yes/.test(doc) && doc.includes('Correct-Horse') && doc.includes(MS[0][3]), doc.slice(0, 300));

  // Re-pasting the same descriptor (e.g. with a trailing newline) keeps the names
  el('wrec-descriptor').value = MS_DESC + '\n'; ctx._wrecApplyDescriptor();
  ck('re-reading the descriptor keeps names and passphrases', ctx._wrecKeys[0].name.startsWith('Dave') && ctx._wrecKeys[2].pp === 'Correct-Horse');

  // Clearing the descriptor releases the auto-filled address
  el('wrec-descriptor').value = ''; ctx._wrecApplyDescriptor();
  ck('removing the descriptor clears the worked-out address and shows manual fields', el('wrec-first-address').value === '' && !el('wrec-first-address').readOnly &&
     el('wrec-manual').style.display === 'block' && el('wrec-detected').style.display === 'none');
  ck('nothing is ever written to browser storage', writes.length === 0, JSON.stringify(writes)); }

// Same printed layout as the old Pull flow for an unnamed single-sig key with a passphrase,
// except the key line no longer carries the descriptor fingerprint
{ const { ctx, el } = makeEnv();
  ctx.wrec_init();
  el('wrec-descriptor').value = cs(VEC[0][1]); ctx._wrecApplyDescriptor();
  el('wrec-title').value = 'Jane’s wallet';
  ctx.wrec_onKeyPassphraseToggle(0, true); ctx.wrec_onKeyInput(0, 'pp', 'hunter2');
  const data = ctx._wrecCollectFormData();
  const oldShape = { title: 'Jane’s wallet', purpose: '', type: 'single', msM: '1', msN: '1', script: 'Native Segwit (P2WPKH)',
    seedSets: ['Set 1'], ppRequired: true, passphrases: [{ target: 'Set 1', value: 'hunter2' }],
    descriptor: cs(VEC[0][1]), firstAddress: VEC[0][2], notes: '' };
  const a = el('a'), b = el('b');
  ctx._wrecRenderDocument(a, data, {}); ctx._wrecRenderDocument(b, oldShape, {});
  ck('record matches the old Pull flow’s layout, with the key shown by name only', a.innerHTML === b.innerHTML && a.innerHTML.length > 500);
  ck('the fingerprint appears on the record only inside the descriptor', a.innerHTML.split('73c5da0a').length === 2 && !/73C5DA0A/.test(a.innerHTML)); }

// Manual fallback
{ const { ctx, el } = makeEnv();
  ctx.wrec_init();
  el('wrec-descriptor').value = 'not a descriptor'; ctx._wrecApplyDescriptor();
  ck('unreadable descriptor: error shown, manual fields opened', el('wrec-detected').style.display === 'block' && /by hand/.test(el('wrec-detected').innerHTML) &&
     el('wrec-manual').style.display === 'block' && el('wrec-manual').open);
  el('wrec-type').value = 'multisig'; el('wrec-ms-m').value = '2'; el('wrec-ms-n').value = '4'; el('wrec-script').value = 'Nested Segwit (P2SH-P2WSH)';
  ctx.wrec_onManualShapeChange();
  ck('manual 2-of-4 gives four key rows and shows the threshold', ctx._wrecKeys.length === 4 && el('wrec-ms-threshold-wrap').style.display === 'block');
  ctx.wrec_onKeyInput(0, 'name', 'Ledger');
  el('wrec-first-address').value = '3Manual';
  const data = ctx._wrecCollectFormData();
  ck('manual record uses the typed shape and address', data.type === 'multisig' && data.msM === '2' && data.msN === '4' && data.script === 'Nested Segwit (P2SH-P2WSH)' &&
     data.seedSets[0] === 'Ledger' && data.seedSets[1] === 'Set 2' && data.firstAddress === '3Manual', JSON.stringify(data));
  el('wrec-descriptor').value = cs(VEC[1][1]); ctx._wrecApplyDescriptor();
  ck('adding a descriptor afterwards keeps the name typed on row 1', ctx._wrecKeys.length === 1 && ctx._wrecKeys[0].name === 'Ledger' && ctx._wrecKeys[0].fp === '73c5da0a');
  ck('…and replaces the typed address with the worked-out one', el('wrec-first-address').value === VEC[1][2]); }

// "Use the wallet I just built"
{ const { ctx, el, last } = makeEnv();
  ctx.wrec_init();
  await ctx.wrec_pullDescriptor();
  ck('pull with nothing built explains what to do', /Output Descriptor tool first/.test(last()), last());
  ctx.desc_state = { currentDescriptor: cs(VEC[0][1]) };
  el('desc-passphrase').value = 'sp-secret';
  await ctx.wrec_pullDescriptor();
  ck('single-sig pull: wallet read and its passphrase recorded on the key', ctx._wrecMeta && ctx._wrecKeys[0].ppOn && ctx._wrecKeys[0].pp === 'sp-secret' && /Wallet added/.test(last()), last()); }
{ const { ctx, el } = makeEnv();
  ctx.wrec_init();
  // This device holds seed #3 with a passphrase; its key (fingerprint with passphrase) is key 3 in the descriptor
  const pass = 'zoo-pass';
  const r3 = HDKey.fromMasterSeed(await bip39.mnemonicToSeed(seeds[2], pass));
  const keys = [msKeys[0], msKeys[1], acct(r3, "48'/0'/0'/2'") + '/<0;1>/*'];
  ctx.desc_state = { currentDescriptor: cs(`wsh(sortedmulti(2,${keys.join(',')}))`), loadedSeed: seeds[2] };
  el('desc-ms-passphrase').value = pass;
  await ctx.wrec_pullDescriptor();
  ck('multisig pull: passphrase goes to this device’s key, not key 1', ctx._wrecKeys[2].ppOn && ctx._wrecKeys[2].pp === pass && !ctx._wrecKeys[0].ppOn,
     JSON.stringify(ctx._wrecKeys.map((k) => [k.fp, k.ppOn]))); }

// ---- Markup ----
{ const b = SRC.slice(SRC.indexOf('<div id="wrec-builder"'), SRC.indexOf('<div id="wrec-preview-card"'));
  ck('descriptor comes first, the human details after', b.indexOf('id="wrec-descriptor"') < b.indexOf('id="wrec-title"') && b.indexOf('id="wrec-title"') < b.indexOf('id="wrec-keys-wrap"'));
  ck('type/threshold/script live in the "by hand" fallback', /<details id="wrec-manual"[\s\S]*id="wrec-type"[\s\S]*id="wrec-script"[\s\S]*<\/details>/.test(b));
  ck('old Seed Word Set / passphrase-target UI is gone', !SRC.includes('wrec-keysets-wrap') && !SRC.includes('wrec-pp-required') && !SRC.includes('_wrecPersist'));
  ck('key passphrases and the print copy are wiped on tool exit', /'\.wrec-key-pp'/.test(SRC) && /'#wrec-print-area'/.test(SRC)); }

console.log(`\nWALLET RECORD: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

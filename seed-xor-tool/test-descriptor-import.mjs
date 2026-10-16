import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import * as btcSigner from '@scure/btc-signer';
/**
 * test-descriptor-import.mjs — Output Descriptor "Verify" tab, used to import a wallet built in
 * another app (Sparrow, BlueWallet …):
 *  - Check Descriptor works with or without a seed (WATCH-ONLY / MATCH / MISMATCH), for
 *    single-sig, multisig and nested multisig, with addresses worked out from the descriptor;
 *  - bad checksums, private keys and descriptors without …/<0;1>/* are handled;
 *  - Use This Descriptor loads it as a watch-only wallet for Receive, CSV and Core export.
 * Run: node test-descriptor-import.mjs
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


function makeEnv(seedPhrase) {
  const els = {};
  const el = (id) => (els[id] ||= { id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, style: {},
    getContext: () => ({ clearRect() {} }), querySelectorAll: () => [], scrollIntoView() {} });
  const statuses = [];
  const ctx = vm.createContext({
    window: { BtcMath: { HDKey, btcSigner, bip39 }, SeedSession: { get: () => (seedPhrase ? { mnemonic: seedPhrase } : null) } },
    document: { getElementById: el, createElement: () => { const d = { set textContent(v) { d.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }; return d; } }, Uint8Array, Math, Number, String, parseInt, isNaN, setTimeout, Promise, console,
    showStatus(m, t) { statuses.push(t + ': ' + m); }, SKScanner: null,
  });
  vm.runInContext([
    ...['DESC_BIP32_PUBLIC_MAINNET', 'DESC_BIP32_PUBLIC_TESTNET', '_DESC_MAINNET_VERS', '_DESC_TESTNET_VERS', '_WREC_SCRIPTS', '_sha256K', '_B58_ALPHABET', 'DESC_RECV_SEARCH', '_descVerified', '_DESC_IMPORT_KEY_TYPES', '_DESC_IMPORT_FORMATS'].map(extractVar),
    'var desc_state = { currentDescriptor: null, imported: null };',
    'var _descRecv = { parsed: null, nodes: {}, address: "" }; var _descRecvScanner = null;',
    ...['desc_checksum', 'desc_parseKeyOrigin', '_base58decode', '_base58checkDecode', '_base58check', '_base58encode', '_sha256sync', '_sha256impl', '_rr', '_descNormalizeXpub',
        '_wrecSplitArgs', '_wrecCall', '_wrecParseDescriptor', '_wrecIndexZeroPubkey', '_wrecCompareBytes', '_wrecFirstAddress', '_wrecAddressFromPubkeys', '_wrecEscape',
        '_descChainNodes', '_descScreenAddresses', '_descRecvWallet', '_descRecvAddressAt', '_descRecvGroups', 'desc_recvReset', 'desc_recvStep', 'desc_recvShow',
        '_descRecvNormalize', '_descRecvResult', 'desc_recvCheck', 'desc_recvStopScan', '_descShowAddrExport', 'desc_arraysEqual',
        '_descImportPrivateCheck', '_descImportKey', '_descImportPath', '_descImportWithChecksum', '_descImportSetup', '_descImportBsms',
        '_descImportDescriptorList', '_descImportSingleKey', '_descImportConvert', '_descShowConverted',
        '_descVerifyAddrRows', 'desc_verify', 'desc_useVerified'].map(extract),
  ].join('\n'), ctx);
  const verify = async (d) => { statuses.length = 0; el('desc-verify-result').style.display = ''; el('desc-verify-input').value = d; await ctx.desc_verify(); return {
    shown: el('desc-verify-result').style.display === 'block', banner: el('desc-verify-banner').innerHTML.replace(/<[^>]+>/g, ' '),
    type: el('desc-verify-type').textContent, recv: el('desc-verify-recv-addrs').innerHTML, change: el('desc-verify-change-addrs').innerHTML,
    useBtn: el('desc-verify-use-btn').style.display !== 'none', status: statuses.join(' | ') }; };
  return { ctx, el, verify, statuses };
}
const cs = (body) => body + '#' + makeEnv().ctx.desc_checksum(body);
const sortB = (a) => a.slice().sort((x, y) => { for (let k = 0; k < 33; k++) if (x[k] !== y[k]) return x[k] - y[k]; return 0; });
const P2 = "48'/0'/0'/2'", P1 = "48'/0'/0'/1'";
const msPub = (roots, path, c, i) => sortB(roots.map((r) => r.derive('m/' + path).deriveChild(c).deriveChild(i).publicKey));

const WPKH = cs(`wpkh(${acct(r1, "84'/0'/0'")}/<0;1>/*)`);
const MS = cs(`wsh(sortedmulti(2,${[r1, r2, r3].map((r) => acct(r, P2) + '/<0;1>/*').join(',')}))`);
const MS_OTHERS = cs(`wsh(sortedmulti(2,${[r2, r3].map((r) => acct(r, P2) + '/<0;1>/*').join(',')}))`);
const NESTED = cs(`sh(wsh(sortedmulti(2,${[r1, r2, r3].map((r) => acct(r, P1) + '/<0;1>/*').join(',')})))`);
const NO_FP = cs(`wpkh(${r1.derive("m/84'/0'/0'").publicExtendedKey}/<0;1>/*)`);
const UNRANGED = cs(`wpkh(${acct(r1, "84'/0'/0'")})`);
const XPRV = cs(`wpkh([${fpHex(r1)}/84h/0h/0h]${r1.derive("m/84'/0'/0'").privateExtendedKey}/<0;1>/*)`);
const BADSUM = MS.slice(0, -1) + (MS.endsWith('q') ? 'p' : 'q');
const ms0 = btcSigner.p2wsh(btcSigner.p2ms(2, msPub([r1, r2, r3], P2, 0, 0))).address;
const ms7 = btcSigner.p2wsh(btcSigner.p2ms(2, msPub([r1, r2, r3], P2, 0, 7))).address;
const nestedC2 = btcSigner.p2sh(btcSigner.p2wsh(btcSigner.p2ms(2, msPub([r1, r2, r3], P1, 1, 2)))).address;

// ---- No seed loaded: watch-only ----
{
  const e = makeEnv(null);
  let r = await e.verify(MS);
  ck('2-of-3 without a seed: WATCH-ONLY banner', r.shown && /WATCH-ONLY/.test(r.banner) && /No seed is loaded/.test(r.banner), r.banner);
  ck('2-of-3 type', r.type === 'Native Segwit (P2WSH) (2-of-3)', r.type);
  ck('2-of-3 receive #0 matches an independent derivation', r.recv.includes(ms0));
  ck('Use button shown', r.useBtn);
  r = await e.verify(WPKH);
  ck('single-sig receive #0 is the BIP-84 vector', r.recv.includes('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'), r.recv.slice(0, 200));
  ck('single-sig change #0 is the BIP-84 vector', r.change.includes('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'));
  r = await e.verify('bitcoin:' + NESTED);
  ck('nested multisig with bitcoin: prefix: type', r.type === 'Nested Segwit (P2SH-P2WSH) (2-of-3)', r.type);
  ck('nested multisig change #2 matches', r.change.includes(nestedC2));
  r = await e.verify(BADSUM);
  ck('bad checksum refused', !r.shown && !r.useBtn && /checksum/.test(r.status), r.status);
  r = await e.verify(XPRV);
  ck('private key refused', !r.shown && !r.useBtn && /private key/.test(r.status), r.status);
  ck('nothing left to use after a failed check', e.ctx.desc_useVerified() === undefined && e.ctx.desc_state.currentDescriptor === null);
  r = await e.verify(UNRANGED);
  ck('missing /<0;1>/*: warned, no addresses, no Use button', r.shown && !r.useBtn && /&lt;0;1&gt;/.test(r.status) && /Not worked out/.test(r.recv), r.status);
  r = await e.verify('   ');
  ck('empty input refused', !r.shown && /Paste, scan or load/.test(r.status), r.status);
}
// ---- Seed loaded ----
{
  const e = makeEnv(ABANDON);
  ck('seed in the 2-of-3: MATCH (Key 1 of 3)', /MATCH/.test((await e.verify(MS)).banner) && /Key 1 of 3/.test((await e.verify(MS)).banner));
  ck('seed not in the multisig: MISMATCH', /MISMATCH/.test((await e.verify(MS_OTHERS)).banner));
  ck('single-sig: MATCH', /MATCH/.test((await e.verify(WPKH)).banner) && !/MISMATCH/.test((await e.verify(WPKH)).banner));
  ck('no key origin: found on a common path', /\bMATCH\b/.test((await e.verify(NO_FP)).banner) && !/MISMATCH/.test((await e.verify(NO_FP)).banner));
  ck('seed of another key: MATCH (Key 2 of 3)', /Key 2 of 3/.test((await makeEnv('legal winner thank year wave sausage worth useful legal winner thank yellow').verify(MS)).banner));
}
// ---- Use This Descriptor ----
{
  const e = makeEnv(null);
  await e.verify(MS);
  e.ctx.desc_useVerified();
  ck('imported descriptor becomes the current one', e.ctx.desc_state.currentDescriptor === MS);
  ck('marked as an imported multisig', e.ctx.desc_state.imported && e.ctx.desc_state.imported.isMulti === true);
  ck('output card shown with 5 receive rows', e.el('desc-output').style.display === 'block' && (e.el('desc-address-list').innerHTML.match(/m\/0\//g) || []).length === 5);
  ck('address export shown', e.el('desc-addr-export').style.display === 'block');
  ck('Receive panel shows #0', e.el('desc-recv-addr').innerHTML.replace(/<\/?span>/g, '').replace(/ /g, '') === ms0);
  e.el('desc-recv-check-input').value = ms7; await e.ctx.desc_recvCheck();
  ck('Receive check finds #7', /is-ok.*receive address #7/.test(e.el('desc-recv-result').className + ' ' + e.el('desc-recv-result').innerHTML));
  ck('success message', /watch-only wallet: Native Segwit \(P2WSH\), 2-of-3/.test(e.statuses.slice(-1)[0]), e.statuses.slice(-1)[0]);
  await e.verify(WPKH); e.ctx.desc_useVerified();
  ck('single-sig import marked not multisig', e.ctx.desc_state.imported.isMulti === false && e.ctx.desc_state.currentDescriptor === WPKH);
}

console.log(`\nDESCRIPTOR IMPORT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

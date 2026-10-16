import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import * as btcSigner from '@scure/btc-signer';
/**
 * test-wallet-export-import.mjs — Output Descriptor "Verify" tab: wallet exports converted to a descriptor.
 *  - BlueWallet / Coldcard / Sparrow multisig setup files, Sparrow descriptor file, BSMS 1.0,
 *    Bitcoin Core descriptor list, single keys (zpub / ypub / [fp/path]xpub / bare xpub);
 *  - every address compared with the same wallet worked out independently by embit;
 *  - refusals: count/policy mismatch, missing/unknown format, private keys, seeds, testnet,
 *    duplicates, prefix/format conflicts; plain descriptors unchanged.
 * Run: node test-wallet-export-import.mjs
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

import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
const b58c = createBase58check(sha256);
const reversion = (xpub, ver) => { const p = b58c.decode(xpub); const q = p.slice(); q[0] = ver >>> 24; q[1] = (ver >> 16) & 255; q[2] = (ver >> 8) & 255; q[3] = ver & 255; return b58c.encode(q); };
const ZPUB = 0x02aa7ed3, YPUB = 0x0295b43f, zpubV = 0x04b24746, ypubV = 0x049d7cb2, TPUB = 0x043587cf;

function makeEnv(seedPhrase) {
  const els = {};
  const el = (id) => (els[id] ||= { id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, style: {},
    getContext: () => ({ clearRect() {} }), querySelectorAll: () => [], scrollIntoView() {}, children: [],
    appendChild(c) { this.children.push(c); } });
  const statuses = [];
  const doc = { getElementById: el, createElement: () => { const d = { style: {}, set textContent(v) { d._t = String(v); d.innerHTML = d._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }, get textContent() { return d._t; } }; return d; } };
  const ctx = vm.createContext({
    window: { BtcMath: { HDKey, btcSigner, bip39 }, SeedSession: { get: () => (seedPhrase ? { mnemonic: seedPhrase } : null) } },
    document: doc, Uint8Array, Math, Number, String, parseInt, isNaN, setTimeout, Promise, console, TextDecoder,
    showStatus(m, t) { statuses.push(t + ': ' + m); }, SKScanner: null,
  });
  vm.runInContext([
    ...['DESC_BIP32_PUBLIC_MAINNET', 'DESC_BIP32_PUBLIC_TESTNET', '_DESC_MAINNET_VERS', '_DESC_TESTNET_VERS', '_WREC_SCRIPTS', '_sha256K', '_B58_ALPHABET',
        'DESC_RECV_SEARCH', '_descVerified', '_DESC_IMPORT_KEY_TYPES', '_DESC_IMPORT_FORMATS', 'DESC_VERIFY_FILE_MAX'].map(extractVar),
    'var desc_state = { currentDescriptor: null, imported: null };',
    'var _descRecv = { parsed: null, nodes: {}, address: "" }; var _descRecvScanner = null;',
    ...['desc_checksum', 'desc_parseKeyOrigin', '_base58decode', '_base58checkDecode', '_base58check', '_base58encode', '_sha256sync', '_sha256impl', '_rr', '_descNormalizeXpub',
        '_wrecSplitArgs', '_wrecCall', '_wrecParseDescriptor', '_wrecIndexZeroPubkey', '_wrecCompareBytes', '_wrecFirstAddress', '_wrecAddressFromPubkeys', '_wrecEscape',
        '_descChainNodes', '_descScreenAddresses', '_descRecvWallet', '_descRecvAddressAt', '_descRecvGroups', 'desc_recvReset', 'desc_recvStep', 'desc_recvShow',
        '_descRecvNormalize', '_descRecvResult', 'desc_recvCheck', 'desc_recvStopScan', '_descShowAddrExport', 'desc_arraysEqual',
        '_descImportPrivateCheck', '_descImportKey', '_descImportPath', '_descImportWithChecksum', '_descImportSetup', '_descImportBsms',
        '_descImportDescriptorList', '_descImportSingleKey', '_descImportFromHex', '_descImportRestoreLines', '_descImportJsonKey', '_descImportConvert', '_descShowConverted', '_descVerifyFromBytes',
        '_descVerifyAddrRows', 'desc_verify', 'desc_useVerified'].map(extract),
  ].join('\n'), ctx);
  const verify = async (text) => {
    statuses.length = 0; el('desc-verify-result').style.display = ''; el('desc-verify-input').value = text; await ctx.desc_verify();
    return { shown: el('desc-verify-result').style.display === 'block', banner: el('desc-verify-banner').innerHTML.replace(/<[^>]+>/g, ' '),
      type: el('desc-verify-type').textContent, recv: el('desc-verify-recv-addrs').innerHTML, change: el('desc-verify-change-addrs').innerHTML,
      conv: el('desc-verify-converted').style.display === 'block', convLabel: el('desc-verify-converted-label').textContent,
      convText: el('desc-verify-converted-text').textContent, convNotes: (el('desc-verify-converted-notes').children || []).map((c) => c.textContent).join(' | '),
      status: statuses.join(' | ') };
  };
  return { ctx, el, verify, statuses };
}

// Reference: the same three test seeds, keys and addresses worked out independently with embit (Python).
const REF = {
  wsh: { path: "48'/0'/0'/2'", recv0: 'bc1qm43n7nnev58aj3nrznz2xscgv98t7gxycq5pmp20a5vzfp5t0q2s7r6twa', recv5: 'bc1qze8k0l2tv6ztfz97ly733hrpjr4gm9np6e0nzpdna28c4jrc8wls9mqre0', change0: 'bc1qy0qa9lx04k0lk9lrv4542ndehul9spkcafdtcpdv38qx6ft5km2ssnce5d',
    keys: [['73c5da0a', 'xpub6DkFAXWQ2dHxq2vatrt9qyA3bXYU4ToWQwCHbf5XB2mSTexcHZCeKS1VZYcPoBd5X8yVcbXFHJR9R8UCVpt82VX1VhR28mCyxUFL4r6KFrf'], ['b8688df1', 'xpub6FQya7zGhR92kacYsNnjreouvnHJMpXYsUXnW6NJJAJRCKsa26TzDy4LdnGhEurr3d6y1J8PJ7EEMKQp74XTqYvmGJNogYXSKDszYHtF8mX'], ['28645006', 'xpub6DnEBNkSJKBYQmsbhS1sP9cNdtU5c9PLFGCjTJmxicxc13WB8zNNGQazabQpyFAGW5bV9tMko4uBxDxjUKL6dSAcx1tEbgEHtgSqyRsekh6']] },
  shwsh: { path: "48'/0'/0'/1'", recv0: '354ZuUuwopSS5CsTjYzXwgQLxVeeN2eQFJ', change0: '35VnVd9d9UAmT6A2dcjSNDicw2w9JBhxiW',
    keys: [['73c5da0a', 'xpub6DkFAXWQ2dHxnMKoSBogHrw1rgNJKR4umdbnNVNTYeCGcduxWnNUHgGptqEQWPKRmeW4Zn4FHSbLMBKEWYaMDYu47Ytg6DdFnPNt8hwn5mE'], ['b8688df1', 'xpub6FQya7zGhR92giSkXpPgPHpq85nUnqabbbNuJiae1zndR3B6Nq2QCoSWBkdLF7bkifSYSNvyTfhg4KBvKyJ94HXuEaeWZsabMnTyJiPz21N'], ['28645006', 'xpub6DnEBNkSJKBYPrWx37y4g5aeMWTdvqzpRqjkVZcif1qn76MbLC6ppoPJywRy99vFMYJCdVRbfpqaDHEvvkHan99G3UVVpFsXepeVXn79dHm']] },
  sh: { path: "45'", recv0: '3PjJCWzqKGfKFHewAB2xdHaptAnV9ehz92', change0: '3Q3es9n51nvMRU3ZNXGWy9Jt7M5ptrEWzG',
    keys: [['73c5da0a', 'xpub68jrRzQopSUSiczuqjRwvVn3CFtSEZY6a3jbT66LM3tvt1rXtYT7Udi8dt3m1qj3q8pKZjt7tqrSt7bRN4LD2vSVq1167PSA5AyM31FUHwU'], ['b8688df1', 'xpub69F7Wq4sNAW5Pn3yZHGE4hygVRSHhM7uMpkD1Ah7amz8iiCcvX5ESpLSUafwHJZP64bz5Ls69RwRZpvTLbxVpc8M59KtYQpPHnsF2MoDZJY'], ['28645006', 'xpub68BiZSLmmvzuGeX37u5t14EC29qCxnFsovHfmQp1wtZBgqnoB1ZR8YmDPyTQkFoqXTbhacTUuTjecvTH41ZtzDticzLC3KT7U4aT5t4ge8H']] },
  wpkh: { recv0: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', change0: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el' },
  shwpkh: { recv0: '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf' },
  pkh: { recv0: '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA' },
  tr: { recv0: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr' },
};
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const roots = await Promise.all([ABANDON, 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'].map(async (m) => HDKey.fromMasterSeed(await bip39.mnemonicToSeed(m, ''))));
for (const [k, ref] of Object.entries(REF).filter(([, r]) => r.keys)) {
  ck(`reference keys (${k}) agree with this machine's derivation`, ref.keys.every(([fp, xp], i) =>
    roots[i].fingerprint.toString(16).padStart(8, '0') === fp && roots[i].derive('m/' + ref.path).publicExtendedKey === xp));
}
const FP = (i) => REF.wsh.keys[i][0].toUpperCase();
const W = REF.wsh.keys.map(([, x]) => x);
const has = (r, ref) => r.shown && r.recv.includes(ref.recv0) && (!ref.change0 || r.change.includes(ref.change0));

// ---- 1. BlueWallet multisig setup file (same layout as the user's export) ----
const BLUE = `# BlueWallet Multisig setup file
# this file may contain private information
#
Name: Master vault 2026
Policy: 2 of 3
Derivation: m/48'/0'/0'/2'
Format: P2WSH

# derivation: m/48'/0'/0'/2'
${FP(0)}: ${W[0]}

# derivation: m/48'/0'/0'/2'
${FP(1)}: ${W[1]}

# derivation: m/48'/0'/0'/2'
${FP(2)}: ${W[2]}
`;
{
  const e = makeEnv(null);
  const r = await e.verify(BLUE);
  ck('BlueWallet: first receive and change addresses match embit', has(r, REF.wsh), r.status + ' ' + r.recv.slice(0, 200));
  ck('BlueWallet: labelled as converted from a BlueWallet setup file', r.conv && r.convLabel === 'Converted from BlueWallet multisig setup file', r.convLabel);
  ck('BlueWallet: descriptor shown, with origins and <0;1>', /^wsh\(sortedmulti\(2,\[73c5da0a\/48'\/0'\/0'\/2'\]xpub6DkFAX.*\/<0;1>\/\*,.*\)\)#[0-9a-z]{8}$/.test(r.convText), r.convText);
  ck('BlueWallet: type 2-of-3 P2WSH', r.type === 'Native Segwit (P2WSH) (2-of-3)', r.type);
  ck('BlueWallet: wallet name and policy noted', /Wallet name: Master vault 2026/.test(r.convNotes) && /2 of 3, Native SegWit multisig/.test(r.convNotes), r.convNotes);
  e.ctx.desc_useVerified();
  ck('BlueWallet: usable as watch-only (converted descriptor loaded)', e.ctx.desc_state.currentDescriptor === r.convText);
  const ri = (await e.verify(BLUE.replace(/\n/g, '\r\n')));
  ck('BlueWallet: Windows line endings work', has(ri, REF.wsh));
  const z = BLUE.replace(W[0], reversion(W[0], ZPUB)).replace(W[2], reversion(W[2], ZPUB));
  const rz = await e.verify(z);
  ck('BlueWallet with Zpub keys: converted to xpub, same addresses', has(rz, REF.wsh) && /Zpub converted to xpub/.test(rz.convNotes) && !/Zpub/.test(rz.convText), rz.status);
  const m = makeEnv(ABANDON);
  ck('BlueWallet with the abandon seed loaded: MATCH (Key 1 of 3)', /MATCH/.test((await m.verify(BLUE)).banner) && /Key 1 of 3/.test((await m.verify(BLUE)).banner));
}

// ---- 2. Coldcard multisig setup file ----
const CC = (fmt, ref, extra = '') => `# Coldcard Multisig setup file (created on 73C5DA0A)
#
Name: CC-2-of-3
Policy: 2 of 3
Derivation: m/${ref.path}
Format: ${fmt}
${extra}
${ref.keys.map(([fp, x]) => fp.toUpperCase() + ': ' + x).join('\n')}
`;
{
  const e = makeEnv(null);
  let r = await e.verify(CC('P2WSH', REF.wsh));
  ck('Coldcard P2WSH: addresses match embit', has(r, REF.wsh), r.status);
  ck('Coldcard: labelled', r.convLabel === 'Converted from Coldcard multisig setup file', r.convLabel);
  r = await e.verify(CC('P2WSH-P2SH', REF.shwsh));
  ck('Coldcard nested (P2WSH-P2SH): addresses match embit', has(r, REF.shwsh) && /^sh\(wsh\(sortedmulti/.test(r.convText), r.status + r.convText.slice(0, 30));
  r = await e.verify(CC('P2SH-P2WSH', REF.shwsh));
  ck('Coldcard nested (P2SH-P2WSH spelling): addresses match embit', has(r, REF.shwsh));
  r = await e.verify(CC('P2SH', REF.sh));
  ck('Coldcard legacy P2SH (m/45\'): addresses match embit', has(r, REF.sh) && /^sh\(sortedmulti/.test(r.convText), r.status);
  // Per-key Derivation lines override the default (Coldcard's mixed-path layout).
  const mixed = `# Coldcard Multisig setup file (created on 73C5DA0A)
Name: mixed
Policy: 2 of 3
Derivation: m/48'/0'/0'/2'
Format: P2WSH

73C5DA0A: ${W[0]}
Derivation: m/48'/0'/7'/2'
B8688DF1: ${W[1]}
28645006: ${W[2]}
`;
  r = await e.verify(mixed);
  ck('Coldcard per-key Derivation applies to the next key only', has(r, REF.wsh) &&
    r.convText.includes("[b8688df1/48'/0'/7'/2']") && r.convText.includes("[28645006/48'/0'/0'/2']") && r.convText.includes("[73c5da0a/48'/0'/0'/2']"), r.convText);
}

// ---- 3. Sparrow exports ----
const SPARROW_CC = `# Coldcard Multisig setup file (created by Sparrow)
#
Name: Sparrow Vault
Policy: 2 of 3
Format: P2WSH

${REF.wsh.keys.map(([fp, x]) => `Derivation: m/48'/0'/0'/2'\n${fp.toUpperCase()}: ${x}\n`).join('\n')}`;
const descBody = (suffix, h) => `wsh(sortedmulti(2,${REF.wsh.keys.map(([fp, x]) => `[${fp}/${h ? "48h/0h/0h/2h" : "48'/0'/0'/2'"}]${x}${suffix}`).join(',')}))`;
const withCs = (b) => b + '#' + makeEnv().ctx.desc_checksum(b);
const SPARROW_DESC = `# Receive and change descriptor (BIP389):
${withCs(descBody('/<0;1>/*', true))}

# Receive descriptor (Bitcoin Core):
${withCs(descBody('/0/*', true))}

# Change descriptor (Bitcoin Core):
${withCs(descBody('/1/*', true))}
`;
const BSMS = (addr) => `BSMS 1.0
${withCs(descBody('/**', false))}
/0/*,/1/*
${addr}
`;
const CORE_JSON = JSON.stringify({ wallet_name: 'vault', descriptors: [
  { desc: withCs(descBody('/0/*', true)), timestamp: 0, active: true, internal: false },
  { desc: withCs(descBody('/1/*', true)), timestamp: 0, active: true, internal: true }] }, null, 2);
{
  const e = makeEnv(null);
  let r = await e.verify(SPARROW_CC);
  ck('Sparrow (Coldcard-format export): addresses match embit', has(r, REF.wsh), r.status);
  ck('Sparrow: labelled as exported from Sparrow', r.convLabel === 'Converted from Coldcard multisig setup file (exported from Sparrow)', r.convLabel);
  r = await e.verify(SPARROW_DESC);
  ck('Sparrow descriptor file: takes the <0;1> line, addresses match', has(r, REF.wsh) && /receive-and-change/.test(r.convLabel), r.convLabel + r.status);
  r = await e.verify(BSMS(REF.wsh.recv0));
  ck('BSMS 1.0: /** expanded, first address checked, addresses match', has(r, REF.wsh) && /BSMS/.test(r.convLabel) && r.convText.includes('/<0;1>/*') && !r.convText.includes('/**'), r.status);
  r = await e.verify(BSMS(REF.wsh.recv5));
  ck('BSMS 1.0 with a different first address: refused', !r.shown && /doesn’t match the one worked out/.test(r.status), r.status);
  r = await e.verify(CORE_JSON);
  ck('Bitcoin Core descriptor list: receive + change combined, addresses match', has(r, REF.wsh) && /Combined/.test(r.convLabel), r.convLabel + r.status);
}

// ---- 4. Single keys ----
{
  const e = makeEnv(null);
  const k84 = roots[0].derive("m/84'/0'/0'").publicExtendedKey, k49 = roots[0].derive("m/49'/0'/0'").publicExtendedKey;
  const k44 = roots[0].derive("m/44'/0'/0'").publicExtendedKey, k86 = roots[0].derive("m/86'/0'/0'").publicExtendedKey;
  let r = await e.verify(reversion(k84, zpubV));
  ck('bare zpub → wpkh, says so (from the prefix)', r.recv.includes(REF.wpkh.recv0) && /Native SegWit \(P2WPKH\) — from the zpub prefix/.test(r.convNotes), r.convNotes + r.status);
  r = await e.verify(`[73c5da0a/84'/0'/0']${reversion(k84, zpubV)}`);
  ck('[fp/84\'/0\'/0\']zpub → wpkh with origin', r.recv.includes(REF.wpkh.recv0) && r.convText.startsWith("wpkh([73c5da0a/84'/0'/0']xpub"), r.convText);
  r = await e.verify(`[73c5da0a/84h/0h/0h]${k84}`);
  ck('[fp/84h…]xpub → wpkh from the path', r.recv.includes(REF.wpkh.recv0) && /from the key path m\/84'\/0'\/0'/.test(r.convNotes), r.convNotes);
  r = await e.verify(reversion(k49, ypubV));
  ck('bare ypub → sh(wpkh)', r.recv.includes(REF.shwpkh.recv0) && r.convText.startsWith('sh(wpkh('), r.convText);
  r = await e.verify(`[73c5da0a/44'/0'/0']${k44}`);
  ck('[fp/44\'…]xpub → pkh', r.recv.includes(REF.pkh.recv0));
  r = await e.verify(`[73c5da0a/86'/0'/0']${k86}`);
  ck('[fp/86\'…]xpub → tr', r.recv.includes(REF.tr.recv0) && r.convText.startsWith('tr('));
  r = await e.verify(k44);
  ck('bare xpub → Legacy, clearly marked ASSUMED', r.recv.includes(REF.pkh.recv0) && /ASSUMED/.test(r.convNotes), r.convNotes);
  ck('a key that MATCHes when a seed is loaded', /\bMATCH\b/.test((await makeEnv(ABANDON).verify(reversion(k84, zpubV))).banner));
  r = await e.verify(`[73c5da0a/49'/0'/0']${reversion(k84, zpubV)}`);
  ck('zpub with a 49\' path: refused, not guessed', !r.shown && /won’t guess/.test(r.status), r.status);
  r = await e.verify(reversion(W[0], ZPUB));
  ck('single Zpub (multisig key): refused', !r.shown && /multisig cosigner key/.test(r.status), r.status);
  r = await e.verify(`[73c5da0a/48'/0'/0'/2']${W[0]}`);
  ck('single key on a 48\' path: refused', !r.shown && /multisig cosigner path/.test(r.status), r.status);
  r = await e.verify(reversion(k84, TPUB));
  ck('tpub: refused (mainnet only)', !r.shown && /testnet/.test(r.status), r.status);
}

// ---- 5. Refusals for setup files ----
{
  const e = makeEnv(null);
  const ref = async (name, text, re) => { const r = await e.verify(text); ck(name, !r.shown && !r.conv && re.test(r.status), r.status); };
  await ref('policy 2 of 3 with only 2 keys', BLUE.replace(/# derivation: m\/48'\/0'\/0'\/2'\n28645006.*\n/i, '').replace(`${FP(2)}: ${W[2]}\n`, ''), /says 2 of 3, but the file has 2 keys/);
  await ref('policy 2 of 3 with 4 keys', BLUE + `\nDEADBEEF: ${REF.sh.keys[0][1]}\n`, /says 2 of 3, but the file has 4 keys/);
  await ref('Format line missing', BLUE.replace('Format: P2WSH\n', ''), /no “Format:” line/);
  await ref('Format unknown', BLUE.replace('Format: P2WSH', 'Format: P2TR'), /“P2TR” isn’t one SafeKeep knows/);
  await ref('Policy line missing', BLUE.replace('Policy: 2 of 3\n', ''), /no “Policy: M of N” line/);
  await ref('Zpub with Format: P2SH', CC('P2SH', REF.wsh).replace(W[0], reversion(W[0], ZPUB)), /Zpub .* won’t guess/);
  await ref('duplicate key', BLUE.replace(W[2], W[1]), /same key as Key 2/);
  await ref('xprv in the file', BLUE.replace(W[2], roots[2].derive("m/48'/0'/0'/2'").privateExtendedKey), /private key \(xprv\)/);
  await ref('seed line (BlueWallet backup with a seed)', BLUE.replace(`${FP(2)}: ${W[2]}`, `# warning! sensitive information, do not disclose ↓\nseed: letter advice cage absurd amount doctor acoustic avoid letter advice cage above\n# warning! sensitive information, do not disclose ↑`), /seed phrase/);
  await ref('WIF private key', 'wpkh(KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn)', /private key \(WIF\)/);
  await ref('testnet cosigner (tpub)', BLUE.replace(W[1], reversion(W[1], TPUB)), /testnet key \(tpub\)/);
  await ref('unrecognised text', 'hello world', /doesn’t recognise this/);
  await ref('markup in a refused field is not inserted as HTML', BLUE.replace('Format: P2WSH', 'Format: <img src=x onerror=alert(1)>'), /&lt;img src=x/);
}

// ---- 5b. Scanned or copied text that lost its form ----
{
  const e = makeEnv(null);
  let r = await e.verify(BLUE.replace(/\n/g, ''));
  ck('setup file with all line breaks lost (as in the pasted sample): addresses match', has(r, REF.wsh) && r.convLabel === 'Converted from BlueWallet multisig setup file', r.status);
  ck('… and the per-key paths and wallet name are kept', r.convText.includes("[28645006/48'/0'/0'/2']") && /Wallet name: Master vault 2026$|Wallet name: Master vault 2026 \|/.test(r.convNotes), r.convNotes);
  r = await e.verify(BLUE.replace(/\n+/g, ' '));
  ck('setup file with line breaks turned into spaces: addresses match', has(r, REF.wsh), r.status);
  r = await e.verify(Buffer.from(BLUE, 'utf8').toString('hex'));
  ck('setup file received as hex digits: decoded, addresses match', has(r, REF.wsh), r.status);
  r = await e.verify(BLUE.replace(`${FP(2)}: ${W[2]}`, `# warning! sensitive information ↓\nseed: letter advice cage absurd amount doctor acoustic avoid letter advice cage above`).replace(/\n/g, ''));
  ck('collapsed file with a seed line: still refused as private', !r.shown && /seed phrase/.test(r.status), r.status);
  r = await e.verify(JSON.stringify({ xfp: '73C5DA0A', xpub: reversion(W[0], ZPUB), path: "m/48'/0'/0'/2'" }));
  ck('one cosigner\'s key export (JSON): clear refusal, not "unrecognised"', !r.shown && /multisig cosigner key/.test(r.status), r.status);
  const k84 = roots[0].derive("m/84'/0'/0'").publicExtendedKey;
  r = await e.verify(JSON.stringify({ xfp: '73C5DA0A', xpub: k84, path: "m/84'/0'/0'" }));
  ck('single-sig key export (JSON) → wpkh with origin', r.recv.includes(REF.wpkh.recv0) && /JSON/.test(r.convLabel), r.convLabel + r.status);
  r = await e.verify('hello world, not a wallet');
  ck('unrecognised text: the message shows what was received', /Received 25 characters, starting “hello world, not a wallet”/.test(r.status), r.status);
}

// ---- 6. Plain descriptors keep working exactly as before ----
{
  const e = makeEnv(null);
  const plain = withCs(descBody('/<0;1>/*', false));
  const c = e.ctx._descImportConvert(plain);
  ck('plain descriptor passed through untouched', c.ok && c.converted === false && c.descriptor === plain);
  const r = await e.verify(plain);
  ck('plain descriptor: no "converted" card, same addresses', !r.conv && has(r, REF.wsh));
  const c2 = e.ctx._descImportConvert('bitcoin:' + plain);
  ck('bitcoin: prefix still stripped', c2.descriptor === plain && !c2.converted);
}

// ---- 7. Files and Courier transfers (bytes → text → check) ----
{
  const e = makeEnv(null);
  e.ctx._descVerifyFromBytes(new TextEncoder().encode('﻿' + BLUE), 'Master vault 2026.txt');
  await new Promise((r) => setTimeout(r, 50));
  ck('a file is decoded as UTF-8 (BOM dropped) and checked', e.el('desc-verify-input').value.startsWith('# BlueWallet') && e.el('desc-verify-result').style.display === 'block');
  e.ctx._descVerifyFromBytes(new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x00, 0x01]), '<b>x</b>.psbt');
  ck('a binary file is refused, its name escaped', /isn’t a text file/.test(e.statuses.slice(-1)[0]) && /&lt;b&gt;/.test(e.statuses.slice(-1)[0]), e.statuses.slice(-1)[0]);
}
{
  const html = SRC;
  ck('scanner routes Courier file frames to the Verify input', /parseCourierFrame\(trimmed\)[\s\S]{0,200}_descvHandleCourierFrame\(courierFrame\)/.test(html));
  ck('ur:bytes decoded as UTF-8 text', /new TextDecoder\('utf-8'\)\.decode\(new Uint8Array\(bytes\)\)/.test(html));
  ck('Load File button and file input present', /id="desc-verify-file-input"[^>]*onchange="desc_verifyLoadFile\(event\)"/.test(html));
}

console.log(`\nWALLET EXPORT IMPORT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

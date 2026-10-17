/**
 * test-saved-wallets.mjs — saved wallets (Output Descriptor tool → vault → PSBT Signer).
 *  1. _psbtSavedWalletCheck on real PSBTs built with @scure/btc-signer: inputs are matched to the
 *     saved wallet by deriving its address at the PSBT's claimed path (never by trusting the PSBT),
 *     a "diet" multisig change output (no witnessScript) that is the saved wallet's change becomes
 *     verified-change and clears the acknowledgment gate, while an attacker's output with the same
 *     claimed path stays unverified, a hijack stays blocked, and a payment to your own saved wallet
 *     still needs its destination checkbox.
 *  2. The review banner (spends from / partly from / not from a saved wallet), names escaped.
 *  3. Output Descriptor: what can be saved (no private keys, no Silent Payments, needs …/<0;1>/*),
 *     duplicate descriptor / duplicate name, checksum added, open and remove.
 *  4. Storage end to end: SafeKeepOS.saveSavedWallets' download → the File Router's patterns never
 *     claim it (even for a wallet named "passphrase") → the Wallets Watcher's Python in
 *     safekeep-boot.sh → loadSavedWallets reads it back. The watcher refuses private keys, oversize
 *     files, too many wallets and bad names.
 * Needs python3. Run: node test-saved-wallets.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'boot.html'), 'utf8');
const BOOTJS = readFileSync(join(HERE, 'shared', 'boot.js'), 'utf8');
const BOOTSH = readFileSync(join(HERE, '..', 'usbbootdrive', 'safekeep-boot.sh'), 'utf8');

function extractBlock(src, start) {
  let i = src.indexOf('{', start), j = i, depth = 0, str = null;
  for (; j < src.length; j++) {
    const c = src[j], n = src[j + 1];
    if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
    if (c === '/' && n === '/') { j = src.indexOf('\n', j); continue; }
    if (c === '/' && n === '*') { j = src.indexOf('*/', j) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return j + 1;
}
function extract(name, src = SRC) {
  const m = new RegExp('(^|\\n)[ \\t]*(async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + name);
  let p = src.indexOf('(', m.index + m[0].length - 1), depth = 0;
  for (; p < src.length; p++) { if (src[p] === '(') depth++; else if (src[p] === ')') { depth--; if (depth === 0) break; } }
  return src.slice(m.index, extractBlock(src, p));
}
// boot.js functions sit inside the SafeKeepOS closure, two spaces in; their regex literals
// hold quotes, so take everything up to the closing brace at that same indent.
function extractBootJs(name) {
  const m = new RegExp('\\n  (async\\s+)?function\\s+' + name + '\\s*\\(').exec(BOOTJS);
  if (!m) throw new Error('not found in boot.js: ' + name);
  return BOOTJS.slice(m.index, BOOTJS.indexOf('\n  }\n', m.index) + 4);
}
function extractVar(name) {
  const m = new RegExp('\\nvar ' + name + '\\s*=').exec(SRC);
  if (!m) throw new Error('var not found: ' + name);
  const after = SRC.slice(m.index + m[0].length).trimStart();
  if (after[0] === '{') { const s = m.index + m[0].length + SRC.slice(m.index + m[0].length).indexOf('{'); return SRC.slice(m.index, extractBlock(SRC, s)) + ';'; }
  return SRC.slice(m.index, SRC.indexOf(';', m.index) + 1);
}

let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c || x === undefined ? '' : '  -> ' + x)); };

// ---- A VM holding the real audit, descriptor parser, saved-wallet and Output Descriptor code ----
const els = {};
const el = (id) => (els[id] ||= { id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, style: { display: '' }, focus() {}, scrollIntoView() {} });
const statuses = [];
const memStore = { list: [] };
const ctx = vm.createContext({
  window: {
    BtcMath: { btcSigner: btc, HDKey, bip39, wordlist },
    SafeKeepOS: {
      loadSavedWallets: async () => memStore.list.map((w) => ({ ...w })),
      saveSavedWallets: async (list) => { memStore.list = list.map((w) => ({ ...w })); return { saved: true }; },
    },
  },
  document: { getElementById: el, createElement: () => { let t = ''; return { set textContent(v) { t = v; }, get innerHTML() { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); } }; } },
  console: { log() {}, warn() {}, error() {} }, Uint8Array, Uint32Array, DataView, BigInt, Number, String, Array, Object, Map, Set, Math, Error, ArrayBuffer, parseInt, isNaN, Date,
  showStatus: (m, t) => statuses.push(t + ':' + m), confirm: () => true,
  PSBT_NETWORK: btc.NETWORK, PSBT_WILDCARD_FP: '00000000', _psbtLoadedBytes: null, _psbtHwMode: false,
  _psbtSnapshotSpOutputs: () => [], _psbtVerifySilentPayments: () => null,
  _descLoadWatchOnly: (d, p, msg) => statuses.push('open:' + msg + d),
});
vm.runInContext([
  ...['DESC_BIP32_PUBLIC_MAINNET', 'DESC_BIP32_PUBLIC_TESTNET', '_DESC_MAINNET_VERS', '_DESC_TESTNET_VERS', '_WREC_SCRIPTS', '_sha256K', '_B58_ALPHABET'].map(extractVar),
  'var _savedWallets = [], _savedWalletsLoading = null; var desc_state = { currentDescriptor: "" };',
  ...['_psbtAuditOutputs', '_psbtExpectedScript', '_psbtScriptsEqual', '_psbtGetDerivEntries', '_psbtNormalizeFp', '_psbtPurposeToType', '_psbtFormatPath',
      '_psbtDetectMultisig', '_psbtVerifyMultisigChange', '_psbtMultisigWalletBinding', '_psbtSavedWalletCheck', '_psbtSavedWalletList', '_psbtAuditWithSavedWallets',
      '_psbtSavedWalletBannerHtml', '_psbtEscape',
      'desc_checksum', 'desc_parseKeyOrigin', '_base58decode', '_base58checkDecode', '_base58check', '_base58encode', '_sha256sync', '_sha256impl', '_rr',
      '_descNormalizeXpub', '_wrecEscape', '_wrecSplitArgs', '_wrecCall', '_wrecParseDescriptor', '_wrecIndexZeroPubkey', '_wrecCompareBytes',
      '_wrecFirstAddress', '_wrecAddressFromPubkeys', '_descChainNodes', '_descImportPrivateCheck',
      '_savedWalletBody', '_savedWalletParse', '_savedWalletSummary', 'savedWallets_load', '_savedWalletsStore', '_descRenderSavedWallets', '_descSaveResult',
      'desc_saveWallet', 'desc_openSavedWallet', 'desc_removeSavedWallet'].map((n) => extract(n)),
].join('\n'), ctx);
const cs = (body) => body + '#' + ctx.desc_checksum(body);

// ---- Keys ----
const H = 0x80000000;
const seedKey = async (m) => HDKey.fromMasterSeed(await bip39.mnemonicToSeed(m, ''));
const me = await seedKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const co1 = await seedKey('legal winner thank year wave sausage worth useful legal winner thank yellow');
const co2 = await seedKey('letter advice cage absurd amount doctor acoustic avoid letter advice cage above');
const att = HDKey.fromMasterSeed(randomBytes(32));
const myFp = (me.fingerprint >>> 0).toString(16).toUpperCase().padStart(8, '0');
const fpHex = (k) => (k.fingerprint >>> 0).toString(16).padStart(8, '0');
const acct = (k, path) => `[${fpHex(k)}/${path.replace(/'/g, 'h')}]${k.derive('m/' + path).publicExtendedKey}`;
const audit = (t, wallets, key = me, fp = myFp) => {
  const tx = btc.Transaction.fromPSBT(t.toPSBT());
  vm.runInContext('_savedWallets = ' + JSON.stringify(wallets.map((w) => ({ name: w[0], descriptor: w[1], added: '' }))), ctx);
  return ctx._psbtAuditWithSavedWallets(tx, key, fp);
};
const outCat = (r, i) => r.outputs.find((o) => o.index === i);

// ======== 1a. Single-sig (BIP-84) ========
console.log('Single-sig wallet:');
const SS = cs(`wpkh(${acct(me, "84'/0'/0'")}/<0;1>/*)`);
const ssKey = (c, i) => me.derive(`m/84'/0'/0'/${c}/${i}`);
const ssPath = (c, i) => [84 + H, H, H, c, i];
function ssTx({ inputs = [[0, 0]], change = [1, 3], changeKey } = {}) {
  const t = new btc.Transaction();
  for (const [c, i] of inputs) {
    const k = ssKey(c, i);
    t.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: btc.p2wpkh(k.publicKey).script, amount: 50_000_000n },
      bip32Derivation: [[k.publicKey, { fingerprint: me.fingerprint, path: ssPath(c, i) }]] });
  }
  t.addOutput({ script: btc.p2wpkh(att.publicKey).script, amount: 10_000_000n });
  const ck2 = changeKey || ssKey(...change);
  t.addOutput({ script: btc.p2wpkh(ck2.publicKey).script, amount: BigInt(inputs.length) * 50_000_000n - 10_010_000n,
    bip32Derivation: [[ck2.publicKey, { fingerprint: me.fingerprint, path: ssPath(...change) }]] });
  return t;
}
{
  const r = audit(ssTx({ inputs: [[0, 0], [0, 7], [1, 2]] }), [['Daily', SS]]);
  ck('every input matched to the saved wallet', r.savedWallets.inputs.every((x) => x.wallet === 'Daily') && r.savedWallets.unmatchedInputs.length === 0, JSON.stringify(r.savedWallets));
  ck('input paths reported (0/0, 0/7, 1/2)', r.savedWallets.inputs.map((x) => x.chain + '/' + x.child).join(' ') === '0/0 0/7 1/2');
  ck('change stays verified-change and names the saved wallet (change #3)', outCat(r, 1).category === 'verified-change' && outCat(r, 1).savedWallet?.name === 'Daily' && outCat(r, 1).savedWallet.child === 3);
  ck('the payment is still a destination, not marked as yours', outCat(r, 0).category === 'destination' && !outCat(r, 0).savedWallet);
  const b = ctx._psbtSavedWalletBannerHtml(r);
  ck('banner: spends from your saved wallet (all 3 inputs)', /success/.test(b) && /Spends from your saved wallet<\/strong> <strong>“Daily”<\/strong> \(all 3 inputs\)/.test(b), b);
}
{
  const r = audit(ssTx(), []);
  ck('no saved wallets: nothing matched, nothing changed', r.savedWallets.count === 0 && r.savedWallets.inputs.length === 0 && outCat(r, 1).category === 'verified-change' && !outCat(r, 1).savedWallet);
  ck('no saved wallets: banner points to the Output Descriptor tool', /No saved wallets yet/.test(ctx._psbtSavedWalletBannerHtml(r)));
}
{
  const r = audit(ssTx({ changeKey: att, change: [1, 0] }), [['Daily', SS]]);
  ck('hijack (my fingerprint, attacker script) stays a blocked hijack', outCat(r, 1).category === 'hijack' && r.hijackDetected && !outCat(r, 1).savedWallet);
}
{
  // An input from another wallet of mine that isn't saved (BIP-86 Taproot).
  const t = ssTx();
  const tk = me.derive("m/86'/0'/0'/0/0");
  t.addInput({ txid: randomBytes(32), index: 1, witnessUtxo: { script: btc.p2tr(tk.publicKey.slice(1)).script, amount: 1_000_000n },
    tapBip32Derivation: [[tk.publicKey.slice(1), { hashes: [], der: { fingerprint: me.fingerprint, path: [86 + H, H, H, 0, 0] } }]] });
  const r = audit(t, [['Daily', SS]]);
  ck('input from an unsaved wallet is reported as unmatched (input 1)', r.savedWallets.unmatchedInputs.join() === '1');
  const b = ctx._psbtSavedWalletBannerHtml(r);
  ck('banner: partly from a saved wallet, names input 1', /warning/.test(b) && /Partly from a saved wallet/.test(b) && /but input 1 doesn&rsquo;t match any saved wallet/.test(b), b);
  const r2 = audit(t, [['Daily', SS], ['Taproot', cs(`tr(${acct(me, "86'/0'/0'")}/<0;1>/*)`)]]);
  ck('… and matched once its Taproot wallet is saved too', r2.savedWallets.unmatchedInputs.length === 0 && r2.savedWallets.inputs[1].wallet === 'Taproot');
  const b2 = ctx._psbtSavedWalletBannerHtml(r2);
  ck('banner: spends from two saved wallets, with input counts', /“Daily”<\/strong> \(1 input\) and <strong>“Taproot”<\/strong> \(1 input\)/.test(b2), b2);
}
{
  const r = audit(ssTx(), [['Other', cs(`wpkh(${acct(co1, "84'/0'/0'")}/<0;1>/*)`)]]);
  const b = ctx._psbtSavedWalletBannerHtml(r);
  ck('banner: not from a saved wallet when no input matches', /Not from a saved wallet/.test(b) && /the input doesn&rsquo;t match any of your saved wallets/.test(b), b);
}
{
  // The PSBT lies about the path: input really at 0/0 but claims 0/5 → no match (we derive, never trust).
  const t = new btc.Transaction(); const k = ssKey(0, 0);
  t.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: btc.p2wpkh(k.publicKey).script, amount: 1_000_000n },
    bip32Derivation: [[k.publicKey, { fingerprint: me.fingerprint, path: ssPath(0, 5) }]] });
  t.addOutput({ script: btc.p2wpkh(att.publicKey).script, amount: 900_000n });
  ck('wrong claimed path: no match', audit(t, [['Daily', SS]]).savedWallets.unmatchedInputs.join() === '0');
  const t2 = new btc.Transaction();
  t2.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: btc.p2wpkh(k.publicKey).script, amount: 1_000_000n },
    bip32Derivation: [[k.publicKey, { fingerprint: me.fingerprint, path: [84 + H, H, H, 0 + H, 0] }]] });
  t2.addOutput({ script: btc.p2wpkh(att.publicKey).script, amount: 900_000n });
  ck('hardened chain step is never used as a claim', audit(t2, [['Daily', SS]]).savedWallets.unmatchedInputs.join() === '0');
}
{
  // Legacy input with only nonWitnessUtxo.
  const PKH = cs(`pkh(${acct(me, "44'/0'/0'")}/<0;1>/*)`);
  const k = me.derive("m/44'/0'/0'/0/4");
  const prev = new btc.Transaction(); prev.addInput({ txid: randomBytes(32), index: 0 });
  prev.addOutput({ script: btc.p2wpkh(att.publicKey).script, amount: 1n });
  prev.addOutput({ script: btc.p2pkh(k.publicKey).script, amount: 2_000_000n });
  const t = new btc.Transaction();
  t.addInput({ txid: prev.id, index: 1, nonWitnessUtxo: prev.toBytes(true, false),
    bip32Derivation: [[k.publicKey, { fingerprint: me.fingerprint, path: [44 + H, H, H, 0, 4] }]] });
  t.addOutput({ script: btc.p2wpkh(att.publicKey).script, amount: 1_900_000n });
  const r = audit(t, [['Old', PKH]]);
  ck('legacy input read from nonWitnessUtxo matches (receive #4)', r.savedWallets.inputs[0].wallet === 'Old' && r.savedWallets.inputs[0].child === 4, JSON.stringify(r.savedWallets));
}

// ======== 1b. Multisig 2-of-3, including a "diet" PSBT ========
console.log('Multisig 2-of-3 wallet:');
const MS_PATH = "48'/0'/0'/2'";
const cosigners = [me, co1, co2];
const MS = cs(`wsh(sortedmulti(2,${cosigners.map((k) => acct(k, MS_PATH) + '/<0;1>/*').join(',')}))`);
const msKeys = (c, i) => cosigners.map((k) => k.derive(`m/${MS_PATH}/${c}/${i}`));
const msPay = (keys) => btc.p2wsh(btc.p2ms(2, keys.map((k) => k.publicKey).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))));
const msDer = (keys, c, i, who = [0, 1, 2]) => who.map((j) => [keys[j].publicKey, { fingerprint: cosigners[j].fingerprint, path: [48 + H, H, H, 2 + H, c, i] }]);
function msTx({ diet = false, changeScriptKeys } = {}) {
  const t = new btc.Transaction();
  const ik = msKeys(0, 2), ip = msPay(ik);
  t.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: ip.script, amount: 30_000_000n }, witnessScript: ip.witnessScript, bip32Derivation: msDer(ik, 0, 2) });
  t.addOutput({ script: btc.p2wpkh(att.publicKey).script, amount: 5_000_000n });
  const ck2 = msKeys(1, 0), cp = msPay(changeScriptKeys || ck2);
  const out = { script: cp.script, amount: 24_990_000n, bip32Derivation: msDer(ck2, 1, 0, diet ? [0] : [0, 1, 2]) };
  if (!diet) out.witnessScript = cp.witnessScript;
  t.addOutput(out);
  return t;
}
{
  const r = audit(msTx({ diet: true }), []);
  ck('diet PSBT without saved wallets: change is unverified and gated', outCat(r, 1).category === 'unverified-change' && r.unverifiedChangeDetected);
  const r2 = audit(msTx({ diet: true }), [['Family Vault', MS]]);
  ck('diet PSBT with the saved wallet: change becomes verified-change', outCat(r2, 1).category === 'verified-change' && /saved wallet “Family Vault”/.test(outCat(r2, 1).auditDetail), outCat(r2, 1).auditDetail);
  ck('… and the acknowledgment gate is cleared', !r2.unverifiedChangeDetected && r2.unverifiedChangeOutputs.length === 0);
  ck('… and the multisig input is matched', r2.savedWallets.inputs[0].wallet === 'Family Vault');
  ck('banner names the multisig wallet', /“Family Vault”/.test(ctx._psbtSavedWalletBannerHtml(r2)));
}
{
  // ATTACK: diet change output to a 2-of-3 {me, attacker, attacker} at the claimed path 1/0.
  const evil = [msKeys(1, 0)[0], att.derive('m/0'), att.derive('m/1')];
  const r = audit(msTx({ diet: true, changeScriptKeys: evil }), [['Family Vault', MS]]);
  ck('ATTACK diet change to a foreign quorum stays unverified and gated', outCat(r, 1).category === 'unverified-change' && r.unverifiedChangeDetected && !outCat(r, 1).savedWallet);
}
{
  const r = audit(msTx(), [['Family Vault', MS]]);
  ck('full PSBT without global xpubs: change bound to the wallet via the saved descriptor', outCat(r, 1).category === 'verified-change' && outCat(r, 1).savedWallet?.name === 'Family Vault');
}
{
  // Paying into another saved wallet (my single-sig receive #5): still a destination with a note.
  const t = msTx(); const k = ssKey(0, 5);
  t.addOutput({ script: btc.p2wpkh(k.publicKey).script, amount: 1n, bip32Derivation: [[k.publicKey, { fingerprint: me.fingerprint, path: ssPath(0, 5) }]] });
  const r = audit(t, [['Family Vault', MS], ['Daily', SS]]);
  ck('payment to your own saved wallet stays a destination (checkbox kept)', outCat(r, 2).category === 'destination' && outCat(r, 2).savedWallet?.name === 'Daily' && outCat(r, 2).savedWallet.chain === 0);
}
{
  const r = audit(msTx(), [['<img src=x onerror=alert(1)>', MS]]);
  const b = ctx._psbtSavedWalletBannerHtml(r);
  ck('wallet names are HTML-escaped in the banner', !b.includes('<img') && b.includes('&lt;img'), b);
}

// ======== 3. Output Descriptor: save / open / remove ========
console.log('Output Descriptor saved wallets:');
const save = async (name, desc) => { el('desc-save-name').value = name; vm.runInContext('desc_state.currentDescriptor = ' + JSON.stringify(desc), ctx); await ctx.desc_saveWallet(); return el('desc-save-result').textContent; };
{
  memStore.list = [];
  let m = await save('Family Vault', MS);
  ck('saves a multisig descriptor', /Saved as “Family Vault”/.test(m) && memStore.list.length === 1 && memStore.list[0].descriptor === MS, m);
  m = await save('Family Vault copy', MS);
  ck('the same descriptor twice is refused (already saved)', /Already saved as “Family Vault”/.test(m) && memStore.list.length === 1, m);
  m = await save('family vault', SS);
  ck('a name already used is refused (any case)', /already called/.test(m) && memStore.list.length === 1, m);
  const noCs = `wpkh(${acct(me, "84'/0'/0'")}/<0;1>/*)`;
  m = await save('Daily', noCs);
  ck('a descriptor without checksum is saved with one added', memStore.list.length === 2 && memStore.list[1].descriptor === cs(noCs), m);
  m = await save('Bad', cs(`wpkh(${me.derive("m/84'/0'/0'").privateExtendedKey}/<0;1>/*)`));
  ck('a descriptor with a private key (xprv) is refused', /private key/.test(m) && memStore.list.length === 2, m);
  m = await save('Unranged', cs(`wpkh(${acct(me, "84'/0'/0'")})`));
  ck('a descriptor without …/<0;1>/* is refused', /^Not saved/.test(m) && memStore.list.length === 2, m);
  m = await save('', SS);
  ck('a name is required', /name/.test(m) && memStore.list.length === 2, m);
  m = await save('x'.repeat(65), cs(`wpkh(${acct(co1, "84'/0'/0'")}/<0;1>/*)`));
  ck('names longer than 64 characters are refused', /64/.test(m) && memStore.list.length === 2, m);
  ck('saved list shown with type and first address', /Family Vault/.test(el('desc-saved-list').innerHTML) && /2-of-3 multisig/.test(el('desc-saved-list').innerHTML) && /bc1q/.test(el('desc-saved-list').innerHTML));
  ctx.desc_openSavedWallet(1);
  ck('Open loads the saved descriptor as watch-only', statuses.some((s) => s.startsWith('open:Opened saved wallet “Daily”') && s.endsWith(cs(noCs))));
  await ctx.desc_removeSavedWallet(0);
  ck('Remove deletes only that wallet', memStore.list.length === 1 && memStore.list[0].name === 'Daily');
}

// ======== 4. Storage: boot.js → File Router → Wallets Watcher → boot.js ========
console.log('Vault storage:');
const py = BOOTSH.slice(BOOTSH.indexOf("<<'SWPYEOF'\n") + 12, BOOTSH.indexOf('\nSWPYEOF', BOOTSH.indexOf("<<'SWPYEOF'\n")));
const dir = mkdtempSync(join(tmpdir(), 'skw-'));
const watcher = (content) => {
  const src = join(dir, 'SAVED_WALLETS.json'), dst = join(dir, 'saved-wallets.json.tmp');
  writeFileSync(src, content); rmSync(dst, { force: true });
  const r = spawnSync('python3', ['-I', '-', src, dst], { input: py, encoding: 'utf8' });
  return { ok: r.status === 0, err: r.stderr, out: existsSync(dst) ? JSON.parse(readFileSync(dst, 'utf8')) : null };
};
const stored = { file: null };
const downloads = [];
const osCtx = vm.createContext({
  JSON, Array, Object, String, Date, Promise, Math, console: { log() {}, warn() {}, error() {} },
  isBootDrive: () => true, _ccTemporarySession: () => osCtx.__temp === true, _isVaultMounted: async () => true, _sleep: async () => {},
  _silentDownload: (name, content) => {
    downloads.push({ name, content });
    // The File Router claims any JSON in seeds/ containing these exact strings.
    if (/"passphrase"/.test(content) || /"safekeep-2fa-backup"/.test(content)) return true;   // stolen → never stored
    const r = watcher(content);
    if (r.ok) stored.file = JSON.stringify(r.out);
    return true;
  },
  fetch: async () => (stored.file ? { ok: true, json: async () => JSON.parse(stored.file) } : { ok: false }),
  VAULT_ROOT: '/media/.safekeep-vault',
});
vm.runInContext([
  "const SAVED_WALLETS_FILE = 'SAVED_WALLETS.json'; const SAVED_WALLETS_URL = 'file:///x'; const SAVED_WALLETS_MAX = 50; let _savedWalletsMem = [];",
  ...['_cleanWalletList', 'loadSavedWallets', 'saveSavedWallets'].map(extractBootJs),
].join('\n'), osCtx);
{
  const list = [{ name: 'Family Vault', descriptor: MS, added: '2026-10-17T00:00:00Z' }, { name: 'passphrase', descriptor: SS, added: '' }, { name: 'safekeep-2fa-backup', descriptor: cs(`wpkh(${acct(co1, "84'/0'/0'")}/<0;1>/*)`), added: '' }];
  const r = await osCtx.saveSavedWallets(list);
  ck('save reaches the vault and is confirmed by reading it back', r.saved === true, JSON.stringify(r));
  ck('the download is SAVED_WALLETS.json', downloads.at(-1).name === 'SAVED_WALLETS.json');
  ck('wallets named "passphrase" / the 2FA marker don’t trip the File Router', !/"passphrase"/.test(downloads.at(-1).content) && !/"safekeep-2fa-backup"/.test(downloads.at(-1).content));
  const back = await osCtx.loadSavedWallets();
  ck('load returns the same wallets, names intact', back.length === 3 && back[1].name === 'passphrase' && back[2].name === 'safekeep-2fa-backup' && back[0].descriptor === MS, JSON.stringify(back));
  ck('stored file has only name, descriptor, added', Object.keys(JSON.parse(stored.file).wallets[0]).join() === 'name,descriptor,added');
  osCtx.__temp = true;
  const t = await osCtx.saveSavedWallets(list);
  ck('a Temporary Session refuses to save and loads nothing', t.saved === false && /Temporary Session/.test(t.error) && (await osCtx.loadSavedWallets()).length === 0);
  osCtx.__temp = false;
  ck('client refuses more than 50 wallets', (await osCtx.saveSavedWallets(Array.from({ length: 51 }, (_, i) => ({ name: 'w' + i, descriptor: SS })))).saved === false);
}
{
  const ok = (wallets) => watcher(JSON.stringify({ version: 1, wallets }));
  ck('watcher stores a valid list', ok([{ name: '  Spaced  ', descriptor: SS }]).out?.wallets[0].name === 'Spaced');
  ck('watcher refuses an xprv', !ok([{ name: 'x', descriptor: `wpkh(${me.derive("m/84'/0'/0'").privateExtendedKey}/<0;1>/*)` }]).ok);
  const wif = createBase58check(sha256).encode(Uint8Array.from([0x80, ...me.derive("m/84'/0'/0'/0/0").privateKey, 1]));
  ck('watcher refuses a WIF private key', !ok([{ name: 'x', descriptor: `wpkh(${wif})` }]).ok);
  ck('watcher allows a public key that merely looks long', ok([{ name: 'x', descriptor: SS }]).ok);
  ck('watcher refuses 51 wallets', !ok(Array.from({ length: 51 }, (_, i) => ({ name: 'w' + i, descriptor: SS }))).ok);
  ck('watcher refuses a control character in a name', !ok([{ name: 'a\nb', descriptor: SS }]).ok);
  ck('watcher refuses an empty name', !ok([{ name: '   ', descriptor: SS }]).ok);
  ck('watcher refuses a 65-character name', !ok([{ name: 'x'.repeat(65), descriptor: SS }]).ok);
  ck('watcher refuses a descriptor with a quote', !ok([{ name: 'x', descriptor: SS + '"' }]).ok);
  ck('watcher refuses a 4 KB+ descriptor', !ok([{ name: 'x', descriptor: 'a'.repeat(4097) }]).ok);
  ck('watcher refuses a file over 256 KB', !watcher(JSON.stringify({ wallets: [], pad: 'x'.repeat(262144) })).ok);
  ck('watcher refuses a file without a wallet list', !watcher('{"settings":{}}').ok && !watcher('not json').ok);
  ck('watcher stores an empty list (all wallets removed)', ok([]).out?.wallets.length === 0);
}
{
  ck('watcher only runs in normal boots', /SAVED_WALLETS\*\.json[\s\S]{0,200}EPHEMERAL_MODE" != "1"/.test(BOOTSH));
  ck('watcher writes into settings/ (backed up, restored, wiped with it)', /SAVED_WALLETS_STORED="\$VAULT_MOUNT\/settings\/saved-wallets\.json"/.test(BOOTSH));
  ck('the PSBT Signer reads the list when it opens and waits for it', /_savedWalletsLoading = savedWallets_load\(\);/.test(SRC) && /await _savedWalletsLoading/.test(SRC));
  ck('both audit paths include the saved-wallet check', (SRC.match(/= _psbtAuditWithSavedWallets\(tx, masterKey, my/g) || []).length === 2 && (SRC.match(/= _psbtAuditOutputs\(tx/g) || []).length === 1);
}
rmSync(dir, { recursive: true, force: true });

console.log(`\nSAVED WALLETS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

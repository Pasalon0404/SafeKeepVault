/**
 * test-review-regressions.mjs — regression tests for the second tool-by-tool review.
 *
 *  1. BIP-39 passphrases are never trimmed anywhere (a trimmed passphrase is a
 *     different wallet; the Output Descriptor + temp-seed screens used to trim).
 *  2. SLIP-39 and Seed XOR recovery show the recovered fingerprint BEFORE anything
 *     is written to the vault (a wrong SLIP-39 passphrase / wrong XOR share is
 *     otherwise undetectable). SLIP-39 shows both readings (SafeKeep / Trezor) and
 *     writes only when the user picks Restore This Wallet.
 *  3. Transfer-drive file names can't inject markup into the backup list.
 *  4. The PSBT review warns on an absurd fee and on outputs > inputs.
 *  6. A printed Shamir share carries no word of the seed (it used to print
 *     the seed's last word, which gives away part of the seed).
 *  5. The dashboard's "Mount Transfer Drive" button stays hidden while the
 *     drive mounts by itself; it appears only if that fails (it used to flash
 *     on screen at every unlock).
 *  7. Seed Management: a typed passphrase must be typed twice before any key
 *     is shown or exported, and its "Output Descriptor (BIP-380)" format is
 *     the same descriptor Output Descriptor makes (it used to be a bare
 *     [fp/path]zpub key, which isn't a valid descriptor).
 *
 * Run: node test-review-regressions.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as bip39 from '@scure/bip39'; import { wordlist } from '@scure/bip39/wordlists/english.js'; import { HDKey } from '@scure/bip32';
import { generateMnemonics, combineMnemonics } from 'shamir-mnemonic-ts';
import * as btcSigner from '@scure/btc-signer';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
process.env.BOOT = join(__dirname, 'boot.html');
// Extract a named top-level function from boot.html (brace matching, string/comment aware).
function extract(name) {
  const re = new RegExp('(^|\\n)([ \\t]*)(async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(SRC); if (!m) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', m.index + m[0].length - 1);
  // skip param list
  let p = m.index + m[0].length - 1, depth = 0;
  for (; p < SRC.length; p++) { const c = SRC[p]; if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) break; } }
  i = SRC.indexOf('{', p);
  depth = 0; let j = i, str = null;
  for (; j < SRC.length; j++) {
    const c = SRC[j], n = SRC[j + 1];
    if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
    if (c === '/' && n === '/') { j = SRC.indexOf('\n', j); continue; }
    if (c === '/' && n === '*') { j = SRC.indexOf('*/', j) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(m.index, j + 1);
}
function lineOf(name) { const i = SRC.search(new RegExp('function\\s+' + name + '\\s*\\(')); return SRC.slice(0, i).split('\n').length; }

// Permissive fake DOM: any element id returns a persistent stub; enough for tool functions.
function makeDom(values = {}) {
  const els = {};
  const mk = (id) => ({ id, value: values[id] ?? '', textContent: '', innerHTML: '', className: '', style: {}, dataset: {}, disabled: false, checked: false,
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } }, children: [],
    appendChild(c){ this.children.push(c); return c; }, setAttribute(){}, removeAttribute(){}, getAttribute(){ return null; }, addEventListener(){},
    querySelector(){ return mk('q'); }, querySelectorAll(){ return []; }, getContext(){ return null; }, focus(){}, remove(){} });
  const document = { getElementById: (id) => (els[id] ||= mk(id)), createElement: () => mk('new'), querySelector: () => mk('q'), querySelectorAll: () => [], body: mk('body') };
  return { document, els };
}


let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

console.log('1. passphrases are never trimmed');
{ const bad = SRC.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) =>
    /passphrase|-pp-|vtmp-pass/i.test(l) && /getElementById\([^)]*\)[^;]*\.value[^;]*\.trim\(\)|\(document\.getElementById\([^)]*pass[^)]*\)[^;]*\)\.trim\(\)/i.test(l));
  ck('no .trim() on any passphrase field read', bad.length === 0, bad.map(b => b[0]).join(','));
}

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FP = (HDKey.fromMasterSeed(await bip39.mnemonicToSeed(M, '')).fingerprint >>> 0).toString(16).padStart(8, '0').toUpperCase();
function recCtx(values, confirmAnswer, extra = {}) {
  const { document } = makeDom(values); const writes = []; const prompts = []; let status = '';
  const ctx = vm.createContext({ window: { BtcMath: { bip39, wordlist, HDKey, btcSigner },
      SafeKeepOS: { restoreMasterSeed: async (m) => { writes.push(m); return { diskVerified: true, fingerprint: FP }; } } },
    SLIP39: { combineMnemonics }, document, Uint8Array, Buffer, console, confirm: (q) => { prompts.push(q); return confirmAnswer; },
    showStatus: (m) => { status = m; }, clearStatus() {}, s39r_showLocalStatus: (m) => { status = m; }, _isEphemeralBoot: () => false,
    _showDiskVerification() {}, hideShamirRecoveryPanel() {}, transitionToDashboard() {}, _SKB_DEV_MODE: false, ...extra });
  ctx.window.SLIP39 = ctx.SLIP39;
  vm.runInContext(['_recoveryFingerprint', '_s39rNeeded', 's39r_updateRecoverBtn', 's39r_recover', '_s39rReadings', '_s39rShowChoice', '_s39rClearChoice', 's39r_restorePending', 'xrr_loadIntoVault'].map(extract).join('\n') +
    '\nvar _s39rPending = null;', ctx);
  return { ctx, writes, prompts, status: () => status };
}
console.log("2. recovery shows the fingerprint before writing");
{ const ent = Buffer.from(bip39.mnemonicToEntropy(M, wordlist));
  const shares = (await generateMnemonics(1, [[2, 3]], ent, 'right-pass', 1))[0];
  for (const [label, pp, restore, expectWrite] of [
      ['SLIP-39 correct passphrase, user restores', 'right-pass', true, true],
      ['SLIP-39 WRONG passphrase, user does not restore', 'wrong-pass', false, false],
      ['SLIP-39 correct passphrase, user does not restore', 'right-pass', false, false]]) {
    const r = recCtx({ 's39r-passphrase': pp }, false, { _s39rShares: shares.slice(0, 2) });
    await r.ctx.s39r_recover();
    const shown = r.ctx.document.getElementById('s39r-choice').innerHTML;
    ck(label + ': Combine writes nothing and asks no confirm()', r.writes.length === 0 && r.prompts.length === 0, JSON.stringify({ writes: r.writes.length, status: r.status() }));
    if (pp === 'right-pass') ck('  the SafeKeep reading shows the real fingerprint ' + FP, shown.includes('Restore This Wallet (' + FP + ')'), shown.slice(0, 200));
    if (pp === 'wrong-pass') ck('  wrong passphrase shows a DIFFERENT fingerprint', !shown.includes(FP), shown.slice(0, 200));
    if (restore) await r.ctx.s39r_restorePending();
    ck(label + (expectWrite ? ' -> written' : ' -> nothing written'), (r.writes.length === 1) === expectWrite && (!expectWrite || r.writes[0] === M), JSON.stringify({ writes: r.writes.length }));
  }
  for (const [label, answer, expectWrite] of [['XOR recovery, user confirms', true, true], ['XOR recovery, user declines', false, false]]) {
    const r = recCtx({}, answer, { _xrrRecoveredMnemonic: M });
    await r.ctx.xrr_loadIntoVault();
    ck(label + (expectWrite ? ' -> written' : ' -> nothing written'), (r.writes.length === 1) === expectWrite && r.prompts[0].includes(FP), JSON.stringify({ writes: r.writes.length }));
  }
}

console.log('3. transfer-drive file names cannot inject markup');
{ const ctx = vm.createContext({ String }); vm.runInContext(extract('rlq_renderEntryButton'), ctx);
  const evil = 'x"><img src=x onerror=alert(1)>\'.7z';
  for (const kind of ['backup', 'export', 'unknown']) {
    const html = ctx.rlq_renderEntryButton(evil, kind);
    ck(`${kind}: no raw <img / quote break-out`, !html.includes('<img') && !html.includes('x">') && html.includes('&lt;img'), html.slice(0, 160));
    ck(`${kind}: file name never spliced into inline JS`, !/rlq_pickEntry\('[^)]*img/.test(html));
  }
  const legit = ctx.rlq_renderEntryButton("Safekeep_backup_2026-09-28.7z", 'backup');
  ck('normal name still shown', legit.includes('Safekeep_backup_2026-09-28.7z'));
}

console.log('4. PSBT review fee guard');
{ const ctx = vm.createContext({ Number, String, BigInt, Math, _psbtEscape: (s) => String(s), _psbtAddressChecksum: () => '', PSBT_WILDCARD_FP: '00000000' });
  vm.runInContext(extract('_psbtBuildReviewHtml') + '\n' + extract('_psbtSavedWalletBannerHtml'), ctx);
  const html = (fee, tin) => ctx._psbtBuildReviewHtml(null, { outputs: [], fee, totalIn: tin, totalOut: tin - fee, feeRate: '10.0', hijackDetected: false }).feeHtml;
  ck('normal fee (0.1%) -> no warning', !/UNUSUALLY HIGH FEE/.test(html(10_000n, 10_000_000n)));
  ck('absurd fee (50%) -> warning', /UNUSUALLY HIGH FEE/.test(html(5_000_000n, 10_000_000n)));
  ck('fee exactly 5% -> warning', /UNUSUALLY HIGH FEE/.test(html(500_000n, 10_000_000n)));
  ck('outputs > inputs -> invalid warning', /Invalid transaction/.test(html(-1_000n, 10_000_000n)));
}
// ---- 5. Mount Transfer Drive button: a fallback only ----
{
  ck('mount button starts hidden in the markup', /<div id="dash-mount-btn-wrap" style="display: none;/.test(SRC));
  const make = () => {
    const els = {};
    const el = (id) => (els[id] ||= { id, style: {}, offsetHeight: 40, textContent: '' });
    const ctx = vm.createContext({ window: {}, document: { getElementById: el }, _skuiFadeTimers: {}, setTimeout: () => 0, clearTimeout: () => {}, console: { log() {}, warn() {} } });
    vm.runInContext(['_dashSyncMountStatus', '_transferAutoMount'].map(extract).join('\n') +
      '\nvar _transferAutoMountBusy = false; var _transferAutoMountTried = false; var bridge = null;' +
      '\nasync function _transferBridgeHandle() { return bridge; }' +
      '\nfunction _archiveAdoptHandle(h) { window.vaultTransferDriveHandle = h; _dashSyncMountStatus(); }', ctx);
    ctx.btn = el('dash-mount-btn-wrap'); ctx.btn.style.display = 'none';
    return ctx;
  };
  const shown = (ctx) => ctx.btn.style.display !== 'none';
  let c = make();
  vm.runInContext('_dashSyncMountStatus()', c);
  ck('before the automatic mount has run: button hidden', !shown(c));
  vm.runInContext('bridge = { label: "TRANSFER" }', c);
  await vm.runInContext('_transferAutoMount()', c);
  ck('automatic mount works: button never shown', !shown(c) && !!c.window.vaultTransferDriveHandle);
  c = make();
  await vm.runInContext('_transferAutoMount()', c);
  ck('automatic mount fails: button appears as the fallback', shown(c) && !c.window.vaultTransferDriveHandle);
  vm.runInContext('_dashSyncMountStatus()', c);
  ck('and stays on when the dashboard is shown again', shown(c));
}
// ---- 6. Shamir print page: no word of the seed ----
{
  const fn = extract('s39_printShare');
  ck('Shamir print page does not read the seed words', !/\.mnemonic\b/.test(fn) && !/checksum ?word/i.test(fn), fn.match(/.*(mnemonic|checksum).*/gi)?.join('\n'));
  ck('Shamir print page still shows the fingerprint and threshold', fn.includes('Master Fingerprint') && fn.includes('Threshold'));
}
// ---- 7. Seed Management: passphrase typed twice, real descriptor ----
console.log('7. Seed Management passphrase check and descriptor');
{
  const els = {};
  const el = (id) => (els[id] ||= { id, value: '', style: {}, textContent: '', className: '' });
  const ctx = vm.createContext({ window: { BtcMath: { HDKey } }, document: { getElementById: el } });
  vm.runInContext(['_descPassphraseConfirmed', 'desc_onPassphraseInput', '_armPassphrase', 'desc_checksum', '_descSingleSig'].map(extract).join('\n') +
    '\nvar _ppFromLibrary = {}; function _descNormalizeXpub(x) { return x; }', ctx);
  const pp = (v) => { el('arm-passphrase').value = v; vm.runInContext("desc_onPassphraseInput('arm-passphrase')", ctx); };
  const usable = () => { try { return vm.runInContext('_armPassphrase()', ctx); } catch (e) { return null; } };
  pp('');
  ck('no passphrase: usable, no confirm box', usable() === '' && el('arm-passphrase-confirm-row').style.display === 'none');
  pp('Secret');
  ck('typed once: refused, confirm box shown', usable() === null && el('arm-passphrase-confirm-row').style.display === 'block');
  el('arm-passphrase-confirm').value = 'secret'; pp('Secret');
  ck('different capitals: still refused', usable() === null);
  el('arm-passphrase-confirm').value = 'Secret'; pp('Secret');
  ck('typed twice: usable', usable() === 'Secret');
  vm.runInContext("_ppFromLibrary['arm-passphrase'] = 'From Library'", ctx); el('arm-passphrase-confirm').value = ''; pp('From Library');
  ck('loaded passphrase (Library or session): usable without retyping', usable() === 'From Library');
  pp('From Library!');
  ck('edited after loading: must be typed twice again', usable() === null);

  const seed = bip39.mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const d = vm.runInContext('(s) => _descSingleSig(s, "84")', ctx)(seed);
  ck('BIP-84 descriptor: standard xpub, script wrapper, checksum',
    d.descriptor.startsWith("wpkh([73c5da0a/84'/0'/0']xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V/<0;1>/*)#") &&
    d.descriptor.split('#')[1] === vm.runInContext('desc_checksum', ctx)(d.descriptor.split('#')[0]), d.descriptor);
  const arm = extract('arm_deriveWallet');
  ck("Seed Management's descriptor format uses Output Descriptor's builders",
    /descriptor_text[\s\S]{0,600}_descLocalKeyOrigin[\s\S]{0,200}_descSingleSig/.test(arm) && extract('desc_generateSingle').includes('_descSingleSig('));
  ck('Seed Management exports and print wait for the confirmed passphrase',
    ['arm_computeColdcardSnapshot', 'arm_computeNunchukSnapshot', 'arm_computeElectrumSnapshot', 'arm_computeElectrumColdcardSnapshot', 'arm_deriveWallet']
      .every((f) => extract(f).includes('_armPassphrase()') && !extract(f).includes("getElementById('arm-passphrase').value")) &&
    extract('arm_print').includes("_descPassphraseConfirmed('arm-passphrase')"));
}
console.log(`\nREVIEW REGRESSIONS: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

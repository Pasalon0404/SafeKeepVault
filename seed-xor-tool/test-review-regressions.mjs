/**
 * test-review-regressions.mjs — regression tests for the second tool-by-tool review.
 *
 *  1. BIP-39 passphrases are never trimmed anywhere (a trimmed passphrase is a
 *     different wallet; the Output Descriptor + temp-seed screens used to trim).
 *  2. SLIP-39 and Seed XOR recovery require the user to confirm the recovered
 *     fingerprint BEFORE anything is written to the vault (a wrong SLIP-39
 *     passphrase / wrong XOR share is otherwise undetectable).
 *  3. Transfer-drive file names can't inject markup into the backup list.
 *  4. The PSBT review warns on an absurd fee and on outputs > inputs.
 *
 * Run: node test-review-regressions.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as bip39 from '@scure/bip39'; import { wordlist } from '@scure/bip39/wordlists/english.js'; import { HDKey } from '@scure/bip32';
import { generateMnemonics, combineMnemonics } from 'shamir-mnemonic-ts';
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
  const ctx = vm.createContext({ window: { BtcMath: { bip39, wordlist, HDKey },
      SafeKeepOS: { restoreMasterSeed: async (m) => { writes.push(m); return { diskVerified: true, fingerprint: FP }; } } },
    SLIP39: { combineMnemonics }, document, Uint8Array, Buffer, console, confirm: (q) => { prompts.push(q); return confirmAnswer; },
    showStatus: (m) => { status = m; }, clearStatus() {}, s39r_showLocalStatus: (m) => { status = m; }, _isEphemeralBoot: () => false,
    _showDiskVerification() {}, hideShamirRecoveryPanel() {}, transitionToDashboard() {}, _SKB_DEV_MODE: false, ...extra });
  ctx.window.SLIP39 = ctx.SLIP39;
  vm.runInContext(['_recoveryFingerprint', 's39r_recover', 'xrr_loadIntoVault'].map(extract).join('\n'), ctx);
  return { ctx, writes, prompts, status: () => status };
}
console.log('2. recovery requires fingerprint confirmation before writing');
{ const ent = Buffer.from(bip39.mnemonicToEntropy(M, wordlist));
  const shares = (await generateMnemonics(1, [[2, 3]], ent, 'right-pass', 1))[0];
  for (const [label, pp, answer, expectWrite] of [
      ['SLIP-39 correct passphrase, user confirms', 'right-pass', true, true],
      ['SLIP-39 WRONG passphrase, user declines', 'wrong-pass', false, false],
      ['SLIP-39 correct passphrase, user declines', 'right-pass', false, false]]) {
    const r = recCtx({ 's39r-passphrase': pp }, answer, { _s39rShares: shares.slice(0, 2) });
    await r.ctx.s39r_recover();
    ck(label + (expectWrite ? ' -> written' : ' -> nothing written'), (r.writes.length === 1) === expectWrite && r.prompts.length === 1, JSON.stringify({ writes: r.writes.length, prompts: r.prompts.length, status: r.status() }));
    if (pp === 'right-pass' && answer) ck('  prompt shows the real fingerprint ' + FP, r.prompts[0].includes(FP), r.prompts[0]);
    if (pp === 'wrong-pass') ck('  wrong passphrase shows a DIFFERENT fingerprint', !r.prompts[0].includes(FP), r.prompts[0]);
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
  vm.runInContext(extract('_psbtBuildReviewHtml'), ctx);
  const html = (fee, tin) => ctx._psbtBuildReviewHtml(null, { outputs: [], fee, totalIn: tin, totalOut: tin - fee, feeRate: '10.0', hijackDetected: false }).feeHtml;
  ck('normal fee (0.1%) -> no warning', !/UNUSUALLY HIGH FEE/.test(html(10_000n, 10_000_000n)));
  ck('absurd fee (50%) -> warning', /UNUSUALLY HIGH FEE/.test(html(5_000_000n, 10_000_000n)));
  ck('fee exactly 5% -> warning', /UNUSUALLY HIGH FEE/.test(html(500_000n, 10_000_000n)));
  ck('outputs > inputs -> invalid warning', /Invalid transaction/.test(html(-1_000n, 10_000_000n)));
}
console.log(`\nREVIEW REGRESSIONS: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

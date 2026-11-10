/**
 * test-trezor-tools.mjs — Trezor settings without Trezor Suite: passphrase
 * protection, erase, recover from words
 *
 * The helper (safekeep-trezor.py passphrase_setting / wipe / recover and
 * its dialog channel) is tested against a fake Trezor by
 * usbbootdrive/tests/test-trezor-helper.py. This checks the app and OS side:
 *   1. The bridge's question-and-answer loop, run for real against a fake
 *      helper: each question goes to onQuestion, answers go back as
 *      TREZOR_REPLY.json with the request id and question number, the
 *      result ends it.
 *   2. The OS: the watcher passes the dialog file, the reply folder and the
 *      Temporary Session flag; leftover replies are shredded; the file
 *      router no longer takes COLDCARD_* / TREZOR_* requests that carry a
 *      "passphrase" for Passphrase Library files.
 *   3. The panel: where it lives (Device Options, and Trezor Tools on the
 *      welcome screen in a Temporary Session), erase confirmations,
 *      recovery in any session (words typed, or picked from the Seed Vault), the PIN grid's ask mode.
 *   4. The new functions parse.
 *
 * Run:  node test-trezor-tools.mjs
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const read = (u) => readFileSync(new URL(u, import.meta.url), 'utf8');
const html = read('./boot.html');
const bridge = read('./shared/boot.js');
const boot = read('../usbbootdrive/safekeep-boot.sh');
const helper = read('../usbbootdrive/safekeep-trezor.py');
const fn = (name) => { const a = html.indexOf(name); return a < 0 ? '' : html.slice(a, html.indexOf('\n}\n', a) + 2); };
const bfn = (name) => { const a = bridge.indexOf(name); return a < 0 ? '' : bridge.slice(a, bridge.indexOf('\n  }\n', a) + 4); };

console.log('\n1. The bridge\'s question-and-answer loop');
async function runLoop(questions, onQuestion) {
  // A fake helper: shows each question in turn once the previous one is answered, then the result.
  const sent = []; let qi = 0, answeredUpTo = 0, requestId = null;
  const fetchStub = async (url) => {
    if (url.endsWith('TREZOR_RESULT.json')) {
      if (qi >= questions.length && answeredUpTo >= questions.filter((q) => q.need !== 'button').length) return { ok: true, json: async () => ({ ok: true, status: 'done', request_id: requestId }) };
      return { ok: false };
    }
    if (url.endsWith('TREZOR_DIALOG.json')) {
      if (qi >= questions.length) return { ok: false };
      const q = Object.assign({ request_id: requestId, seq: qi + 1 }, questions[qi]);
      if (q.need === 'button' || answeredUpTo > questions.slice(0, qi).filter((x) => x.need !== 'button').length) qi++;
      return { ok: true, json: async () => q };
    }
    return { ok: false };
  };
  const body = bfn('async function _trezorDialogRequest');
  const loop = new Function('isBootDrive', '_ccRequestId', '_rawBlobDownload', '_sleep', 'fetch', '_usbQueueAck', 'TREZOR_REQUEST_FILE', 'TREZOR_RESULT_URL', 'TREZOR_DIALOG_URL', 'TREZOR_REPLY_FILE', 'TREZOR_ACK_FILE',
    'let _tzInFlight = false; const _usbAckChain = Promise.resolve();\n' + body + '\nreturn _trezorDialogRequest;')(
    () => true, () => 'rid-1', (name, text) => {
      const o = JSON.parse(text);
      if (name === 'TREZOR_REQUEST.json') requestId = o.request_id;
      else { sent.push(o); answeredUpTo++; }
    }, async () => {}, fetchStub, () => {}, 'TREZOR_REQUEST.json', 'file:///s/TREZOR_RESULT.json', 'file:///s/TREZOR_DIALOG.json', 'TREZOR_REPLY.json', 'TREZOR_ACK.json');
  const result = await loop({ action: 'recover' }, 60000, onQuestion);
  return { result, sent };
}
const seen = [];
const { result, sent } = await runLoop(
  [{ need: 'button' }, { need: 'pin', kind: 'new_first' }, { need: 'pin', kind: 'new_second' }, { need: 'word' }, { need: 'word' }],
  async (q) => { seen.push(q.need + (q.kind ? ':' + q.kind : '')); return q.need === 'pin' ? { positions: '123' } : q.need === 'word' ? { word: 'legal' } : null; });
ck('every question reaches onQuestion, in order', seen.join(',') === 'button,pin:new_first,pin:new_second,word,word', seen.join(','));
ck('answers go back for PIN and word questions only, with the request id and question number', sent.length === 4 && sent.every((r) => r.request_id === 'rid-1') && sent.map((r) => r.seq).join(',') === '2,3,4,5' && sent[0].positions === '123' && sent[3].word === 'legal', JSON.stringify(sent));
ck('the result ends the loop', result && result.status === 'done', JSON.stringify(result));
const c = await runLoop([{ need: 'word' }], async () => { throw new Error('closed'); });
ck('if answering fails, a cancel is sent (the Trezor is never left waiting)', c.sent.length === 1 && c.sent[0].cancel === true, JSON.stringify(c.sent));
ck('the three bridge functions are exported', /trezorSetPassphraseProtection, trezorWipe, trezorRecover,/.test(bridge));
ck('wipe sends the fingerprint the user saw; recover sends the word count and passphrase choice', bfn('async function trezorWipe').includes('req.expected_xfp = String(expectedXfp).toLowerCase()') && bfn('async function trezorRecover').includes("action: 'recover', word_count: Number(wordCount)"));

console.log('\n2. The OS');
const w = boot.slice(boot.indexOf('# TREZOR WATCHER'), boot.indexOf('TREZOR_WATCHER_PID=$!'));
ck('the watcher gives the helper the dialog file (RAM), the reply folder and the Temporary Session flag', w.includes('SAFEKEEP_TZ_DIALOG="$TREZOR_DIALOG"') && w.includes('SAFEKEEP_TZ_REPLY_DIR="$CHROMIUM_DOWNLOAD_DIR"') && w.includes('SAFEKEEP_TZ_TEMPORARY="$TREZOR_TEMPORARY"') && w.includes('TREZOR_DIALOG="$SIGNAL_DIR/TREZOR_DIALOG.json"') && w.includes('if [ "$EPHEMERAL_MODE" = "1" ]; then TREZOR_TEMPORARY=1; else TREZOR_TEMPORARY=0; fi'));
ck('…and shreds any answers left over afterwards', w.includes('shred -u -n 1 -z "$_tzr"'));
ck('the file router skips COLDCARD_* and TREZOR_* (their requests may carry a "passphrase" that must never become a Passphrase Library file)', /SEED_STORAGE\*\|COLDCARD_\*\|TREZOR_\*\|/.test(boot));
ck('the helper: recovery in any session, wipe only the confirmed Trezor', !helper.includes("not_temporary") && helper.includes("if want is None or got_xfp != want:"));

console.log('\n3. The panel');
ck('in Device Options → Trezor: Passphrase Protection, Erase This Trezor, Recover from Words', html.indexOf('id="tzx-block"') > html.indexOf('id="settings-trezor-section"') && ['onclick="tzx_passphrase()">Passphrase Protection', 'onclick="tzx_openWipe()">Erase This Trezor', 'onclick="tzx_openRecover()">Recover from Words'].every((t) => html.includes(t)));
ck('in a Temporary Session (no Dashboard): Trezor Tools on the welcome screen, shown with Sign with Hardware Wallet', html.includes('id="welcome-tz-btn" style="display: none; margin-top: 0.5rem;" onclick="tzx_openTools()"') && (html.match(/const _tzb = document\.getElementById\('welcome-tz-btn'\); if \(_tzb && hwb\) _tzb\.style\.display = hwb\.style\.display;/g) || []).length === (html.match(/if \(hwb\) hwb\.style\.display = /g) || []).length);
ck('…which opens the Trezor section in an overlay and puts it back on close', fn('function tzx_openTools').includes("box.appendChild(sec)") && fn('function tzx_closeTools').includes('_tzxHome.parent.insertBefore(sec, _tzxHome.next)'));
ck('the PIN grid opens above that overlay', /\.tz-pin-overlay \{[\s\S]{0,140}z-index: 10050;/.test(html) && html.includes('.ccb-import-overlay { position: fixed; inset: 0; z-index: 10040;'));
const wipe = fn('function tzx_openWipe');
ck('erase: a warning, "I have the recovery words", and typing ERASE before the button works', wipe.includes('Erasing removes the seed, PIN and settings from the Trezor.') && wipe.includes('id="tzx-wipe-have"') && fn('function tzx_wipeCheck').includes("=== 'ERASE'"));
ck('…the fingerprint comes from the unlocked Trezor, and goes to the helper', fn('async function tzx_wipe').includes('tzEnsureUnlocked') && fn('async function tzx_wipe').includes('os.trezorWipe(xfp, _tzxOnQuestion)'));
const rec = fn('async function tzx_openRecover');
ck('recover: in any session; a normal session says each word passes briefly through the encrypted vault, and suggests a Temporary Session for words from paper', !rec.includes('Recovery runs only in') && rec.includes('Each word passes briefly through this vault on the flash drive (encrypted, then erased)') && rec.includes('For words from a paper backup, a Temporary Session keeps them in memory only.'));
ck('…explains the scrambled order and the decoy words', rec.includes('also asks for a few words that aren’t in the seed (decoys'));
ck('…words typed, or from SafeKeep\'s Seed Vault (only when it is on; 12, 18 or 24 words)', rec.includes('value="type" checked onchange="tzx_recSource()"> Type the words') && rec.includes('From SafeKeep’s Seed Vault') && rec.includes("typeof _svAvailable === 'function' && _svAvailable()") && rec.includes('[12, 18, 24].indexOf(e.mnemonic.split'));
ck('…a picked seed sets the word count, and shows its words numbered to click (a decoy is typed)', fn('async function tzx_recover').includes('n = _tzx.recWords.length;') && fn('function _tzxAskWord').includes('onclick="tzx_pickChip(\' + i + \')"><b>\' + (i + 1) + \'</b> ') && fn('function tzx_pickChip').includes('input.value = words[i];') && rec.includes('A decoy is shown on the Trezor’s screen: type it.'));
ck('…the picked words are forgotten when recovery ends or the panel closes', (fn('async function tzx_recover').match(/_tzx\.recWords = null;/g) || []).length >= 2 && fn('function tzx_close').includes('_tzx.recWords = null; _tzx.svList = [];'));
ck('…one word at a time, from the recovery word list, cleared after each', fn('function tzx_wordNext').includes("bip.indexOf(w) < 0") && fn('function tzx_wordNext').includes('_tzx.boxes.clear()') && fn('function _tzxAskWord').includes("idPrefix: 'tzxw'") && fn('function _tzxAskWord').includes("getElementById('tzxw-word-0')"));
ck('the Trezor\'s questions: confirm on its screen, PIN on the blank grid, a word', fn('function _tzxOnQuestion').includes("q.need === 'button'") && fn('function _tzxOnQuestion').includes('_tzPinAsk(q.kind)') && fn('function _tzxOnQuestion').includes('_tzxAskWord()'));
ck('the PIN grid\'s ask mode hands the positions back instead of sending them', fn('async function _tzPinSubmit').includes('if (_tzPin.ask) {') && fn('function _tzPinAsk').includes("ask: true") && fn('function _tzPinAsk').includes("'Choose a new PIN'"));
ck('not in the online demo', fn('async function tzSettingsRefresh').includes('tzxBlock.hidden = _skvDemoActive()') && fn('function tzx_openWipe').includes('_skvDemoActive()') && fn('function tzx_openRecover').includes('_skvDemoActive()'));
ck('the dev build\'s pretend Trezor recovers in any session', !html.includes("status: 'not_temporary'"));
ck('the dev build has a pretend Trezor for all three', ['trezorSetPassphraseProtection: async function (enable, onQuestion)', 'trezorWipe: async function (xfp, onQuestion)', 'trezorRecover: async function (n, pp, onQuestion)'].every((t) => html.includes(t)));
ck('American English: no "tick" in the new text', !/\b[Tt]ick/.test(html.slice(html.indexOf('id="tzx-block"'), html.indexOf('id="tzx-block"') + 2000)));

console.log('\n4. Parsing');
for (const name of ['function _tzxOnQuestion', 'async function tzx_passphrase', 'async function tzx_passphraseSet', 'function tzx_openWipe', 'function tzx_wipeCheck', 'async function tzx_wipe', 'async function tzx_openRecover', 'function tzx_recSource', 'function tzx_pickChip', 'function _tzxAskWord', 'function tzx_wordNext', 'function tzx_wordCancel', 'async function tzx_recover', 'function tzx_openTools', 'function tzx_closeTools', 'function _tzPinAsk', 'function _tzPinTexts', 'async function _tzPinSubmit']) {
  let ok = true, err = '';
  try { new Function(fn(name).replace(/^async function/, 'return async function').replace(/^function/, 'return function')); } catch (x) { ok = false; err = x.message; }
  ck(`${name.replace(/^(async )?function /, '')} parses`, ok, err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { wordlist } from '@scure/bip39/wordlists/english.js';
/**
 * test-passphrase-workspace.mjs — Passphrase Library workspace flow through the real cipher_* /
 * pp_* functions in boot.html: generated passphrases lock the field and skip the Confirm re-type,
 * Save stays disabled until the written-copy check passes, Edit turns it back into a typed
 * passphrase, typed passphrases still need a matching Confirm, paste is blocked in both
 * confirmation fields, and generator style options reformat the same words instead of re-rolling.
 * Run: node test-passphrase-workspace.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
// Extract a named top-level function from boot.html (brace matching, string/comment aware).
function extract(name) {
  const re = new RegExp('(^|\\n)([ \\t]*)(async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(SRC); if (!m) throw new Error('not found: ' + name);
  let p = m.index + m[0].length - 1, depth = 0;
  for (; p < SRC.length; p++) { const c = SRC[p]; if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) break; } }
  let i = SRC.indexOf('{', p), j = i, str = null; depth = 0;
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

let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

// Minimal DOM: every id is a persistent element with the properties these functions touch.
function makeEnv({ amnesia = false } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { id, value: '', textContent: '', innerHTML: '', type: 'text', readOnly: false, disabled: false,
    checked: false, title: '', style: { display: '' }, focused: false, focus() { this.focused = true; } });
  const document = { getElementById: el, createElement: () => el('_new') };
  const statuses = [], saved = [];
  const ctx = vm.createContext({
    window: { BtcMath: { wordlist }, crypto: globalThis.crypto, SeedSession: { get: () => ({ fingerprint: 'abcd1234' }) } },
    document, Uint32Array, Math,
    showStatus: (m, t) => statuses.push(t + ':' + m),
    isAmnesiaMode: () => amnesia,
    _pp_computeLiveFP: () => {},
    cipher_refreshArchive: async () => {},
    pp_config: { wordCount: 6, separator: '-', capitalization: 'title', lastPassphrase: '', _lastAppliedPassphrase: '' },
  });
  ctx.window.SafeKeepOS = { savePassphrase: async (nickname, passphrase) => { saved.push({ nickname, passphrase }); return { saved: true, slug: 'x' }; } };
  ctx.SafeKeepOS = ctx.window.SafeKeepOS;
  vm.runInContext(['var _cipherActiveSlug = null, _cipherDirty = true, _cipherSource = "typed", _cipherVerified = false, _cipherGenInfo = null, _ppDraw = null;',
    ...['pp_cryptoRandomInt', 'pp_applyCase', 'pp_generate', 'pp_render', 'pp_setWordCount', 'pp_setSeparator', 'pp_setCapitalization', 'pp_entropyBits', 'pp_updateEntropy', 'cipher_toggleGenerator', '_cipherApplySourceUI',
        'cipher_editGenerated', 'cipher_startVerify', 'cipher_checkVerify', 'cipher_cancelVerify', 'cipher_blockPaste', 'cipher_onPassphraseInput',
        'cipher_onConfirmInput', 'cipher_useGenerated', 'cipher_save', 'cipher_new'].map(extract),
  ].join('\n'), ctx);
  return { ctx, el, statuses, saved, last: () => statuses[statuses.length - 1] || '' };
}
const shown = (e) => e.style.display !== 'none';

// ---- Generator opens inline and generates straight away ----
{ const { ctx, el } = makeEnv();
  ctx.cipher_new();
  ck('generator starts closed', el('cipher-gen-panel').style.display === 'none');
  ctx.cipher_toggleGenerator();
  ck('Generate opens the inline generator', el('cipher-gen-panel').style.display === 'block' && el('cipher-gen-btn').textContent === 'Close');
  const pp = ctx.pp_config.lastPassphrase;
  ck('opening the generator produces a 6-word passphrase', pp.split('-').length === 6, pp);
  ctx.cipher_toggleGenerator();
  ck('Close collapses it again', el('cipher-gen-panel').style.display === 'none' && el('cipher-gen-btn').textContent === 'Generate'); }

// ---- Use this passphrase: locked field, no Confirm, Save gated on the written-copy check ----
{ const { ctx, el, saved, last } = makeEnv();
  ctx.cipher_new(); ctx.cipher_toggleGenerator(true);
  const pp = ctx.pp_config.lastPassphrase;
  el('cipher-nickname').value = 'hidden wallet';
  ctx.cipher_useGenerated();
  ck('field holds the generated passphrase', el('cipher-passphrase').value === pp);
  ck('field is read-only with an Edit button', el('cipher-passphrase').readOnly && shown(el('cipher-edit-btn')));
  ck('Confirm re-type is hidden for generated passphrases', el('cipher-confirm-block').style.display === 'none');
  ck('written-copy check is offered', shown(el('cipher-verify-block')) && shown(el('cipher-verify-intro')));
  ck('badge shows source, words and bits', el('cipher-pp-badge').textContent === 'Generated · 6 words · 66 bits', el('cipher-pp-badge').textContent);
  ck('generator collapses after use', el('cipher-gen-panel').style.display === 'none');
  ck('fingerprint preview and Print are available right away', shown(el('pp-fp-preview')) && shown(el('pp-print-btn')) && shown(el('cipher-action-row')));
  ck('Save is disabled until the copy is checked', el('cipher-save-btn').disabled);
  await ctx.cipher_save();
  ck('cipher_save refuses an unchecked generated passphrase', saved.length === 0 && /written copy/.test(last()), last());

  ctx.cipher_startVerify();
  ck('check hides the passphrase', el('cipher-passphrase').type === 'password');
  ck('check disables Generate (its output shows the passphrase)', el('cipher-gen-btn').disabled);
  ck('check shows the copy input', shown(el('cipher-verify-step')) && el('cipher-verify-intro').style.display === 'none' && el('cipher-verify-input').focused);

  el('cipher-verify-input').value = pp.toLowerCase();   // title case dropped — a real copying mistake
  ctx.cipher_checkVerify();
  ck('a wrong copy fails and keeps Save disabled', !ctx._cipherVerified && el('cipher-save-btn').disabled && /does not match/.test(el('cipher-verify-status').textContent));
  ck('a wrong copy clears the input and keeps it hidden', el('cipher-verify-input').value === '' && el('cipher-passphrase').type === 'password');

  el('cipher-verify-input').value = pp;
  ctx.cipher_checkVerify();
  ck('a matching copy passes', ctx._cipherVerified && shown(el('cipher-verify-done')));
  ck('passing re-shows the passphrase and re-enables Generate', el('cipher-passphrase').type === 'text' && !el('cipher-gen-btn').disabled);
  ck('passing enables Save', !el('cipher-save-btn').disabled);
  ck('badge notes the checked copy', /copy checked$/.test(el('cipher-pp-badge').textContent));
  await ctx.cipher_save();
  ck('cipher_save stores the checked passphrase', saved.length === 1 && saved[0].passphrase === pp && saved[0].nickname === 'hidden wallet', JSON.stringify(saved)); }

// ---- Show passphrase again leaves the check without passing it ----
{ const { ctx, el } = makeEnv();
  ctx.cipher_new(); ctx.cipher_toggleGenerator(true); ctx.cipher_useGenerated();
  ctx.cipher_startVerify(); el('cipher-verify-input').value = 'partial';
  ctx.cipher_cancelVerify();
  ck('Show passphrase again un-hides it and returns to the intro', el('cipher-passphrase').type === 'text' && shown(el('cipher-verify-intro')) && el('cipher-verify-step').style.display === 'none');
  ck('Show passphrase again clears the partial copy and stays unchecked', el('cipher-verify-input').value === '' && !ctx._cipherVerified && el('cipher-save-btn').disabled); }

// ---- Temporary Session: checking works, saving stays off ----
{ const { ctx, el } = makeEnv({ amnesia: true });
  ctx.cipher_new(); ctx.cipher_toggleGenerator(true); ctx.cipher_useGenerated();
  ctx.cipher_startVerify(); el('cipher-verify-input').value = ctx.pp_config.lastPassphrase; ctx.cipher_checkVerify();
  ck('amnesia: copy check passes but Save stays disabled', ctx._cipherVerified && el('cipher-save-btn').disabled); }

// ---- Edit turns a generated passphrase back into a typed one ----
{ const { ctx, el, saved, last } = makeEnv();
  ctx.cipher_new(); ctx.cipher_toggleGenerator(true); ctx.cipher_useGenerated();
  ctx.cipher_startVerify(); el('cipher-verify-input').value = ctx.pp_config.lastPassphrase; ctx.cipher_checkVerify();
  ctx.cipher_editGenerated();
  ck('Edit unlocks the field', !el('cipher-passphrase').readOnly && el('cipher-edit-btn').style.display === 'none' && el('cipher-passphrase').focused);
  ck('Edit brings Confirm back and drops the copy check', shown(el('cipher-confirm-block')) && el('cipher-verify-block').style.display === 'none');
  ck('Edit clears the generated state', ctx._cipherSource === 'typed' && !ctx._cipherVerified && ctx._cipherGenInfo === null && el('cipher-pp-badge').style.display === 'none');
  ck('Edit hides the action row until Confirm matches', el('cipher-action-row').style.display === 'none');
  el('cipher-nickname').value = 'n';
  el('cipher-passphrase').value += 'x'; ctx.cipher_onPassphraseInput();
  await ctx.cipher_save();
  ck('edited passphrase cannot be saved without a matching Confirm', saved.length === 0 && /do not match/.test(last()), last()); }

// ---- Typed passphrases keep the Confirm step ----
{ const { ctx, el, saved } = makeEnv();
  ctx.cipher_new();
  ck('typed: Confirm shown, copy check hidden, field editable', shown(el('cipher-confirm-block')) && el('cipher-verify-block').style.display === 'none' && !el('cipher-passphrase').readOnly);
  el('cipher-nickname').value = 'typed one';
  el('cipher-passphrase').value = 'correct horse battery staple'; ctx.cipher_onPassphraseInput();
  el('cipher-confirm').value = 'correct horse battery stapel'; ctx.cipher_onConfirmInput();
  ck('typed: mismatch keeps actions hidden', el('cipher-action-row').style.display === 'none' && /do not match/.test(el('cipher-match-status').textContent));
  el('cipher-confirm').value = 'correct horse battery staple'; ctx.cipher_onConfirmInput();
  ck('typed: match reveals Save and Print', shown(el('cipher-action-row')) && !el('cipher-save-btn').disabled && shown(el('pp-print-btn')));
  await ctx.cipher_save();
  ck('typed: matching passphrase saves', saved.length === 1 && saved[0].passphrase === 'correct horse battery staple'); }

// ---- Paste guard, Clear / New ----
{ const { ctx, el, last } = makeEnv();
  let prevented = false;
  const r = ctx.cipher_blockPaste({ preventDefault: () => { prevented = true; } });
  ck('paste guard cancels the paste and explains why', prevented && r === false && /Paste is turned off/.test(last()));
  ctx.cipher_toggleGenerator(true); ctx.cipher_useGenerated(); ctx.cipher_startVerify();
  ctx.cipher_new();
  ck('Clear / New resets a generated, half-checked workspace', !el('cipher-passphrase').readOnly && el('cipher-passphrase').type === 'text' &&
     el('cipher-passphrase').value === '' && ctx._cipherSource === 'typed' && shown(el('cipher-confirm-block')) && el('cipher-verify-block').style.display === 'none' &&
     el('pp-print-btn').style.display === 'none' && el('cipher-gen-panel').style.display === 'none'); }

// ---- Style options reformat the same draw; only Regenerate / word count re-roll ----
{ const { ctx, el } = makeEnv();
  ctx.cipher_new(); ctx.cipher_toggleGenerator(true);
  const words = () => ctx._ppDraw.words.join(' ');
  const base = words(), first = ctx.pp_config.lastPassphrase;     // 6 words, hyphen, Title Case
  ctx.pp_setSeparator(' ');
  ck('separator change keeps the words', words() === base && ctx.pp_config.lastPassphrase === first.split('-').join(' '), ctx.pp_config.lastPassphrase);
  ctx.pp_setCapitalization('upper');
  ck('capitalization change keeps the words', words() === base && ctx.pp_config.lastPassphrase === base.toUpperCase(), ctx.pp_config.lastPassphrase);
  ck('output shows the reformatted passphrase', el('pp-output').textContent === ctx.pp_config.lastPassphrase);
  el('pp-add-num').checked = true; ctx.pp_render();
  const withNum = ctx.pp_config.lastPassphrase;
  ck('Append Number keeps the words and adds one digit', words() === base && /^[A-Z ]+$/.test(withNum.replace(/[0-9]/, '')) && (withNum.match(/[0-9]/g) || []).length === 1, withNum);
  ck('entropy follows the options (66 + log2(10))', el('pp-entropy-text').textContent === '69 bits', el('pp-entropy-text').textContent);
  el('pp-add-sym').checked = true; ctx.pp_render();
  const withBoth = ctx.pp_config.lastPassphrase;
  ck('Append Symbol keeps the words and the digit', words() === base && withBoth.replace(/[!@#$%^&*]/, '') === withNum, withBoth);
  ctx.pp_setSeparator('-');
  ck('digit and symbol stay put across a separator change', ctx.pp_config.lastPassphrase === withBoth.split(' ').join('-'), ctx.pp_config.lastPassphrase);
  el('pp-add-num').checked = false; ctx.pp_render(); el('pp-add-num').checked = true; ctx.pp_render();
  ck('toggling Append Number off and on keeps the same digit', ctx.pp_config.lastPassphrase === withBoth.split(' ').join('-'));
  el('pp-add-num').checked = false; el('pp-add-sym').checked = false; ctx.pp_render();
  ck('turning both off restores the plain words', ctx.pp_config.lastPassphrase === base.toUpperCase().split(' ').join('-'));
  ctx.pp_generate();
  ck('Regenerate picks new words', words() !== base);
  const before8 = words(); ctx.pp_setWordCount(8);
  ck('word count change picks a new 8-word draw', ctx._ppDraw.words.length === 8 && !words().startsWith(before8)); }

// ---- Reopening the generator re-shows the draw; Clear / New starts fresh ----
{ const { ctx, el } = makeEnv();
  ctx.cipher_new(); ctx.cipher_toggleGenerator(true);
  const pp = ctx.pp_config.lastPassphrase;
  ctx.cipher_toggleGenerator(false); el('pp-output').textContent = '';   // what the tool-exit wipe does to the output
  ctx.cipher_toggleGenerator(true);
  ck('reopening re-renders the current draw', el('pp-output').textContent === pp && ctx.pp_config.lastPassphrase === pp);
  ctx.cipher_new();
  ck('Clear / New drops the draw', ctx._ppDraw === null && ctx.pp_config.lastPassphrase === '');
  ctx.cipher_toggleGenerator(true);
  ck('the next open makes a fresh passphrase', ctx.pp_config.lastPassphrase && ctx.pp_config.lastPassphrase !== pp); }

// ---- Markup wiring ----
{ const ws = SRC.slice(SRC.indexOf('<div id="state-passphrase">'), SRC.indexOf('<!-- ======== Archive'));
  const tag = (id) => (ws.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>', 's')) || [''])[0];
  ck('Confirm input blocks paste and drop', /onpaste="return cipher_blockPaste\(event\)"/.test(tag('cipher-confirm')) && /ondrop="return false"/.test(tag('cipher-confirm')));
  ck('copy-check input blocks paste and drop', /onpaste="return cipher_blockPaste\(event\)"/.test(tag('cipher-verify-input')) && /ondrop="return false"/.test(tag('cipher-verify-input')));
  ck('generator sits inline, between the passphrase field and Confirm',
     ws.indexOf('id="cipher-passphrase"') < ws.indexOf('id="cipher-gen-panel"') && ws.indexOf('id="cipher-gen-panel"') < ws.indexOf('id="cipher-confirm-block"'));
  ck('old Generator card / checkbox is gone', !SRC.includes('cipher-gen-toggle'));
  ck('number/symbol toggles reformat instead of re-rolling', /id="pp-add-num" onchange="pp_render\(\)"/.test(ws) && /id="pp-add-sym" onchange="pp_render\(\)"/.test(ws));
  ck('copy-check input is wiped on tool exit', /'#cipher-verify-input'/.test(SRC.slice(SRC.indexOf('var _sensitiveSelectors'), SRC.indexOf('var _sensitiveSelectors') + 3000))); }

console.log(`\nPASSPHRASE WORKSPACE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

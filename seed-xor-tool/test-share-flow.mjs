/**
 * test-share-flow.mjs — the share tools' guided flow (SHARE_TOOLS_DESIGN.md, Part 1).
 *   1. The SLIP-39 word list matches shamir-mnemonic-ts word for word, and
 *      every BIP-39 and SLIP-39 word is found from its first four letters.
 *   2. Words: suggestions, unique prefixes, splitting pasted text.
 *   3. compareShare: empty and wrong boxes by position, never the words.
 *   4. The flow: write → check → … → final → done, going back, and actions
 *      that don't fit the step.
 *   5. In a real browser: the word boxes (autocomplete, paste, marks), the
 *      screens walked through for an XOR-style and a Shamir-style split
 *      (a wrong word, a failed recombine), and "check shares I already
 *      have". Skipped when
 *      no Chromium is found; CHROMIUM_BINARY picks one.
 * Run: node test-share-flow.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bip39 from '@scure/bip39';
import { wordlist as BIP39 } from '@scure/bip39/wordlists/english.js';
import { generateMnemonics } from 'shamir-mnemonic-ts';
import { SLIP39_WORDLIST } from './shared/slip39-wordlist.js';
import { suggestWords, resolveWord, splitWords, compareShare, startFlow, nextStep, allChecked } from './shared/share-flow.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c || !x ? '' : '  -> ' + x)); };

// ---- 1. Word lists ----
{
  // The package's exports hide its word list module; load it by path.
  const { wordsFromIndices } = createRequire(import.meta.url)(join(HERE, 'node_modules/shamir-mnemonic-ts/dist/wordlist.js'));
  const lib = [...wordsFromIndices([...Array(1024).keys()])];
  ck('SLIP-39 list has 1024 words', SLIP39_WORDLIST.length === 1024);
  ck('SLIP-39 list matches shamir-mnemonic-ts word for word', JSON.stringify(lib) === JSON.stringify([...SLIP39_WORDLIST]));
  const shares = (await generateMnemonics(1, [[2, 3]], Buffer.alloc(32, 7), '', 1))[0];
  ck('every word of a real SLIP-39 share is in the list', shares.every((s) => s.split(' ').every((w) => SLIP39_WORDLIST.includes(w))));
  for (const [name, list] of [['BIP-39', BIP39], ['SLIP-39', SLIP39_WORDLIST]]) {
    const bad = list.filter((w) => resolveWord(w.slice(0, 4), list) !== w);
    ck(`${name}: every word is found from its first four letters`, bad.length === 0, bad.slice(0, 5).join(' '));
  }
}

// ---- 2. Words ----
{
  ck('suggestions start with the prefix, at most 8', suggestWords('ab', BIP39).length === 8 && suggestWords('ab', BIP39).every((w) => w.startsWith('ab')));
  ck('an exact word comes first', suggestWords('act', BIP39)[0] === 'act' && suggestWords('act', BIP39).includes('action'));
  ck('no suggestions for an empty box or a non-word', suggestWords('', BIP39).length === 0 && suggestWords('xyzq', BIP39).length === 0);
  ck('case and spaces are ignored', suggestWords('  ABAN ', BIP39)[0] === 'abandon');
  ck('a unique prefix resolves', resolveWord('aban', BIP39) === 'abandon' && resolveWord('acad', SLIP39_WORDLIST) === 'academic');
  ck('an ambiguous prefix does not', resolveWord('ab', BIP39) === '' && resolveWord('ac', SLIP39_WORDLIST) === '');
  ck('a whole word resolves even when longer words start with it', resolveWord('act', BIP39) === 'act');
  ck('a non-word does not resolve', resolveWord('bitcoin', BIP39) === '');
  ck('pasted words: spaces, newlines and commas', JSON.stringify(splitWords('Abandon  ability,able\nabout')) === '["abandon","ability","able","about"]');
  ck('pasted words: numbering is dropped', JSON.stringify(splitWords('1. abandon 2) ability 3: able 4.about 10. zoo')) === '["abandon","ability","able","about","zoo"]');
  ck('pasted words: empty text', splitWords('').length === 0 && splitWords(null).length === 0);
}

// ---- 3. compareShare ----
{
  const exp = 'abandon ability able about above absent'.split(' ');
  ck('identical → ok', compareShare(exp.slice(), exp).ok);
  ck('a string share works too', compareShare(exp.slice(), exp.join(' ')).ok);
  ck('case and spaces in typed words are ignored', compareShare(exp.map((w) => ' ' + w.toUpperCase()), exp).ok);
  const r = compareShare(['abandon', 'zoo', '', 'about', 'above', 'absurd'], exp);
  ck('wrong and empty boxes by position', !r.ok && JSON.stringify(r.wrong) === '[1,5]' && JSON.stringify(r.missing) === '[2]');
  ck('the result holds no words', !/abandon|ability|able|absent|absurd|zoo/.test(JSON.stringify(r)));
  ck('a short typed share is missing its end', JSON.stringify(compareShare(['abandon'], exp).missing) === '[1,2,3,4,5]');
}

// ---- 4. The flow ----
{
  let s = startFlow(3);
  ck('starts at write 1', s.step === 'write' && s.index === 0 && s.total === 3 && !allChecked(s));
  s = nextStep(s, 'wrote'); ck('wrote → check 1', s.step === 'check' && s.index === 0);
  s = nextStep(s, 'back'); ck('back → write 1', s.step === 'write' && s.index === 0);
  ck('passed does nothing on a write step', nextStep(s, 'passed') === s);
  s = nextStep(nextStep(s, 'wrote'), 'passed'); ck('passed → write 2, share 1 checked', s.step === 'write' && s.index === 1 && s.checked[0]);
  s = nextStep(nextStep(s, 'wrote'), 'passed');
  s = nextStep(nextStep(s, 'wrote'), 'passed'); ck('after the last share → final', s.step === 'final' && allChecked(s));
  ck('final-ok does nothing before final', nextStep(startFlow(2), 'final-ok').step === 'write');
  const f = nextStep(s, 'final-failed', 'Fingerprint differs.');
  ck('final-failed stays on final with the message', f.step === 'final' && f.error === 'Fingerprint differs.');
  ck('final-ok → done', nextStep(s, 'final-ok').step === 'done');
  ck('unknown actions change nothing', nextStep(s, 'jump') === s);
  ck('states are not changed in place', s.step === 'final' && startFlow(2).checked !== startFlow(2).checked);
  let threw = false; try { startFlow(1); } catch { threw = true; }
  ck('one share is refused', threw);
}

// ---- 5. Real browser ----
const executablePath = [process.env.CHROMIUM_BINARY, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .find((p) => p && existsSync(p));
let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch { /* not installed */ }
if (!executablePath || !chromium) {
  console.log('  SKIP real-browser checks (set CHROMIUM_BINARY; needs playwright-core)');
} else {
  const types = { '.js': 'text/javascript', '.html': 'text/html' };
  const server = createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><div id="host"></div>'); return; }
    if (req.url === '/bip39.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('export default ' + JSON.stringify(BIP39)); return; }
    const p = join(HERE, req.url.replace(/\?.*$/, ''));
    if (!p.startsWith(join(HERE, 'shared')) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[extname(p)] || 'text/plain' }); res.end(readFileSync(p));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/');
  await page.evaluate(async () => {
    window.SF = await import('/shared/share-flow-ui.js');
    window.WB = await import('/shared/word-boxes.js');
    window.BIP39 = (await import('/bip39.js')).default;
    window.SLIP = (await import('/shared/slip39-wordlist.js')).SLIP39_WORDLIST;
  });

  // Word boxes
  await page.evaluate(() => { window.boxes = WB.createWordBoxes(document.getElementById('host'), { count: 12, wordlist: BIP39, idPrefix: 't' }); });
  await page.click('#t-word-0'); await page.keyboard.type('aban');
  ck('boxes: suggestions appear while typing', await page.isVisible('#host .rst-autocomplete-item'));
  await page.keyboard.press('Enter');
  ck('boxes: Enter takes the suggestion and moves on', (await page.inputValue('#t-word-0')) === 'abandon' &&
    await page.evaluate(() => document.activeElement.id) === 't-word-1');
  await page.keyboard.type('abil'); await page.keyboard.press('Tab');
  ck('boxes: Tab completes a unique prefix', (await page.inputValue('#t-word-1')) === 'ability');
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text', '3. able 4. about 5. above');
    document.getElementById('t-word-2').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  ck('boxes: a pasted phrase fills the following boxes', JSON.stringify(await page.evaluate(() => boxes.getWords().slice(0, 6))) === '["abandon","ability","able","about","above",""]');
  await page.fill('#t-word-5', 'bitcoin');
  ck('boxes: a non-word counts as empty', await page.evaluate(() => boxes.getWords()[5] === ''));
  await page.evaluate(() => boxes.markWrong([1, 3]));
  ck('boxes: marked boxes are outlined', JSON.stringify(await page.$$eval('#host input.wrong', (els) => els.map((e) => e.id))) === '["t-word-1","t-word-3"]');
  await page.evaluate(() => boxes.destroy());

  // The flow
  async function walk(kind) {
    return page.evaluate(async (kind) => {
      const host = document.getElementById('host');
      const shares = kind === 'xor'
        ? ['abandon ability able about above absent absorb abstract absurd abuse access accident', 'zoo zone zero youth young you wrong write wrist wreck wrap worth', 'act action actor actress actual adapt add addict address adjust admit adult']
        : ['academic acid acne acquire acrobat activity actress adapt adequate adjust admit adorn adult advance advocate afraid again agency agree aide', 'wrist writing wrote year yelp yield yoga zero academic acid acne acquire acrobat activity actress adapt adequate adjust admit adorn'];
      const log = { finished: 0, cancelled: 0, verified: null };
      window.flow = SF.mountShareFlow(host, {
        idPrefix: 'f' + kind, shares, wordlist: kind === 'xor' ? BIP39 : SLIP,
        shareName: kind === 'xor' ? 'XOR share' : 'Shamir share',
        schemeLine: kind === 'xor' ? 'All 3 shares are needed.' : 'Any 2 of 2 shares recover the seed.',
        fingerprint: '5436d724',
        drawQR: (canvas) => { canvas.dataset.drawn = '1'; },
        verifyAll: async (typed) => { log.verified = typed; return kind === 'xor' ? { ok: true } : { ok: false, message: 'They rebuild a different seed.' }; },
        doneLines: ['Store each share in a different place.'],
        onFinish: () => { log.finished++; }, onCancel: () => { log.cancelled++; },
      });
      window.flowLog = log; window.flowShares = shares;
      return shares.length;
    }, kind);
  }
  const text = () => page.evaluate(() => document.getElementById('host').innerText);
  const typeShare = (k, words) => page.evaluate(([k, words]) => {
    document.querySelectorAll('#host .rst-cell input').forEach((inp, i) => { inp.value = words[i] || ''; inp.dispatchEvent(new Event('input')); });
  }, [k, words]);
  const clickText = (t) => page.getByRole('button', { name: t, exact: true }).click();

  const n = await walk('xor');
  let t = await text();
  ck('flow: opens on share 1 with its words, scheme and fingerprint', /XOR share 1 of 3/.test(t) && /All 3 shares are needed/.test(t) && /5436d724/.test(t) && /abandon/.test(t));
  ck('flow: progress shows every share', (await page.$$('#host .sf-chip')).length === 3);
  ck('flow: no Copy button', !(await page.$$eval('#host button', (bs) => bs.map((b) => b.textContent))).includes('Copy'));
  await clickText('Show QR');
  ck('flow: Show QR draws the code', await page.$eval('#host .sf-qr canvas', (c) => c.dataset.drawn === '1'));
  await clickText('I’ve written it down — check it');
  t = await text();
  ck('flow: check screen has empty word boxes and no share words', /Check XOR share 1 of 3/.test(t) && (await page.$$('#host .rst-cell input')).length === 12 &&
    !(await page.evaluate(() => document.getElementById('host').innerHTML.includes('accident'))));
  const shares = await page.evaluate(() => flowShares.map((s) => s.split(' ')));
  const typo = shares[0].slice(); typo[3] = 'zoo'; typo[10] = '';
  await typeShare(0, typo); await clickText('Check share 1');
  t = await text();
  ck('flow: a wrong word is named by position, the empty box counted', /Word 4 doesn’t match share 1/.test(t) && /1 empty box/.test(t), t.slice(0, 400));
  ck('flow: the wrong box is outlined', JSON.stringify(await page.$$eval('#host input.wrong', (els) => els.map((e) => e.dataset.idx))) === '["3"]');
  await clickText('Look at share 1 again');
  ck('flow: going back shows share 1 again', /XOR share 1 of 3/.test(await text()));
  await clickText('I’ve written it down — check it');
  ck('flow: the typed words are kept when coming back', (await page.inputValue('#fxor-0-word-3')) === 'zoo');
  for (let k = 0; k < n; k++) {
    if (k > 0) await clickText('I’ve written it down — check it');
    await typeShare(k, shares[k]); await clickText('Check share ' + (k + 1));
    if (k < n - 1) ck(`flow: share ${k + 1} passes and share ${k + 2} is shown`, new RegExp('Share ' + (k + 1) + ' matches your paper[\\s\\S]*XOR share ' + (k + 2) + ' of 3').test(await text()));
  }
  await page.waitForFunction(() => /Your 3 shares are checked/.test(document.getElementById('host').innerText));
  ck('flow: all checked → recombined → done', await page.evaluate(() => flow.isComplete() && flowLog.verified.length === 3 && flowLog.verified[2] === flowShares[2]));
  ck('flow: done lists the summary', /Store each share in a different place/.test(await text()));
  await clickText('Back to Dashboard');
  ck('flow: Back to Dashboard calls onFinish', await page.evaluate(() => flowLog.finished === 1));
  await page.evaluate(() => flow.destroy());
  ck('flow: destroy clears the screen', await page.evaluate(() => document.getElementById('host').innerHTML === ''));

  await walk('slip');
  const sshares = await page.evaluate(() => flowShares.map((s) => s.split(' ')));
  ck('Shamir: all 20 SLIP-39 words are shown', (await page.$$('#host .sf-word')).length === 20);
  for (let k = 0; k < 2; k++) {
    await clickText('I’ve written it down — check it');
    await typeShare(k, sshares[k]); await clickText('Check share ' + (k + 1));
  }
  await page.waitForFunction(() => /different seed/.test(document.getElementById('host').innerText));
  ck('Shamir: a failed recombine shows the reason and is not complete', await page.evaluate(() => !flow.isComplete()));
  await clickText('Cancel');
  ck('Shamir: Cancel calls onCancel', await page.evaluate(() => flowLog.cancelled === 1));

  // Check shares I already have
  await page.evaluate(() => {
    window.chk = { back: 0, got: null };
    window.checker = SF.mountShareChecker(document.getElementById('host'), {
      idPrefix: 'c', wordlist: BIP39, wordCount: 12, shareName: 'XOR share', counts: [2, 3, 4], count: 2,
      intro: 'Type in each share.', scan: () => () => {},
      check: async (typed) => { chk.got = typed; return typed[0].startsWith('abandon')
        ? { ok: true, message: 'They rebuild your vault seed.', words: 'zoo zone zero youth young you wrong write wrist wreck wrap worth', wordsLabel: 'These are your vault seed words.' }
        : { ok: false, message: 'They rebuild a different seed.' }; },
      onBack: () => { chk.back++; },
    });
  });
  ck('checker: two shares of 12 boxes, each with Scan QR', (await page.$$('#host .rst-cell input')).length === 24 && (await page.$$('#host .sf-share-head button')).length === 2);
  await page.fill('#c-0-word-0', 'abandon');
  await clickText('3');
  ck('checker: choosing 3 shares adds a share and keeps typed words', (await page.$$('#host .rst-cell input')).length === 36 && (await page.inputValue('#c-0-word-0')) === 'abandon');
  await clickText('Check these shares');
  ck('checker: empty boxes are named by share', /Fill in every word of shares 1, 2, 3/.test(await text()));
  const twelve = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
  await page.evaluate((w) => { document.querySelectorAll('#host .rst-cell input').forEach((inp, i) => { inp.value = w[i % 12]; inp.dispatchEvent(new Event('input')); }); }, twelve);
  await clickText('Check these shares');
  await page.waitForFunction(() => /rebuild your vault seed/.test(document.getElementById('host').innerText));
  ck('checker: passes the typed shares and shows a pass', await page.evaluate(() => chk.got.length === 3 && chk.got[2].split(' ').length === 12) && await page.isVisible('#host .sf-status.ok'));
  ck('checker: the rebuilt words stay hidden until asked for', !(await page.evaluate(() => document.getElementById('host').innerText.includes('youth'))) && await page.isVisible('#host .sf-reveal button'));
  await clickText('Show the seed words');
  ck('checker: Show the seed words shows the numbered words and the label', (await page.$$('#host .sf-reveal .sf-word')).length === 12 && /youth/.test(await text()) && /These are your vault seed words/.test(await text()));
  ck('checker: no Copy next to the words', !(await page.$$eval('#host button', (bs) => bs.map((b) => b.textContent))).includes('Copy'));
  await clickText('Hide the seed words');
  ck('checker: Hide the seed words hides them again', !(await page.evaluate(() => document.getElementById('host').innerText.includes('youth'))) && await page.isVisible('#host .sf-reveal button'));
  await clickText('Show the seed words');
  await page.fill('#c-0-word-0', 'zoo');
  ck('checker: editing a word clears the old result and the words', !(await page.isVisible('#host .sf-status.ok')) && !(await page.evaluate(() => document.getElementById('host').innerText.includes('youth'))) && (await page.$$('#host .sf-reveal *')).length === 0);
  await page.fill('#c-0-word-0', 'act'); await clickText('Check these shares');
  await page.waitForFunction(() => /different seed/.test(document.getElementById('host').innerText));
  ck('checker: shows a failure (no words offered when the check returns none)', await page.isVisible('#host .sf-status.error') && (await page.$$('#host .sf-reveal *')).length === 0);
  await clickText('Back');
  ck('checker: Back calls onBack', await page.evaluate(() => chk.back === 1));
  await page.evaluate(() => checker.destroy());
  // Words per share: either length, and a scanned share of the other length switches it.
  await page.evaluate(() => {
    window.scanned = null;
    window.checker2 = SF.mountShareChecker(document.getElementById('host'), {
      idPrefix: 'c2', wordlist: BIP39, wordCount: 24, wordCounts: [12, 24], wordCountLabel: (n) => n + ' words',
      shareName: 'XOR share', counts: [2, 3], count: 2,
      scan: (reader, onWords) => { window.scanned = onWords; return () => {}; },
      check: async () => ({ ok: true, message: 'ok' }), onBack() {},
    });
  });
  ck('checker: defaults to the vault seed length (2 × 24 boxes)', (await page.$$('#host .rst-cell input')).length === 48);
  await clickText('12 words');
  ck('checker: choosing 12 words gives 2 × 12 boxes', (await page.$$('#host .rst-cell input')).length === 24);
  await page.fill('#c2-0-word-0', 'abandon'); await clickText('3');
  ck('checker: changing the share count keeps the length and typed words', (await page.$$('#host .rst-cell input')).length === 36 && (await page.inputValue('#c2-0-word-0')) === 'abandon');
  await clickText('24 words');
  ck('checker: changing the length clears typed words of the old length', (await page.$$('#host .rst-cell input')).length === 72 && (await page.inputValue('#c2-0-word-0')) === '');
  await page.locator('#host .sf-share-head button').nth(1).click();
  await page.evaluate((w) => window.scanned(w), twelve);
  ck('checker: scanning a 12-word share switches to 12 words and fills that share', (await page.$$('#host .rst-cell input')).length === 36 && (await page.inputValue('#c2-1-word-0')) === 'abandon' && (await page.inputValue('#c2-1-word-11')) === 'accident');
  await page.locator('#host .sf-share-head button').nth(0).click();
  await page.evaluate(() => window.scanned('one two three'.split(' ')));
  ck('checker: a QR code of neither length is refused, naming both lengths', /isn’t a 12 or 24-word xor share/.test(await text()));
  await page.evaluate(() => checker2.destroy());
  ck('checker: destroy clears the screen', await page.evaluate(() => document.getElementById('host').innerHTML === ''));

  await page.setViewportSize({ width: 1920, height: 1080 });
  await walk('slip');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  ck('no sideways scroll at 1920×1080', wide);
  ck('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close(); server.close();
}

console.log(`\nSHARE FLOW: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

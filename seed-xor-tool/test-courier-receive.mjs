/**
 * test-courier-receive.mjs — The Courier's Receive tab, in the BUILT app
 *
 * The online Courier Tool sends a long text as ur:bytes in many small
 * fountain-coded frames (and relays BBQr codes as BBQr frames). The
 * Receive tab used to take the first frame of such a code as if it were
 * the whole text ("ur:bytes/1-23/…"), and a single-line password field
 * dropped line breaks. This opens dist/boot.html in Chromium and feeds the
 * real receiver (xfr_processQR) frames made here with the same UR library:
 *
 *   1. A two-page, multi-line text as animated ur:bytes arrives whole,
 *      byte for byte, line breaks included, hidden until Show.
 *   2. Frames arriving in any order, and repeated, still work; no text is
 *      shown before the last needed frame.
 *   3. A PSBT as ur:crypto-psbt is offered as a file to save.
 *   4. Animated BBQr text arrives whole; a BBQr PSBT is offered as a file.
 *   5. A single static QR code with line breaks keeps them.
 *
 * Needs `npm run build` first and a Chromium-family browser (CHROMIUM_BINARY).
 * Run:  node test-courier-receive.mjs
 */
import { existsSync } from 'node:fs';
import { UR, UREncoder } from '@ngraveio/bc-ur';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };

const app = new URL('./dist/boot.html', import.meta.url);
if (!existsSync(app)) { console.error('dist/boot.html is missing: run `npm run build` first.'); process.exit(1); }
const executablePath = [process.env.CHROMIUM_BINARY,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
if (!executablePath) { console.error('No Chromium-family browser found. Set CHROMIUM_BINARY.'); process.exit(1); }

// About two pages of text, with line breaks, blank lines, tabs and accents.
const para = 'The quick brown fox jumps over the lazy dog, café déjà vu: 0123456789.\n';
const TEXT = Array.from({ length: 60 }, (_, i) => (i % 10 === 9 ? '\n' : '') + `${i + 1}.\t` + para).join('') + 'END ✓';

// As the Courier Tool does it: ur:bytes in 90-byte fragments.
function urFrames(ur, fragLen, count) {
    const enc = new UREncoder(ur, fragLen);
    const out = [];
    for (let i = 0; i < count; i++) out.push(enc.nextPart());
    return { frames: out, parts: enc.fragmentsLength };
}
const textUr = UR.fromBuffer(Buffer.from(new TextEncoder().encode(TEXT)));
const text = urFrames(textUr, 90, 0);
const textAll = urFrames(textUr, 90, Math.ceil(text.parts * 1.6) + 5).frames;

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath, headless: true, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(app.href);
await page.waitForFunction(() => typeof window.xfr_processQR === 'function' && !!window.URDecoder, null, { timeout: 30000 });

const fresh = () => page.evaluate(() => {
    xfr_state.recvUr = null; xfr_state.recvBbqr = null; xfr_state.recvCollector = null; xfr_state.recvTotalChunks = null;
    document.getElementById('xfr-recv-static').style.display = 'none';
    document.getElementById('xfr-recv-complete').style.display = 'none';
    document.getElementById('xfr-recv-text').value = '';
});
const feed = (frames) => page.evaluate(async (frames) => { for (const f of frames) { await xfr_processQR(f); } await new Promise((r) => setTimeout(r, 50)); }, frames);
const shown = () => page.evaluate(() => ({
    staticShown: document.getElementById('xfr-recv-static').style.display === 'block',
    fileShown: document.getElementById('xfr-recv-complete').style.display === 'block',
    text: document.getElementById('xfr-recv-text').value,
    masked: document.getElementById('xfr-recv-text').classList.contains('xfr-masked'),
    tag: document.getElementById('xfr-recv-text').tagName,
    saveName: document.getElementById('xfr-recv-save-name').value,
    bytes: xfr_state.recvBytes ? Array.from(xfr_state.recvBytes) : null,
    progress: document.getElementById('xfr-recv-chunk-count').textContent,
}));

try {
    console.log(`  (the text is ${TEXT.length} characters, ${text.parts} UR fragments)`);
    ck('the test text needs many frames', text.parts > 10);

    // 1. One frame used to be taken as the whole text.
    await fresh();
    await feed(textAll.slice(0, 1));
    let s = await shown();
    ck('one frame of an animated ur:bytes code isn\'t shown as the text', !s.staticShown && s.text === '', JSON.stringify(s).slice(0, 200));
    ck('it shows progress instead', /^\d+%$/.test(s.progress) && s.progress !== '100%', s.progress);

    await feed(textAll.slice(1));
    s = await shown();
    ck('the whole two-page text arrives, byte for byte', s.staticShown && s.text === TEXT, s.text.slice(0, 120));
    ck('line breaks, tabs and accents are kept', s.text.split('\n').length === TEXT.split('\n').length && s.text.includes('café') && s.text.includes('\t'));
    ck('the text is in a multi-line box, hidden until Show', s.tag === 'TEXTAREA' && s.masked);

    // 2. Out of order and repeated frames (a camera misses and re-reads).
    await fresh();
    const shuffled = [...textAll].reverse().flatMap((f, i) => (i % 3 === 0 ? [f, f] : [f]));
    await feed(shuffled);
    s = await shown();
    ck('frames in any order, some twice, still give the whole text', s.staticShown && s.text === TEXT);

    // Show / Hide works on the multi-line box.
    const toggled = await page.evaluate(() => {
        const box = document.getElementById('xfr-recv-text'); const btn = box.parentNode.querySelector('button');
        xfr_togglePwd('xfr-recv-text', btn); const a = [box.classList.contains('xfr-masked'), btn.textContent];
        xfr_togglePwd('xfr-recv-text', btn); return a.concat([box.classList.contains('xfr-masked'), btn.textContent]);
    });
    ck('Show reveals the text, Hide hides it again', JSON.stringify(toggled) === JSON.stringify([false, 'Hide', true, 'Show']), JSON.stringify(toggled));

    // 3. A PSBT as ur:crypto-psbt becomes a file.
    await fresh();
    const psbt = Buffer.concat([Buffer.from('70736274ff', 'hex'), Buffer.alloc(700, 7)]);
    const psbtUrFixed = new UR(UR.fromBuffer(psbt).cbor, 'crypto-psbt');
    const pf = urFrames(psbtUrFixed, 100, 0);
    await feed(urFrames(psbtUrFixed, 100, Math.ceil(pf.parts * 1.6) + 5).frames);
    s = await shown();
    ck('a ur:crypto-psbt arrives as a file to save, named .psbt', s.fileShown && s.saveName === 'received.psbt'
        && s.bytes && Buffer.from(s.bytes).equals(psbt), JSON.stringify({ fileShown: s.fileShown, name: s.saveName, n: s.bytes && s.bytes.length }));

    // 4. BBQr (the Courier Tool's relay mode passes these on).
    const bbqr = (type, hex, per) => {
        const chunks = hex.match(new RegExp('.{1,' + per + '}', 'g'));
        const b36 = (n) => n.toString(36).toUpperCase().padStart(2, '0');
        return chunks.map((c, i) => 'B$H' + type + b36(chunks.length) + b36(i) + c);
    };
    await fresh();
    const bt = bbqr('U', Buffer.from(TEXT).toString('hex').toUpperCase(), 400);
    await feed(bt.slice(0, 2));
    s = await shown();
    ck('part of a BBQr code isn\'t shown as the text', !s.staticShown && /%$/.test(s.progress));
    await feed(bt.slice(2).reverse());
    s = await shown();
    ck('animated BBQr text arrives whole', s.staticShown && s.text === TEXT);
    await fresh();
    await feed(bbqr('P', psbt.toString('hex').toUpperCase(), 300));
    s = await shown();
    ck('a BBQr PSBT arrives as a file to save', s.fileShown && s.saveName === 'received.psbt' && s.bytes && Buffer.from(s.bytes).equals(psbt));

    // 5. A single static QR with line breaks (a short note, a descriptor).
    await fresh();
    await feed(['first line\nsecond line\n\nfourth line']);
    s = await shown();
    ck('a single static QR keeps its line breaks', s.staticShown && s.text === 'first line\nsecond line\n\nfourth line', JSON.stringify(s.text));

    ck('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
    await browser.close();
}

console.log(`\ntest-courier-receive: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

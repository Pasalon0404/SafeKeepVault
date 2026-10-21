/**
 * test-entropy-built.mjs — seed generation in the BUILT app, in Chromium
 *
 * COLDCARD's 2021–2026 seed flaw was a build change that swapped the random
 * number generator and nothing noticed. The other entropy tests check the
 * source modules; this one opens dist/boot.html (what ships on the stick) in
 * Chromium and drives the real Entropy Generator functions:
 *
 *   1. The start-up self-check ran and passed in the built page.
 *   2. Health check: a replaced, all-zero or repeating random number
 *      generator makes every seed path refuse (Mixed, 1-click), and the real
 *      one passes.
 *   3. Mixed mode: the seed is exactly SHA-256(label || device32 ||
 *      SHA-256(pool)) truncated, computed here with node:crypto from the
 *      bytes the page actually drew. Changing either the pool or the device
 *      bytes changes the seed.
 *   4. After a Mixed seed the pool and meter are empty and the button stays
 *      off until all-new input fills it again.
 *   5. Verifiable dice: patterned rolls are refused, unusual rolls need the
 *      confirmation box, ordinary rolls go through.
 *   6. Mouse: 0.25 bits a sample and no more than half the target, also
 *      after switching from 24 to 12 words.
 *
 * Needs `npm run build` first and a Chromium-family browser: set
 * CHROMIUM_BINARY, or it looks for Google Chrome / chromium in the usual
 * places. It fails (does not skip) if it can't find one.
 *
 * Run:  node test-entropy-built.mjs
 */

import { existsSync } from 'node:fs';
import { createHash, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const MIX_LABEL = 'SafeKeepVault/entropy-mix/v1';

const app = new URL('./dist/boot.html', import.meta.url);
if (!existsSync(app)) { console.error('dist/boot.html is missing: run `npm run build` first.'); process.exit(1); }
const executablePath = [process.env.CHROMIUM_BINARY,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/ungoogled-chromium', '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
if (!executablePath) { console.error('No Chromium-family browser found. Set CHROMIUM_BINARY.'); process.exit(1); }

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath, headless: true, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(app.href);
await page.waitForFunction(() => document.documentElement.dataset.selfTests !== undefined, null, { timeout: 30000 });

// In-page helpers: a generator stand-in that looks built-in (a bound function
// prints as "[native code]"), records every draw, and can be put back.
await page.evaluate(() => {
    const real = Crypto.prototype.getRandomValues;
    window.__rng = {
        draws: [],
        restore() { Crypto.prototype.getRandomValues = real; },
        use(fill) {
            const rec = this.draws;
            Crypto.prototype.getRandomValues = (function (a) { fill(a); rec.push(Array.from(a)); return a; }).bind(null);
        },
        // xorshift32: looks random enough for the health check, and repeatable.
        seeded(seed) {
            let x = seed >>> 0 || 1;
            this.use((a) => { for (let i = 0; i < a.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; a[i] = x & 255; } });
        },
    };
    window.__key = (k) => eob_handleDiceKey({ key: k, preventDefault() {} });
    // eob_init('forge') keeps earlier work when re-entered; start clean.
    window.__fresh = () => { _eobHasWork = false; eob_init('forge'); };
});

console.log('\n1. Built page');
ck('start-up self-check ran and passed', await page.evaluate(() => document.documentElement.dataset.selfTestsFailed === '0'),
    await page.evaluate(() => document.documentElement.dataset.selfTestsFailed));
ck('entropy modules are loaded', await page.evaluate(() =>
    !!(window.SKEntropyMix && window.DiceFairness?.verifiableDiceGate && window.EntropySources?.mouseCredit && window.generateHardenedEntropy)));

console.log('\n2. Random number generator health check');
ck('the real generator passes', await page.evaluate(async () => (await SKEntropyMix.drawCheckedRandom(32)).length === 32));
const refused = (fnSrc) => page.evaluate(async (src) => {
    try { await (0, eval)(src)(); return false; } catch (e) { return /random number generator/.test(e.message); } finally { __rng.restore(); }
}, fnSrc);
ck('a generator replaced by script is refused',
    await refused('async () => { Crypto.prototype.getRandomValues = function (a) { return a; }; return SKEntropyMix.drawCheckedRandom(32); }'));
ck('an all-zero generator is refused',
    await refused('async () => { __rng.use((a) => a.fill(0)); return SKEntropyMix.drawCheckedRandom(32); }'));
ck('a constant generator is refused',
    await refused('async () => { __rng.use((a) => a.fill(0xa5)); return generateHardenedEntropy(16); }'));
ck('a generator that repeats its output is refused', await refused(`async () => {
    __rng.seeded(777); await SKEntropyMix.drawCheckedRandom(32);
    __rng.seeded(777); return SKEntropyMix.drawCheckedRandom(32); }`));
ck('a counting generator is refused',
    await refused('async () => { let n = 0; __rng.use((a) => { for (let i = 0; i < a.length; i++) a[i] = (n++ * 37) & 255; }); return SKEntropyMix.drawCheckedRandom(32); }'));
ck('a heavily biased generator is refused',
    await refused('async () => { let x = 7; __rng.use((a) => { for (let i = 0; i < a.length; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = (x >>> 16) & 0x7f; } }); return SKEntropyMix.drawCheckedRandom(32); }'));
{
    // A broken generator must stop a Mixed seed too, and show no words.
    const r = await page.evaluate(async () => {
        __fresh();
        _activeEntropyPool = 'D3x'; _eobEstimatedBits = 999;
        __rng.use((a) => a.fill(0));
        try { await eob_forgeSeed(); } finally { __rng.restore(); }
        return { shown: document.getElementById('eob-forge-result').style.display, words: document.getElementById('eob-result-words').textContent };
    });
    ck('Mixed mode makes no seed from a broken generator', r.shown === 'none' && r.words === '', JSON.stringify(r));
}

console.log('\n3. Mixed mode = SHA-256(label || device || SHA-256(pool))');
const forge = (pool, seed, words = 12) => page.evaluate(async ({ pool, seed, words }) => {
    __fresh();
    eob_setWordCount(words);
    _activeEntropyPool = pool; _eobEstimatedBits = 999;
    __rng.draws.length = 0;
    __rng.seeded(seed);
    try { await eob_forgeSeed(); } finally { __rng.restore(); }
    return { hex: document.getElementById('eob-result-hex').textContent, draws: __rng.draws.slice(),
             pool: _activeEntropyPool, bits: _eobEstimatedBits, btn: document.getElementById('eob-forge-btn').disabled };
}, { pool, seed, words });
{
    const pool = 'D4lq1C' + 'AS' + 'M120,340,1234.5,99';
    const a = await forge(pool, 12345);
    const device = a.draws.filter((d) => d.length === 32);
    ck('one health-checked 32-byte device draw (after a 1024-byte sample)', a.draws.length === 2 && a.draws[0].length === 1024 && device.length === 1, a.draws.map((d) => d.length).join());
    const expected = sha256(MIX_LABEL, device[0], sha256(pool)).subarray(0, 16).toString('hex');
    ck('12 words: entropy matches node:crypto', a.hex === expected, `${a.hex} vs ${expected}`);
    // Each forge here uses different device bytes from the one before: the
    // health check refuses a generator that repeats its last output.
    const c = await forge(pool, 54321);
    ck('different device bytes change the seed', c.hex !== a.hex);
    const b = await forge(pool + 'x', 12345);
    ck('one more character in the pool changes the seed', b.hex !== a.hex && b.draws.length === 2);
    const d = await forge(pool, 999, 24);
    const dev24 = d.draws.filter((x) => x.length === 32)[0];
    ck('24 words: entropy matches node:crypto', d.hex === sha256(MIX_LABEL, dev24, sha256(pool)).toString('hex'));
    const xor = Buffer.from(device[0].slice(0, 16)).map((v, i) => v ^ sha256(pool)[i]).toString('hex');
    ck('…and is no longer the old XOR mix', a.hex !== xor);

    console.log('\n4. Pool is emptied after a Mixed seed');
    ck('pool and credit are empty', a.pool === '' && a.bits === 0, JSON.stringify({ pool: a.pool, bits: a.bits }));
    ck('Generate button is off', a.btn === true);
    const after = await page.evaluate(() => {
        _eobWiggleThrottle = 0;
        eob_handleWiggle({ clientX: 10, clientY: 10, timeStamp: 1 });
        _eobWiggleThrottle = 0;
        eob_handleWiggle({ clientX: 50, clientY: 70, timeStamp: 2 });
        return { btn: document.getElementById('eob-forge-btn').disabled, shown: document.getElementById('eob-forge-result').style.display };
    });
    ck('a little new input does not turn it back on', after.btn === true);
    ck('the seed just made stays on screen', after.shown === 'block');
}

console.log('\n5. Verifiable dice');
const verify = (rolls, tick) => page.evaluate(({ rolls, tick }) => {
    __fresh();
    eob_setEntropyMode('verifiable');
    for (const r of rolls) __key(String(r));
    const box = document.getElementById('eob-dice-confirm');
    if (tick) { document.getElementById('eob-dice-confirm-check').checked = true; eob_updateMeter(); }
    return { btn: document.getElementById('eob-forge-btn').disabled, hint: document.getElementById('eob-forge-hint').textContent,
             panel: document.getElementById('eob-dice-fairness').textContent, confirm: !box.hidden };
}, { rolls, tick });
{
    const pattern = await verify('123456'.repeat(9).slice(0, 50));
    ck('123456123456… is refused', pattern.btn === true && /pattern/.test(pattern.hint), pattern.hint);
    ck('…and the panel no longer says "looks fair"', /not random/.test(pattern.panel) && !/No sign of bias/.test(pattern.panel), pattern.panel.slice(0, 120));
    ck('…with no way to confirm it anyway', pattern.confirm === false);
    for (const s of ['112233445566'.repeat(5).slice(0, 50), '1'.repeat(50), '135135'.repeat(9).slice(0, 50)]) {
        const r = await verify(s);
        ck(`${s.slice(0, 12)}… is refused`, r.btn === true);
    }
    // Ordinary rolls: a fair die, retried until the gate says ok (99% are).
    let fair;
    for (let i = 0; i < 20; i++) {
        fair = Array.from({ length: 50 }, () => randomInt(1, 7));
        if (await page.evaluate((r) => DiceFairness.verifiableDiceGate(r).id === 'ok', fair)) break;
    }
    const ok = await verify(fair);
    ck('ordinary rolls are accepted', ok.btn === false && ok.confirm === false, ok.hint);
    // A run of 8 sixes in otherwise ordinary rolls: unusual, needs confirming.
    const odd = fair.slice(0, 42).concat(Array(8).fill(6));
    const gate = await page.evaluate((r) => DiceFairness.verifiableDiceGate(r).id, odd);
    const unchecked = await verify(odd);
    ck('unusual rolls need the confirmation box', gate === 'confirm' && unchecked.btn === true && unchecked.confirm === true, gate);
    const checked = await verify(odd, true);
    ck('…and go through once it is ticked', checked.btn === false);
    const undo = await page.evaluate(() => { __key('Backspace'); __key('6'); return document.getElementById('eob-dice-confirm-check').checked; });
    ck('changing a roll clears the confirmation', undo === false);
}

console.log('\n6. Mouse credit');
{
    const r = await page.evaluate(() => {
        __fresh();
        eob_setWordCount(24);
        for (let i = 0; i < 2000; i++) {
            _eobWiggleThrottle = 0;
            eob_handleWiggle({ clientX: (i * 37) % 400, clientY: (i * 91) % 300, timeStamp: i });
        }
        const at24 = { counted: _eobCountedBits(), btn: document.getElementById('eob-forge-btn').disabled };
        eob_setWordCount(12);
        return { at24, at12: { counted: _eobCountedBits(), btn: document.getElementById('eob-forge-btn').disabled,
                 hint: document.getElementById('eob-forge-hint').textContent }, pool: _activeEntropyPool.slice(0, 200) };
    });
    ck('24 words: 2000 samples count as 128 of 256 bits', r.at24.counted === 128 && r.at24.btn === true, JSON.stringify(r.at24));
    ck('switching to 12 words: still only half (64 of 128)', r.at12.counted === 64 && r.at12.btn === true, JSON.stringify(r.at12));
    ck('the hint says to add dice, cards or camera', /dice, cards or camera/.test(r.at12.hint), r.at12.hint);
    ck('samples record fine timing', /M\d+,\d+,\d+(\.\d+)?,\d+/.test(r.pool), r.pool.slice(0, 60));
}

ck('no page errors from the Entropy Generator', !pageErrors.some((m) => /eob_|Entropy|DiceFairness|SKEntropyMix/.test(m)), pageErrors.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

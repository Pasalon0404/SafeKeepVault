/**
 * test-dice-fairness.mjs — chi-squared die fairness check
 *
 *   1. p-values match published chi-squared critical values (df = 5, the d6
 *      case) and the closed forms for even df (df = 2: e^(-x/2); df = 4:
 *      e^(-x/2)(1 + x/2)), checked independently of the gamma code.
 *   2. Verdicts: empty / need-more below 30 rolls / ok / suspicious / biased,
 *      and out-of-range input is ignored.
 *   3. Simulation: a fair die is flagged "biased" about 1% of the time and
 *      "suspicious or worse" about 5%; a loaded die (one face twice as likely)
 *      is caught almost always at 300 rolls.
 *   4. boot.html wiring: the panel exists, only hand-entered rolls feed it,
 *      all three reset paths clear it, and boot-entry.js loads the module.
 *   5. Pattern check: made-up sequences (123456…, 112233…, 1111…) that the
 *      chi-squared test calls fair are caught; Verifiable mode refuses them,
 *      asks to confirm unusual rolls, and passes ordinary ones. Simulated
 *      fair dice are never refused and asked to confirm about 1% of the time.
 *
 * Run:  node test-dice-fairness.mjs
 */

import { assessDice, chiSquaredPValue, describeAssessment, findRollPatterns, verifiableDiceGate, PATTERN_LIMITS } from './shared/dice-fairness.js';
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('\n1. p-values');
// Published upper-tail critical values for 5 degrees of freedom.
for (const [x, p] of [[1.6103, 0.90], [4.3515, 0.50], [9.2364, 0.10], [11.0705, 0.05], [12.8325, 0.025], [15.0863, 0.01], [20.5150, 0.001]]) {
    const got = chiSquaredPValue(x, 5);
    ck(`df=5, χ²=${x} → p=${p}`, near(got, p, 1e-4), got);
}
for (const x of [0.1, 1, 3, 7.5, 20, 60]) {
    const g2 = chiSquaredPValue(x, 2), e2 = Math.exp(-x / 2);
    const g4 = chiSquaredPValue(x, 4), e4 = Math.exp(-x / 2) * (1 + x / 2);
    ck(`closed form df=2, χ²=${x}`, near(g2, e2, 1e-12 + e2 * 1e-9), `${g2} vs ${e2}`);
    ck(`closed form df=4, χ²=${x}`, near(g4, e4, 1e-12 + e4 * 1e-9), `${g4} vs ${e4}`);
}
ck('χ²=0 → p=1', chiSquaredPValue(0, 5) === 1);

console.log('\n2. Verdicts');
ck('no rolls → empty', assessDice([]).verdict.id === 'empty');
ck('29 rolls → need-more', assessDice(Array(29).fill(1)).verdict.id === 'need-more');
{
    const r = assessDice(Array.from({ length: 30 }, (_, i) => (i % 6) + 1));
    ck('30 perfectly even rolls → ok', r.verdict.id === 'ok' && r.chi === 0 && r.p === 1);
}
ck('60 rolls all sixes → biased', assessDice(Array(60).fill(6)).verdict.id === 'biased');
{
    // counts 15,10,10,10,10,5: χ² = (25+0+0+0+0+25)/10 = 5 → p ≈ 0.416
    const rolls = [...Array(15).fill(1), ...Array(10).fill(2), ...Array(10).fill(3), ...Array(10).fill(4), ...Array(10).fill(5), ...Array(5).fill(6)];
    const r = assessDice(rolls);
    ck('hand-computed χ² = 5', near(r.chi, 5, 1e-12), r.chi);
    ck('…verdict ok', r.verdict.id === 'ok');
}
{
    // counts 18,10,10,10,10,2: χ² = (64+64)/10 = 12.8 → p ≈ 0.025
    const rolls = [...Array(18).fill(1), ...Array(10).fill(2), ...Array(10).fill(3), ...Array(10).fill(4), ...Array(10).fill(5), ...Array(2).fill(6)];
    ck('χ² = 12.8 → suspicious', assessDice(rolls).verdict.id === 'suspicious');
}
{
    const r = assessDice([1, 2, 7, 0, 'x', 3.5, '4', null]);
    ck('out-of-range and non-integer values ignored', r.n === 3 && r.counts.join() === '1,1,0,1,0,0', r.counts.join());
}
ck('description mentions remaining rolls', /24 more/.test(describeAssessment(assessDice([1, 2, 3, 4, 5, 6]))));

console.log('\n3. Simulation (crypto RNG)');
{
    const TRIALS = 4000, N = 120;
    let biased = 0, flagged = 0;
    for (let t = 0; t < TRIALS; t++) {
        const id = assessDice(Array.from({ length: N }, () => randomInt(1, 7))).verdict.id;
        if (id === 'biased') biased++;
        if (id === 'biased' || id === 'suspicious') flagged++;
    }
    ck(`fair die flagged "biased" ≈1% (got ${(biased / TRIALS * 100).toFixed(2)}%)`, biased / TRIALS < 0.025);
    ck(`fair die flagged at all ≈5% (got ${(flagged / TRIALS * 100).toFixed(2)}%)`, flagged / TRIALS > 0.025 && flagged / TRIALS < 0.08);
}
{
    // Face 6 twice as likely as each other face: weights 1,1,1,1,1,2 of 7.
    const loaded = () => { const v = randomInt(0, 7); return v >= 5 ? 6 : v + 1; };
    const TRIALS = 500;
    let caught = 0;
    for (let t = 0; t < TRIALS; t++) if (assessDice(Array.from({ length: 300 }, loaded)).verdict.id === 'biased') caught++;
    ck(`loaded die caught at 300 rolls (got ${(caught / TRIALS * 100).toFixed(1)}%)`, caught / TRIALS > 0.9);
}

console.log('\n4. boot.html wiring');
{
    const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
    const entry = readFileSync(new URL('./boot-entry.js', import.meta.url), 'utf8');
    ck('panel element present', html.includes('id="eob-dice-fairness"'));
    ck('boot-entry.js imports the module', entry.includes("import './shared/dice-fairness.js'"));
    const handler = html.slice(html.indexOf('function eob_handleDiceKey('), html.indexOf('function eob_handleWiggle('));
    ck('manual dice handler records the roll and re-renders', handler.includes('_eobDiceRolls.push(') && handler.includes('eob_renderDiceFairness()'));
    const others = html.slice(html.indexOf('function eob_handleWiggle('), html.indexOf('async function eob_captureVideoNoise(') + 2000);
    ck('mouse and camera do not feed the check', !others.includes('_eobDiceRolls'));
    ck('all reset paths clear the rolls', (html.match(/\n {4}_eobDiceRolls = \[\];/g) || []).length === 3);
    ck('all reset paths re-render the panel', (html.match(/eob-dice-count'\)\.textContent = '0';\n\s*eob_renderDiceFairness\(\);/g) || []).length === 3);
    const render = html.slice(html.indexOf('function eob_renderDiceFairness('), html.indexOf('// --- Method B: Playing Cards ---'));
    ck('panel shows the pattern check over the fairness verdict', render.includes('DF.findRollPatterns(_eobDiceRolls)') && render.includes('these rolls are not random'));
    ck('any change to the rolls clears the confirmation', render.includes('confirmCheck.checked = false'));
    ck('switching mode re-renders the panel', html.slice(html.indexOf('function eob_setEntropyMode('), html.indexOf('function _eobVerifiableGate(')).includes('eob_renderDiceFairness();'));
}

console.log('\n5. Pattern check');
{
    const seq = (s) => s.split('').map(Number);
    const MADE_UP = {
        '123456 repeated': '123456'.repeat(9).slice(0, 50),
        '654321 repeated': '654321'.repeat(9).slice(0, 50),
        '112233445566 repeated': '112233445566'.repeat(5).slice(0, 50),
        '135 repeated': '135'.repeat(17).slice(0, 50),
        '12 repeated': '12'.repeat(25),
        'all ones': '1'.repeat(50),
        '24 words, 123456 repeated': '123456'.repeat(17).slice(0, 99),
        '20 ones then real rolls': '1'.repeat(20) + '351624613521645236134526163452',
    };
    for (const [name, s] of Object.entries(MADE_UP)) {
        ck(`${name}: chi-squared alone ${assessDice(seq(s)).verdict.id === 'ok' ? 'calls it fair' : 'flags it'}; pattern check refuses it`,
            findRollPatterns(seq(s)).level === 'pattern' && verifiableDiceGate(seq(s)).id === 'block', JSON.stringify(findRollPatterns(seq(s)).reasons));
    }
    ck('123456… has a plain-English reason', /repeats every 6 rolls/.test(findRollPatterns(seq(MADE_UP['123456 repeated'])).reasons.join()));
    ck('fewer than 30 rolls are never judged', findRollPatterns(Array(29).fill(1)).level === 'none');
    ck('SeedSigner\'s own patterned vector would be refused here', verifiableDiceGate(seq('12345612345612345612345612345612345612345612345612')).id === 'block');
    const real = seq('35162461352164523613452616345216345261346521634526');
    ck('ordinary rolls pass', findRollPatterns(real).level === 'none' && verifiableDiceGate(real).id === 'ok', JSON.stringify(findRollPatterns(real)));
    const run8 = real.slice(0, 42).concat(Array(8).fill(6));
    ck('a run of 8 is unusual: confirm, not refuse', findRollPatterns(run8).level === 'suspicious' && verifiableDiceGate(run8).id === 'confirm');
    ck('a likely-biased die needs confirming', verifiableDiceGate(seq('6'.repeat(20) + '1'.repeat(5) + '6'.repeat(1) + '2345'.repeat(6))).id !== 'ok');
    ck('limits are frozen', Object.isFrozen(PATTERN_LIMITS));
    for (const N of [50, 99]) {
        const TRIALS = 20000;
        const c = { ok: 0, confirm: 0, block: 0 };
        for (let t = 0; t < TRIALS; t++) c[verifiableDiceGate(Array.from({ length: N }, () => randomInt(1, 7))).id]++;
        ck(`${N} fair rolls: never refused (${c.block} of ${TRIALS})`, c.block === 0);
        ck(`${N} fair rolls: asked to confirm about 1% (got ${(c.confirm / TRIALS * 100).toFixed(2)}%)`, c.confirm / TRIALS < 0.025);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

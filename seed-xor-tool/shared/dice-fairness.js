/**
 * dice-fairness.js — Pearson chi-squared goodness-of-fit for physical dice
 *
 * The Entropy Forge's Manual Dice card credits each roll with log2(6) ≈ 2.58
 * bits. That only holds for a fair die. This module scores the rolls entered
 * so far against a uniform distribution and turns the result into a plain
 * verdict, so a loaded or badly worn die is noticed before a seed is forged.
 *
 * It is advisory. A lucky streak can look biased, and a slightly biased die
 * can look fair until many more rolls arrive. It never blocks forging: the
 * rolls are hashed into the pool with every other source.
 *
 * Thresholds: at least 5 expected rolls per face (30 for a d6), the usual
 * floor for the chi-squared approximation. Below p = 0.05 is "suspicious",
 * below p = 0.01 is "likely biased". A fair die lands in each band 5% and 1%
 * of the time respectively.
 *
 * Inspired by EntropyLab's dice fairness panel (src/js/app.js).
 */

const LANCZOS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
];

export function logGamma(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    const s = z - 1;
    let x = LANCZOS[0];
    for (let i = 1; i < LANCZOS.length; i++) x += LANCZOS[i] / (s + i);
    const t = s + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (s + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized upper incomplete gamma Q(a, x) = Γ(a, x) / Γ(a). */
export function upperRegularizedGamma(a, x) {
    if (!(a > 0) || !(x >= 0) || !Number.isFinite(x)) return x === Infinity ? 0 : 1;
    if (x === 0) return 1;
    const logPre = -x + a * Math.log(x) - logGamma(a);
    if (x < a + 1) {
        // Series for the lower function P, then Q = 1 - P.
        let term = 1 / a, sum = term;
        for (let n = 1; n < 500; n++) {
            term *= x / (a + n);
            sum += term;
            if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
        }
        return Math.min(1, Math.max(0, 1 - Math.exp(logPre) * sum));
    }
    // Continued fraction for Q (modified Lentz).
    const tiny = 1e-300;
    let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
    for (let i = 1; i < 500; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
        c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        const delta = d * c;
        h *= delta;
        if (Math.abs(delta - 1) < 1e-15) break;
    }
    return Math.min(1, Math.max(0, Math.exp(logPre) * h));
}

/** P(X ≥ chi) for X ~ chi-squared with `df` degrees of freedom. */
export function chiSquaredPValue(chi, df) {
    return upperRegularizedGamma(df / 2, chi / 2);
}

export const MIN_PER_FACE = 5;
export const P_SUSPICIOUS = 0.05;
export const P_BIASED = 0.01;

/**
 * Score a list of rolls (numbers or digit strings, 1..sides). Rolls outside
 * that range are ignored. Returns counts, the statistic, its p-value and a
 * verdict: { id: 'empty' | 'need-more' | 'ok' | 'suspicious' | 'biased', tone }.
 */
export function assessDice(rolls, sides = 6) {
    const counts = new Array(sides).fill(0);
    for (const r of rolls || []) {
        const v = Number(r);
        if (Number.isInteger(v) && v >= 1 && v <= sides) counts[v - 1]++;
    }
    const n = counts.reduce((a, b) => a + b, 0);
    const minimum = MIN_PER_FACE * sides;
    const expected = n / sides;
    let chi = 0;
    if (n) for (const c of counts) chi += (c - expected) ** 2 / expected;
    const df = sides - 1;
    const p = n ? chiSquaredPValue(chi, df) : 1;
    let verdict;
    if (!n) verdict = { id: 'empty', tone: 'muted' };
    else if (n < minimum) verdict = { id: 'need-more', tone: 'muted' };
    else if (p < P_BIASED) verdict = { id: 'biased', tone: 'danger' };
    else if (p < P_SUSPICIOUS) verdict = { id: 'suspicious', tone: 'warn' };
    else verdict = { id: 'ok', tone: 'ok' };
    return { sides, n, minimum, remaining: Math.max(0, minimum - n), counts, expected, chi, df, p, verdict };
}

/** One-line plain-English summary of an assessment. */
export function describeAssessment(r) {
    const stats = `χ² ${r.chi.toFixed(2)}, ${r.df} df, ${r.p < 0.001 ? 'p < 0.001' : 'p = ' + r.p.toFixed(3)}`;
    switch (r.verdict.id) {
        case 'empty': return '';
        case 'need-more':
            return `${r.n} of ${r.minimum} rolls needed for a fairness check. ${r.remaining} more to go.`;
        case 'biased':
            return `Likely biased: a fair die would give counts this uneven less than 1% of the time (${stats}). ` +
                'Check the die and the rolling surface, or switch to a different die.';
        case 'suspicious':
            return `Possibly biased: a fair die would give counts this uneven less than 5% of the time (${stats}). ` +
                'Keep rolling. If this persists, use a different die.';
        default:
            return `No sign of bias (${stats}).` +
                (r.n < 2 * r.minimum ? ` ${2 * r.minimum - r.n} more rolls would make this check more reliable.` : '');
    }
}

if (typeof window !== 'undefined') {
    window.DiceFairness = { assessDice, describeAssessment, chiSquaredPValue };
}

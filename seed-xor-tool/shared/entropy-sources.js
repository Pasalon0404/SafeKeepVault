/**
 * entropy-sources.js — entropy credits, verifiable dice and camera sampling
 *
 * The Entropy Generator's meter shows how much entropy the USER has
 * contributed. These credits are deliberately conservative:
 *
 *   - Physical dice: log2(6) ≈ 2.585 bits per roll (a fair die; the
 *     fairness panel checks that assumption).
 *   - Mouse movement: 0.5 bits per sample. Pointer paths are smooth and
 *     partly predictable, so a coordinate pair is worth far less than its
 *     size suggests.
 *   - Camera: 4 bits per frame, and only for a frame whose sensor-noise
 *     bits (the lowest bit of each R, G and B value) actually changed from
 *     the previous frame and aren't stuck at all-0 or all-1.
 *   - Playing cards: log2(cards left in the deck) per card, so a whole
 *     well-shuffled 52-card deck is log2(52!) ≈ 225.6 bits. The credit only
 *     holds for a thoroughly shuffled deck, which the screen asks for.
 *
 * There is deliberately no "digital dice" source: rolls drawn from the
 * device's random number generator add nothing, because that generator is
 * XORed into every Mixed seed anyway, and counting them let the meter fill
 * without the user contributing any randomness.
 *
 * Verifiable dice mode turns dice into a seed exactly as SeedSigner and
 * COLDCARD do — SHA-256 of the roll digits as ASCII text, first 16 bytes for
 * 12 words or all 32 for 24 — with nothing else mixed in, so the same rolls
 * entered on either device give the same words. SeedSigner accepts exactly
 * 50 rolls (12 words) or 99 rolls (24 words), so those are the counts here.
 */

export const ENTROPY_CREDIT = Object.freeze({
    diceRoll: Math.log2(6),
    mouseSample: 0.5,
    cameraFrame: 4,
});

export const DECK_SIZE = 52;
export const CARD_RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K']);
export const CARD_SUITS = Object.freeze(['S', 'H', 'D', 'C']);
const SUIT_SYMBOL = Object.freeze({ S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' });

/**
 * Rank from a key press: A 2–9 J Q K, and T or 0 for ten (case-insensitive).
 * Returns the canonical rank or null.
 */
export function cardRankFromKey(key) {
    const k = String(key).toUpperCase();
    if (k === '0') return 'T';
    return CARD_RANKS.includes(k) ? k : null;
}

/** Suit from a key press: S H D C (case-insensitive). Returns it or null. */
export function cardSuitFromKey(key) {
    const k = String(key).toUpperCase();
    return CARD_SUITS.includes(k) ? k : null;
}

/** Card code ("TH") as people write it ("10♥"). */
export function cardLabel(code) {
    return (code[0] === 'T' ? '10' : code[0]) + SUIT_SYMBOL[code[1]];
}

/**
 * Credit for the next card from a deck that already has `drawn` cards out:
 * log2 of the cards still in it. Zero once the deck is used up.
 */
export function cardCredit(drawn) {
    const left = DECK_SIZE - drawn;
    return left > 1 ? Math.log2(left) : 0;
}

export const VERIFIABLE_DICE_ROLLS = Object.freeze({ 12: 50, 24: 99 });

/** Rolls verifiable mode needs for a 12- or 24-word seed. */
export function verifiableRollsNeeded(words) {
    const n = VERIFIABLE_DICE_ROLLS[words];
    if (!n) throw new Error('Verifiable dice supports 12 or 24 words');
    return n;
}

/**
 * Entropy from physical dice, SeedSigner/COLDCARD method.
 * `rolls` is a string or array of faces 1–6; its length must be exactly
 * 50 (12 words) or 99 (24 words).
 */
export async function diceRollsToEntropy(rolls, words) {
    const text = Array.isArray(rolls) ? rolls.join('') : String(rolls);
    if (!/^[1-6]*$/.test(text)) throw new Error('Dice rolls must be the digits 1 to 6');
    const needed = verifiableRollsNeeded(words);
    if (text.length !== needed) {
        throw new Error(`A ${words}-word seed needs exactly ${needed} rolls (got ${text.length})`);
    }
    const data = new TextEncoder().encode(text);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    data.fill(0);
    const entropy = digest.slice(0, words === 12 ? 16 : 32);
    digest.fill(0);
    return entropy;
}

/**
 * The sensor-noise bits of a camera frame: the lowest bit of every R, G and
 * B value (alpha is skipped — it is always 255), packed eight to a byte.
 * `rgba` is ImageData.data.
 */
export function cameraFrameLsbs(rgba) {
    const pixels = Math.floor(rgba.length / 4);
    const out = new Uint8Array(Math.ceil((pixels * 3) / 8));
    let bit = 0;
    for (let p = 0; p < pixels; p++) {
        for (let c = 0; c < 3; c++, bit++) {
            if (rgba[p * 4 + c] & 1) out[bit >> 3] |= 1 << (bit & 7);
        }
    }
    return out;
}

function popcount8(x) {
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    return (x + (x >> 4)) & 0x0f;
}

/**
 * Credit for one frame's noise bits. Zero unless there is a previous frame to
 * compare with, at least 1% of the bits changed since it (a frozen or
 * denoised feed repeats itself), and the bits are not almost all 0 or all 1
 * (a saturated or blank picture).
 */
export function cameraFrameCredit(lsbs, prevLsbs) {
    if (!prevLsbs || prevLsbs.length !== lsbs.length || !lsbs.length) return 0;
    const totalBits = lsbs.length * 8;
    let ones = 0, changed = 0;
    for (let i = 0; i < lsbs.length; i++) {
        ones += popcount8(lsbs[i]);
        changed += popcount8(lsbs[i] ^ prevLsbs[i]);
    }
    const onesRatio = ones / totalBits;
    if (onesRatio < 0.1 || onesRatio > 0.9) return 0;
    if (changed / totalBits < 0.01) return 0;
    return ENTROPY_CREDIT.cameraFrame;
}

if (typeof window !== 'undefined') {
    window.EntropySources = {
        ENTROPY_CREDIT, VERIFIABLE_DICE_ROLLS, verifiableRollsNeeded,
        DECK_SIZE, CARD_RANKS, CARD_SUITS, cardRankFromKey, cardSuitFromKey, cardLabel, cardCredit,
        diceRollsToEntropy, cameraFrameLsbs, cameraFrameCredit,
    };
}

/**
 * entropy-sources.js — entropy credits, verifiable dice and camera sampling
 *
 * The Entropy Generator's meter shows how much entropy the USER has
 * contributed. These credits are deliberately conservative:
 *
 *   - Physical dice: log2(6) ≈ 2.585 bits per roll (a fair die; the
 *     fairness panel checks that assumption).
 *   - Mouse movement: 0.25 bits per sample, and at most half the target
 *     (64 of 128 bits, 128 of 256) from the mouse in total. Pointer paths
 *     are smooth and partly predictable, the position is on screen, and a
 *     few seconds of wiggling shouldn't be able to fill the meter alone.
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
 *
 * Draw your own words: the user draws 11 (or 23) words at random, by hand,
 * and flips a coin 7 (or 3) times for the rest of the last word. The seed's
 * entropy is exactly those bits: each word's 11-bit index, then the flips
 * (Heads = 1, Tails = 0), and the last word's remaining 4 (or 8) bits are
 * the BIP-39 checksum. This is SeedSigner's Tools → "Calc 12th/24th word" →
 * "Coin flip entropy", so the same words and flips give the same last word.
 */

export const ENTROPY_CREDIT = Object.freeze({
    diceRoll: Math.log2(6),
    mouseSample: 0.25,
    cameraFrame: 4,
});

/** Most the mouse may add towards a target of `targetBits`: half of it. */
export const MOUSE_SHARE_MAX = 0.5;

/**
 * Credit for one more mouse sample when the mouse has already been credited
 * `mouseBitsSoFar` towards `targetBits`. Zero once the mouse's share is full.
 */
export function mouseCredit(mouseBitsSoFar, targetBits) {
    const room = targetBits * MOUSE_SHARE_MAX - mouseBitsSoFar;
    return room > 0 ? Math.min(ENTROPY_CREDIT.mouseSample, room) : 0;
}

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

/** Coin flips that fill the last word: 7 for 12 words, 3 for 24. */
export const FINAL_WORD_FLIPS = Object.freeze({ 12: 7, 24: 3 });

/** The flips needed to finish a seed of `words` words (12 or 24). */
export function finalWordFlipsNeeded(words) {
    const n = FINAL_WORD_FLIPS[words];
    if (!n) throw new Error('Final word: the seed must be 12 or 24 words');
    return n;
}

/**
 * Entropy bytes for a seed whose first 11 (or 23) words were drawn by hand.
 * `drawn` is those words, `flips` the coin flips as '1' (heads) and '0'
 * (tails), in the order flipped, `wordlist` the BIP-39 English list. The
 * mnemonic of the result starts with `drawn`; its last word follows from the
 * flips and the checksum.
 */
export function finalWordEntropy(drawn, flips, wordlist) {
    const total = drawn.length + 1;
    if (total !== 12 && total !== 24) throw new Error('Final word: enter 11 or 23 words');
    const flipText = Array.isArray(flips) ? flips.join('') : String(flips);
    const needed = finalWordFlipsNeeded(total);
    if (!/^[01]*$/.test(flipText)) throw new Error('Coin flips must be heads (1) or tails (0)');
    if (flipText.length !== needed) throw new Error(`A ${total}-word seed needs exactly ${needed} coin flips (got ${flipText.length})`);
    let bits = '';
    for (const w of drawn) {
        const i = wordlist.indexOf(String(w).trim().toLowerCase());
        if (i < 0) throw new Error(`"${w}" is not a BIP-39 word`);
        bits += i.toString(2).padStart(11, '0');
    }
    bits += flipText;
    const out = new Uint8Array(bits.length / 8);
    for (let b = 0; b < out.length; b++) out[b] = parseInt(bits.slice(b * 8, b * 8 + 8), 2);
    return out;
}

/**
 * Drawn words that someone could guess: a word drawn three or more times,
 * four or more words in a row that sit next to each other in the word list
 * (abandon ability able about), or every word in alphabetical order. A real
 * draw almost never does any of these (each is well under one in a million
 * for 11 words). Returns { id: 'ok' | 'block', reasons: [...] }.
 */
export function drawnWordsGate(drawn, wordlist) {
    const idx = drawn.map((w) => wordlist.indexOf(String(w).trim().toLowerCase()));
    const reasons = [];
    const counts = new Map();
    for (const i of idx) counts.set(i, (counts.get(i) || 0) + 1);
    for (const [i, c] of counts) if (c >= 3) reasons.push(`"${wordlist[i]}" is drawn ${c} times`);
    // Longest stretch where each word is the next (or the previous) word in
    // the list, going the same way throughout.
    let run = 1, step = 0, longest = 1;
    for (let k = 1; k < idx.length; k++) {
        const d = idx[k] - idx[k - 1];
        if ((d === 1 || d === -1) && (run === 1 || d === step)) run++;
        else run = (d === 1 || d === -1) ? 2 : 1;
        step = d;
        longest = Math.max(longest, run);
    }
    if (longest >= 4) reasons.push(`${longest} words in a row are next to each other in the word list`);
    if (idx.length >= 6 && idx.every((v, k) => k === 0 || v >= idx[k - 1])) reasons.push('the words are in alphabetical order');
    return { id: reasons.length ? 'block' : 'ok', reasons };
}

if (typeof window !== 'undefined') {
    window.EntropySources = {
        ENTROPY_CREDIT, MOUSE_SHARE_MAX, mouseCredit, VERIFIABLE_DICE_ROLLS, verifiableRollsNeeded,
        DECK_SIZE, CARD_RANKS, CARD_SUITS, cardRankFromKey, cardSuitFromKey, cardLabel, cardCredit,
        diceRollsToEntropy, cameraFrameLsbs, cameraFrameCredit,
        FINAL_WORD_FLIPS, finalWordFlipsNeeded, finalWordEntropy, drawnWordsGate,
    };
}

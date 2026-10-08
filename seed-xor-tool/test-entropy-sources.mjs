/**
 * test-entropy-sources.mjs — entropy credits, Verifiable dice, camera noise bits
 *
 *   1. Verifiable dice matches SeedSigner's published vectors (12 and 24
 *      words) and COLDCARD's documented "123456" example, cross-checked with
 *      node:crypto and the separate bip39 package.
 *   2. Verifiable dice refuses anything but exactly 50 / 99 rolls of 1–6.
 *   3. Camera noise bits: lowest bit of R, G, B only, packed LSB-first.
 *   4. Camera credit: 0 without a previous frame, for a repeated or nearly
 *      repeated frame, or for an all-0 / all-1 frame; 4 bits otherwise.
 *   5. Credits: mouse 0.5, dice log2(6), camera 4; no digital-dice source.
 *   6. Playing cards: key parsing, labels, log2(cards left) per card, a full
 *      deck worth log2(52!).
 *   7. boot.html wiring: no hard-coded credits left, the verifiable path skips
 *      the CSPRNG mix, the camera uses the noise bits, resets go back to Mixed.
 *
 * Run:  node test-entropy-sources.mjs
 */

import {
    ENTROPY_CREDIT, VERIFIABLE_DICE_ROLLS, verifiableRollsNeeded,
    diceRollsToEntropy, cameraFrameLsbs, cameraFrameCredit,
    DECK_SIZE, CARD_RANKS, CARD_SUITS, cardRankFromKey, cardSuitFromKey, cardLabel, cardCredit,
} from './shared/entropy-sources.js';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bip39 from 'bip39';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const throwsAsync = async (fn) => { try { await fn(); return false; } catch { return true; } };
const words = (entropy) => bip39.entropyToMnemonic(Buffer.from(entropy).toString('hex'));

console.log('\n1. Verifiable dice vectors');
// From SeedSigner tests/test_mnemonic_generation.py.
const VECTORS = [
    [24, '522222222222222222222222222222222222222222222555555555555555555555555555555555555555555555555555555',
        'resource timber firm banner horror pupil frozen main pear direct pioneer broken grid core insane begin sister pony end debate task silk empty curious'],
    [24, '222222222222222222222222222222222222222222222555555555555555555555555555555555555555555555555555555',
        'garden uphold level clog sword globe armor issue two cute scorpion improve verb artwork blind tail raw butter combine move produce foil feature wave'],
    [24, '222222222222222222222222222222222222222222222555555555555555555555555555555555555555555555555555556',
        'lizard broken love tired depend eyebrow excess lonely advance father various cram ignore panic feed plunge miss regret boring unique galaxy fan detail fly'],
    [12, '12345612345612345612345612345612345612345612345612',
        'unveil nice picture region tragic fault cream strike tourist control recipe tourist'],
];
for (const [w, rolls, expected] of VECTORS) {
    const e = await diceRollsToEntropy(rolls, w);
    ck(`${w} words from ${rolls.slice(0, 12)}…`, words(e) === expected, words(e));
    const ref = createHash('sha256').update(rolls, 'ascii').digest().subarray(0, w === 12 ? 16 : 32);
    ck(`  matches node:crypto SHA-256`, Buffer.from(e).equals(ref));
}
ck('array input gives the same entropy',
    Buffer.from(await diceRollsToEntropy(VECTORS[3][1].split('').map(Number), 12)).equals(Buffer.from(await diceRollsToEntropy(VECTORS[3][1], 12))));
// COLDCARD's documented example (coldcard.com/docs/verifying-dice-roll-math):
// same method, six rolls, 24 words.
ck('COLDCARD "123456" example uses the same method',
    words(createHash('sha256').update('123456').digest()) ===
    'mirror reject rookie talk pudding throw happy era myth already payment own sentence push head sting video explain letter bomb casual hotel rather garment');

console.log('\n2. Verifiable dice input rules');
ck('12 words need 50 rolls, 24 need 99', verifiableRollsNeeded(12) === 50 && verifiableRollsNeeded(24) === 99 && VERIFIABLE_DICE_ROLLS[12] === 50);
ck('other word counts are refused', (() => { try { verifiableRollsNeeded(18); return false; } catch { return true; } })());
ck('49 rolls refused for 12 words', await throwsAsync(() => diceRollsToEntropy('1'.repeat(49), 12)));
ck('51 rolls refused for 12 words', await throwsAsync(() => diceRollsToEntropy('1'.repeat(51), 12)));
ck('100 rolls refused for 24 words', await throwsAsync(() => diceRollsToEntropy('1'.repeat(100), 24)));
ck('a 0 is refused', await throwsAsync(() => diceRollsToEntropy('0' + '1'.repeat(49), 12)));
ck('a 7 is refused', await throwsAsync(() => diceRollsToEntropy('7' + '1'.repeat(49), 12)));
ck('lengths are 16 and 32 bytes',
    (await diceRollsToEntropy('3'.repeat(50), 12)).length === 16 && (await diceRollsToEntropy('3'.repeat(99), 24)).length === 32);

console.log('\n3. Camera noise bits');
{
    // Two pixels: (R,G,B,A) = (1,0,3,255) and (2,5,0,255) → bits 1,0,1, 0,1,0
    const lsbs = cameraFrameLsbs(new Uint8ClampedArray([1, 0, 3, 255, 2, 5, 0, 255]));
    ck('two pixels pack into one byte', lsbs.length === 1);
    ck('R,G,B low bits, LSB first, alpha skipped', lsbs[0] === 0b010101, lsbs[0].toString(2));
    const big = cameraFrameLsbs(new Uint8ClampedArray(64 * 64 * 4).fill(255));
    ck('64×64 frame → 1536 bytes', big.length === 1536);
    ck('alpha-only 255 frame with RGB 0 gives zero bits',
        cameraFrameLsbs(new Uint8ClampedArray(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : 0))).every(b => b === 0));
}

console.log('\n4. Camera credit');
{
    const a = new Uint8Array(randomBytes(1536)), b = new Uint8Array(randomBytes(1536));
    ck('no previous frame → 0', cameraFrameCredit(a, null) === 0);
    ck('changing noisy frames → 4', cameraFrameCredit(b, a) === 4);
    ck('identical frame → 0', cameraFrameCredit(a, a.slice()) === 0);
    const nearly = a.slice(); for (let i = 0; i < 10; i++) nearly[i] ^= 1;   // 10 of 12288 bits
    ck('under 1% of bits changed → 0', cameraFrameCredit(nearly, a) === 0);
    ck('all-zero frame → 0', cameraFrameCredit(new Uint8Array(1536), a) === 0);
    ck('all-one frame → 0', cameraFrameCredit(new Uint8Array(1536).fill(255), a) === 0);
    ck('size mismatch → 0', cameraFrameCredit(a, b.subarray(0, 100)) === 0);
}

console.log('\n5. Credits');
ck('no digital-dice credit', !('digitalDice' in ENTROPY_CREDIT));
ck('mouse credit 0.5', ENTROPY_CREDIT.mouseSample === 0.5);
ck('dice credit log2(6)', ENTROPY_CREDIT.diceRoll === Math.log2(6));
ck('camera credit 4 per frame', ENTROPY_CREDIT.cameraFrame === 4);
ck('credits are frozen', Object.isFrozen(ENTROPY_CREDIT));

console.log('\n6. Playing cards');
{
    ck('52 cards: 13 ranks × 4 suits', DECK_SIZE === 52 && CARD_RANKS.length * CARD_SUITS.length === 52);
    ck('ranks from keys (case-insensitive)', ['a', 'A', '2', '9', 't', 'j', 'q', 'K'].map(cardRankFromKey).join('') === 'AA29TJQK');
    ck('0 means ten', cardRankFromKey('0') === 'T');
    ck('1, 10, X and suits are not ranks', ['1', '10', 'X', 'S', 'H', 'D', 'C', ' '].every(k => cardRankFromKey(k) === null));
    ck('suits from keys (case-insensitive)', ['s', 'H', 'd', 'C'].map(cardSuitFromKey).join('') === 'SHDC');
    ck('other keys are not suits', ['A', 'X', '1', 'K'].every(k => cardSuitFromKey(k) === null));
    ck('labels', cardLabel('AS') === 'A\u2660' && cardLabel('TH') === '10\u2665' && cardLabel('KD') === 'K\u2666' && cardLabel('2C') === '2\u2663');
    ck('first card log2(52)', cardCredit(0) === Math.log2(52));
    ck('second card log2(51)', cardCredit(1) === Math.log2(51));
    ck('last card is forced: 0 bits', cardCredit(51) === 0);
    ck('no credit past the deck', cardCredit(52) === 0 && cardCredit(60) === 0);
    let deck = 0; for (let i = 0; i < 52; i++) deck += cardCredit(i);
    let lf = 0; for (let k = 2; k <= 52; k++) lf += Math.log2(k);
    ck('full deck = log2(52!) ≈ 225.58 bits', Math.abs(deck - lf) < 1e-9 && Math.abs(deck - 225.581) < 0.001, deck);
}

console.log('\n7. boot.html wiring');
{
    const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
    const entry = readFileSync(new URL('./boot-entry.js', import.meta.url), 'utf8');
    const fn = (name) => {
        const start = html.indexOf(name);
        if (start < 0) return '';
        const next = html.indexOf('\nfunction ', start + 10), nextAsync = html.indexOf('\nasync function ', start + 10);
        const end = Math.min(...[next, nextAsync].filter(i => i > 0));
        return html.slice(start, end);
    };
    ck('boot-entry.js loads the module', entry.includes("import './shared/entropy-sources.js'"));
    ck('mode toggle and verification panel exist',
        html.includes('id="eob-mode-mixed"') && html.includes('id="eob-mode-verifiable"') && html.includes('id="eob-mode-desc-verifiable"'));
    ck('Digital Dice card and function are gone',
        !html.includes('eob_rollDigitalDice') && !html.includes('eob-card-digital') && !html.includes('eob-digital-count') && !html.includes('_eobDigitalCount'));
    const wiggle = fn('function eob_handleWiggle');
    ck('mouse uses the 0.5-bit credit', wiggle.includes("_eobCredit('mouseSample')"));
    const cam = fn('async function eob_captureVideoNoise');
    ck('camera samples noise bits, not every 17th byte', cam.includes('cameraFrameLsbs') && cam.includes('cameraFrameCredit') && !cam.includes('i += 17'));
    const dice = fn('function eob_handleDiceKey');
    ck('Backspace undoes a roll', dice.includes("'Backspace'") && dice.includes('_eobDiceRolls.pop()'));
    ck('verifiable mode stops at the needed roll count', dice.includes('_eobRollsNeeded()'));
    ck('Playing Cards card exists', html.includes('id="eob-card-cards"') && html.includes('onkeydown="eob_handleCardKey(event)"') && html.includes('onclick="eob_newDeck()"'));
    const cards = fn('function eob_handleCardKey');
    ck('cards credit log2(cards left) and refuse duplicates', cards.includes('ES.cardCredit(_eobDeckCards.length)') && cards.includes('_eobDeckCards.indexOf(code) !== -1'));
    ck('cards stop at 52 per deck', cards.includes('_eobDeckCards.length >= ES.DECK_SIZE'));
    ck('Backspace undoes a card and its credit', cards.includes('_eobDeckCards.pop()') && cards.includes('_eobEstimatedBits - ES.cardCredit(_eobDeckCards.length)'));
    ck('cards are hidden in Verifiable mode', fn('function eob_setEntropyMode').includes("'eob-card-cards'"));
    ck('both reset paths clear the deck', ['function eob_init', 'function eob_clearAll'].every(n => fn(n).includes('_eobDeckCards = [];') && fn(n).includes('_eobRenderCards();')));
    const forge = fn('async function eob_forgeSeed');
    const verifiableBranch = forge.slice(forge.indexOf('if (_eobVerifiable)'), forge.indexOf('BYOE discipline'));
    ck('forge gate uses _eobCanForge', forge.includes('if (!_eobCanForge()) return;'));
    ck('verifiable forge uses diceRollsToEntropy', verifiableBranch.includes('diceRollsToEntropy(_eobDiceRolls'));
    ck('verifiable forge skips the CSPRNG mix', !verifiableBranch.includes('getRandomValues') && !verifiableBranch.includes('^'));
    ck('mixed forge still XORs with the CSPRNG', forge.includes('crypto.getRandomValues(sysEntropy)') && forge.includes('userEntropy[_mi] ^ sysEntropy[_mi]'));
    const canForge = fn('function _eobCanForge');
    ck('verifiable needs exactly the roll count', canForge.includes('_eobDiceRolls.length === _eobRollsNeeded()'));
    ck('roll counts in boot.html match the module (50 / 99)', fn('function _eobRollsNeeded').includes('? 50 : 99'));
    ck('eob_init resets to Mixed', fn('function eob_init').includes("eob_setEntropyMode('mixed')"));
    // Every Entropy Generator function must still parse (a stray quote in a
    // string breaks the whole inline script, and eob_init with it).
    for (const name of ['function eob_init', 'function eob_setEntropyMode', 'function _eobCanForge', 'function eob_updateMeter',
        'function eob_handleDiceKey', 'function _eobRenderCards', 'function eob_handleCardKey', 'function eob_newDeck', 'function eob_handleWiggle', 'async function eob_captureVideoNoise', 'async function eob_forgeSeed']) {
        let ok = true, err = '';
        try { new Function(fn(name).replace(/^async function/, 'return async function').replace(/^function/, 'return function')); } catch (e) { ok = false; err = e.message; }
        ck(`${name.replace(/^(async )?function /, '')} parses`, ok, err);
    }
    ck('meter says "bits from you"', fn('function eob_updateMeter').includes("bits from you"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

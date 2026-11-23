/**
 * pwcheck.js — password strength check (PASSPHRASE_STRENGTH_DESIGN.md)
 *
 * Estimates how many guesses a smart attacker needs, in bits (log2 of the
 * guesses), and rates the password Weak, Fair or Strong for what it
 * protects. The vault and the Encrypted Backup have different bands,
 * because a 7z backup is far cheaper to guess than the LUKS vault.
 *
 * usbbootdrive/safekeep-pwcheck.py is a line-by-line port of this file
 * and is what enforces the rule on the stick; this copy draws the bar in
 * the app. test-pwcheck.mjs runs both on the same passwords and requires
 * the same bits, band and reasons. Change both together.
 *
 * How it estimates: the password is split into the cheapest pieces an
 * attacker would guess, and the pieces' bits are added up.
 *   - Words: a piece found in the word lists (pwcheck-lists.json: common
 *     passwords, English words, names, BIP39) costs log2 of its rank,
 *     times its capitalisation and l33t-speak variations, times 2 if
 *     reversed. A BIP39 word costs at most 11 bits (one of 2048).
 *   - Repeats ("abcabc"): the repeated part, plus log2 of the count.
 *   - Sequences ("abcd", "4321"): where it starts, its length, direction.
 *   - Years 1900–2049.
 *   - Anything else, character by character: 10 for a digit, 26 for a
 *     letter, 33 for other printable ASCII, 100 for anything else.
 * Each word, repeat, sequence or year adds 1 bit for "which kind of piece
 * comes next". Only the first 128 characters are split; the rest are
 * counted character by character.
 *
 * Separators: a password that splits on one separator (space - _ . , + /)
 * can also be rated as its parts, plus 3 bits for the separator once,
 * since an attacker tries the same separator between every word. If it
 * is 3 or more BIP39 words in lowercase, each word counts a full 11 bits:
 * that is what SafeKeep's generator makes, and a randomly chosen BIP39
 * word is one of 2048 however common it is in English. A phrase someone
 * made up from BIP39 words is overrated by this; nothing can tell.
 */

export const BANDS = {
    vault: { weak: 40, strong: 60 },
    backup: { weak: 50, strong: 65 },
};

const LIST_ORDER = ['passwords', 'english_wikipedia', 'us_tv_and_film', 'surnames', 'female_names', 'male_names', 'bip39'];
const LIST_KIND = {
    passwords: 'common', english_wikipedia: 'word', us_tv_and_film: 'word',
    surnames: 'name', female_names: 'name', male_names: 'name', bip39: 'word',
};
const MIN_WORD = 3;
const MAX_WORD = 32;
const MAX_SPLIT = 128;
const PIECE_BITS = 1;
const YEAR_BITS = Math.log2(150);
const SEPARATORS = [' ', '-', '_', '.', ',', '+', '/'];
const SEPARATOR_BITS = 3;
const BIP39_WORD_BITS = 11;
const L33T = {
    '4': ['a'], '@': ['a'], '8': ['b'], '(': ['c'], '3': ['e'], '6': ['g'], '9': ['g'],
    '1': ['i', 'l'], '!': ['i'], '|': ['i', 'l'], '0': ['o'], '$': ['s'], '5': ['s'],
    '7': ['t'], '+': ['t'], '2': ['z'],
};

export const REASON_TEXT = {
    common: 'a common password',
    word: 'common words',
    name: 'a name',
    repeat: 'repeated characters',
    sequence: 'a sequence such as abc or 123',
    year: 'a year',
};

/** Word → [rank, kind]. A word in several lists keeps its best rank. */
export function buildDictionary(lists) {
    const dict = new Map();
    for (const name of LIST_ORDER) {
        const words = lists[name].split(',');
        for (let i = 0; i < words.length; i++) {
            const w = words[i];
            if (!w) continue;
            const rank = name === 'bip39' ? 2048 : i + 1;
            const cur = dict.get(w);
            if (!cur || rank < cur[0]) dict.set(w, [rank, LIST_KIND[name]]);
        }
    }
    dict.bip39 = new Set(lists.bip39.split(','));
    return dict;
}

function charBits(c) {
    const o = c.codePointAt(0);
    if (o >= 48 && o <= 57) return Math.log2(10);
    if ((o >= 97 && o <= 122) || (o >= 65 && o <= 90)) return Math.log2(26);
    if (o >= 32 && o <= 126) return Math.log2(33);
    return Math.log2(100);
}

const isUpper = (c) => c >= 'A' && c <= 'Z';
const isLower = (c) => c >= 'a' && c <= 'z';
const isDigit = (c) => c >= '0' && c <= '9';
const lower = (cps) => cps.map((c) => (isUpper(c) ? c.toLowerCase() : c));

function nCk(n, k) {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
}

function caseVariations(cps) {
    let up = 0, low = 0;
    for (const c of cps) { if (isUpper(c)) up++; else if (isLower(c)) low++; }
    if (up === 0) return 1;
    if (low === 0) return 2;
    if (up === 1 && (isUpper(cps[0]) || isUpper(cps[cps.length - 1]))) return 2;
    let v = 0;
    for (let i = 1; i <= Math.min(up, low); i++) v += nCk(up + low, i);
    return v;
}

/** The lowercase piece, plus up to two l33t-speak readings of it. */
function readings(lowCps) {
    const out = [[lowCps.join(''), 0]];
    if (!lowCps.some(isLower)) return out;
    let subs = 0;
    for (const c of lowCps) if (L33T[c]) subs++;
    if (subs === 0) return out;
    for (const pick of [0, 1]) {
        const w = lowCps.map((c) => (L33T[c] ? L33T[c][Math.min(pick, L33T[c].length - 1)] : c)).join('');
        if (!out.some((r) => r[0] === w)) out.push([w, subs]);
    }
    return out;
}

function dictionaryBits(cps, dict) {
    if (cps.length < MIN_WORD || cps.length > MAX_WORD) return null;
    const caseVar = caseVariations(cps);
    let best = null;
    for (const [w, subs] of readings(lower(cps))) {
        const rev = Array.from(w).reverse().join('');
        for (const [word, revMul] of rev === w ? [[w, 1]] : [[w, 1], [rev, 2]]) {
            const hit = dict.get(word);
            if (!hit) continue;
            const bits = Math.log2(hit[0] * caseVar * 2 ** subs * revMul);
            if (!best || bits < best[0]) best = [bits, hit[1]];
        }
    }
    return best;
}

function repeatBits(cps, dict, cache) {
    const n = cps.length;
    if (n < 2) return null;
    for (let p = 1; p <= n / 2; p++) {
        if (n % p) continue;
        let ok = true;
        for (let i = p; i < n && ok; i++) ok = cps[i] === cps[i - p];
        if (ok) return [estimateCps(cps.slice(0, p), dict, cache).bits + Math.log2(n / p), 'repeat'];
    }
    return null;
}

function sequenceBits(cps) {
    const n = cps.length;
    if (n < 3) return null;
    const cls = isDigit(cps[0]) ? isDigit : isLower(cps[0]) ? isLower : isUpper(cps[0]) ? isUpper : null;
    if (!cls || !cps.every(cls)) return null;
    const d = cps[1].codePointAt(0) - cps[0].codePointAt(0);
    if (d !== 1 && d !== -1) return null;
    for (let i = 2; i < n; i++) if (cps[i].codePointAt(0) - cps[i - 1].codePointAt(0) !== d) return null;
    const base = 'aAzZ019'.includes(cps[0]) ? 4 : isDigit(cps[0]) ? 10 : 26;
    return [Math.log2(base * n * (d < 0 ? 2 : 1)), 'sequence'];
}

function yearBits(cps) {
    if (cps.length !== 4 || !cps.every(isDigit)) return null;
    const y = Number(cps.join(''));
    return y >= 1900 && y <= 2049 ? [YEAR_BITS, 'year'] : null;
}

function pieceBits(cps, dict, cache) {
    let best = null;
    for (const r of [dictionaryBits(cps, dict), repeatBits(cps, dict, cache), sequenceBits(cps), yearBits(cps)]) {
        if (r && (!best || r[0] < best[0])) best = r;
    }
    return best;
}

function estimateCps(cps, dict, cache) {
    const key = cps.join('');
    if (cache.has(key)) return cache.get(key);
    const n = Math.min(cps.length, MAX_SPLIT);
    const best = new Array(n + 1).fill(Infinity);
    const from = new Array(n + 1).fill(null);
    best[0] = 0;
    for (let i = 1; i <= n; i++) {
        best[i] = best[i - 1] + charBits(cps[i - 1]);
        from[i] = [i - 1, null];
        for (let j = 0; j <= i - 2; j++) {
            const piece = pieceBits(cps.slice(j, i), dict, cache);
            if (!piece) continue;
            const total = best[j] + piece[0] + PIECE_BITS;
            if (total < best[i]) { best[i] = total; from[i] = [j, piece[1]]; }
        }
    }
    let bits = best[n];
    for (let i = n; i < cps.length; i++) bits += charBits(cps[i]);
    const kinds = [];
    for (let i = n; i > 0; i = from[i][0]) if (from[i][1]) kinds.unshift(from[i][1]);
    const reasons = [];
    for (const k of kinds) if (!reasons.includes(k)) reasons.push(k);
    const result = { bits, reasons };
    cache.set(key, result);
    return result;
}

function estimatePassword(cps, dict) {
    const cache = new Map();
    let best = estimateCps(cps, dict, cache);
    for (const sep of SEPARATORS) {
        if (!cps.includes(sep)) continue;
        const parts = [[]];
        for (const c of cps) { if (c === sep) parts.push([]); else parts[parts.length - 1].push(c); }
        if (parts.some((p) => p.length === 0)) continue;
        if (parts.length >= 3 && parts.every((p) => dict.bip39.has(p.join('')))) {
            return { bits: parts.length * BIP39_WORD_BITS + SEPARATOR_BITS, reasons: ['few-words'] };
        }
        let bits = SEPARATOR_BITS;
        const reasons = [];
        for (const p of parts) {
            const r = estimateCps(p, dict, cache);
            bits += r.bits;
            for (const k of r.reasons) if (!reasons.includes(k)) reasons.push(k);
        }
        if (bits < best.bits) best = { bits, reasons };
    }
    return best;
}

/** { bits, band: 'weak' | 'fair' | 'strong', reasons: [kind…] } */
export function ratePassword(password, context, dict) {
    const bands = BANDS[context];
    if (!bands) throw new Error('unknown context: ' + context);
    const { bits, reasons } = estimatePassword(Array.from(password), dict);
    const band = bits < bands.weak ? 'weak' : bits < bands.strong ? 'fair' : 'strong';
    return { bits, band, reasons };
}

/** One line for the user: what makes it weak, or nothing for Strong. */
export function describeRating(rating) {
    if (rating.band === 'strong') return '';
    if (rating.reasons.join() === 'few-words') return 'Random words are good, but each adds only about 11 bits: use more of them.';
    const parts = rating.reasons.map((r) => REASON_TEXT[r]);
    if (!parts.length) return 'It is too short.';
    const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
    return 'It is mostly ' + list + ', which attackers try first.';
}

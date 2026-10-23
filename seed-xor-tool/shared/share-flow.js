/**
 * share-flow.js — the logic behind the share tools' guided flow
 * (SHARE_TOOLS_DESIGN.md). No DOM: word-boxes.js and share-flow-ui.js draw
 * the screens; test-share-flow.mjs tests this file directly.
 *
 * The flow, the same for Seed XOR and Shamir Backup:
 *   write k  — share k is shown; the user writes it down.
 *   check k  — the user types it back (or scans it); it must match the
 *              share SafeKeep made, word for word.
 *   final    — every share is checked; the tool recombines the typed
 *              shares and confirms they rebuild the vault seed.
 *   done     — summary.
 */

/**
 * Words that start with `prefix`, at most `max` of them, in list order.
 * An exact match always comes first.
 */
export function suggestWords(prefix, wordlist, max = 8) {
    const p = String(prefix || '').trim().toLowerCase();
    if (!p) return [];
    const out = [];
    if (wordlist.includes(p)) out.push(p);
    for (const w of wordlist) {
        if (out.length >= max) break;
        if (w !== p && w.startsWith(p)) out.push(w);
    }
    return out;
}

/**
 * The single word `typed` stands for, or '' if none or several. A whole
 * word counts, and so does a prefix only one word starts with (BIP-39 and
 * SLIP-39 words are unique by their first four letters).
 */
export function resolveWord(typed, wordlist) {
    const p = String(typed || '').trim().toLowerCase();
    if (!p) return '';
    if (wordlist.includes(p)) return p;
    const matches = suggestWords(p, wordlist, 2);
    return matches.length === 1 ? matches[0] : '';
}

/**
 * Split pasted or scanned text into words: lower case, any whitespace or
 * commas between them, and numbering such as "1." "2)" "3:" dropped.
 */
export function splitWords(text) {
    return String(text || '')
        .toLowerCase()
        .split(/[\s,]+/)
        .map((w) => w.replace(/^\d+[.):]?$/, '').replace(/^\d+[.):]/, ''))
        .filter(Boolean);
}

/**
 * Compare a typed share with the share SafeKeep made.
 *   typed:    array of words, '' where a box is empty
 *   expected: array of words (or the share as a string)
 * Returns { ok, missing, wrong }: the indices of empty and of wrong boxes.
 * Only positions are reported, never the expected words.
 */
export function compareShare(typed, expected) {
    const exp = Array.isArray(expected) ? expected : splitWords(expected);
    const missing = [], wrong = [];
    for (let i = 0; i < exp.length; i++) {
        const t = String((typed && typed[i]) || '').trim().toLowerCase();
        if (!t) missing.push(i);
        else if (t !== exp[i]) wrong.push(i);
    }
    return { ok: missing.length === 0 && wrong.length === 0, missing, wrong };
}

/** The start of a flow over `total` shares. */
export function startFlow(total) {
    if (!Number.isInteger(total) || total < 2) throw new Error('A split needs at least 2 shares.');
    return { step: 'write', index: 0, total, checked: new Array(total).fill(false), error: '' };
}

/**
 * Move the flow on. Actions:
 *   'wrote'   write k → check k
 *   'back'    check k → write k (to look at the share again)
 *   'passed'  check k → write k+1, or final once every share is checked
 *   'final-ok'          final → done
 *   'final-failed'      final stays, with `error` set
 * Any other action, or one that doesn't fit the step, leaves the state as
 * it is.
 */
export function nextStep(state, action, detail) {
    const s = { ...state, checked: state.checked.slice(), error: '' };
    switch (action) {
        case 'wrote':
            if (s.step === 'write') s.step = 'check';
            return s;
        case 'back':
            if (s.step === 'check') s.step = 'write';
            return s;
        case 'passed':
            if (s.step !== 'check') return state;
            s.checked[s.index] = true;
            {
                const next = s.checked.indexOf(false);
                if (next === -1) { s.step = 'final'; s.index = s.total - 1; }
                else { s.step = 'write'; s.index = next; }
            }
            return s;
        case 'final-ok':
            if (s.step === 'final') s.step = 'done';
            return s;
        case 'final-failed':
            if (s.step === 'final') s.error = String(detail || 'The shares did not rebuild the seed.');
            return s;
        default:
            return state;
    }
}

/** True once every share is checked (final or done). */
export function allChecked(state) {
    return state.checked.every(Boolean);
}

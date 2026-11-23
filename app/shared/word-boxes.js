/**
 * word-boxes.js — numbered word boxes with autocomplete, for typing back a
 * seed or a share (SHARE_TOOLS_DESIGN.md). One component for both word
 * lists: BIP-39 (Seed XOR shares, seeds) and SLIP-39 (Shamir shares).
 *
 * Uses the app's existing .rst-grid / .rst-cell / .rst-autocomplete styles,
 * so the boxes look like every other word entry in SafeKeep.
 *
 *   const boxes = createWordBoxes(container, { count: 24, wordlist, idPrefix: 'xs' });
 *   boxes.getWords()        → ['abandon', '', …]  ('' where a box is empty
 *                             or doesn't name exactly one word)
 *   boxes.setWords(words)   fill from a paste or a scan
 *   boxes.markWrong([3, 7]) outline those boxes in red; clearMarks() undoes
 *   boxes.markAllRight()    outline every box in green
 *   boxes.clear(), boxes.focus(), boxes.onChange(fn), boxes.destroy()
 *
 * Typing: suggestions appear once a few words match; Enter or Tab takes
 * the highlighted (or only) one and moves on; arrow keys move through the
 * suggestions. A unique prefix ("aban") is completed when the box loses
 * focus. Pasting several words fills the boxes from the one pasted into.
 */
import { suggestWords, resolveWord, splitWords } from './share-flow.js';

export function createWordBoxes(container, { count, wordlist, idPrefix, columns }) {
    if (!container) throw new Error('No container for the word boxes.');
    const listeners = [];
    const cells = [];
    let selected = -1;

    const grid = document.createElement('div');
    grid.className = 'rst-grid skb-wordboxes';
    grid.style.gridTemplateColumns = 'repeat(' + (columns || (count > 24 ? 4 : 3)) + ', 1fr)';

    for (let i = 0; i < count; i++) {
        const cell = document.createElement('div');
        cell.className = 'rst-cell';
        const num = document.createElement('span');
        num.className = 'rst-cell-num';
        num.textContent = String(i + 1);
        const input = document.createElement('input');
        input.type = 'text';
        input.id = idPrefix + '-word-' + i;
        input.dataset.idx = String(i);
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('aria-label', 'Word ' + (i + 1));
        const ac = document.createElement('div');
        ac.className = 'rst-autocomplete';
        cell.append(num, input, ac);
        grid.appendChild(cell);
        cells.push({ input, ac });

        input.addEventListener('input', () => onInput(i));
        input.addEventListener('keydown', (e) => onKeydown(i, e));
        input.addEventListener('paste', (e) => onPaste(i, e));
        input.addEventListener('blur', () => setTimeout(() => { hideSuggestions(i); complete(i); }, 150));
    }
    container.innerHTML = '';
    container.appendChild(grid);

    function changed() { listeners.forEach((fn) => { try { fn(); } catch (_) { /* a listener's problem */ } }); }

    function paint(i) {
        const { input } = cells[i];
        const v = input.value.trim().toLowerCase();
        input.classList.remove('valid', 'invalid', 'wrong', 'right');
        if (!v) return;
        if (wordlist.includes(v)) input.classList.add('valid');
        else if (suggestWords(v, wordlist, 1).length === 0) input.classList.add('invalid');
    }

    function hideSuggestions(i) { cells[i].ac.style.display = 'none'; selected = -1; }

    function showSuggestions(i, words, typed) {
        const { ac } = cells[i];
        ac.innerHTML = '';
        selected = -1;
        words.forEach((w) => {
            const item = document.createElement('div');
            item.className = 'rst-autocomplete-item';
            item.dataset.word = w;
            const strong = document.createElement('strong');
            strong.textContent = w.slice(0, typed.length);
            item.append(strong, document.createTextNode(w.slice(typed.length)));
            item.addEventListener('mousedown', (ev) => { ev.preventDefault(); take(i, w); });
            ac.appendChild(item);
        });
        ac.style.display = words.length ? 'block' : 'none';
    }

    function highlight(i) {
        cells[i].ac.querySelectorAll('.rst-autocomplete-item').forEach((el, k) => {
            el.classList.toggle('selected', k === selected);
        });
    }

    function take(i, word) {
        cells[i].input.value = word;
        paint(i);
        hideSuggestions(i);
        if (i + 1 < cells.length) cells[i + 1].input.focus();
        changed();
    }

    function complete(i) {
        const { input } = cells[i];
        const v = input.value.trim().toLowerCase();
        const w = resolveWord(v, wordlist);
        if (w && w !== input.value) { input.value = w; paint(i); changed(); }
    }

    function onInput(i) {
        const v = cells[i].input.value.trim().toLowerCase();
        paint(i);
        if (!v || wordlist.includes(v)) hideSuggestions(i);
        else {
            const words = suggestWords(v, wordlist, 9);
            if (words.length > 0 && words.length <= 8) showSuggestions(i, words, v);
            else hideSuggestions(i);
        }
        changed();
    }

    function onKeydown(i, e) {
        const { input, ac } = cells[i];
        const items = ac.style.display === 'block' ? [...ac.querySelectorAll('.rst-autocomplete-item')] : [];
        if (e.key === 'ArrowDown' && items.length) {
            e.preventDefault(); selected = Math.min(items.length - 1, selected + 1); highlight(i);
        } else if (e.key === 'ArrowUp' && items.length) {
            e.preventDefault(); selected = Math.max(0, selected - 1); highlight(i);
        } else if (e.key === 'Escape') {
            hideSuggestions(i);
        } else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
            const pick = items.length ? items[Math.max(0, selected)].dataset.word : resolveWord(input.value, wordlist);
            if (pick) { e.preventDefault(); take(i, pick); }
            else if (e.key === 'Enter') { e.preventDefault(); if (i + 1 < cells.length) cells[i + 1].input.focus(); }
        } else if (e.key === 'Backspace' && !input.value && i > 0) {
            e.preventDefault(); cells[i - 1].input.focus();
        }
    }

    function onPaste(i, e) {
        const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
        const words = splitWords(text);
        if (words.length <= 1) return;   // one word: let the browser paste it
        e.preventDefault();
        words.slice(0, cells.length - i).forEach((w, k) => { cells[i + k].input.value = w; paint(i + k); });
        hideSuggestions(i);
        const last = Math.min(cells.length - 1, i + words.length);
        cells[last].input.focus();
        changed();
    }

    return {
        count,
        getWords() { return cells.map(({ input }) => resolveWord(input.value, wordlist)); },
        setWords(words) {
            const list = Array.isArray(words) ? words : splitWords(words);
            cells.forEach(({ input }, i) => { input.value = (list[i] || '').toLowerCase(); paint(i); hideSuggestions(i); });
            changed();
        },
        markWrong(indices) {
            const set = new Set(indices);
            cells.forEach(({ input }, i) => {
                input.classList.toggle('wrong', set.has(i));
                input.classList.remove('right');
            });
            const first = indices.length ? cells[indices[0]] : null;
            if (first) first.input.focus();
        },
        markAllRight() { cells.forEach(({ input }) => { input.classList.remove('wrong'); input.classList.add('right'); }); },
        clearMarks() { cells.forEach((_, i) => paint(i)); },
        clear() { cells.forEach(({ input }, i) => { input.value = ''; paint(i); hideSuggestions(i); }); changed(); },
        focus() { const empty = cells.find(({ input }) => !input.value); (empty || cells[0]).input.focus(); },
        onChange(fn) { listeners.push(fn); },
        destroy() { cells.forEach(({ input }) => { input.value = ''; }); container.innerHTML = ''; listeners.length = 0; },
    };
}

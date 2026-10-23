/**
 * share-flow-ui.js — the screens of the share tools' guided flow
 * (SHARE_TOOLS_DESIGN.md): write down share k, check share k, the final
 * check, done. Seed XOR and Shamir Backup each pass in their shares and a
 * few hooks; the steps and their order come from share-flow.js.
 *
 *   const flow = mountShareFlow(container, {
 *     idPrefix: 'xorf',
 *     shares: ['word word …', …],          // the shares SafeKeep just made
 *     wordlist,                            // BIP-39 or SLIP-39
 *     shareName: 'XOR share',              // shown in headings
 *     schemeLine: 'All 3 shares are needed to recover the seed.',
 *     fingerprint: '5436d724',
 *     print(i),                            // optional: print share i
 *     drawQR(canvas, i),                   // optional: draw share i's QR
 *     scan(readerEl, onWords, onError) → stop function   // optional
 *     verifyAll(typedShares, extra) → Promise<{ ok, message }>,  // recombine
 *     finalField: { label, hint },         // optional: ask for one more value
 *                                          // (Shamir's share passphrase) before
 *                                          // the final check; passed as `extra`
 *     doneLines: ['…', …],                 // the summary on the last screen
 *     onFinish(), onCancel(),
 *   });
 *   flow.isComplete()   true once every share is checked and recombined
 *   flow.stopScanning() turns the camera off (e.g. when leaving the tool)
 *   flow.destroy()      clears the screens and forgets the shares
 *
 * Nothing here shows the expected words on the check screen: a wrong box
 * is marked by position only.
 */
import { startFlow, nextStep, compareShare, splitWords } from './share-flow.js';
import { createWordBoxes } from './word-boxes.js';

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function button(label, className, onClick) {
    const b = el('button', 'skb-btn' + (className ? ' ' + className : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
}

function wordList(indices) {
    const n = indices.map((i) => String(i + 1));
    if (n.length === 1) return 'Word ' + n[0];
    return 'Words ' + n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
}

export function mountShareFlow(container, opts) {
    const shares = opts.shares.map((s) => splitWords(s));
    const total = shares.length;
    const typed = new Array(total).fill(null);
    let state = startFlow(total);
    let boxes = null;
    let stopScan = null;
    let complete = false;
    let destroyed = false;
    let notice = '';   // "Share k matches", shown once on the next screen
    let resetScanUI = null;   // puts the check screen's Scan button back

    function stopScanner() {
        if (stopScan) { try { stopScan(); } catch (_) { /* already stopped */ } stopScan = null; }
        if (resetScanUI) resetScanUI();
    }

    function progress() {
        const row = el('div', 'sf-progress');
        for (let i = 0; i < total; i++) {
            const done = state.checked[i];
            const current = (state.step === 'write' || state.step === 'check') && state.index === i;
            const chip = el('span', 'sf-chip' + (done ? ' done' : '') + (current ? ' current' : ''),
                'Share ' + (i + 1) + (done ? ' ✓' : ''));
            row.appendChild(chip);
        }
        return row;
    }

    function header(title, sub) {
        const h = el('div', 'sf-head');
        h.appendChild(el('div', 'sf-title', title));
        if (sub) h.appendChild(el('div', 'sf-sub', sub));
        return h;
    }

    function status(kind, text) {
        const s = el('div', 'sf-status' + (kind ? ' ' + kind : ''), text || '');
        if (!text) s.style.display = 'none';
        return s;
    }

    function setStatus(s, kind, text) {
        s.className = 'sf-status' + (kind ? ' ' + kind : '');
        s.textContent = text;
        s.style.display = text ? 'block' : 'none';
    }

    function footer() {
        const f = el('div', 'sf-footer');
        f.appendChild(button('Cancel', 'sf-quiet', () => opts.onCancel && opts.onCancel()));
        return f;
    }

    function render() {
        if (destroyed) return;
        stopScanner();
        resetScanUI = null;
        if (boxes) { boxes.destroy(); boxes = null; }
        container.innerHTML = '';
        const card = el('div', 'skb-card sf-card');
        container.appendChild(card);
        if (state.step === 'write') renderWrite(card);
        else if (state.step === 'check') renderCheck(card);
        else if (state.step === 'final') renderFinal(card);
        else renderDone(card);
        try { container.scrollIntoView({ block: 'start' }); } catch (_) { /* not in a scrollable view */ }
    }

    function renderWrite(card) {
        const k = state.index;
        card.appendChild(progress());
        if (notice) { card.appendChild(status('ok', notice)); notice = ''; }
        card.appendChild(header(opts.shareName + ' ' + (k + 1) + ' of ' + total, opts.schemeLine));
        const meta = el('div', 'sf-meta');
        meta.appendChild(document.createTextNode('Write all ' + shares[k].length + ' words down in order. Seed fingerprint '));
        meta.appendChild(el('strong', 'sf-fp', opts.fingerprint || '--------'));
        card.appendChild(meta);

        const grid = el('div', 'sf-words' + (shares[k].length > 24 ? ' sf-words--wide' : ''));
        shares[k].forEach((w, i) => {
            const cell = el('div', 'sf-word');
            cell.appendChild(el('span', 'sf-word-num', String(i + 1)));
            cell.appendChild(el('span', 'sf-word-text', w));
            grid.appendChild(cell);
        });
        card.appendChild(grid);

        const tools = el('div', 'sf-tools');
        let qrWrap = null;
        if (opts.print) tools.appendChild(button('Print', '', () => opts.print(k)));
        if (opts.drawQR) {
            const qrBtn = button('Show QR', '', () => {
                if (!qrWrap) {
                    qrWrap = el('div', 'sf-qr');
                    const canvas = document.createElement('canvas');
                    qrWrap.appendChild(canvas);
                    tools.after(qrWrap);
                    opts.drawQR(canvas, k);
                    qrBtn.textContent = 'Hide QR';
                } else {
                    qrWrap.remove(); qrWrap = null; qrBtn.textContent = 'Show QR';
                }
            });
            tools.appendChild(qrBtn);
        }
        if (tools.childNodes.length) card.appendChild(tools);

        const next = button('I’ve written it down — check it', 'skb-btn--primary sf-primary', () => { state = nextStep(state, 'wrote'); render(); });
        card.appendChild(next);
        card.appendChild(footer());
    }

    function renderCheck(card) {
        const k = state.index;
        card.appendChild(progress());
        card.appendChild(header('Check ' + opts.shareName + ' ' + (k + 1) + ' of ' + total,
            'Type share ' + (k + 1) + ' from your paper' + (opts.scan ? ', or scan its QR code' : '') + '. SafeKeep compares it with the share it made.'));

        const boxHost = el('div', 'sf-boxes');
        card.appendChild(boxHost);
        boxes = createWordBoxes(boxHost, { count: shares[k].length, wordlist: opts.wordlist, idPrefix: opts.idPrefix + '-' + k });
        if (typed[k]) boxes.setWords(typed[k]);

        const msg = status('', '');
        let reader = null;
        const tools = el('div', 'sf-tools');
        if (opts.scan) {
            const scanBtn = button('Scan QR', '', () => {
                if (stopScan) { stopScanner(); if (reader) reader.style.display = 'none'; scanBtn.textContent = 'Scan QR'; return; }
                if (!reader) { reader = el('div', 'sf-reader'); reader.id = opts.idPrefix + '-reader-' + k; tools.after(reader); }
                reader.style.display = 'block';
                scanBtn.textContent = 'Stop scanning';
                setStatus(msg, 'info', 'Point the camera at share ' + (k + 1) + '’s QR code.');
                stopScan = opts.scan(reader, (words) => {
                    stopScanner(); reader.style.display = 'none'; scanBtn.textContent = 'Scan QR';
                    if (!words || words.length !== shares[k].length) {
                        setStatus(msg, 'error', 'That QR code isn’t a ' + shares[k].length + '-word ' + opts.shareName.toLowerCase() + '.');
                        return;
                    }
                    boxes.setWords(words);
                    check();
                }, (err) => {
                    stopScanner(); reader.style.display = 'none'; scanBtn.textContent = 'Scan QR';
                    setStatus(msg, 'error', 'The camera couldn’t start: ' + (err && err.message ? err.message : String(err)));
                });
            });
            tools.appendChild(scanBtn);
            resetScanUI = () => { if (reader) reader.style.display = 'none'; scanBtn.textContent = 'Scan QR'; };
        }
        tools.appendChild(button('Clear', 'sf-quiet', () => { boxes.clear(); setStatus(msg, '', ''); boxes.focus(); }));
        card.appendChild(tools);
        card.appendChild(msg);

        function check() {
            const words = boxes.getWords();
            const r = compareShare(words, shares[k]);
            if (r.ok) {
                typed[k] = words;
                boxes.markAllRight();
                notice = 'Share ' + (k + 1) + ' matches your paper.';
                state = nextStep(state, 'passed');
                render();
                return;
            }
            if (r.wrong.length) {
                boxes.markWrong(r.wrong);
                setStatus(msg, 'error', wordList(r.wrong) + (r.wrong.length === 1 ? ' doesn’t' : ' don’t') +
                    ' match share ' + (k + 1) + '. Check ' + (r.wrong.length === 1 ? 'it' : 'them') + ' against your paper' +
                    (r.missing.length ? ', and fill in the ' + r.missing.length + ' empty ' + (r.missing.length === 1 ? 'box' : 'boxes') : '') + '.');
            } else {
                boxes.clearMarks();
                setStatus(msg, 'error', 'Fill in every word: ' + r.missing.length + (r.missing.length === 1 ? ' box is' : ' boxes are') + ' empty.');
                boxes.focus();
            }
        }

        const actions = el('div', 'sf-actions');
        actions.appendChild(button('Look at share ' + (k + 1) + ' again', '', () => { typed[k] = boxes.getWords(); state = nextStep(state, 'back'); render(); }));
        actions.appendChild(button('Check share ' + (k + 1), 'skb-btn--primary sf-primary', check));
        card.appendChild(actions);
        card.appendChild(footer());
        setTimeout(() => boxes && boxes.focus(), 50);
    }

    function renderFinal(card) {
        card.appendChild(progress());
        if (notice) { card.appendChild(status('ok', notice)); notice = ''; }
        const ff = opts.finalField;
        card.appendChild(header('Every share checked', ff ? ff.hint : 'Rebuilding the seed from the shares you typed\u2026'));
        const msg = status('info', ff ? '' : 'Working\u2026');
        let input = null, go = null, footerShown = false;
        if (ff) {
            const wrap = el('div', 'sf-field');
            const label = el('label', 'sf-field-label', ff.label);
            input = document.createElement('input');
            input.type = 'password';
            input.id = opts.idPrefix + '-final-field';
            input.autocomplete = 'off';
            input.spellcheck = false;
            label.htmlFor = input.id;
            wrap.append(label, input);
            card.appendChild(wrap);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
        }
        card.appendChild(msg);
        if (ff) {
            go = button('Check', 'skb-btn--primary sf-primary', () => run());
            card.appendChild(go);
            setTimeout(() => input && input.focus(), 50);
        }

        function failed(text) {
            state = nextStep(state, 'final-failed', text);
            setStatus(msg, 'error', state.error);
            if (go) go.disabled = false;
            if (!footerShown) { card.appendChild(footer()); footerShown = true; }
        }

        function run() {
            if (go) { go.disabled = true; }
            setStatus(msg, 'info', 'Rebuilding the seed from the shares you typed\u2026');
            Promise.resolve()
                .then(() => opts.verifyAll(typed.map((w) => w.join(' ')), input ? input.value : undefined))
                .then((r) => {
                    if (destroyed || state.step !== 'final') return;
                    if (r && r.ok) {
                        if (input) input.value = '';
                        complete = true; state = nextStep(state, 'final-ok'); render(); return;
                    }
                    failed(r && r.message);
                })
                .catch((e) => { if (!destroyed) failed(e && e.message); });
        }

        if (!ff) run();
    }

    function renderDone(card) {
        card.appendChild(progress());
        card.appendChild(header('Your ' + total + ' shares are checked', opts.schemeLine));
        const list = el('ul', 'sf-done');
        (opts.doneLines || []).forEach((line) => list.appendChild(el('li', '', line)));
        card.appendChild(list);
        card.appendChild(button('Back to Dashboard', 'skb-btn--primary sf-primary', () => opts.onFinish && opts.onFinish()));
    }

    render();

    return {
        isComplete: () => complete,
        stopScanning: stopScanner,
        state: () => ({ ...state, checked: state.checked.slice() }),
        destroy() {
            destroyed = true;
            stopScanner();
            if (boxes) { boxes.destroy(); boxes = null; }
            typed.fill(null);
            shares.forEach((s) => s.fill(''));
            container.innerHTML = '';
        },
    };
}

/**
 * "Check shares I already have": type in (or scan) shares made earlier and
 * learn whether they rebuild the vault seed. Nothing is loaded and the
 * rebuilt seed's words are never shown.
 *
 *   const checker = mountShareChecker(container, {
 *     idPrefix: 'xorc',
 *     wordlist, wordCount: 24,            // words per share
 *     shareName: 'XOR share',
 *     counts: [2, 3, 4], count: 3,        // how many shares to enter
 *     intro: '…',                         // one or two lines at the top
 *     scan(readerEl, onWords, onError) → stop function    // optional
 *     check(typedShares, extra) → Promise<{ ok, message }>,
 *     extraField: { label },              // optional: one more value, e.g.
 *                                         // Shamir's share passphrase
 *     onBack(),
 *   });
 *   checker.stopScanning(); checker.destroy();
 */
export function mountShareChecker(container, opts) {
    let count = opts.count || opts.counts[0];
    let boxes = [];
    let extraValue = '';
    let stopScan = null, resetScanUI = null;
    let destroyed = false;

    function stopScanner() {
        if (stopScan) { try { stopScan(); } catch (_) { /* already stopped */ } stopScan = null; }
        if (resetScanUI) { resetScanUI(); resetScanUI = null; }
    }

    function setStatus(s, kind, text) {
        s.className = 'sf-status' + (kind ? ' ' + kind : '');
        s.textContent = text;
        s.style.display = text ? 'block' : 'none';
    }

    function render() {
        if (destroyed) return;
        const kept = boxes.map((b) => b.getWords());
        stopScanner();
        boxes.forEach((b) => b.destroy());
        boxes = [];
        container.innerHTML = '';
        const card = el('div', 'skb-card sf-card');
        container.appendChild(card);

        const h = el('div', 'sf-head');
        h.appendChild(el('div', 'sf-title', 'Check shares you already have'));
        if (opts.intro) h.appendChild(el('div', 'sf-sub', opts.intro));
        card.appendChild(h);

        if (opts.counts.length > 1) {
            const row = el('div', 'sf-counts');
            row.appendChild(el('span', 'sf-counts-label', 'How many shares?'));
            opts.counts.forEach((c) => {
                const b = button(String(c), c === count ? 'sf-count active' : 'sf-count', () => { count = c; render(); });
                b.setAttribute('aria-pressed', c === count ? 'true' : 'false');
                row.appendChild(b);
            });
            card.appendChild(row);
        }

        const result = el('div', 'sf-status');
        result.style.display = 'none';

        for (let k = 0; k < count; k++) {
            const block = el('div', 'sf-share-block');
            const head = el('div', 'sf-share-head');
            head.appendChild(el('span', 'sf-share-label', opts.shareName + ' ' + (k + 1)));
            const host = el('div', 'sf-boxes');
            const b = createWordBoxes(host, { count: opts.wordCount, wordlist: opts.wordlist, idPrefix: opts.idPrefix + '-' + k });
            if (kept[k]) b.setWords(kept[k]);
            b.onChange(() => setStatus(result, '', ''));
            boxes.push(b);
            if (opts.scan) {
                let reader = null;
                const scanBtn = button('Scan QR', '', () => {
                    const mine = resetScanUI && resetScanUI.owner === k;
                    stopScanner();
                    if (mine) return;   // second click stops this scanner
                    if (!reader) { reader = el('div', 'sf-reader'); reader.id = opts.idPrefix + '-reader-' + k; head.after(reader); }
                    reader.style.display = 'block';
                    scanBtn.textContent = 'Stop scanning';
                    resetScanUI = () => { reader.style.display = 'none'; scanBtn.textContent = 'Scan QR'; };
                    resetScanUI.owner = k;
                    stopScan = opts.scan(reader, (words) => {
                        stopScanner();
                        if (!words || words.length !== opts.wordCount) {
                            setStatus(result, 'error', 'That QR code isn’t a ' + opts.wordCount + '-word ' + opts.shareName.toLowerCase() + '.');
                            return;
                        }
                        b.setWords(words);
                    }, (err) => {
                        stopScanner();
                        setStatus(result, 'error', 'The camera couldn’t start: ' + (err && err.message ? err.message : String(err)));
                    });
                });
                head.appendChild(scanBtn);
            }
            block.append(head, host);
            card.appendChild(block);
        }

        let extra = null;
        if (opts.extraField) {
            const wrap = el('div', 'sf-field');
            const label = el('label', 'sf-field-label', opts.extraField.label);
            extra = document.createElement('input');
            extra.type = 'password';
            extra.id = opts.idPrefix + '-extra';
            extra.autocomplete = 'off';
            extra.spellcheck = false;
            extra.value = extraValue;
            extra.addEventListener('input', () => { extraValue = extra.value; setStatus(result, '', ''); });
            label.htmlFor = extra.id;
            wrap.append(label, extra);
            card.appendChild(wrap);
        }
        card.appendChild(result);
        const actions = el('div', 'sf-actions');
        actions.appendChild(button('Back', '', () => opts.onBack && opts.onBack()));
        const go = button('Check these shares', 'skb-btn--primary sf-primary', async () => {
            stopScanner();
            const typed = boxes.map((b) => b.getWords());
            const empty = typed.map((w, k) => (w.some((x) => !x) ? k + 1 : 0)).filter(Boolean);
            if (empty.length) {
                setStatus(result, 'error', 'Fill in every word of ' + (empty.length === 1 ? 'share ' + empty[0] : 'shares ' + empty.join(', ')) + '.');
                return;
            }
            go.disabled = true;
            setStatus(result, 'info', 'Checking…');
            let r;
            try { r = await opts.check(typed.map((w) => w.join(' ')), extra ? extra.value : undefined); } catch (e) { r = { ok: false, message: e && e.message }; }
            go.disabled = false;
            if (destroyed) return;
            setStatus(result, r && r.ok ? 'ok' : 'error', (r && r.message) || 'The check failed.');
        });
        actions.appendChild(go);
        card.appendChild(actions);
    }

    render();

    return {
        stopScanning: stopScanner,
        destroy() {
            destroyed = true;
            stopScanner();
            boxes.forEach((b) => b.destroy());
            boxes = [];
            extraValue = '';
            container.innerHTML = '';
        },
    };
}

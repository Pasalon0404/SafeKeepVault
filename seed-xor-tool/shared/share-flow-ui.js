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
 *     verifyAll(typedShares) → Promise<{ ok, message }>,  // recombine
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
        card.appendChild(header('Every share checked', 'Rebuilding the seed from the shares you typed…'));
        const msg = status('info', 'Working…');
        card.appendChild(msg);
        Promise.resolve()
            .then(() => opts.verifyAll(typed.map((w) => w.join(' '))))
            .then((r) => {
                if (destroyed || state.step !== 'final') return;
                if (r && r.ok) { complete = true; state = nextStep(state, 'final-ok'); render(); return; }
                state = nextStep(state, 'final-failed', r && r.message);
                setStatus(msg, 'error', state.error);
                card.appendChild(footer());
            })
            .catch((e) => {
                if (destroyed) return;
                state = nextStep(state, 'final-failed', e && e.message);
                setStatus(msg, 'error', state.error);
                card.appendChild(footer());
            });
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

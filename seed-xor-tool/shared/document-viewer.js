/**
 * SafeKeepVault — the sealed document viewer (DOCUMENTS_DESIGN.md, §4)
 *
 * Documents are outside content: a PDF or image someone else made. They are
 * never opened by Chromium's own viewers. Each preview runs in an
 *   <iframe sandbox="allow-scripts" srcdoc="…">
 * without allow-same-origin. Its origin is opaque, so even if a document
 * triggered a bug in a viewer, the code in the frame couldn't read the vault
 * (file:// fetches fail), reach the app's page or memory, start a download,
 * open a window or navigate the app. Checked in the pinned Chromium on
 * Nov 18, 2026 with the kiosk's --allow-file-access-from-files.
 *
 * The app sends the document's bytes (and, for PDFs, the pdf.js code) to the
 * frame with postMessage. The frame sends back only short status text, which
 * the app shows with textContent.
 *
 * Inside the frame:
 *   - text: the first 5 MB, decoded as UTF-8, set with textContent;
 *   - images (PNG, JPEG, GIF, WebP, by their first bytes): an <img> of a
 *     blob URL with that exact type; SVG is never shown (it can carry script);
 *   - PDF: pdf.js with isEvalSupported: false (fonts can't run code, the fix
 *     for CVE-2024-4367), no scripting (pdf.sandbox isn't bundled), no XFA,
 *     no annotation layer (links are drawn but not clickable).
 * The frame's own Content-Security-Policy allows no network at all.
 */

export const TEXT_EXTS = ['txt', 'md', 'csv', 'log', 'json'];
export const TEXT_LIMIT = 5 * 1024 * 1024;
export const VIEWABLE = ['text', 'png', 'jpeg', 'gif', 'webp', 'pdf'];
const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** What the bytes are, from their first bytes (the same rules as safekeep-documents.py). */
export function detectKind(bytes, name) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const head = b.subarray(0, 65536);
    const startsWith = (sig, at = 0) => sig.every((v, i) => head[at + i] === v);
    const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
    const first1k = head.subarray(0, 1024);
    for (let i = 0; i + 5 <= first1k.length; i++) {
        if (first1k[i] === 0x25 && first1k[i + 1] === 0x50 && first1k[i + 2] === 0x44 && first1k[i + 3] === 0x46 && first1k[i + 4] === 0x2d) return 'pdf';
    }
    if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (startsWith([0xff, 0xd8, 0xff])) return 'jpeg';
    if (startsWith(ascii('GIF87a')) || startsWith(ascii('GIF89a'))) return 'gif';
    if (startsWith(ascii('RIFF')) && startsWith(ascii('WEBP'), 8)) return 'webp';
    const ext = extOf(name);
    if (TEXT_EXTS.includes(ext) && !head.includes(0)) {
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(head);
            return 'text';
        } catch (e) {
            // A character cut at the 64 KB boundary is fine.
            try {
                new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 3)));
                if (head.length === 65536) return 'text';
            } catch (e2) { /* not text */ }
        }
    }
    return 'other';
}

export function extOf(name) {
    const base = String(name || '').split('/').pop();
    if (!base.includes('.')) return 'bin';
    const ext = base.split('.').pop().toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
}

export function kindLabel(kind) {
    return { pdf: 'PDF', png: 'PNG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image', text: 'Text' }[kind] || 'File';
}

// ---------------------------------------------------------------------------
// The frame's page. Everything in it runs in the opaque-origin sandbox.
// ---------------------------------------------------------------------------
const FRAME_CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline' blob:",
    "worker-src blob:",
    "img-src blob:",
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

const FRAME_SCRIPT = String.raw`
(function () {
  var shown = false;
  var root = document.getElementById('root');
  function status(text, extra) {
    var msg = { type: 'skdoc-status', text: String(text) };
    if (extra) { for (var k in extra) msg[k] = extra[k]; }
    parent.postMessage(msg, '*');
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fail(text) {
    root.textContent = '';
    root.appendChild(el('div', 'msg', text));
    status(text, { error: true });
  }
  window.addEventListener('message', function (ev) {
    if (shown || ev.source !== parent) return;
    var m = ev.data;
    if (!m || m.type !== 'skdoc-show') return;
    shown = true;
    try {
      if (m.theme) {
        var st = document.documentElement.style;
        st.setProperty('--bg', m.theme.bg); st.setProperty('--fg', m.theme.fg);
        st.setProperty('--muted', m.theme.muted); st.setProperty('--border', m.theme.border);
        st.setProperty('--accent', m.theme.accent);
      }
      if (m.kind === 'text') return showText(m.data);
      if (m.kind === 'png' || m.kind === 'jpeg' || m.kind === 'gif' || m.kind === 'webp') return showImage(m.data, m.mime);
      if (m.kind === 'pdf') return showPdf(m.data, m.lib, m.worker);
      fail('SafeKeep can\'t show this kind of file. Export it to open it elsewhere.');
    } catch (e) {
      fail('This document couldn\'t be shown.');
    }
  });

  function showText(data) {
    var limit = ${TEXT_LIMIT};
    var bytes = new Uint8Array(data);
    var cut = bytes.length > limit;
    var text = new TextDecoder('utf-8').decode(cut ? bytes.subarray(0, limit) : bytes);
    root.textContent = '';
    if (cut) root.appendChild(el('div', 'note', 'Showing the first 5 MB of this file.'));
    root.appendChild(el('pre', 'text', text));
    status(cut ? 'Text (first 5 MB)' : 'Text');
  }

  function showImage(data, mime) {
    var url = URL.createObjectURL(new Blob([data], { type: mime }));
    var img = el('img', 'image');
    img.alt = '';
    img.onload = function () { status('Image, ' + img.naturalWidth + ' × ' + img.naturalHeight); };
    img.onerror = function () { fail('This image couldn\'t be shown. It may be damaged.'); };
    img.src = url;
    root.textContent = '';
    root.appendChild(img);
  }

  function showPdf(data, libSrc, workerSrc) {
    var libUrl = URL.createObjectURL(new Blob([libSrc], { type: 'text/javascript' }));
    var workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
    root.textContent = '';
    var bar = el('div', 'bar');
    var prev = el('button', null, '◀ Previous'); var next = el('button', null, 'Next ▶');
    var label = el('span', 'pages', 'Opening…');
    var zoomOut = el('button', null, '−'); var zoomIn = el('button', null, '+');
    var fit = el('button', null, 'Fit width'); var zoomLabel = el('span', 'zoom', '');
    [prev, label, next, el('span', 'gap'), zoomOut, zoomLabel, zoomIn, fit].forEach(function (x) { bar.appendChild(x); });
    var view = el('div', 'pdfview');
    var canvas = el('canvas');
    view.appendChild(canvas);
    root.appendChild(bar); root.appendChild(view);
    var doc = null, pageNo = 1, scale = 1, fitMode = true, busy = false, again = false;

    function render() {
      if (busy) { again = true; return; }
      busy = true;
      doc.getPage(pageNo).then(function (page) {
        var base = page.getViewport({ scale: 1 });
        if (fitMode && view.clientWidth > 50) scale = Math.max(0.25, Math.min(4, (view.clientWidth - 24) / base.width));
        var vp = page.getViewport({ scale: scale });
        var ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * ratio); canvas.height = Math.floor(vp.height * ratio);
        canvas.style.width = Math.floor(vp.width) + 'px'; canvas.style.height = Math.floor(vp.height) + 'px';
        var ctx = canvas.getContext('2d');
        return page.render({ canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
      }).then(function () {
        label.textContent = 'Page ' + pageNo + ' of ' + doc.numPages;
        zoomLabel.textContent = Math.round(scale * 100) + '%';
        prev.disabled = pageNo <= 1; next.disabled = pageNo >= doc.numPages;
        status('PDF, page ' + pageNo + ' of ' + doc.numPages, { page: pageNo, pages: doc.numPages });
      }).catch(function () {
        label.textContent = 'Page ' + pageNo + ' couldn\'t be shown';
        status('This page couldn\'t be shown.', { error: true });
      }).then(function () {
        busy = false;
        if (again) { again = false; render(); }
      });
    }
    prev.onclick = function () { if (pageNo > 1) { pageNo--; render(); view.scrollTop = 0; } };
    next.onclick = function () { if (doc && pageNo < doc.numPages) { pageNo++; render(); view.scrollTop = 0; } };
    zoomOut.onclick = function () { if (doc) { fitMode = false; scale = Math.max(0.25, scale / 1.25); render(); } };
    zoomIn.onclick = function () { if (doc) { fitMode = false; scale = Math.min(6, scale * 1.25); render(); } };
    fit.onclick = function () { if (doc) { fitMode = true; render(); } };
    // Fit to the frame's width once it has its size, and again if it changes.
    var lastW = 0;
    new ResizeObserver(function () {
      var w = view.clientWidth;
      if (doc && fitMode && Math.abs(w - lastW) > 8) { lastW = w; render(); }
    }).observe(view);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev.onclick();
      if (e.key === 'ArrowRight' || e.key === 'PageDown') next.onclick();
    });

    import(libUrl).then(function (pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjsLib.getDocument({
        data: new Uint8Array(data),
        isEvalSupported: false,
        enableXfa: false,
        disableAutoFetch: true,
        disableStream: true,
        stopAtErrors: false,
        verbosity: 0,
      }).promise;
    }).then(function (d) {
      doc = d;
      render();
    }).catch(function (e) {
      var pw = e && e.name === 'PasswordException';
      fail(pw ? 'This PDF is protected with a password. SafeKeep can\'t open it: export it and open it elsewhere.'
              : 'This PDF couldn\'t be opened. It may be damaged.');
    });
  }
  status('ready', { ready: true });
})();
`;

const FRAME_STYLE = `
:root { --bg: #111; --fg: #eee; --muted: #999; --border: #333; --accent: #f7931a; color-scheme: dark light; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
#root { height: 100%; display: flex; flex-direction: column; }
.msg { margin: auto; padding: 2rem; color: var(--muted); text-align: center; max-width: 36rem; }
.note { padding: 0.4rem 0.75rem; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--border); }
pre.text { margin: 0; padding: 0.75rem 1rem; white-space: pre-wrap; word-break: break-word; overflow: auto; flex: 1;
  font: 13px/1.5 ui-monospace, "JetBrains Mono", monospace; }
img.image { max-width: 100%; max-height: 100%; object-fit: contain; margin: auto; display: block; }
.bar { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); }
.bar button { background: transparent; color: var(--fg); border: 1px solid var(--border); border-radius: 6px;
  padding: 0.25rem 0.7rem; font: inherit; cursor: pointer; }
.bar button:disabled { opacity: 0.4; cursor: default; }
.bar .gap { flex: 1; }
.bar .pages, .bar .zoom { color: var(--muted); min-width: 4rem; text-align: center; }
.pdfview { flex: 1; overflow: auto; padding: 12px; text-align: center; background: #525659; }
.pdfview canvas { background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.4); }
`;

export const FRAME_HTML = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + FRAME_CSP + '">' +
    '<style>' + FRAME_STYLE + '</style></head><body><div id="root"><div class="msg">Opening…</div></div>' +
    '<script>' + FRAME_SCRIPT + '</' + 'script></body></html>';

/**
 * Show a document in a sealed frame inside `container`.
 * @param {HTMLElement} container
 * @param {{ name: string, bytes: ArrayBuffer|Uint8Array, kind?: string, lib?: string, worker?: string,
 *           theme?: object, onStatus?: (s: object) => void }} opts
 * @returns {{ frame: HTMLIFrameElement, kind: string, destroy: () => void }}
 */
export function openViewer(container, opts) {
    const bytes = opts.bytes instanceof Uint8Array ? opts.bytes : new Uint8Array(opts.bytes);
    const kind = detectKind(bytes, opts.name);
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'Document preview');
    frame.style.cssText = 'width: 100%; height: 100%; border: 0; display: block;';
    frame.srcdoc = FRAME_HTML;

    let sent = false;
    function onMessage(ev) {
        if (ev.source !== frame.contentWindow) return;
        const m = ev.data;
        if (!m || m.type !== 'skdoc-status') return;
        if (m.ready && !sent) {
            sent = true;
            const copy = bytes.slice().buffer;     // the frame gets its own copy
            frame.contentWindow.postMessage({
                type: 'skdoc-show', kind, mime: MIME[kind] || '', data: copy,
                lib: kind === 'pdf' ? (opts.lib || '') : '', worker: kind === 'pdf' ? (opts.worker || '') : '',
                theme: opts.theme || null,
            }, '*', [copy]);
            return;
        }
        if (typeof opts.onStatus === 'function') {
            opts.onStatus({
                text: typeof m.text === 'string' ? m.text.slice(0, 200) : '',
                error: m.error === true,
                page: Number.isInteger(m.page) ? m.page : null,
                pages: Number.isInteger(m.pages) ? m.pages : null,
            });
        }
    }
    window.addEventListener('message', onMessage);
    container.appendChild(frame);
    return {
        frame,
        kind,
        destroy() {
            window.removeEventListener('message', onMessage);
            if (frame.parentNode) frame.parentNode.removeChild(frame);
        },
    };
}

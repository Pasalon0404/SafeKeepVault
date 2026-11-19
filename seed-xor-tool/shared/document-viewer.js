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
export const VIEWABLE = ['text', 'png', 'jpeg', 'gif', 'webp', 'pdf', 'odt'];
const ODT_MIME = 'application/vnd.oasis.opendocument.text';
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
    if (isOdt(head)) return 'odt';
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

/** An OpenDocument text file: a zip whose first entry is an uncompressed
 *  "mimetype" holding the ODF text type (the ODF standard requires this). */
function isOdt(head) {
    if (head.length < 30 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 3 || head[3] !== 4) return false;
    const u16 = (o) => head[o] | (head[o + 1] << 8);
    if (u16(8) !== 0) return false;
    const nameLen = u16(26), extraLen = u16(28);
    if (String.fromCharCode(...head.subarray(30, 30 + nameLen)) !== 'mimetype') return false;
    const start = 30 + nameLen + extraLen;
    return String.fromCharCode(...head.subarray(start, start + ODT_MIME.length)) === ODT_MIME && head[start + ODT_MIME.length] !== 0x2d;
}

export function extOf(name) {
    const base = String(name || '').split('/').pop();
    if (!base.includes('.')) return 'bin';
    const ext = base.split('.').pop().toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
}

export function kindLabel(kind) {
    return { pdf: 'PDF', png: 'PNG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image', text: 'Text', odt: 'OpenDocument text' }[kind] || 'File';
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

const ODT_SCRIPT = String.raw`
// ---------------------------------------------------------------------------
// OpenDocument text (.odt): a reading view, not the page layout.
// An .odt is a zip; its text is content.xml (and named styles in styles.xml).
// Everything here is our own code: the zip is read by hand and unpacked with
// the browser's DecompressionStream (zlib), and the XML by a small reader of
// our own, not DOMParser (Chromium's XML parser is C code). The document is
// built from elements and text nodes only: no markup from the file is ever
// parsed as HTML. Links are shown but can't be clicked. Images: PNG, JPEG,
// GIF and WebP only. Limits stop zip bombs and very deep nesting.
// ---------------------------------------------------------------------------
var SK_ODT = {
  MAX_XML: 20 * 1024 * 1024,        // content.xml / styles.xml, unpacked
  MAX_TOTAL: 100 * 1024 * 1024,     // everything unpacked
  MAX_IMAGE: 20 * 1024 * 1024,
  MAX_IMAGES: 200,
  MAX_NODES: 1000000,
  MAX_DEPTH: 256
};

function SkOdtError(text) { this.text = text; }

function skOdtZip(b) {
  function u16(o) { return b[o] | (b[o + 1] << 8); }
  function u32(o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  var bad = new SkOdtError('This document couldn\'t be opened. It may be damaged.');
  var eocd = -1;
  for (var i = b.length - 22, min = Math.max(0, b.length - 65557); i >= min; i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad;
  var count = u16(eocd + 10), cdSize = u32(eocd + 12), cdOff = u32(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdOff + cdSize > b.length) throw bad;
  var entries = {}, p = cdOff, dec = new TextDecoder('utf-8');
  for (var n = 0; n < count; n++) {
    if (p + 46 > b.length || u32(p) !== 0x02014b50) throw bad;
    var nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32);
    var name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    entries[name] = { flags: u16(p + 8), method: u16(p + 10), comp: u32(p + 20), size: u32(p + 24), local: u32(p + 42) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  var used = 0;
  async function read(name, limit) {
    var e = entries[name];
    if (!e) return null;
    if (e.flags & 1) throw new SkOdtError('This document is protected with a password. SafeKeep can\'t open it: export it and open it elsewhere.');
    var lo = e.local;
    if (lo + 30 > b.length || u32(lo) !== 0x04034b50) throw bad;
    var start = lo + 30 + u16(lo + 26) + u16(lo + 28), end = start + e.comp;
    if (end > b.length) throw bad;
    var raw = b.subarray(start, end);
    var tooBig = new SkOdtError('This document is too large to show here. Export it to open it elsewhere.');
    if (e.method === 0) {
      if (raw.length > limit || used + raw.length > SK_ODT.MAX_TOTAL) throw tooBig;
      used += raw.length;
      return raw;
    }
    if (e.method !== 8) throw bad;
    var reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    var parts = [], total = 0;
    for (;;) {
      var r;
      try { r = await reader.read(); } catch (err) { throw bad; }
      if (r.done) break;
      total += r.value.length;
      if (total > limit || used + total > SK_ODT.MAX_TOTAL) { try { reader.cancel(); } catch (_) {} throw tooBig; }
      parts.push(r.value);
    }
    used += total;
    var out = new Uint8Array(total), o = 0;
    for (var k = 0; k < parts.length; k++) { out.set(parts[k], o); o += parts[k].length; }
    return out;
  }
  return { entries: entries, read: read };
}

// A small XML reader: elements {n, a, c} and text strings. No DTDs, no
// external anything; unknown entities are left as they are.
function skOdtXml(s) {
  var bad = new SkOdtError('This document couldn\'t be opened. It may be damaged.');
  var root = { n: '#root', a: {}, c: [] }, stack = [root], i = 0, len = s.length, nodes = 0;
  function decode(t) {
    if (t.indexOf('&') < 0) return t;
    return t.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, function (m, g) {
      if (g === 'lt') return '<'; if (g === 'gt') return '>'; if (g === 'amp') return '&';
      if (g === 'quot') return '"'; if (g === 'apos') return "'";
      var cp = g.charAt(1) === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) ? String.fromCodePoint(cp) : '�';
    });
  }
  var attrRe = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  while (i < len) {
    var lt = s.indexOf('<', i);
    if (lt < 0) lt = len;
    if (lt > i) stack[stack.length - 1].c.push(decode(s.slice(i, lt)));
    if (lt >= len) break;
    if (s.startsWith('<!--', lt)) { var ce = s.indexOf('-->', lt + 4); if (ce < 0) throw bad; i = ce + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { var de = s.indexOf(']]>', lt + 9); if (de < 0) throw bad; stack[stack.length - 1].c.push(s.slice(lt + 9, de)); i = de + 3; continue; }
    if (s.startsWith('<?', lt)) { var pe = s.indexOf('?>', lt + 2); if (pe < 0) throw bad; i = pe + 2; continue; }
    if (s.startsWith('<!', lt)) throw bad;                    // no DOCTYPE in ODF
    var gt = lt + 1, q = '';
    for (; gt < len; gt++) {
      var ch = s.charAt(gt);
      if (q) { if (ch === q) q = ''; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '>') break;
    }
    if (gt >= len) throw bad;
    var tag = s.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.charAt(0) === '/') {
      var closing = tag.slice(1).trim(), top = stack.pop();
      if (!top || top.n !== closing || !stack.length) throw bad;
      continue;
    }
    var selfClose = tag.charAt(tag.length - 1) === '/';
    if (selfClose) tag = tag.slice(0, -1);
    var nm = /^[^\s]+/.exec(tag);
    if (!nm) throw bad;
    var attrs = {}, am;
    attrRe.lastIndex = nm[0].length;
    while ((am = attrRe.exec(tag))) attrs[am[1]] = decode(am[2] !== undefined ? am[2] : am[3]);
    var node = { n: nm[0], a: attrs, c: [] };
    stack[stack.length - 1].c.push(node);
    if (++nodes > SK_ODT.MAX_NODES) throw new SkOdtError('This document is too large to show here. Export it to open it elsewhere.');
    if (!selfClose) {
      stack.push(node);
      if (stack.length > SK_ODT.MAX_DEPTH) throw new SkOdtError('This document is nested too deeply to show here. Export it to open it elsewhere.');
    }
  }
  if (stack.length !== 1) throw bad;
  return root;
}

function skOdtFind(node, name) {
  for (var i = 0; i < node.c.length; i++) { var x = node.c[i]; if (typeof x !== 'string' && x.n === name) return x; }
  return null;
}

async function skShowOdt(data, root, el, status, fail) {
  var bytes = new Uint8Array(data);
  try {
    var zip = skOdtZip(bytes);
    var manifest = await zip.read('META-INF/manifest.xml', SK_ODT.MAX_XML);
    if (manifest && new TextDecoder('utf-8').decode(manifest).indexOf('encryption-data') >= 0) {
      throw new SkOdtError('This document is protected with a password. SafeKeep can\'t open it: export it and open it elsewhere.');
    }
    var contentBytes = await zip.read('content.xml', SK_ODT.MAX_XML);
    if (!contentBytes) throw new SkOdtError('This document couldn\'t be opened. It may be damaged.');
    var content = skOdtXml(new TextDecoder('utf-8').decode(contentBytes));
    var stylesBytes = await zip.read('styles.xml', SK_ODT.MAX_XML);
    var stylesDoc = stylesBytes ? skOdtXml(new TextDecoder('utf-8').decode(stylesBytes)) : null;
  } catch (e) {
    return fail(e instanceof SkOdtError ? e.text : 'This document couldn\'t be opened. It may be damaged.');
  }

  // ---- styles: bold, italic, underline, strike-through, alignment, lists ----
  var styles = {}, listStyles = {};
  function collect(container) {
    if (!container) return;
    container.c.forEach(function (x) {
      if (typeof x === 'string') return;
      if (x.n === 'style:style') {
        var st = { parent: x.a['style:parent-style-name'] || '', list: x.a['style:list-style-name'] || '' };
        x.c.forEach(function (p) {
          if (typeof p === 'string') return;
          if (p.n === 'style:text-properties') {
            var w = p.a['fo:font-weight'];
            if (w) st.bold = w === 'bold' || parseInt(w, 10) >= 600;
            var fs = p.a['fo:font-style'];
            if (fs) st.italic = fs === 'italic' || fs === 'oblique';
            var u = p.a['style:text-underline-style'];
            if (u) st.underline = u !== 'none';
            var lt = p.a['style:text-line-through-style'];
            if (lt) st.strike = lt !== 'none';
          }
          if (p.n === 'style:paragraph-properties') {
            var al = p.a['fo:text-align'];
            if (al) st.align = { center: 'center', end: 'right', right: 'right', justify: 'justify' }[al] || 'left';
          }
        });
        styles[(x.a['style:family'] || '') + ':' + (x.a['style:name'] || '')] = st;
      } else if (x.n === 'text:list-style') {
        var levels = {};
        x.c.forEach(function (lv) {
          if (typeof lv === 'string') return;
          var level = parseInt(lv.a['text:level'], 10) || 1;
          if (lv.n === 'text:list-level-style-number') levels[level] = 'number';
          else if (lv.n === 'text:list-level-style-bullet' || lv.n === 'text:list-level-style-image') levels[level] = 'bullet';
        });
        listStyles[x.a['style:name'] || ''] = levels;
      }
    });
  }
  function under(doc, path) {
    var n = doc;
    for (var i = 0; n && i < path.length; i++) n = skOdtFind(n, path[i]);
    return n;
  }
  if (stylesDoc) {
    collect(under(stylesDoc, ['office:document-styles', 'office:styles']));
    collect(under(stylesDoc, ['office:document-styles', 'office:automatic-styles']));
  }
  collect(under(content, ['office:document-content', 'office:automatic-styles']));
  function resolve(family, name) {
    var out = {}, seen = 0;
    while (name && seen++ < 20) {
      var st = styles[family + ':' + name];
      if (!st) break;
      ['bold', 'italic', 'underline', 'strike', 'align', 'list'].forEach(function (k) {
        if (out[k] === undefined && st[k] !== undefined && st[k] !== '') out[k] = st[k];
      });
      name = st.parent;
    }
    return out;
  }
  function applyText(e, st) {
    if (st.bold) e.style.fontWeight = '700';
    if (st.italic) e.style.fontStyle = 'italic';
    var deco = [];
    if (st.underline) deco.push('underline');
    if (st.strike) deco.push('line-through');
    if (deco.length) e.style.textDecoration = deco.join(' ');
  }

  // ---- building the reading view ----
  var page = el('div', 'odt');
  var notes = [];
  var images = 0, skippedImages = 0, pending = [];
  var SKIP = { 'office:annotation': 1, 'office:annotation-end': 1, 'text:tracked-changes': 1, 'text:sequence-decls': 1,
    'office:forms': 1, 'text:variable-decls': 1, 'text:user-field-decls': 1, 'svg:title': 1, 'svg:desc': 1,
    'text:bookmark': 1, 'text:bookmark-start': 1, 'text:bookmark-end': 1, 'text:soft-page-break': 1, 'office:scripts': 1 };

  function inline(nodes, out) {
    nodes.forEach(function (x) {
      if (typeof x === 'string') { out.appendChild(document.createTextNode(x.replace(/[ \t\r\n]+/g, ' '))); return; }
      if (SKIP[x.n]) return;
      switch (x.n) {
        case 'text:span': {
          var sp = el('span');
          applyText(sp, resolve('text', x.a['text:style-name']));
          inline(x.c, sp); out.appendChild(sp); return;
        }
        case 'text:a': {
          var a = el('span', 'link');
          var href = x.a['xlink:href'];
          if (href) a.title = href.slice(0, 500);
          inline(x.c, a); out.appendChild(a); return;
        }
        case 'text:line-break': out.appendChild(el('br')); return;
        case 'text:tab': out.appendChild(document.createTextNode(' ')); return;
        case 'text:s': {
          var c = Math.min(100, parseInt(x.a['text:c'], 10) || 1);
          out.appendChild(document.createTextNode(new Array(c + 1).join(' '))); return;
        }
        case 'text:note': {
          var cite = skOdtFind(x, 'text:note-citation');
          var label = cite ? cite.c.filter(function (t) { return typeof t === 'string'; }).join('') : String(notes.length + 1);
          out.appendChild(el('sup', 'noteref', label || String(notes.length + 1)));
          var body = skOdtFind(x, 'text:note-body');
          if (body) notes.push({ label: label, body: body });
          return;
        }
        case 'draw:frame': frame(x, out); return;
        default: inline(x.c, out);    // keep the text of anything else
      }
    });
  }

  function frame(x, out) {
    x.c.forEach(function (k) {
      if (typeof k === 'string') return;
      if (k.n === 'draw:image') return image(k, x, out);
      if (k.n === 'draw:text-box') { var box = el('span', 'textbox'); blocks(k.c, box, 0); out.appendChild(box); }
    });
  }

  function length(v) {
    var m = /^([0-9.]+)(in|cm|mm|pt|px)$/.exec(v || '');
    if (!m) return 0;
    var f = { in: 96, cm: 37.8, mm: 3.78, pt: 96 / 72, px: 1 }[m[2]];
    return Math.min(4000, Math.round(parseFloat(m[1]) * f));
  }

  function image(img, frameNode, out) {
    var href = img.a['xlink:href'] || '';
    var holder = el('span', 'imgwrap');
    out.appendChild(holder);
    if (!href || /^[a-z]+:/i.test(href) || images >= SK_ODT.MAX_IMAGES) { skippedImages++; holder.appendChild(el('span', 'noimg', '[image not shown]')); return; }
    images++;
    var w = length(frameNode.a['svg:width']);
    pending.push(zip.read(href.replace(/^\.\//, ''), SK_ODT.MAX_IMAGE).then(function (b) {
      var type = !b ? '' : (b[0] === 0x89 && b[1] === 0x50) ? 'image/png' : (b[0] === 0xff && b[1] === 0xd8) ? 'image/jpeg'
        : (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) ? 'image/gif'
        : (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) ? 'image/webp' : '';
      if (!type) { skippedImages++; holder.appendChild(el('span', 'noimg', '[image not shown]')); return; }
      var im = el('img');
      im.alt = '';
      if (w) im.style.width = w + 'px';
      im.src = URL.createObjectURL(new Blob([b], { type: type }));
      holder.appendChild(im);
    }).catch(function () { skippedImages++; holder.appendChild(el('span', 'noimg', '[image not shown]')); }));
  }

  function paragraph(x, out, tag) {
    var st = resolve('paragraph', x.a['text:style-name']);
    var p = el(tag);
    applyText(p, st);
    if (st.align) p.style.textAlign = st.align;
    inline(x.c, p);
    if (!p.textContent.trim() && !p.querySelector('img,br')) p.appendChild(el('br'));
    out.appendChild(p);
  }

  function list(x, out, depth, inherited) {
    var styleName = x.a['text:style-name'] || inherited || '';
    var level = depth + 1;
    var kinds = listStyles[styleName] || {};
    var numbered = kinds[level] === 'number';
    if (!x.a['text:style-name'] && !inherited) {
      // No list style here: a paragraph style inside may name one.
      var firstItem = skOdtFind(x, 'text:list-item'), firstP = firstItem && skOdtFind(firstItem, 'text:p');
      var viaPara = firstP && resolve('paragraph', firstP.a['text:style-name']).list;
      if (viaPara) { styleName = viaPara; numbered = (listStyles[viaPara] || {})[level] === 'number'; }
    }
    var l = el(numbered ? 'ol' : 'ul');
    x.c.forEach(function (it) {
      if (typeof it === 'string' || (it.n !== 'text:list-item' && it.n !== 'text:list-header')) return;
      var li = el('li');
      if (it.n === 'text:list-header') li.style.listStyleType = 'none';
      it.c.forEach(function (k) {
        if (typeof k === 'string') return;
        if (k.n === 'text:list') list(k, li, depth + 1, styleName);
        else blocks([k], li, depth);
      });
      l.appendChild(li);
    });
    out.appendChild(l);
  }

  function table(x, out) {
    var t = el('table');
    function rows(container) {
      container.c.forEach(function (r) {
        if (typeof r === 'string') return;
        if (r.n === 'table:table-header-rows' || r.n === 'table:table-rows' || r.n === 'table:table-row-group') return rows(r);
        if (r.n !== 'table:table-row') return;
        var times = Math.min(50, parseInt(r.a['table:number-rows-repeated'], 10) || 1);
        for (var k = 0; k < times; k++) {
          var tr = el('tr');
          r.c.forEach(function (cell) {
            if (typeof cell === 'string' || cell.n !== 'table:table-cell') return;
            var reps = Math.min(50, parseInt(cell.a['table:number-columns-repeated'], 10) || 1);
            for (var j = 0; j < reps; j++) {
              var td = el('td');
              var cs = Math.min(1000, parseInt(cell.a['table:number-columns-spanned'], 10) || 1);
              var rs = Math.min(1000, parseInt(cell.a['table:number-rows-spanned'], 10) || 1);
              if (cs > 1) td.colSpan = cs;
              if (rs > 1) td.rowSpan = rs;
              blocks(cell.c, td, 0);
              tr.appendChild(td);
            }
          });
          t.appendChild(tr);
        }
      });
    }
    rows(x);
    var wrap = el('div', 'tablewrap');
    wrap.appendChild(t);
    out.appendChild(wrap);
  }

  function blocks(nodes, out, depth) {
    nodes.forEach(function (x) {
      if (typeof x === 'string' || SKIP[x.n]) return;
      switch (x.n) {
        case 'text:h': {
          var lvl = Math.max(1, Math.min(6, parseInt(x.a['text:outline-level'], 10) || 1));
          paragraph(x, out, 'h' + lvl); return;
        }
        case 'text:p': paragraph(x, out, 'p'); return;
        case 'text:list': list(x, out, 0, ''); return;
        case 'table:table': table(x, out); return;
        case 'draw:frame': { var p = el('p'); frame(x, p); out.appendChild(p); return; }
        default: blocks(x.c, out, depth);     // sections, indexes, and the like
      }
    });
  }

  var body = under(content, ['office:document-content', 'office:body', 'office:text']);
  if (!body) return fail('This file isn\'t an OpenDocument text document SafeKeep can show.');
  blocks(body.c, page, 0);
  if (notes.length) {
    var nb = el('div', 'notes');
    nb.appendChild(el('div', 'noteshead', 'Notes'));
    notes.forEach(function (n) {
      var row = el('div', 'note-row');
      row.appendChild(el('sup', 'noteref', n.label));
      blocks(n.body.c, row, 0);
      nb.appendChild(row);
    });
    page.appendChild(nb);
  }
  var view = el('div', 'odtview');
  view.appendChild(page);
  root.textContent = '';
  root.appendChild(view);
  await Promise.all(pending);
  status('OpenDocument text' + (skippedImages ? ' (' + skippedImages + ' image' + (skippedImages > 1 ? 's' : '') + ' not shown)' : ''));
}
`;

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
      if (m.kind === 'odt') return skShowOdt(m.data, root, el, status, fail);
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
.odtview { flex: 1; overflow: auto; padding: 16px; background: #525659; }
.odt { background: #fff; color: #111; max-width: 52rem; margin: 0 auto; padding: 2.5rem 3rem; box-shadow: 0 1px 6px rgba(0,0,0,.4);
  font: 15px/1.55 "Liberation Serif", Georgia, serif; overflow-wrap: anywhere; }
.odt h1, .odt h2, .odt h3, .odt h4, .odt h5, .odt h6 { font-family: system-ui, sans-serif; line-height: 1.25; margin: 1.2em 0 0.4em; }
.odt p { margin: 0 0 0.6em; white-space: pre-wrap; }
.odt h1 { white-space: pre-wrap; } .odt h2 { white-space: pre-wrap; }
.odt ul, .odt ol { margin: 0 0 0.6em; padding-left: 1.8em; }
.odt li > p { margin: 0 0 0.2em; }
.odt .tablewrap { overflow-x: auto; margin: 0 0 0.8em; }
.odt table { border-collapse: collapse; }
.odt td { border: 1px solid #999; padding: 0.3em 0.5em; vertical-align: top; }
.odt td > p:last-child { margin-bottom: 0; }
.odt .link { color: #1a56c9; text-decoration: underline; }
.odt img { max-width: 100%; height: auto; vertical-align: middle; }
.odt .noimg { color: #777; font-style: italic; }
.odt .textbox { display: inline-block; border: 1px dashed #bbb; padding: 0.3em; }
.odt .noteref { font-size: 0.75em; }
.odt .notes { border-top: 1px solid #bbb; margin-top: 2em; padding-top: 0.6em; font-size: 0.9em; }
.odt .noteshead { font-weight: 700; margin-bottom: 0.4em; font-family: system-ui, sans-serif; }
.odt .note-row { display: flex; gap: 0.4em; } .odt .note-row > p { margin: 0 0 0.3em; }
`;

export const FRAME_HTML = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + FRAME_CSP + '">' +
    '<style>' + FRAME_STYLE + '</style></head><body><div id="root"><div class="msg">Opening…</div></div>' +
    '<script>' + ODT_SCRIPT + '</' + 'script><script>' + FRAME_SCRIPT + '</' + 'script></body></html>';

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

/**
 * test-qr-draw.mjs — Draw my SeedQR (shared/qr-draw.js + boot.html sqrd_*)
 *
 *   1. Template sizes match the blank templates on safekeepbitcoin.com
 *      (measured from their PDFs: 85.68 mm for 21×21, 87.88 mm for 25×25),
 *      and a bank card is 85.60 × 53.98 mm.
 *   2. Blocks cover every square exactly once, in reading order.
 *   3. Row lists use the template's 1-based numbers and join runs.
 *   4. A real SeedQR grid (made with the same QR library as the app) gives
 *      the finder pattern's well-known rows in block 1.
 *   5. Wiring: the SeedQR tool keeps the module grid, the two buttons, the
 *      overlay closes and clears its canvases, Scan to Verify is the end,
 *      leaving the tool closes it, and the app's Escape shortcut leaves an
 *      open overlay (picker, Draw my SeedQR, COLDCARD import) alone and
 *      goes home through sidebar_goHome.
 *
 * Run:  node test-qr-draw.mjs
 */
import { templateGridMm, blocksFor, rowRuns, countDark, CARD_WIDTH_MM, CARD_HEIGHT_MM } from './shared/qr-draw.js';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };

console.log('\n1. Sizes');
ck('21×21 template grid is 85.68 mm, 25×25 is 87.88 mm', templateGridMm(21) === 85.68 && templateGridMm(25) === 87.88);
ck('29×29 (no template) uses 3 mm squares', templateGridMm(29) === 87);
ck('bank card 85.60 × 53.98 mm (ISO/IEC 7810 ID-1)', CARD_WIDTH_MM === 85.6 && CARD_HEIGHT_MM === 53.98);

console.log('\n2. Blocks');
for (const [n, count] of [[21, 9], [25, 16], [29, 25]]) {
    const bl = blocksFor(n, 7);
    const seen = new Set();
    let dup = false;
    for (const b of bl) for (let r = b.row0; r < b.row0 + b.rows; r++) for (let c = b.col0; c < b.col0 + b.cols; c++) { const k = r + ',' + c; if (seen.has(k)) dup = true; seen.add(k); }
    ck(`${n}×${n}: ${count} blocks cover all ${n * n} squares once`, bl.length === count && seen.size === n * n && !dup);
    ck(`  reading order, last block ends at the corner`, bl.every((b, i) => b.index === i) && bl[bl.length - 1].row0 + bl[bl.length - 1].rows === n && bl[bl.length - 1].col0 + bl[bl.length - 1].cols === n);
}
ck('bad sizes are refused', (() => { try { blocksFor(0); return false; } catch { return true; } })());

console.log('\n3. Row lists');
const g = [[true, true, true, false, true, false, true, true]];
ck('runs joined, 1-based: 1–3, 5, 7–8', rowRuns(g, 0) === '1–3, 5, 7–8');
ck('a column range uses the template\'s numbers', rowRuns(g, 0, 4, 8) === '5, 7–8');
ck('an empty range gives ""', rowRuns([[false, false]], 0) === '');
ck('a run ending at the range end is closed', rowRuns([[false, true, true]], 0, 0, 3) === '2–3');
ck('countDark', countDark([[true, false], [true, true]]) === 3);

console.log('\n4. A real SeedQR');
{
    // 12-word Compact SeedQR: 16 bytes, version 1, error correction L.
    const qr = QRCode.create([{ data: new Uint8Array(16).fill(7), mode: 'byte' }], { errorCorrectionLevel: 'L', version: 1 });
    const n = qr.modules.size;
    const m = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => !!qr.modules.get(r, c)));
    ck('21×21', n === 21);
    const b1 = [0, 1, 2, 3, 4, 5, 6].map((r) => rowRuns(m, r, 0, 7));
    ck('block 1 is the finder pattern: 1–7 / 1, 7 / 1, 3–5, 7 ×3 / 1, 7 / 1–7', JSON.stringify(b1) === JSON.stringify(['1–7', '1, 7', '1, 3–5, 7', '1, 3–5, 7', '1, 3–5, 7', '1, 7', '1–7']), JSON.stringify(b1));
    ck('top-right finder is columns 15–21', rowRuns(m, 0, 14, 21) === '15–21');
}

console.log('\n5. Wiring');
const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
const entry = readFileSync(new URL('./boot-entry.js', import.meta.url), 'utf8');
const fn = (name) => { const a = html.indexOf(name); if (a < 0) return ''; const n = [html.indexOf('\nfunction ', a + 10), html.indexOf('\nasync function ', a + 10), html.indexOf('\n// ', a + 10)].filter((i) => i > 0); return html.slice(a, Math.min(...n)); };
ck('boot-entry.js loads the module', entry.includes("import './shared/qr-draw.js'"));
ck('sqr_generate keeps the module grid', fn('async function sqr_generate').includes('sqr_state.modules = modules'));
ck('two buttons: Trace It on the Screen, Copy It Square by Square', html.includes(`onclick="sqrd_open('lightbox')">Trace It on the Screen`) && html.includes(`onclick="sqrd_open('blocks')">Copy It Square by Square`));
ck('the light box sizes the code from the template width and the screen scale', fn('function _sqrdRender').includes('QD.templateGridMm(n)') && fn('function _sqrdRender').includes('(gridMm * ppm) / n'));
ck('the bank card outline uses the card\'s real size', fn('function _sqrdRender').includes('QD.CARD_WIDTH_MM * ppm') && fn('function _sqrdRender').includes('QD.CARD_HEIGHT_MM * ppm'));
ck('closing clears the drawn code', fn('function sqrd_close').includes('c.width = 1; c.height = 1;') && fn('function sqrd_close').includes('ov.remove()'));
ck('the last block\'s button is Scan to Verify, which opens the Verify tab and the camera', fn('function _sqrdRender').includes("last ? 'Scan to Verify'") && fn('function sqrd_verify').includes("sqr_switchTab('verify')") && fn('function sqrd_verify').includes('sqr_startVerify()'));
ck('leaving the SeedQR tool closes it', fn('function sqr_cleanup').includes('sqrd_close()'));
const esc = html.slice(html.indexOf("document.addEventListener('keydown', function(evt) {\n    if (evt.key !== 'Escape') return;"), html.indexOf('}, true);  // useCapture: true — fires BEFORE tool-local Escape handlers'));
ck('the Escape shortcut leaves open overlays alone', esc.includes("document.querySelector('#skfp-overlay, #sqrd-overlay, #ccb-import-overlay')"));
ck('…and goes home through sidebar_goHome (welcome when no seed)', esc.includes('sidebar_goHome();'));
for (const name of ['function _sqrdPxPerMm', 'function sqrd_open', 'function sqrd_close', 'function _sqrdKey', 'function sqrd_setScale', 'function sqrd_toggleCard', 'function _sqrdDrawGrid', 'function _sqrdRender', 'function sqrd_step', 'function sqrd_verify']) {
    let ok = true, err = '';
    try { new Function(fn(name).replace(/^function/, 'return function')); } catch (e) { ok = false; err = e.message; }
    ck(`${name.replace(/^function /, '')} parses`, ok, err);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

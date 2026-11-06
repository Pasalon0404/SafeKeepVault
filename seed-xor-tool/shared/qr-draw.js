/**
 * qr-draw.js — helpers for copying a SeedQR by hand (SeedQR tool → Draw my SeedQR)
 *
 * The SeedQR tool draws its code from a grid of modules (true = dark). To
 * copy it onto a blank template without a printer, SafeKeep offers:
 *   - a light box: the code full-screen at the template's real size, so the
 *     printed template laid on the screen shows the squares to fill in;
 *   - square by square: one block at a time, with the template's numbering
 *     (1 at the top left, rows down, columns across) and a list of the
 *     dark squares in each row of the block.
 *
 * Sizes are those of the blank templates on safekeepbitcoin.com (Print QR),
 * measured from their PDFs (US Letter, printed at 100%): the grid is
 * 85.68 mm wide for 21×21 and 87.88 mm for 25×25. A bank card (ISO/IEC
 * 7810 ID-1) is 85.60 mm wide, which the light box uses to learn the
 * screen's scale. There is no 29×29 template, so 29×29 uses 3.0 mm squares.
 */

export const CARD_WIDTH_MM = 85.6;
export const CARD_HEIGHT_MM = 53.98;
const TEMPLATE_GRID_MM = Object.freeze({ 21: 85.68, 25: 87.88 });

/** Width of the template's grid in millimetres for a code of this size. */
export function templateGridMm(gridSize) {
    return TEMPLATE_GRID_MM[gridSize] || gridSize * 3.0;
}

/**
 * The blocks to copy, in reading order: rows of blocks top to bottom, left
 * to right. Each is { index, row0, col0, rows, cols } with 0-based row0 /
 * col0; the last row and column of blocks can be smaller.
 */
export function blocksFor(gridSize, blockSize = 7) {
    if (!(gridSize > 0) || !(blockSize > 0)) throw new Error('bad grid');
    const out = [];
    for (let r = 0; r < gridSize; r += blockSize) {
        for (let c = 0; c < gridSize; c += blockSize) {
            out.push({ index: out.length, row0: r, col0: c, rows: Math.min(blockSize, gridSize - r), cols: Math.min(blockSize, gridSize - c) });
        }
    }
    return out;
}

/**
 * The dark squares in one row between two columns, as the template numbers
 * them (1-based), with runs joined: [1,2,3,5,7,8] → "1–3, 5, 7–8".
 * `modules` is an array of rows of booleans. Returns '' for none.
 */
export function rowRuns(modules, row, col0 = 0, col1 = null) {
    const line = modules[row] || [];
    const end = col1 == null ? line.length : col1;
    const parts = [];
    let start = -1;
    for (let c = col0; c <= end; c++) {
        const dark = c < end && !!line[c];
        if (dark && start < 0) start = c;
        if (!dark && start >= 0) {
            const a = start + 1, b = c;   // 1-based, inclusive
            parts.push(a === b ? String(a) : a + '–' + b);
            start = -1;
        }
    }
    return parts.join(', ');
}

/** How many dark squares a grid has (for the progress line). */
export function countDark(modules) {
    return modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
}

if (typeof window !== 'undefined') {
    window.QrDraw = Object.freeze({ CARD_WIDTH_MM, CARD_HEIGHT_MM, templateGridMm, blocksFor, rowRuns, countDark });
}

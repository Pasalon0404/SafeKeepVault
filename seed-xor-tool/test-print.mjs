/**
 * test-print.mjs — Print my SeedQR (SeedQR tool → Print It on a USB Printer)
 *
 * The helper itself (PCL page, USB, the Print Watcher run for real) is
 * tested by usbbootdrive/tests/test-print-helper.py. This checks the
 * wiring around it:
 *   1. The printer ban stays: CUPS and Ghostscript are still purged and the
 *      kernel's printer drivers still banned; the helper goes through libusb.
 *   2. OS wiring: the Print Watcher, install lines, the note router, the
 *      Settings Watcher key.
 *   3. The bridge: printDetect / printSeedQR, request through the download
 *      folder, result from RAM, ack.
 *   4. The app: the third choice, the panel, safety notes, the fingerprint,
 *      the saved settings.
 *
 * Run:  node test-print.mjs
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const OS = new URL('../usbbootdrive/', import.meta.url);
const read = (u) => readFileSync(u, 'utf8');
const html = read(new URL('./boot.html', import.meta.url));
const bridge = read(new URL('./shared/boot.js', import.meta.url));
const boot = read(new URL('safekeep-boot.sh', OS));
const harden = read(new URL('safekeep-harden.sh', OS));
const helper = read(new URL('safekeep-print.py', OS));
const fn = (name) => { const a = html.indexOf(name); return a < 0 ? '' : html.slice(a, html.indexOf('\n}\n', a)); };

console.log('\n1. The printer ban stays');
ck('CUPS, its filters and Ghostscript are still purged', /apt-get purge -y cups cups-browsed[\s\S]*ghostscript/.test(harden));
ck('usblp, lp, ppdev and parport are still banned', ['blacklist usblp', 'install usblp /bin/false', 'install lp /bin/false', 'install parport /bin/false'].every((l) => harden.includes(l)));
ck('the helper uses libusb only, never a network socket or a spooler', /import usb1/.test(helper) && !/\bsocket\b|urllib|http|subprocess|os\.system|\/dev\/usb\/lp/.test(helper));
ck('…and opens only a USB printer-class interface (7/1, protocol 1 or 2)', helper.includes('setting.getClass() != 7 or setting.getSubClass() != 1 or setting.getProtocol() not in (1, 2)'));
ck('…and sends no job name', helper.includes("b'\\x1b%-12345X@PJL ENTER LANGUAGE=PCL\\r\\n'") && !/JOB NAME|@PJL JOB/.test(helper));

console.log('\n2. OS wiring');
const w = boot.slice(boot.indexOf('# PRINT WATCHER'), boot.indexOf('PRINT_WATCHER_PID=$!'));
ck('the Print Watcher runs the helper with the HWI Python (libusb1)', w.includes('PRINT_PY="/opt/safekeep-hwi/bin/python3"') && w.includes('PRINT_HELPER="/usr/local/lib/safekeep/safekeep-print.py"'));
ck('…request from the download folder, result in RAM, ack', w.includes('PRINT_REQUEST="$CHROMIUM_DOWNLOAD_DIR/PRINT_REQUEST.json"') && w.includes('PRINT_RESULT="$SIGNAL_DIR/PRINT_RESULT.json"') && w.includes('PRINT_ACK*.json'));
ck('…and deletes the request', w.includes('rm -f "$PRINT_REQUEST"'));
ck('the note router skips PRINT_ files', boot.includes('BRIGHTNESS_*|PRINT_*|'));
ck('the Settings Watcher keeps safekeepSeedQrPrint', /ALLOWED = \([^)]*'safekeepSeedQrPrint'/.test(boot));
for (const f of ['build.sh', 'quick-update.sh']) {
    ck(`${f} installs safekeep-print.py`, read(new URL(f, OS)).includes('install -m 755 safekeep-print.py "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-print.py"'));
}
ck('quick-update.sh doesn\'t need harden or chroot changes for this', !harden.includes('safekeep-print'));

console.log('\n3. The bridge');
ck('PRINT_REQUEST / PRINT_ACK are OS protocol files', bridge.includes("'PRINT_REQUEST', 'PRINT_ACK',"));
ck('printDetect and printSeedQR are exported', /printDetect,\s*printSeedQR,/.test(bridge));
ck('the result is read from RAM (/tmp/safekeep-signals)', bridge.includes('const PRINT_RESULT_URL   = `file://${COLDCARD_SIGNAL_DIR}/PRINT_RESULT.json`;'));
ck('the request copy is dropped once sent, and a stale result is ignored', bridge.includes('payload = null;   // holds the SeedQR') && bridge.includes('result.request_id === requestId'));
ck('printSeedQR sends rows of 0/1, size, fingerprint, cutting line and its space (the code alone, no style)', bridge.includes("action: 'print', modules: rows, size_mm: Number(sizeMm), fingerprint: fingerprint || ''") && bridge.includes('cut_box: !!cutBox, box_margin_mm: Number(boxMarginMm) || 3'));

console.log('\n4. The app');
ck('the SeedQR tool offers Print It on a USB Printer as a third choice', html.includes(`onclick="sqrd_open('print')">Print It on a USB Printer</button>`) && html.includes('.sqrd-choices { display: grid; grid-template-columns: repeat(3, 1fr);'));
ck('the panel: printer status with Check Again, size 10–150 mm, Template size, fingerprint', ['id="sqrp-printer"', 'onclick="sqrp_check()">Check Again', 'id="sqrp-size" min="10" max="150"', 'id="sqrp-template-size"', 'id="sqrp-fp"'].every((t) => html.includes(t)));
ck('no template style: no style choice, no grid or numbers in the preview', !html.includes('sqrp-style') && !html.includes('sqrp_state.style') && !fn('function _sqrpRender').includes('labelPt'));
ck('safety notes: USB only, network off, take the page, switch the printer off', ['SafeKeep never prints over a network.', 'turn that off or unplug it first.', 'Stay with the printer and take the page.', 'switch the printer off: it keeps the page in its memory until then.'].every((t) => html.includes(t)));
ck('Print is enabled only with exactly one printer found', fn('function _sqrpRender').includes("document.getElementById('sqrp-print').disabled = sqrp_state.busy || !one;"));
ck('a printer that doesn\'t list PCL gets a calm note, not a warning (the M2070 doesn\'t list it but prints fine)', fn('async function sqrp_check').includes("else if (p[0].pcl === false) _sqrpPrinter('✓ ' + p[0].name + '. It doesn’t say it speaks PCL") && fn('async function sqrp_check').includes("If the page comes out garbled, this printer can’t be used.', 'ok');"));
ck('the fingerprint is the seed\'s (no passphrase), worked out when the SeedQR is made', fn('async function sqr_generate').includes("sqr_state.fingerprint = await _recoveryFingerprint(words.join(' '));"));
ck('after printing: switch the printer off, then Scan to Verify', fn('async function sqrp_print').includes('switch the printer off to clear its memory, then check the printout with Scan to Verify.') && fn('async function sqrp_print').includes("getElementById('sqrp-verify').hidden = false"));
ck('the last print settings are a Device Options key (saved in the vault)', html.includes("var SQRP_KEY = 'safekeepSeedQrPrint';") && /var _skbDsKeys = \[[^\]]*'safekeepSeedQrPrint'/.test(html) && /_RLQ_APP_SETTINGS_KEYS = \[[\s\S]*?'safekeepSeedQrPrint'/.test(html));
ck('…holding only the size, the fingerprint and cutting-line choices', fn('async function sqrp_print').includes('JSON.stringify({ size: sqrp_state.size, fingerprint: sqrp_state.fingerprint, cutBox: sqrp_state.cutBox, boxMargin: sqrp_state.boxMargin })'));
ck('the cutting line: a checkbox, and a slider for the space inside it (0.5–30 mm, 3 mm to start)', html.includes('<input type="checkbox" id="sqrp-box" onchange="sqrp_set({ cutBox: this.checked })"> Print a square line around it to cut along') && html.includes('id="sqrp-box-margin" min="0.5" max="30" step="0.5"') && html.includes('boxMargin: 3,') && fn('async function sqrp_print').includes('boxMarginMm: sqrp_state.boxMargin'));
ck('…a close-up of the square to cut out, and a note when the space is under two squares', html.includes('<canvas id="sqrp-closeup"') && fn('function _sqrpRender').includes('var thin = L.box.margin < 2 * L.cell;'));
ck('…the preview uses the helper\'s layout: chosen space, fingerprint at most 3 mm under the code, shrink to fit 190 mm', fn('function _sqrpLayout').includes('Math.min(margin, 3)') && fn('function _sqrpLayout').includes('while (sq > 190 && margin > 0.5)') && helper.includes('gap = min(margin, mm(3)) if cut_box else mm(5)') && helper.includes('BOX_MAX_MM = 190.0') && helper.includes('BOX_MARGIN_DEFAULT_MM = 3.0'));
ck('the preview mirrors the helper (105 mm centre, 30 mm down)', fn('function _sqrpLayout').includes('x0: 105 - size / 2, y0: 30') && helper.includes('PAGE_CENTRE_X_MM = 105.0') && helper.includes('TOP_MM = 30.0'));
ck('the helper has no template style either', !/field_style|grid_line|label_pt/.test(helper));
ck('the vault notice: shown when the vault doesn\'t keep the seed or this isn\'t the vault\'s seed, never in a Temporary Session', fn('function _sqrpVaultNotice').includes("if (typeof _isEphemeralBoot === 'function' && _isEphemeralBoot()) return '';") && fn('function _sqrpVaultNotice').includes("'This vault is set not to keep the seed. '") && fn('function _sqrpVaultNotice').includes('!sqr_state.isVaultSeed') && fn('function _sqrpVaultNotice').includes('print from a Temporary Session instead.') && fn('function _sqrpRender').includes('vaultNote.hidden = !vaultText;'));
ck('…"the vault\'s seed" means the session seed, and not a temporary one', fn('async function sqr_generate').includes('_vaultVolatile') && fn('async function sqr_generate').includes('norm(sess.mnemonic) === norm(words.join'));
ck('the dev build has a pretend printer', html.includes("printers: window._devNoPrinter ? [] : [{ name: 'Samsung M2070 Series (mock)', pcl: true }]"));
for (const name of ['function _sqrpLayout', 'function _sqrpDraw', 'function _sqrpVaultNotice', 'function sqrp_init', 'function sqrp_set', 'async function sqrp_check', 'async function sqrp_print', 'function _sqrpRender']) {
    let ok = true, err = '';
    try { new Function(fn(name).replace(/^async function/, 'return async function').replace(/^function/, 'return function') + '\n}'); } catch (e) { ok = false; err = e.message; }
    ck(`${name.replace(/^(async )?function /, '')} parses`, ok, err);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

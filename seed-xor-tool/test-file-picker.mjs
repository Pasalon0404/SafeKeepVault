/**
 * test-file-picker.mjs — SafeKeep's own file picker (skfp_* in boot.html)
 *
 * On the flash drive the system file dialog would offer Home, Other
 * Locations and every mounted drive. SafeKeep catches every file input and
 * shows only the Transfer Drive instead. This checks the wiring; the
 * behaviour was checked in the dev build on all four screens (COLDCARD
 * backup, PSBT Signer, Output Descriptor Import, Transfer files): the
 * system dialog never opened, each showed only its file types, a chosen
 * file reached the screen's own handler, and a file named like HTML stayed
 * plain text.
 *
 * Run:  node test-file-picker.mjs
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
const fn = (name) => { const a = html.indexOf(name); if (a < 0) return ''; const n = [html.indexOf('\nfunction ', a + 10), html.indexOf('\nasync function ', a + 10), html.indexOf('\n// Catch every', a + 10)].filter((i) => i > 0); return html.slice(a, Math.min(...n)); };

console.log('\n1. Every file input is caught on the flash drive');
const catcher = html.slice(html.indexOf('// Catch every file input before the system dialog opens.'), html.indexOf('// ---- Restore from a COLDCARD backup (ccb_*) ----'));
ck('one capturing click listener for all file inputs', /document\.addEventListener\('click', function \(e\) \{[\s\S]*t\.type !== 'file'[\s\S]*e\.preventDefault\(\);[\s\S]*skfp_chooseFor\(t\);[\s\S]*\}, true\);/.test(catcher));
ck('in-app only from the flash drive (file://) or the dev server\'s Transfer Drive', fn('function skfp_inApp').includes("window.location.protocol === 'file:'") && fn('function skfp_inApp').includes('_mockLabel'));
const inputs = [...html.matchAll(/<input type="file"[^>]*>/g)].map((m) => m[0]);
ck('the four file inputs are known', inputs.length === 4, inputs.length);
ck('each has a picker title', inputs.every((i) => /data-skfp-title="[^"]+"/.test(i)), inputs.filter((i) => !/data-skfp-title/.test(i)).join(' | '));
for (const id of ['ccb-file-input', 'psbt-file-input', 'desc-verify-file-input', 'xfr-file-input']) ck(`  ${id} is one of them`, inputs.some((i) => i.includes(`id="${id}"`)));

console.log('\n2. The picker');
const list = fn('async function _skfpList');
ck('lists the Transfer Drive only (no other folder can be reached)', list.includes('window.vaultTransferDriveHandle') && !/showOpenFilePicker|showDirectoryPicker|\.click\(\)/.test(fn('function skfp_open') + list + fn('async function _skfpRender')));
ck('filters by the input\'s accept extensions, skips dot files', list.includes('lower.endsWith(x)') && list.includes("entry.name.charAt(0) === '.'"));
ck('newest first', list.includes('(b.lastModified || 0) - (a.lastModified || 0)'));
const render = fn('async function _skfpRender');
ck('file names are drawn as text, never markup', render.includes('n.textContent = f.name') && !/innerHTML\s*=\s*[^;]*f\.name/.test(render));
ck('says what to do when nothing matches, and when the drive is missing', render.includes('then press Refresh') && render.includes('Transfer Drive isn’t available'));
ck('Escape and Cancel close it without a file', fn('function _skfpKey').includes("e.key === 'Escape'") && fn('function skfp_open').includes("getElementById('skfp-cancel').onclick = function () { skfp_close(null); }"));
const choose = fn('async function skfp_chooseFor');
ck('the chosen file is handed to the input with a change event (screens keep their handlers)', choose.includes('new DataTransfer()') && choose.includes('input.files = dt.files') && choose.includes("new Event('change', { bubbles: true })"));
const exts = new Function(fn('function _skfpExts').replace(/^function _skfpExts/, 'return function'))();
ck('accept → extensions (MIME types ignored)', JSON.stringify(exts('.7z,.TXT, text/plain,application/json,.json')) === '[".7z",".txt",".json"]');

console.log('\n3. Screens');
ck('PSBT Signer\'s Load from Transfer Drive opens the same picker (its separate list is gone)', fn('async function psbtLoadFromTransfer').includes("getElementById('psbt-file-input').click()") && !html.includes('_psbtShowDrivePicker'));
ck('Transfer screen\'s drive list escapes file names', html.includes("'<span>' + _wrecEscape(files[i].name) + '</span>'"));
for (const name of ['function skfp_inApp', 'function _skfpExts', 'function _skfpFmtSize', 'async function _skfpList', 'function skfp_close', 'function _skfpKey', 'function skfp_open', 'async function _skfpRender', 'async function skfp_chooseFor', 'async function psbtLoadFromTransfer']) {
    let ok = true, err = '';
    try { new Function(fn(name).replace(/^async function/, 'return async function').replace(/^function/, 'return function')); } catch (e) { ok = false; err = e.message; }
    ck(`${name.replace(/^(async )?function /, '')} parses`, ok, err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

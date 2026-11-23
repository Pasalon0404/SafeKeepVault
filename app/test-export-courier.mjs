import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
/**
 * test-export-courier.mjs — after Seed Management saves an export (Download
 * JSON), it offers "Send with the Courier", as the Backup screen does after
 * Export Backup. The Courier gets the text just written (no read-back).
 * Run: node test-export-courier.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, 'boot.html'), 'utf8');
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };
const fn = (name) => { const i = HTML.search(new RegExp('\\n(async )?function ' + name + '\\s*\\(')); return HTML.slice(i, HTML.indexOf('\n}\n', i) + 2); };
const save = fn('_armSaveExportToTransfer');
ck('offered after a save by the OS (flash drive)', /'Exported ' \+ filename[\s\S]{0,120}_armOfferCourier\(filename, text\)/.test(save));
ck('offered after a save to the mounted Transfer Drive, under the name actually written', /_armOfferCourier\(writeName, text\)/.test(save));
ck('a failed or canceled save offers nothing', !/_armOfferCourier[^;]*;\s*return false/.test(save));
ck('changing the key format or wallet hides the offer', /arm_dismissCourierOffer\(\)/.test(fn('arm_onConfigChange')));
ck('the offer box sits under the export buttons', /id="arm-download-export-btn"[\s\S]{0,400}id="arm-courier-offer"/.test(HTML));

const box = { hidden: true, innerHTML: '' };
let opened = null;
const ctx = vm.createContext({ document: { getElementById: (id) => id === 'arm-courier-offer' ? box : null }, File: class { constructor(parts, name, opts) { this.text = parts.join(''); this.name = name; this.type = opts.type; } },
  _xfrOpenWithFile: (f, auto) => { opened = { f, auto }; }, _psbtEscape: (s) => String(s).replace(/</g, '&lt;'), String });
vm.runInContext('var _armLastExport = null;\n' + fn('_armOfferCourier') + fn('arm_sendExportWithCourier') + fn('arm_dismissCourierOffer'), ctx);
ctx._armOfferCourier('5436D724-BIP84-<x>.json', '{"xpub":"abc"}');
ck('the offer shows the file name (escaped) and both buttons', !box.hidden && /5436D724-BIP84-&lt;x>\.json/.test(box.innerHTML) && /Send with the Courier/.test(box.innerHTML) && /Not now/.test(box.innerHTML), box.innerHTML);
ctx.arm_sendExportWithCourier();
ck('Send opens the Courier with that file and starts it', opened && opened.auto === true && opened.f.name === '5436D724-BIP84-<x>.json' && opened.f.text === '{"xpub":"abc"}' && opened.f.type === 'application/json');
ck('the offer closes once sent', box.hidden && box.innerHTML === '');
console.log(`test-export-courier: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

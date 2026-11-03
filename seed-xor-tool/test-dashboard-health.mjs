import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
/**
 * test-dashboard-health.mjs — the Dashboard's Health list was blank at
 * start-up (v1.58): it was drawn only by showState('state-dashboard'), and
 * start-up, unlock and restore reach the Dashboard through
 * transitionToDashboard() instead. Also: Health follows the Transfer Drive
 * line, which is filled in after start-up.
 * Run: node test-dashboard-health.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, 'boot.html'), 'utf8');
let pass = 0, fail = 0; const ck = (n, c) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n); };
const fn = (name) => { const i = HTML.search(new RegExp('\\nfunction ' + name + '\\s*\\(')); return HTML.slice(i, HTML.indexOf('\n}\n', i)); };
ck('transitionToDashboard draws the Dashboard (wallet card + Health)', /dashv2_render\(\)/.test(fn('transitionToDashboard')));
ck('showState still draws it when navigating back', /dashv2_render\(\)/.test(HTML.slice(HTML.indexOf('function showState('), HTML.indexOf('function showState(') + 20000)));
ck('Health redraws when the Transfer Drive line changes', /\['status-transfer-label', 'dash-version'\]\.forEach[\s\S]{0,200}moH\.observe/.test(HTML));
ck('the redraw only runs while the Dashboard is on screen', /dash\.style\.display !== 'none' && typeof dashv2_renderHealth === 'function'/.test(HTML));
console.log(`test-dashboard-health: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

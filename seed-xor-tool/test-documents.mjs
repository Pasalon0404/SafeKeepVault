/**
 * test-documents.mjs — Documents in the vault (DOCUMENTS_DESIGN.md), in the BUILT app
 *
 * Opens dist/boot.html in Chromium and uses the Documents tab the way the
 * kiosk does, with the OS side played by the real pieces:
 *   - the app's downloads are saved into a temporary vault's seeds/, as the
 *     kiosk's Chromium download policy does;
 *   - the real usbbootdrive/safekeep-documents.py runs in a loop, as the
 *     File Router does, moving them into documents/ and writing the index;
 *   - the app's reads of file:///media/.safekeep-vault/… go to that
 *     temporary vault (a small fetch wrapper added before the app loads);
 *   - the Transfer Drive is the app's own in-memory Transfer backend.
 *
 * Checks: import (PDF, text, PNG, SVG) with "remove from the Transfer Drive",
 * the sealed viewer (PDF pages drawn, text and images shown, a PDF with
 * JavaScript runs nothing, a damaged PDF fails cleanly), the frame can't read
 * the vault or reach the app, rename, export (name clash → " (2)"), delete,
 * the 100 MB and free-space limits, Temporary Session, backup/restore/wipe
 * wiring in the OS scripts, and the helper's own tests.
 *
 * Needs `npm run build` first, python3, and a Chromium-family browser
 * (CHROMIUM_BINARY).
 * Run:  node test-documents.mjs
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const OS = join(HERE, '..', 'usbbootdrive');
const HELPER = join(OS, 'safekeep-documents.py');
let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra !== undefined && !cond) ? '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. The OS side, without a browser ----
console.log('1. OS scripts');
{
  const r = spawnSync('python3', [join(OS, 'tests', 'test-documents-helper.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  ck('safekeep-documents.py passes its own tests', r.status === 0, (r.stdout || '').split('\n').filter((l) => /FAIL|passed/.test(l)).join(' | ') + r.stderr);
  const boot = readFileSync(join(OS, 'safekeep-boot.sh'), 'utf8');
  ck('boot: documents/ is created (0700) with the other vault folders', /mkdir -p "\$VAULT_MOUNT\/documents"\n\s+chmod 700 "\$VAULT_MOUNT\/documents"/.test(boot));
  ck('boot: route, cleanup and index run at boot, only with a vault (not in a Temporary Session)',
    /if \[ "\$EPHEMERAL_MODE" != "1" \] && \[ -f "\$DOCUMENTS_HELPER" \]; then\n\s+python3 -I "\$DOCUMENTS_HELPER" route "\$SEED_DIR" "\$VAULT_MOUNT\/documents"\n\s+python3 -I "\$DOCUMENTS_HELPER" cleanup "\$SEED_DIR"\n\s+python3 -I "\$DOCUMENTS_HELPER" index/.test(boot));
  ck('boot: the File Router hands SKDOC-* requests to the helper', /if compgen -G "\$SEED_DIR\/SKDOC-\*" >\/dev\/null; then\n\s+python3 -I \/usr\/local\/lib\/safekeep\/safekeep-documents\.py route "\$SEED_DIR" "\$DOCUMENTS_DIR"/.test(boot));
  ck('backup: documents is a backup item', /'documents': 'documents',/.test(boot));
  ck('restore: documents is copied, overwritten and counted', (boot.match(/for VDIR in codex passphrases twofa settings seeds documents; do/g) || []).length === 3
    && /"\$VAULT_MOUNT\/seeds" "\$VAULT_MOUNT\/documents"/.test(boot) && /\\"documentsCount\\":\$DOCS_COUNT/.test(boot) && /documentsCount=len\(/.test(boot));
  ck('restore: the documents index is rebuilt afterwards', /safekeep-documents\.py index "\$VAULT_MOUNT\/documents"/.test(boot));
  ck('wipe: documents is wiped with the other vault folders', /for dir in codex passphrases twofa settings documents; do/.test(boot));
  // Requests must never be taken by another router: none matches *.html / *.json.
  const reqNames = readFileSync(join(HERE, 'shared', 'boot.js'), 'utf8').match(/SKDOC-\$\{id\}\.[a-z]+/g) || [];
  ck('the app\'s request names are only .skmeta/.skbin/.skren/.skdel (never .html or .json, which other routers take)',
    reqNames.length === 4 && reqNames.every((n) => /\.(skmeta|skbin|skren|skdel)$/.test(n)), reqNames);
  const build = readFileSync(join(OS, 'build.sh'), 'utf8'), qu = readFileSync(join(OS, 'quick-update.sh'), 'utf8');
  ck('build.sh and quick-update.sh install the helper',
    /install -m 755 safekeep-documents\.py "\$CHROOT_DIR\/usr\/local\/lib\/safekeep\/safekeep-documents\.py"/.test(build)
    && /install -m 755 safekeep-documents\.py "\$CHROOT_DIR\/usr\/local\/lib\/safekeep\/safekeep-documents\.py"/.test(qu)
    && / safekeep-documents\.py quiet-downloads\/manifest\.json/.test(build));
  ck('the vault partition is 900 MB', /^DATA_SIZE_MB=900\b/m.test(build));
  const viewer = readFileSync(join(HERE, 'shared', 'document-viewer.js'), 'utf8');
  ck('viewer: sandbox="allow-scripts" only (no allow-same-origin)', /frame\.setAttribute\('sandbox', 'allow-scripts'\);/.test(viewer) && !/allow-same-origin/.test(viewer.replace(/^\s*\*.*$/gm, '')));
  ck('viewer: pdf.js with isEvalSupported false, no XFA; the scripting sandbox isn\'t bundled',
    /isEvalSupported: false/.test(viewer) && /enableXfa: false/.test(viewer) && !/pdf\.sandbox/.test(readFileSync(join(HERE, 'boot-entry.js'), 'utf8')));
  ck('viewer: the frame\'s CSP allows no network', /"connect-src 'none'"/.test(viewer) && /"default-src 'none'"/.test(viewer));
}

// ---- 2. The built app in Chromium ----
const app = new URL('./dist/boot.html', import.meta.url);
if (!existsSync(app)) { console.error('dist/boot.html is missing: run `npm run build` first.'); process.exit(1); }
const executablePath = [process.env.CHROMIUM_BINARY,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
if (!executablePath) { console.error('No Chromium-family browser found. Set CHROMIUM_BINARY.'); process.exit(1); }

const VAULT = mkdtempSync(join(tmpdir(), 'skdoc-vault-'));
const SEEDS = join(VAULT, 'seeds'), DOCS = join(VAULT, 'documents'), ERRS = join(VAULT, 'errors.json');
mkdirSync(SEEDS); mkdirSync(DOCS);
writeFileSync(join(SEEDS, '.vault-sentinel.json'), JSON.stringify({ uuid: 'test-vault', ts: Date.now() }));
writeFileSync(join(VAULT, 'secret.txt'), 'VAULT-SECRET');
const helper = (...a) => spawnSync('python3', ['-I', HELPER, ...a], { encoding: 'utf8' });
helper('index', DOCS, ERRS);
let routing = true;
const router = (async () => { while (routing) { helper('route', SEEDS, DOCS, ERRS); await sleep(400); } })();

const { chromium } = await import('playwright-core');
// Sample files, made with the browser itself.
const gen = await chromium.launch({ executablePath, headless: true });
const gp = await gen.newPage();
await gp.setContent('<h1>Letter of instruction</h1><p>For my family.</p><div style="page-break-after:always"></div><h1>Page two</h1>');
const PDF = await gp.pdf({ format: 'Letter' });
const PNG = Buffer.from(await gp.evaluate(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 30;
  const x = c.getContext('2d'); x.fillStyle = '#f7931a'; x.fillRect(0, 0, 40, 30); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
await gen.close();
const TEXT = Buffer.from('Recovery steps\n\n1. Find the flash drive.\n2. Café ✓ <b>not markup</b>\n', 'utf8');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>parent.alert(1)</script></svg>');
// A PDF whose document-open action is JavaScript (pdf.js runs no PDF scripts here).
const jsObjs = ['<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>', '<< /S /JavaScript /JS (app.alert\\(1\\); this.print\\(\\);) >>'];
let jsPdf = '%PDF-1.7\n'; const offs = [];
jsObjs.forEach((o, i) => { offs.push(jsPdf.length); jsPdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = jsPdf.length;
jsPdf += `xref\n0 ${jsObjs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
  `trailer\n<< /Size ${jsObjs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const JS_PDF = Buffer.from(jsPdf, 'latin1');
const BAD_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 0x7f)]);

const browser = await chromium.launch({ executablePath, headless: true, args: ['--allow-file-access-from-files'] });
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(({ from, to }) => {
  const orig = window.fetch;
  window.fetch = function (u, o) { if (typeof u === 'string' && u.startsWith(from)) u = to + u.slice(from.length); return orig.call(this, u, o); };
}, { from: 'file:///media/.safekeep-vault/', to: 'file://' + VAULT + '/' });
const page = await ctx.newPage();
const pageErrors = [], dialogs = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
page.on('download', async (d) => { try { await d.saveAs(join(SEEDS, d.suggestedFilename())); } catch (e) { pageErrors.push('download: ' + e.message); } });
await page.goto(app.href);
await page.waitForFunction(() => window.SafeKeepOS && window.SafeKeepOS.listDocuments && window.SKDocViewer && window.SKTransfer && typeof docs_switchTab === 'function', null, { timeout: 30000 });

// The Transfer Drive: the app's in-memory backend, with files on it.
await page.evaluate(async (files) => {
  const be = SKTransfer.memoryBackend('TRANSFER (test)');
  for (const [name, b64] of files) await be.write(name, new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
  window.vaultTransferDriveHandle = SKTransfer.makeHandle(be);
  window._testTransfer = be;
  showState('state-securenote');
  docs_switchTab('documents');
}, [['Letter of instruction.pdf', PDF.toString('base64')], ['Recovery steps.txt', TEXT.toString('base64')],
    ['scan.png', PNG.toString('base64')], ['drawing.svg', SVG.toString('base64')], ['script.pdf', JS_PDF.toString('base64')],
    ['damaged.pdf', BAD_PDF.toString('base64')]]);

const transferNames = () => page.evaluate(async () => (await window._testTransfer.list()).map((f) => f.name).sort());
const docsList = () => page.evaluate(async () => (await SafeKeepOS.listDocuments()).documents.map((d) => ({ id: d.id, name: d.name, kind: d.kind, size: d.size })));
const statusText = () => page.evaluate(() => document.getElementById('docs-status').textContent);
async function importVia(name, removeAfter = true) {
  await page.evaluate(async (removeAfter) => { await docs_openImport(); document.getElementById('docs-remove-after').checked = removeAfter; }, removeAfter);
  await page.evaluate((n) => docs_import(n), name);
  return statusText();
}
// The viewer's frame (a sandboxed srcdoc frame: Playwright reports its URL as '' or about:srcdoc).
const frameOf = () => page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame() && (f.url() === '' || f.url() === 'about:srcdoc'));

try {
  console.log('2. Import');
  let st = await page.evaluate(() => document.getElementById('docs-unavailable').style.display);
  ck('the Documents tab is available with a vault', st === 'none');
  const shown = await page.evaluate(async () => { await docs_openImport(); return Array.from(document.querySelectorAll('#docs-import-list > div')).map((r) => r.firstChild.textContent); });
  ck('Import lists the Transfer Drive\'s files', shown.includes('Letter of instruction.pdf') && shown.includes('scan.png'), shown);
  ck('"Remove it from the Transfer Drive after importing" is checked by default', await page.evaluate(() => document.getElementById('docs-remove-after').checked));
  st = await importVia('Letter of instruction.pdf');
  ck('a PDF is saved into the vault', /is saved in the vault/.test(st), st);
  ck('and removed from the Transfer Drive', !(await transferNames()).includes('Letter of instruction.pdf'));
  let list = await docsList();
  const pdfDoc = list.find((d) => d.name === 'Letter of instruction.pdf');
  ck('the list shows it as a PDF of the right size', pdfDoc && pdfDoc.kind === 'pdf' && pdfDoc.size === PDF.length, list);
  const stored = readdirSync(DOCS).find((n) => n.endsWith('.pdf'));
  ck('the vault holds the exact bytes as <id>.pdf', stored && createHash('sha256').update(readFileSync(join(DOCS, stored))).digest('hex') === createHash('sha256').update(PDF).digest('hex'));
  ck('documents/ has the names list for 7-Zip users, naming the PDF', /^[0-9a-f]{16}\.pdf +Letter of instruction\.pdf +\(/m.test(readFileSync(join(DOCS, 'README - document names.txt'), 'utf8')));
  ck('no request files are left in seeds/', readdirSync(SEEDS).filter((n) => n.startsWith('SKDOC-')).length === 0, readdirSync(SEEDS));
  st = await importVia('Recovery steps.txt', false);
  ck('with the box unchecked, the file stays on the Transfer Drive, and the message says so', /still on the Transfer Drive/.test(st) && (await transferNames()).includes('Recovery steps.txt'), st);
  await importVia('scan.png'); await importVia('drawing.svg'); await importVia('script.pdf'); await importVia('damaged.pdf');
  list = await docsList();
  const kinds = Object.fromEntries(list.map((d) => [d.name, d.kind]));
  ck('text, PNG and SVG are stored with the right kinds', kinds['Recovery steps.txt'] === 'text' && kinds['scan.png'] === 'png' && kinds['drawing.svg'] === 'other', kinds);
  const buttons = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#docs-list [data-doc-id]')).map((r) =>
    [r.firstChild.firstChild.textContent, Array.from(r.querySelectorAll('button')).map((b) => b.textContent).join(',')])));
  ck('viewable documents have Open; an SVG has only Rename, Export, Delete', buttons['scan.png'].startsWith('Open,') && buttons['drawing.svg'] === 'Rename,Export,Delete', buttons);

  await page.evaluate(async () => { await docs_openImport(); document.getElementById('state-securenote').scrollIntoView(); });
  await page.screenshot({ path: join(VAULT, 'documents-tab.png') });
  await page.evaluate(() => docs_closeImport());

  console.log('3. The sealed viewer');
  const openDoc = async (name) => {
    const d = (await docsList()).find((x) => x.name === name);
    await page.evaluate(({ id, name }) => docs_open(id, name), d);
    for (let i = 0; i < 40; i++) {
      const s = await page.evaluate(() => document.getElementById('docs-viewer-status').textContent);
      if (s && !/Opening|Reading/.test(s)) return s;
      await sleep(250);
    }
    return page.evaluate(() => document.getElementById('docs-viewer-status').textContent);
  };
  st = await openDoc('Letter of instruction.pdf');
  ck('a PDF opens on page 1 of 2', st === 'PDF, page 1 of 2', st);
  let fr = frameOf();
  const drawn = fr && await fr.evaluate(() => { const c = document.querySelector('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) dark++; return { w: c.width, dark }; });
  ck('its first page is drawn, fitted to the width', drawn && drawn.w > 600 && drawn.dark > 500, drawn);
  await fr.evaluate(() => Array.from(document.querySelectorAll('button')).find((b) => /Next/.test(b.textContent)).click());
  await sleep(800);
  ck('Next shows page 2', (await page.evaluate(() => document.getElementById('docs-viewer-status').textContent)) === 'PDF, page 2 of 2');
  await page.screenshot({ path: join(VAULT, 'viewer-pdf.png') });

  // What a document's code could try from inside the frame.
  const sealed = await fr.evaluate(async (paths) => {
    const out = {};
    for (const [k, u] of Object.entries(paths)) { try { const r = await fetch(u); out[k] = 'read: ' + (await r.text()).slice(0, 20); } catch (e) { out[k] = 'blocked'; } }
    try { out.parent = 'read: ' + parent.document.title; } catch (e) { out.parent = 'blocked'; }
    try { out.app = typeof parent.SafeKeepOS; } catch (e) { out.app = 'blocked'; }
    try { out.top = typeof top.location.href; } catch (e) { out.top = 'blocked'; }
    out.origin = location.origin;
    return out;
  }, { vaultFile: 'file://' + VAULT + '/secret.txt', vaultPath: 'file:///media/.safekeep-vault/seeds/.vault-sentinel.json', index: 'file://' + DOCS + '/.documents-index.json' });
  ck('inside the frame: vault files can\'t be read', sealed.vaultFile === 'blocked' && sealed.vaultPath === 'blocked' && sealed.index === 'blocked', sealed);
  ck('inside the frame: the app\'s page and its SafeKeepOS can\'t be reached', sealed.parent === 'blocked' && sealed.app === 'blocked' && sealed.top === 'blocked', sealed);
  ck('the frame\'s origin is opaque', sealed.origin === 'null', sealed.origin);
  const appReads = await page.evaluate(async (u) => { try { return (await (await fetch(u)).text()); } catch (e) { return 'blocked'; } }, 'file://' + VAULT + '/secret.txt');
  ck('(while the app itself can read the same file)', appReads === 'VAULT-SECRET', appReads);

  st = await openDoc('Recovery steps.txt');
  fr = frameOf();
  const txt = await fr.evaluate(() => ({ text: document.querySelector('pre').textContent, bold: !!document.querySelector('b') }));
  ck('a text file shows its exact text, markup as plain text', st === 'Text' && txt.text === TEXT.toString('utf8') && !txt.bold, txt);
  st = await openDoc('scan.png');
  ck('a PNG shows at its size', st === 'Image, 40 × 30', st);
  await page.evaluate(() => docs_closeViewer());
  st = await openDoc('script.pdf');
  await sleep(1500);
  ck('a PDF with an "open" JavaScript action opens, and runs nothing', st === 'PDF, page 1 of 1' && dialogs.length === 0, { st, dialogs });
  st = await openDoc('damaged.pdf');
  ck('a damaged PDF fails with a plain message', /couldn't be opened/.test(st), st);
  await page.evaluate(() => docs_closeViewer());
  ck('Close removes the frame', !(await page.evaluate(() => !!document.querySelector('#docs-viewer-frame iframe'))));

  console.log('4. Rename, export, delete');
  let txtDoc = (await docsList()).find((d) => d.name === 'Recovery steps.txt');
  let r = await page.evaluate((id) => SafeKeepOS.renameDocument(id, 'Steps for Mom.txt'), txtDoc.id);
  ck('rename', r.ok && (await docsList()).some((d) => d.id === txtDoc.id && d.name === 'Steps for Mom.txt'), r);
  r = await page.evaluate((id) => SafeKeepOS.renameDocument(id, '   '), txtDoc.id);
  ck('a blank name is refused', !r.ok, r);
  await page.evaluate(async () => { await window._testTransfer.write('Steps for Mom.txt', new Blob(['other'])); await docs_refresh(); });
  await page.evaluate(async (id) => {
    const row = document.querySelector(`[data-doc-id="${id}"]`);
    Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Export').click();
    Array.from(row.querySelectorAll('.docs-inline button')).find((b) => /Export to Transfer Drive/.test(b.textContent)).click();
  }, txtDoc.id);
  await sleep(1000);
  const exported = await page.evaluate(async () => { const f = (await window._testTransfer.list()).map((x) => x.name);
    const b = await window._testTransfer.read('Steps for Mom (2).txt').catch(() => null); return { f, text: b ? await b.text() : null }; });
  ck('export writes the exact bytes, as "name (2)" when the name is taken', exported.text === TEXT.toString('utf8'), exported);
  ck('the export message warns to delete it there', /delete it there/.test(await statusText()), await statusText());
  const svgDoc = (await docsList()).find((d) => d.name === 'drawing.svg');
  r = await page.evaluate((id) => SafeKeepOS.deleteDocument(id), svgDoc.id);
  ck('delete removes it from the list and the vault', r.ok && !(await docsList()).some((d) => d.id === svgDoc.id) && !readdirSync(DOCS).some((n) => n.startsWith(svgDoc.id)), r);

  console.log('5. Limits and sessions');
  r = await page.evaluate(() => SafeKeepOS.saveDocument('huge.bin', new Uint8Array(100 * 1024 * 1024 + 1)));
  ck('over 100 MB is refused in the app', !r.saved && /100 MB/.test(r.error), r);
  routing = false; await router;
  const ix = JSON.parse(readFileSync(join(DOCS, '.documents-index.json'), 'utf8'));
  writeFileSync(join(DOCS, '.documents-index.json'), JSON.stringify({ ...ix, free: 5 * 1024 * 1024 }));
  r = await page.evaluate(() => SafeKeepOS.saveDocument('small.txt', new Uint8Array(1024)));
  ck('a file that leaves under 20 MB free is refused', !r.saved && /isn't room/.test(r.error), r);
  ck('and nothing was sent', readdirSync(SEEDS).filter((n) => n.startsWith('SKDOC-')).length === 0);
  writeFileSync(join(DOCS, '.documents-index.json'), JSON.stringify(ix));
  const temp = await page.evaluate(() => {
    const l = document.getElementById('dash-identity-label'); const was = l.textContent; l.textContent = 'Temporary Seed Active';
    docs_onPageOpen(); const out = { shown: document.getElementById('docs-unavailable').style.display, text: document.getElementById('docs-unavailable').textContent,
      main: document.getElementById('docs-main').style.display };
    l.textContent = was; docs_onPageOpen(); return out;
  });
  ck('in a Temporary Session the tab explains why it isn\'t available', temp.shown === 'block' && temp.main === 'none' && /Temporary Session/.test(temp.text), temp);
  const backupItem = await page.evaluate(() => !!document.getElementById('rlq-chk-documents') && document.getElementById('rlq-chk-documents').value);
  ck('Encrypted Backup offers Documents', backupItem === 'documents');

  ck('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  routing = false;
  await browser.close();
  if (!process.env.KEEP) rmSync(VAULT, { recursive: true, force: true });
  else console.log('  (kept ' + VAULT + ')');
}

console.log(`\ntest-documents: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

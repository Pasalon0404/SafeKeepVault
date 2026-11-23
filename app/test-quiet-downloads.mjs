/**
 * test-quiet-downloads.mjs — no "Download started" message in the kiosk.
 *   The app writes its request files to the OS as downloads; in kiosk mode
 *   Chromium shows "Download started. To see it, press Esc." for each one.
 *   usbbootdrive/quiet-downloads/ is a tiny extension that turns Chromium's
 *   download UI off (chrome.downloads.setUiOptions); the files are still
 *   written.
 *   1. The extension: only the downloads permissions, no page access.
 *   2. safekeep-boot.sh loads it; build.sh and quick-update.sh install it.
 *   3. In a real Chromium (kiosk, Xvfb, openbox): without the extension the
 *      message appears, with it the file is written and nothing appears.
 *      Skipped when Chromium, Xvfb, openbox or ImageMagick is missing;
 *      CHROMIUM=/path/to/chrome picks the browser. Not incognito: without
 *      the stick's download policy (which only root can install) an
 *      incognito window asks where to save. The incognito kiosk with the
 *      policy was checked by hand on ungoogled-chromium 155.
 * Run: node test-quiet-downloads.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OS = join(HERE, '..', 'usbbootdrive');
const EXT = join(OS, 'quiet-downloads');
const INSTALLED = '/usr/local/lib/safekeep/quiet-downloads';
const read = (f) => readFileSync(join(OS, f), 'utf8');
let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c || !x ? '' : '  -> ' + x)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. The extension ----
{
  const m = JSON.parse(read('quiet-downloads/manifest.json'));
  const bg = read('quiet-downloads/background.js');
  ck('manifest v3 with a background service worker', m.manifest_version === 3 && m.background?.service_worker === 'background.js');
  ck('only the downloads permissions', JSON.stringify(m.permissions) === '["downloads","downloads.ui"]', JSON.stringify(m.permissions));
  ck('no page access: no host permissions, content scripts or web resources',
    !m.host_permissions && !m.optional_permissions && !m.content_scripts && !m.web_accessible_resources && !m.externally_connectable);
  ck('works in the incognito kiosk', m.incognito === 'spanning');
  ck('turns the download UI off, at load and at startup',
    /chrome\.downloads\.setUiOptions\(\{ enabled: false \}\)/.test(bg) && /\nhideDownloadUi\(\);\n/.test(bg) && bg.includes('chrome.runtime.onStartup.addListener(hideDownloadUi)'));
  const calls = bg.replace(/\/\/.*$/gm, '').match(/chrome\.[a-zA-Z.]+/g) || [];
  ck('no other browser API used', calls.every((c) => ['chrome.downloads.setUiOptions', 'chrome.runtime.onStartup.addListener', 'chrome.runtime.onInstalled.addListener'].includes(c)), calls.join(' '));
}

// ---- 2. Loaded and installed ----
{
  const boot = read('safekeep-boot.sh');
  const launch = boot.slice(boot.indexOf('    ungoogled-chromium \\\n        --kiosk'), boot.indexOf('    CHROMIUM_EXIT=$?'));
  ck('the kiosk launch loads the extension', launch.includes(`--load-extension=${INSTALLED} \\`), launch);
  const build = read('build.sh'), quick = read('quick-update.sh');
  const install = `install -m 644 quiet-downloads/manifest.json quiet-downloads/background.js "$CHROOT_DIR${INSTALLED}/"`;
  ck('build.sh requires both files', /for f in [^\n]*quiet-downloads\/manifest\.json quiet-downloads\/background\.js; do/.test(build));
  ck('build.sh installs them', build.includes(install) && build.includes(`install -d -m 755 "$CHROOT_DIR${INSTALLED}"`));
  ck('quick-update.sh installs them', quick.includes(install) && quick.includes(`install -d -m 755 "$CHROOT_DIR${INSTALLED}"`));
}

// ---- 3. Real Chromium ----
const has = (c) => spawnSync('bash', ['-c', `command -v ${c}`]).status === 0;
const chrome = process.env.CHROMIUM || ['/opt/pw-browsers/chromium/chrome-linux/chrome', ...(existsSync('/opt/pw-browsers') ? readdirSync('/opt/pw-browsers').filter((d) => /^chromium-\d+$/.test(d)).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`) : [])].find((p) => existsSync(p));
if (!chrome || !has('Xvfb') || !has('openbox') || !has('import') || !has('convert')) {
  console.log('  SKIP real-Chromium check (needs Chromium, Xvfb, openbox and ImageMagick)');
} else {
  const tmp = mkdtempSync(join(tmpdir(), 'sk-quiet-'));
  // A plain dark page that downloads one request file after 1.5 s, like the
  // app's _rawBlobDownload.
  const page = join(tmp, 'page.html');
  writeFileSync(page, `<html><body style="margin:0;background:#102030"><script>
setTimeout(function () { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['{}'])); a.download = 'REQUEST.json'; document.body.appendChild(a); a.click(); }, 1500);
</script></body></html>`);
  const display = ':' + (90 + Math.floor(Math.random() * 9));
  const env = { ...process.env, DISPLAY: display };
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24'], { stdio: 'ignore' });
  await sleep(1000);
  const wm = spawn('openbox', [], { env, stdio: 'ignore' });
  await sleep(800);

  // Returns { file, message }: was the file written, and did any screenshot
  // show something other than the page's background in the top band, where
  // Chromium puts the message.
  async function run(tag, extra) {
    const home = join(tmp, tag);
    mkdirSync(join(home, 'Downloads'), { recursive: true });
    // What the stick's policy sets: save to a fixed folder without asking.
    mkdirSync(join(home, 'profile', 'Default'), { recursive: true });
    writeFileSync(join(home, 'profile', 'Default', 'Preferences'), JSON.stringify({
      download: { default_directory: join(home, 'Downloads'), prompt_for_download: false, directory_upgrade: true },
      savefile: { default_directory: join(home, 'Downloads') },
    }));
    const browser = spawn(chrome, ['--user-data-dir=' + join(home, 'profile'), '--kiosk', '--start-fullscreen', '--app=file://' + page, '--no-first-run', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--disable-dev-tools', ...extra],
      { env: { ...env, HOME: home, XDG_DOWNLOAD_DIR: join(home, 'Downloads') }, stdio: 'ignore' });
    let message = false;
    for (let i = 0; i < 14; i++) {
      await sleep(400);
      const shot = join(tmp, `${tag}-${i}.png`);
      spawnSync('import', ['-window', 'root', shot], { env });
      const r = spawnSync('convert', [shot, '-crop', '640x120+320+0', '-format', '%[fx:maxima.r*255] %[fx:maxima.g*255]', 'info:'], { encoding: 'utf8' });
      const [red, green] = r.stdout.trim().split(' ').map(Number);
      if (red > 0x30 || green > 0x40) message = true;
    }
    browser.kill();
    await sleep(500);
    const file = existsSync(join(home, 'Downloads', 'REQUEST.json'));
    return { file, message };
  }

  const without = await run('without', []);
  ck('real Chromium, no extension: the file is written', without.file);
  ck('real Chromium, no extension: the "Download started" message appears (the check can see it)', without.message);
  const withExt = await run('with', ['--load-extension=' + EXT]);
  ck('real Chromium, with the extension: the file is still written', withExt.file);
  ck('real Chromium, with the extension: no message', !withExt.message);
  wm.kill(); xvfb.kill();
  if (!process.env.KEEP) rmSync(tmp, { recursive: true, force: true }); else console.log(tmp);
}

console.log(`\nQUIET DOWNLOADS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

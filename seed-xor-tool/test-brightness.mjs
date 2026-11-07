/**
 * test-brightness.mjs — Screen Brightness, and the SeedQR tool's word boxes
 *
 *   1. usbbootdrive/safekeep-brightness.sh, with a fake xrandr and a fake
 *      /sys/class/backlight: dim (software, every connected screen,
 *      30–100 %), full / restore (the light box's hardware backlight),
 *      up / down (brightness keys), bad input refused, no backlight is fine.
 *   2. The Brightness Watcher in safekeep-boot.sh, run for real against
 *      temp folders: every request in order, only known actions.
 *   3. OS wiring: install lines, Settings Watcher key.
 *   4. App wiring: the bridge, the sliders, the light box, the keys.
 *   5. The SeedQR tool's word entry is the app's standard word boxes.
 *
 * Run:  node test-brightness.mjs
 */
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const OS = new URL('../usbbootdrive/', import.meta.url);
const read = (u) => readFileSync(u, 'utf8');
const helper = new URL('safekeep-brightness.sh', OS).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake xrandr: two connected screens and one disconnected; --output calls are recorded.
function makeEnv(root) {
    const bl = join(root, 'bl'); mkdirSync(bl, { recursive: true });
    const xr = join(root, 'xrandr');
    writeFileSync(xr, `#!/bin/bash
if [ "$1" = "--query" ]; then
  echo "Screen 0: minimum 8 x 8, current 2880 x 1800"
  echo "eDP-1 connected primary 2880x1800+0+0 (normal) 331mm x 207mm"
  echo "HDMI-1 connected 1920x1080+0+0 (normal) 509mm x 286mm"
  echo "DP-1 disconnected (normal left inverted right x axis y axis)"
else
  echo "$*" >> "${root}/xrandr.calls"
fi
`);
    chmodSync(xr, 0o755);
    return { bl, env: { ...process.env, SAFEKEEP_BACKLIGHT_DIR: bl, SAFEKEEP_BRIGHTNESS_STATE: join(root, 'state'), SAFEKEEP_BRIGHTNESS_LOG: join(root, 'log'), SAFEKEEP_XRANDR: xr } };
}
const calls = (root) => existsSync(join(root, 'xrandr.calls')) ? readFileSync(join(root, 'xrandr.calls'), 'utf8').trim().split('\n') : [];

console.log('\n1. safekeep-brightness.sh');
{
    const root = mkdtempSync(join(tmpdir(), 'skbright-'));
    const { bl, env } = makeEnv(root);
    const dev = (name, max, cur) => { mkdirSync(join(bl, name), { recursive: true }); writeFileSync(join(bl, name, 'max_brightness'), max + '\n'); writeFileSync(join(bl, name, 'brightness'), cur + '\n'); };
    const val = (name) => Number(readFileSync(join(bl, name, 'brightness'), 'utf8'));
    const run = (...args) => { try { execFileSync('bash', [helper, ...args], { env, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
    const clear = () => rmSync(join(root, 'xrandr.calls'), { force: true });

    run('dim', '70');
    ck('dim 70 → every connected screen at 0.70, not the disconnected one', JSON.stringify(calls(root)) === JSON.stringify(['--output eDP-1 --brightness 0.70', '--output HDMI-1 --brightness 0.70']), calls(root).join(' | '));
    clear(); run('dim', '100');
    ck('dim 100 → 1.00', calls(root)[0] === '--output eDP-1 --brightness 1.00');
    clear(); run('dim', '5');
    ck('never below 30 %', calls(root)[0] === '--output eDP-1 --brightness 0.30');
    clear(); run('dim', '999');
    ck('never above 100 %', calls(root)[0] === '--output eDP-1 --brightness 1.00');
    ck('dim without a number, or an unknown action, is refused', run('dim', 'abc') === 2 && run('dim') === 2 && run('poweroff') === 2 && run('set', '50') === 2);
    ck('no backlight: full / restore / up / down do nothing and don\'t fail', run('full') === 0 && run('restore') === 0 && run('up') === 0 && !existsSync(join(root, 'state')));

    dev('acpi_video0', 7, 3); dev('intel_backlight', 96000, 48000);
    run('full');
    ck('full: every backlight to 100 %, the level before remembered', val('intel_backlight') === 96000 && val('acpi_video0') === 7 && readFileSync(join(root, 'state'), 'utf8').trim() === '50');
    run('full');
    ck('a second full keeps the first remembered level', readFileSync(join(root, 'state'), 'utf8').trim() === '50');
    run('restore');
    ck('restore puts it back (50 %) and forgets it', val('intel_backlight') === 48000 && !existsSync(join(root, 'state')));
    ck('restore without a full does nothing', run('restore') === 0 && val('intel_backlight') === 48000);
    run('up');
    ck('up: next 10 % (60), read from the finest backlight', val('intel_backlight') === 57600);
    run('down'); run('down');
    ck('down, down: 50, 40 (a coarse backlight can\'t stall it)', val('intel_backlight') === 38400);
    for (let i = 0; i < 6; i++) run('down');
    ck('the keys never go below 10 %', val('intel_backlight') === 9600 && val('acpi_video0') >= 1);
    ck('it runs nothing but xrandr', !/\b(eval|sudo|exec|sh -c)\b/.test(read(new URL('safekeep-brightness.sh', OS)).replace(/^\s*#.*$/gm, '')));
    rmSync(root, { recursive: true, force: true });
}

console.log('\n2. The Brightness Watcher, run for real');
{
    const boot = read(new URL('safekeep-boot.sh', OS));
    const block = boot.slice(boot.indexOf('    # -------------------------------------------------------------------\n    # BRIGHTNESS WATCHER'), boot.indexOf('    BRIGHTNESS_WATCHER_PID=$!'));
    const root = mkdtempSync(join(tmpdir(), 'skbright-w-'));
    const { bl, env } = makeEnv(root);
    mkdirSync(join(bl, 'gmux_backlight'), { recursive: true });
    writeFileSync(join(bl, 'gmux_backlight', 'max_brightness'), '1023\n'); writeFileSync(join(bl, 'gmux_backlight', 'brightness'), '512\n');
    const dl = join(root, 'dl'), sig = join(root, 'sig'); mkdirSync(dl); mkdirSync(sig);
    const script = join(root, 'w.sh');
    writeFileSync(script, 'set -uo pipefail\nCHROMIUM_DOWNLOAD_DIR=' + JSON.stringify(dl) + '\nSIGNAL_DIR=' + JSON.stringify(sig) + '\n' +
        block.replaceAll('/usr/local/lib/safekeep/safekeep-brightness.sh', helper) + '    wait\n');
    const child = spawn('bash', [script], { env, stdio: 'ignore', detached: true });
    await sleep(400);
    const put = async (name, body) => { writeFileSync(join(dl, name), body); await sleep(30); };
    // The light box opening: full, then dim 100, then a dragged slider.
    await put('BRIGHTNESS_REQUEST.json', '{"action":"full"}');
    await put('BRIGHTNESS_REQUEST (1).json', '{"action":"dim","percent":100}');
    await put('BRIGHTNESS_REQUEST (2).json', '{"action":"dim","percent":60}');
    await put('BRIGHTNESS_REQUEST (3).json', '{"action":"$(reboot)"}');
    await put('BRIGHTNESS_REQUEST (4).json', '{"action":"dim","percent":"40; rm -rf /"}');
    await sleep(900);
    const c = calls(root);
    ck('every request is carried out, oldest first', JSON.stringify(c) === JSON.stringify(['--output eDP-1 --brightness 1.00', '--output HDMI-1 --brightness 1.00', '--output eDP-1 --brightness 0.60', '--output HDMI-1 --brightness 0.60']), c.join(' | '));
    ck('…full turned the backlight up and remembered 50 %', readFileSync(join(bl, 'gmux_backlight', 'brightness'), 'utf8').trim() === '1023' && readFileSync(join(sig, 'brightness-before-lightbox'), 'utf8').trim() === '50');
    ck('…an unknown action and a non-number are ignored, and every request file is removed', readdirSync(dl).length === 0);
    await put('BRIGHTNESS_REQUEST.json', '{"action":"restore"}');
    await sleep(700);
    ck('restore puts the backlight back', readFileSync(join(bl, 'gmux_backlight', 'brightness'), 'utf8').trim() === '512');
    try { process.kill(-child.pid); } catch (_) {}
    rmSync(root, { recursive: true, force: true });
    ck('the watcher can reach the X display (DISPLAY, XAUTHORITY)', block.includes('export DISPLAY="${DISPLAY:-:0}"') && block.includes('export XAUTHORITY="${XAUTHORITY:-/root/.Xauthority}"'));
}

console.log('\n3. OS wiring');
{
    const boot = read(new URL('safekeep-boot.sh', OS));
    ck('the note router skips BRIGHTNESS_ files', boot.includes('DISPLAY_SLEEP_*|BRIGHTNESS_*|'));
    ck('the Settings Watcher keeps safekeepBrightness', /ALLOWED = \([^)]*'safekeepBrightness'/.test(boot));
    for (const f of ['build.sh', 'quick-update.sh']) {
        ck(`${f} installs the helper`, read(new URL(f, OS)).includes('install -m 755 safekeep-brightness.sh "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-brightness.sh"'));
    }
    execFileSync('bash', ['-n', new URL('safekeep-boot.sh', OS).pathname]);
    ck('safekeep-boot.sh parses', true);
}

console.log('\n4. App wiring');
const html = read(new URL('./boot.html', import.meta.url));
const bridge = read(new URL('./shared/boot.js', import.meta.url));
{
    const fn = (name) => { const a = html.indexOf(name); return a < 0 ? '' : html.slice(a, html.indexOf('\n}\n', a)); };
    ck('the request file passes the firewall', bridge.includes("'BRIGHTNESS_REQUEST',"));
    ck('SafeKeepOS exports setBrightness, stepBrightness, lightboxBacklight', /setBrightness,\s*stepBrightness,\s*lightboxBacklight,/.test(bridge));
    ck('setBrightness asks for software dimming, 30–100, at most every 200 ms', bridge.includes("{ action: 'dim', percent: Math.max(30, Math.min(100, p)) }") && bridge.includes('200 - (Date.now() - _brightLast)'));
    ck('lightboxBacklight asks for full / restore', bridge.includes("_brightSend({ action: on ? 'full' : 'restore' })"));
    ck('Device Options has Screen Brightness, 30–100, always shown', html.includes('id="settings-brightness" class="skbright-range" min="30" max="100"') && !html.includes('skbright-none') && !html.includes('settings-brightness-info'));
    ck('the light box has the ☀ slider', html.includes(`'<label class="sqrd-size skbright-row" title="Screen brightness">`));
    ck('opening the light box: hardware backlight full, dimming 100 %', fn('function sqrd_open').includes('skbright_lightbox(true)') && fn('function skbright_lightbox').includes('os.lightboxBacklight(!!open)') && fn('function skbright_lightbox').includes('var n = open ? 100 : _skbrightSaved();'));
    ck('closing it puts the saved level and the backlight back', fn('function sqrd_close').includes("if (sqrd_state.mode === 'lightbox' && typeof skbright_lightbox === 'function') skbright_lightbox(false);"));
    ck('the light box slider doesn\'t change the saved level', fn('function skbright_set').includes('if (!_skbrightLightbox) { try { localStorage.setItem(SKBRIGHT_KEY'));
    ck('the brightness keys step the hardware backlight', html.includes("e.key !== 'BrightnessUp' && e.key !== 'BrightnessDown'") && html.includes("os.stepBrightness(e.key === 'BrightnessUp' ? 1 : -1)"));
    const loader = html.slice(html.indexOf('var _skbDsKeys'), html.indexOf('\n', html.indexOf('var _skbDsKeys')));
    const rlq = html.slice(html.indexOf('var _RLQ_APP_SETTINGS_KEYS'), html.indexOf('];', html.indexOf('var _RLQ_APP_SETTINGS_KEYS')));
    ck('safekeepBrightness is a Device Options key (boot loader + settings sync), set again at start', loader.includes("'safekeepBrightness'") && rlq.includes("'safekeepBrightness'") && html.includes('if (n < 100) _skbrightApply(n);'));
    ck('the old status file and diagnostics are gone', !bridge.includes('getBrightness') && !html.includes('getBrightness') && !bridge.includes('BRIGHTNESS.json'));
}

console.log('\n5. SeedQR word boxes');
{
    const a = html.indexOf('function sqr_buildInputGrid'), fnText = html.slice(a, html.indexOf('\n}\n', a));
    ck('the SeedQR tool builds the standard word boxes', fnText.includes("SF.createWordBoxes(host, { count: count, wordlist: SF.wordlists.bip39, idPrefix: 'sqr-in' })"));
    ck('its old hand-made autocomplete is gone', !/function sqr_(onInput|onKeydown|selectWord|closeDropdown)\b/.test(html));
    ck('a scanned SeedQR fills the boxes', html.includes('if (_sqrBoxes) _sqrBoxes.setWords(words);'));
    ck('leaving the tool clears typed words', html.slice(html.indexOf('function sqr_cleanup'), html.indexOf('function sqr_cleanup') + 300).includes('_sqrBoxes.destroy()'));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

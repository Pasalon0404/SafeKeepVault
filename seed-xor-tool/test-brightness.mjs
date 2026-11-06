/**
 * test-brightness.mjs — Screen Brightness, and the SeedQR tool's word boxes
 *
 *   1. usbbootdrive/safekeep-brightness.sh against a fake /sys/class/backlight:
 *      get / set / up / down, 10 % floor, 100 % ceiling, every backlight set,
 *      read back from the finest one, bad input refused, no backlight →
 *      { available: false }.
 *   2. OS wiring: safekeep-boot.sh's Brightness Watcher, the image and quick
 *      update install the helper, the Settings Watcher keeps the level.
 *   3. App wiring: SafeKeepOS.setBrightness / stepBrightness / getBrightness,
 *      the request file passes the firewall, Device Options and the light
 *      box have the slider, the brightness keys work, the level is a Device
 *      Options key (saved in the vault).
 *   4. The SeedQR tool's word entry is the app's standard word boxes.
 *
 * Run:  node test-brightness.mjs
 */
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const OS = new URL('../usbbootdrive/', import.meta.url);
const read = (u) => readFileSync(u, 'utf8');

console.log('\n1. safekeep-brightness.sh');
{
    const helper = new URL('safekeep-brightness.sh', OS).pathname;
    const root = mkdtempSync(join(tmpdir(), 'skbright-'));
    const bl = join(root, 'bl'), status = join(root, 'BRIGHTNESS.json');
    const dev = (name, max, cur) => { mkdirSync(join(bl, name), { recursive: true }); writeFileSync(join(bl, name, 'max_brightness'), max + '\n'); writeFileSync(join(bl, name, 'brightness'), cur + '\n'); };
    const val = (name) => Number(readFileSync(join(bl, name, 'brightness'), 'utf8'));
    const run = (...args) => {
        let code = 0;
        try { execFileSync('bash', [helper, ...args], { env: { ...process.env, SAFEKEEP_BACKLIGHT_DIR: bl, SAFEKEEP_BRIGHTNESS_STATUS: status }, stdio: 'pipe' }); } catch (e) { code = e.status; }
        let st = null; try { st = JSON.parse(readFileSync(status, 'utf8')); } catch (_) {}
        return { code, st };
    };
    mkdirSync(bl, { recursive: true });
    ck('no backlight → { available: false }', JSON.stringify(run('get').st) === '{"available":false}');
    dev('acpi_video0', 7, 3); dev('intel_backlight', 96000, 48000);
    ck('get reads the finest backlight: 50 %', run('get').st?.percent === 50, JSON.stringify(run('get').st));
    let r = run('set', '73');
    ck('set 73 → 73 %, both backlights set', r.st?.available === true && r.st.percent === 73 && val('intel_backlight') === 70080 && val('acpi_video0') === 5, `${JSON.stringify(r.st)} ${val('acpi_video0')}`);
    ck('up rounds to the next 10 %: 80', run('up').st?.percent === 80);
    ck('down, down: 70, 60 (a coarse backlight can\'t stall it)', run('down').st?.percent === 70 && run('down').st?.percent === 60);
    ck('never below 10 %', run('set', '3').st?.percent === 10 && run('down').st?.percent === 10 && val('acpi_video0') >= 1);
    ck('never above 100 %', run('set', '250').st?.percent === 100 && run('up').st?.percent === 100);
    ck('set without a number is refused', run('set', 'abc').code === 2 && run('set').code === 2);
    ck('an unknown action is refused', run('poweroff').code === 2);
    ck('nothing else is run', !/\b(eval|xrandr|sudo|exec)\b/.test(read(new URL('safekeep-brightness.sh', OS)).replace(/^#.*$/gm, '')));
    rmSync(root, { recursive: true, force: true });
}

console.log('\n2. OS wiring');
{
    const boot = read(new URL('safekeep-boot.sh', OS));
    const w = boot.slice(boot.indexOf('# BRIGHTNESS WATCHER'), boot.indexOf('BRIGHTNESS_WATCHER_PID=$!'));
    ck('the Brightness Watcher reads BRIGHTNESS_REQUEST*.json from the download folder', w.includes('"$CHROMIUM_DOWNLOAD_DIR/BRIGHTNESS_REQUEST*.json"'));
    ck('…acts on the newest, deletes them all, reads at most 256 bytes', w.includes('ls -t') && w.includes('rm -f "${BR_FILES[@]}"') && w.includes('head -c 256'));
    ck('…passes only set <1–3 digits> / up / down / get to the helper', w.includes('[0-9]\\{1,3\\}') && w.includes('set)         [ -n "$BR_PCT" ] && bash "$BRIGHTNESS_HELPER" set "$BR_PCT"') && w.includes('up|down|get) bash "$BRIGHTNESS_HELPER" "$BR_ACTION"'));
    ck('…status in the RAM signal folder', w.includes('SAFEKEEP_BRIGHTNESS_STATUS="$SIGNAL_DIR/BRIGHTNESS.json"'));
    ck('the note router skips BRIGHTNESS_ files', boot.includes('DISPLAY_SLEEP_*|BRIGHTNESS_*|'));
    ck('the Settings Watcher keeps safekeepBrightness', /ALLOWED = \([^)]*'safekeepBrightness'/.test(boot));
    for (const f of ['build.sh', 'quick-update.sh']) {
        ck(`${f} installs the helper`, read(new URL(f, OS)).includes('install -m 755 safekeep-brightness.sh "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-brightness.sh"'));
    }
    execFileSync('bash', ['-n', new URL('safekeep-boot.sh', OS).pathname]);
    ck('safekeep-boot.sh parses', true);
}

console.log('\n3. App wiring');
const html = read(new URL('./boot.html', import.meta.url));
const bridge = read(new URL('./shared/boot.js', import.meta.url));
{
    ck('the request file passes the firewall', bridge.includes("'BRIGHTNESS_REQUEST',"));
    ck('SafeKeepOS exports setBrightness, stepBrightness, getBrightness', /setBrightness,\s*stepBrightness,\s*getBrightness,/.test(bridge));
    ck('setBrightness sends 10–100 at most every 200 ms, ending with the last', bridge.includes('Math.max(10, Math.min(100, p))') && bridge.includes('200 - (Date.now() - _brightLast)'));
    ck('getBrightness reads /tmp/safekeep-signals/BRIGHTNESS.json', bridge.includes("'file:///tmp/safekeep-signals/BRIGHTNESS.json'"));
    ck('Device Options has Screen Brightness with a slider', html.includes('id="settings-brightness-section"') && html.includes('id="settings-brightness" class="skbright-range"'));
    ck('…refreshed when Device Options opens', html.includes("if (this.open && typeof skbright_refresh === 'function') skbright_refresh()"));
    ck('the light box has a brightness slider', html.includes(`'<label class="sqrd-size skbright-row" title="Screen brightness">`) && html.includes("if (mode === 'lightbox' && typeof skbright_refresh === 'function') skbright_refresh();"));
    ck('the brightness keys step it', html.includes("e.key !== 'BrightnessUp' && e.key !== 'BrightnessDown'") && html.includes("os.stepBrightness(e.key === 'BrightnessUp' ? 1 : -1)"));
    const loader = html.slice(html.indexOf('var _skbDsKeys'), html.indexOf('\n', html.indexOf('var _skbDsKeys')));
    const rlq = html.slice(html.indexOf('var _RLQ_APP_SETTINGS_KEYS'), html.indexOf('];', html.indexOf('var _RLQ_APP_SETTINGS_KEYS')));
    ck('safekeepBrightness is a Device Options key (boot loader + settings sync)', loader.includes("'safekeepBrightness'") && rlq.includes("'safekeepBrightness'"));
    ck('without a backlight, the sliders give way to a note', html.includes('class="skbright-none" hidden') && html.includes(".skbright-off { display: none !important; }"));
    ck('the dev build has a pretend backlight', html.includes('getBrightness: function () { return Promise.resolve({ available: true, percent: window._devBrightness || 80 }); }'));
}

console.log('\n4. SeedQR word boxes');
{
    const a = html.indexOf('function sqr_buildInputGrid'), fnText = html.slice(a, html.indexOf('\n}\n', a));
    ck('the SeedQR tool builds the standard word boxes', fnText.includes("SF.createWordBoxes(host, { count: count, wordlist: SF.wordlists.bip39, idPrefix: 'sqr-in' })"));
    ck('its old hand-made autocomplete is gone', !/function sqr_(onInput|onKeydown|selectWord|closeDropdown)\b/.test(html));
    ck('a scanned SeedQR fills the boxes', html.includes('if (_sqrBoxes) _sqrBoxes.setWords(words);'));
    ck('leaving the tool clears typed words', html.slice(html.indexOf('function sqr_cleanup'), html.indexOf('function sqr_cleanup') + 300).includes('_sqrBoxes.destroy()'));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

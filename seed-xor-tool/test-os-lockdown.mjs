/**
 * test-os-lockdown.mjs — SafeKeep OS lock-down (usbbootdrive/):
 *   1. Openbox: release builds have no Terminal or File Explorer (shortcut or
 *      menu); SAFEKEEP_DEV_SHELL=1 builds have both and a marker file.
 *   2. Network driver families are deleted from a module tree: unlisted NICs
 *      (alx, ipheth …), Wi-Fi/Bluetooth stacks, USB gadget; boot/USB/vault/
 *      camera/firewall drivers survive; the build fails if a required driver
 *      is missing or a network driver is left.
 *   3. Build tools are purged after the build and their absence is checked.
 *   4. Network watchdog: an interface other than lo (or a missing firewall)
 *      writes NETWORK_ALERT.json; none → no file.
 *   5. The app's warning text: names filtered, firewall message.
 *   6. Chromium is pinned: the build downloads the pinned release's file,
 *      stops on a hash mismatch or a missing pin, records the browser in
 *      /etc/safekeep-chromium, and build.sh passes the overrides through.
 * Needs bash. Run: node test-os-lockdown.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const OS = join(HERE, '..', 'usbbootdrive');
const read = (f) => readFileSync(join(OS, f), 'utf8');
let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c || !x ? '' : '  -> ' + x)); };
const bash = (script, env = {}) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) throw new Error('marker not found: ' + a); const j = s.indexOf(b, i); if (j < 0) throw new Error('marker not found: ' + b); return s.slice(i, j + b.length); };

// ---- 1. Openbox: Terminal / File Explorer only in developer builds ----
{
  const setup = read('chroot-setup.sh');
  const seg = between(setup, 'echo "Configuring Openbox application rules and shortcuts..."', '\nfi\n');
  for (const dev of ['0', '1']) {
    const root = mkdtempSync(join(tmpdir(), 'sk-ob-'));
    mkdirSync(join(root, 'etc/xdg/openbox'), { recursive: true });
    const script = 'set -e\n' + seg.replaceAll('/etc/', root + '/etc/');
    const r = bash(script, { SAFEKEEP_DEV_SHELL: dev });
    const rc = readFileSync(join(root, 'etc/xdg/openbox/rc.xml'), 'utf8');
    const menu = readFileSync(join(root, 'etc/xdg/openbox/menu.xml'), 'utf8');
    const hasShell = /C-A-t|Terminal|pcmanfm|xterm -fa 'Monospace' -fs 28/.test(rc + menu);
    if (dev === '0') {
      ck('release build: script succeeds', r.status === 0, r.stderr);
      ck('release build: no Terminal / File Explorer shortcut or menu item', !hasShell, rc + menu);
      ck('release build: Unlock, Setup, Browser and Power Off stay', /unlock-vault/.test(menu) && /setup-vault/.test(menu) && /ungoogled-chromium/.test(menu) && /poweroff/.test(menu));
      ck('release build: no developer marker', !existsSync(join(root, 'etc/safekeep-dev-shell')));
      ck('release build: no placeholder left', !/SAFEKEEP_DEV_/.test(rc + menu));
    } else {
      ck('developer build: Terminal + File Explorer shortcuts', /key="C-A-t"/.test(rc) && /key="C-A-f"/.test(rc), rc);
      ck('developer build: menu items', /Terminal \(Ctrl\+Alt\+T\)/.test(menu) && /File Explorer/.test(menu), menu);
      ck('developer build: marker file', existsSync(join(root, 'etc/safekeep-dev-shell')));
    }
    for (const [n, x] of [['rc.xml', rc], ['menu.xml', menu]]) {
      const opens = (x.match(/<(item|keybind|menu|separator)\b/g) || []).length;
      ck(`${dev === '1' ? 'developer' : 'release'} ${n}: tags balanced`, opens > 0 && (x.match(/<\/(item|keybind|menu)>|<separator \/>/g) || []).length === opens, x);
    }
    rmSync(root, { recursive: true, force: true });
  }
  ck('casper.service masked (no eject of the stick at shutdown)', /^systemctl mask casper\.service\b/m.test(setup));
  ck('console-setup + setvtrgb masked (boot logo keeps its font and colours)', /^systemctl mask console-setup\.service setvtrgb\.service\b/m.test(setup));
  ck('console-setup udev rule masked (no font reload under the boot logo)', /^ln -sf \/dev\/null \/etc\/udev\/rules\.d\/90-console-setup\.rules$/m.test(setup));
  ck('splash redrawn after udev settles (graphics driver takeover)', /After=systemd-udev-settle\.service safekeep-splash\.service[\s\S]*ExecStart=\/bin\/cat \/etc\/safekeep-splash\.txt[\s\S]*systemctl enable safekeep-splash-redraw\.service/.test(setup));
  ck('boot logo colours reset bold (22) so colour 3 is not bright yellow', !/\\033\[3[37]m/.test(setup) && !/\\033\[3[37]m/.test(read('safekeep-boot.sh')));
  const build = read('build.sh');
  ck('build.sh passes SAFEKEEP_DEV_SHELL into the chroot', /\/usr\/bin\/env SAFEKEEP_DEV_SHELL="\$SAFEKEEP_DEV_SHELL" [^;]{0,240}\/bin\/bash -c "\/chroot-setup.sh"/.test(build));
  ck('build.sh: chroot gets its own /run, not the build machine\'s', !/mount --bind \/run\b/.test(build) && /mount -t tmpfs [^\n]*"\$CHROOT_DIR\/run"/.test(build));
  ck('build.sh: anything but 1 means off', /\[ "\$SAFEKEEP_DEV_SHELL" = "1" \] \|\| SAFEKEEP_DEV_SHELL=0/.test(build));
  ck('quick-update.sh warns about a developer OS tree', /etc\/safekeep-dev-shell/.test(read('quick-update.sh')));
  ck('File Explorer launcher only in developer builds', /if \[ "\$\{SAFEKEEP_DEV_SHELL:-0\}" = "1" \]; then\ncat > \/usr\/share\/applications\/safekeep-files.desktop/.test(setup));
}

// ---- 2. Network driver families deleted ----
const harden = read('safekeep-harden.sh');
const dropBlock = between(harden, '# --- Whole driver families', 'firewall drivers present."\n');
function moduleTree(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sk-mod-'));
  const k = join(root, 'lib/modules/6.8.0-99-generic');
  const files = ['kernel/drivers/net/ethernet/atheros/alx/alx.ko.zst', 'kernel/drivers/net/usb/ipheth.ko.zst',
    'kernel/drivers/net/usb/pegasus.ko.zst', 'kernel/drivers/net/wireguard/wireguard.ko.zst', 'kernel/drivers/net/ppp/ppp_generic.ko.zst',
    'kernel/drivers/net/wireless/mediatek/mt76/mt7921/mt7921e.ko.zst', 'kernel/net/wireless/cfg80211.ko.zst',
    'kernel/net/mac80211/mac80211.ko.zst', 'kernel/net/bluetooth/bluetooth.ko.zst', 'kernel/drivers/bluetooth/btusb.ko.zst',
    'kernel/drivers/usb/gadget/function/u_ether.ko.zst', 'kernel/drivers/staging/rtl8712/r8712u.ko.zst',
    'kernel/drivers/firewire/firewire-net.ko.zst', 'kernel/drivers/usb/class/cdc-wdm.ko.zst',
    // must survive
    'kernel/drivers/usb/storage/usb-storage.ko.zst', 'kernel/drivers/usb/storage/uas.ko.zst', 'kernel/drivers/usb/host/xhci-pci.ko.zst',
    'kernel/fs/exfat/exfat.ko.zst', 'kernel/fs/overlayfs/overlay.ko.zst', 'kernel/drivers/md/dm-crypt.ko.zst',
    'kernel/net/netfilter/nf_tables.ko.zst', 'kernel/drivers/hid/usbhid/usbhid.ko.zst', 'kernel/drivers/hid/hid-generic.ko.zst',
    'kernel/drivers/media/usb/uvc/uvcvideo.ko.zst', 'kernel/drivers/usb/class/cdc-acm.ko.zst', 'kernel/drivers/staging/media/ipu3/ipu3-imgu.ko.zst',
    'updates/dkms/facetimehd.ko.zst'].filter((f) => !(opts.drop || []).some((d) => f.endsWith('/' + d)));
  for (const f of files) { mkdirSync(dirname(join(k, f)), { recursive: true }); writeFileSync(join(k, f), ''); }
  writeFileSync(join(k, 'modules.builtin'), ['sd_mod', 'xhci-hcd', 'ehci-hcd', 'ext4', 'vfat', 'squashfs', 'loop', 'dm-mod']
    .map((m) => `kernel/x/${m}.ko`).join('\n') + '\n');
  return { root, k };
}
const runDrop = (root, block = dropBlock) => bash('set -euo pipefail\n' + block.replaceAll('/lib/modules/', root + '/lib/modules/'));
{
  const { root, k } = moduleTree();
  const r = runDrop(root);
  ck('driver families: block succeeds', r.status === 0, r.stderr + r.stdout);
  const gone = ['kernel/drivers/net', 'kernel/net/wireless', 'kernel/net/mac80211', 'kernel/net/bluetooth', 'kernel/drivers/bluetooth',
    'kernel/drivers/usb/gadget', 'kernel/drivers/staging/rtl8712', 'kernel/drivers/firewire/firewire-net.ko.zst', 'kernel/drivers/usb/class/cdc-wdm.ko.zst'];
  ck('unlisted NICs, Wi-Fi/Bluetooth stacks, USB gadget, FireWire net deleted', gone.every((p) => !existsSync(join(k, p))), gone.filter((p) => existsSync(join(k, p))).join(', '));
  const kept = ['kernel/drivers/usb/storage/uas.ko.zst', 'kernel/net/netfilter/nf_tables.ko.zst', 'kernel/drivers/hid/usbhid/usbhid.ko.zst',
    'kernel/drivers/media/usb/uvc/uvcvideo.ko.zst', 'kernel/drivers/usb/class/cdc-acm.ko.zst', 'kernel/drivers/staging/media/ipu3/ipu3-imgu.ko.zst', 'updates/dkms/facetimehd.ko.zst'];
  ck('USB storage, firewall, keyboard/HID, cameras kept', kept.every((p) => existsSync(join(k, p))), kept.filter((p) => !existsSync(join(k, p))).join(', '));
  ck('reports the check', /no network driver left/.test(r.stdout), r.stdout);
  rmSync(root, { recursive: true, force: true });
}
{
  const { root } = moduleTree({ drop: ['uas.ko.zst'] });
  const r = runDrop(root);
  ck('a required driver missing fails the build', r.status !== 0 && /required driver 'uas'/.test(r.stderr), r.stderr);
  rmSync(root, { recursive: true, force: true });
}
{
  const { root } = moduleTree();
  const r = runDrop(root, dropBlock.replace('    kernel/drivers/net             #', '    kernel/drivers/not-net         #'));
  ck('a network driver left fails the build', r.status !== 0 && /network driver file\(s\) still present/.test(r.stderr), r.stderr);
  rmSync(root, { recursive: true, force: true });
}

// ---- 3. Build tools removed ----
{
  const sec = between(harden, '# SECTION 6b: REMOVE BUILD TOOLS', '# SECTION 7: INITRAMFS REBUILD');
  ck('build tools section runs before the initramfs rebuild', harden.indexOf('SECTION 6b') < harden.indexOf('SECTION 7: INITRAMFS'));
  for (const p of ['gcc', 'binutils', 'dkms', 'make', 'linux-headers-generic', 'build-essential', 'git'])
    ck(`purges ${p}`, new RegExp(`for _p in [^;]*\\b${p.replace(/[-]/g, '\\-')}\\b`).test(sec));
  ck('dry run refuses to remove anything the stick runs on', /apt-get -s purge/.test(sec) && /ungoogled-chromium/.test(sec) && /exit 1/.test(sec));
  ck('verifies no compiler, assembler or linker is left', /for _tool in gcc cc c\+\+ g\+\+ as ld make dkms git; do/.test(sec));
  ck('verifies the hardware-wallet libraries still import', /safekeep-ckcc\/bin\/python3 -c/.test(sec) && /safekeep-hwi\/bin\/python3 -c/.test(sec));
  ck('keeps the FaceTime camera driver', /facetimehd\.ko/.test(sec));
}

// ---- 4. Network watchdog (safekeep-boot.sh) ----
{
  const boot = read('safekeep-boot.sh');
  const loop = between(boot, '    (\n        NET_SIGNAL_DIR=', '        done\n    ) &');
  const once = 'set -uo pipefail\n' + loop.replace('while true; do', 'for _i in 1; do').replace('/sys/class/net/*', '$FAKE/*')
    .replace('"/tmp/safekeep-signals"', '"$OUT"').replace('sleep 3', ':').replace(/\) &$/, ')');
  const root = mkdtempSync(join(tmpdir(), 'sk-net-'));
  const FAKE = join(root, 'net'), OUT = join(root, 'out'), BIN = join(root, 'bin');
  mkdirSync(join(FAKE, 'lo'), { recursive: true }); mkdirSync(BIN);
  writeFileSync(join(BIN, 'nft'), '#!/bin/sh\n[ -f "$NFT_OK" ]\n', { mode: 0o755 });
  writeFileSync(join(BIN, 'ip'), '#!/bin/sh\necho "$@" >> "$IP_LOG"\n', { mode: 0o755 });
  const env = { FAKE, OUT, PATH: BIN + ':' + process.env.PATH, NFT_OK: join(root, 'nft-ok'), IP_LOG: join(root, 'ip.log') };
  writeFileSync(env.NFT_OK, '');
  const alert = join(OUT, 'NETWORK_ALERT.json');
  let r = bash(once, env);
  ck('watchdog: only lo + firewall loaded → no alert file', r.status === 0 && !existsSync(alert), r.stderr);
  mkdirSync(join(FAKE, 'enx00e04c680001')); mkdirSync(join(FAKE, 'wlan0'));
  r = bash(once, env);
  const a = existsSync(alert) ? JSON.parse(readFileSync(alert, 'utf8')) : null;
  ck('watchdog: new interfaces → alert lists them', a && a.interfaces.join() === 'enx00e04c680001,wlan0' && a.firewall === true, JSON.stringify(a));
  const ipLog = existsSync(env.IP_LOG) ? readFileSync(env.IP_LOG, 'utf8') : '';
  ck('watchdog: interfaces switched off', /link set dev enx00e04c680001 down/.test(ipLog) && /link set dev wlan0 down/.test(ipLog), ipLog);
  rmSync(join(FAKE, 'enx00e04c680001'), { recursive: true }); rmSync(join(FAKE, 'wlan0'), { recursive: true });
  r = bash(once, env);
  ck('watchdog: interfaces gone → alert removed', !existsSync(alert));
  rmSync(env.NFT_OK);
  r = bash(once, env);
  const b = existsSync(alert) ? JSON.parse(readFileSync(alert, 'utf8')) : null;
  ck('watchdog: firewall not loaded → alert', b && b.firewall === false && b.interfaces.length === 0, JSON.stringify(b));
  ck('watchdog: one instance per boot (pid file)', /NETWATCH_PIDFILE="\/run\/safekeep-netwatch.pid"/.test(boot) && /kill -0/.test(boot));
  rmSync(root, { recursive: true, force: true });
}

// ---- 5. App warning text (shared/boot.js) ----
{
  const src = readFileSync(join(HERE, 'shared/boot.js'), 'utf8');
  const fn = between(src, 'function _networkAlertText(alert) {', '\n  }\n');
  const ctx = vm.createContext({}); vm.runInContext(fn, ctx);
  const t = (x) => ctx._networkAlertText(x);
  ck('names listed', /Network hardware appeared \(enx1, wlan0\)/.test(t({ interfaces: ['enx1', 'wlan0'], firewall: true })));
  ck('odd names dropped (no markup reaches the page)', !/img/.test(t({ interfaces: ['<img src=x>', 'eth0'], firewall: true })) && /\(eth0\)/.test(t({ interfaces: ['<img src=x>', 'eth0'], firewall: true })));
  ck('firewall warning', /firewall is not loaded/.test(t({ interfaces: [], firewall: false })));
  ck('nothing to report → no warning', t({ interfaces: [], firewall: true }) === '' && t({}) === '');
  ck('tells the user what to do', /Unplug any network cable/.test(t({ interfaces: ['eth0'] })));
  ck('polled only on the boot drive', /if \(isBootDrive\(\) && typeof document !== 'undefined'\)/.test(src) && /textContent = text/.test(src));
}

// ---- 6. Chromium pin (chroot-setup.sh) ----
{
  const setup = read('chroot-setup.sh');
  const tag = (setup.match(/^UC_PIN_TAG_DEFAULT="([^"]*)"/m) || [])[1];
  const hash = (setup.match(/^UC_EXPECTED_SHA256_DEFAULT="([^"]*)"/m) || [])[1];
  ck('a Chromium release and its SHA-256 are pinned by default', /^\d+\.\d+\.\d+\.\d+-\d+$/.test(tag || '') && /^[0-9a-f]{64}$/.test(hash || ''), tag + ' ' + hash);
  // Run the download gate with stand-ins: wget writes a known file, the
  // version check sees a known version line.
  const gate = between(setup, 'UC_PIN_TAG_DEFAULT=', 'chmod +x /tmp/uc.AppImage\n');
  const record = between(setup, 'if ! UC_VERSION_LINE=$(ungoogled-chromium --version); then', '> /etc/safekeep-chromium\nfi\n');
  function runGate(env, { version } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'sk-uc-'));
    const bin = join(root, 'bin'); mkdirSync(bin); mkdirSync(join(root, 'etc'));
    writeFileSync(join(bin, 'wget'), '#!/bin/bash\nout=""; while [ $# -gt 0 ]; do [ "$1" = -O ] && { out="$2"; shift; }; url="$1"; shift; done\necho "$url" > "' + root + '/url"\nprintf "fake appimage" > "$out"\n', { mode: 0o755 });
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\necho \'"browser_download_url": "https://example.invalid/latest-x86_64.AppImage"\'\n', { mode: 0o755 });
    writeFileSync(join(bin, 'ungoogled-chromium'), '#!/bin/bash\necho "Chromium ' + (version || '155.0.8059.84') + '"\n', { mode: 0o755 });
    const script = 'set -e\n' + ('UC_PIN_TAG_DEFAULT=' + gate.slice('UC_PIN_TAG_DEFAULT='.length)).replaceAll('/tmp/uc.AppImage', root + '/uc.AppImage') +
      record.replaceAll('/etc/safekeep-chromium', root + '/etc/safekeep-chromium');
    const r = bash(script, { PATH: bin + ':' + process.env.PATH, ...env });
    const url = existsSync(join(root, 'url')) ? readFileSync(join(root, 'url'), 'utf8').trim() : '';
    const rec = existsSync(join(root, 'etc/safekeep-chromium')) ? readFileSync(join(root, 'etc/safekeep-chromium'), 'utf8').trim() : '';
    rmSync(root, { recursive: true, force: true });
    return { r, url, rec };
  }
  const fakeSha = (spawnSync('bash', ['-c', 'printf "fake appimage" | sha256sum | cut -d" " -f1'], { encoding: 'utf8' }).stdout || '').trim();
  let g = runGate({});
  ck('default build: downloads the pinned release\'s file directly', g.url === `https://github.com/ungoogled-software/ungoogled-chromium-portablelinux/releases/download/${tag}/ungoogled-chromium-${tag}-x86_64.AppImage`, g.url);
  ck('default build: a file that doesn\'t match the pinned hash stops the build', g.r.status !== 0 && /SHA-256 mismatch/.test(g.r.stderr), g.r.stderr);
  g = runGate({ UC_PIN_TAG: '155.0.8059.84-1', UC_EXPECTED_SHA256: fakeSha });
  ck('matching hash and version: passes and records the pinned browser', g.r.status === 0 && g.rec === `pinned 155.0.8059.84-1 ${fakeSha}`, g.r.stderr + g.rec);
  g = runGate({ UC_PIN_TAG: '155.0.8059.84-1', UC_EXPECTED_SHA256: fakeSha }, { version: '156.0.8078.47' });
  ck('a browser reporting another version stops the build', g.r.status !== 0 && /expected Chromium 155\.0\.8059\.84/.test(g.r.stderr), g.r.stderr);
  g = runGate({ UC_PIN_TAG: '156.0.8078.47-1' });
  ck('a new tag without its own hash stops the build (the default hash won\'t match)', g.r.status !== 0 && /mismatch/.test(g.r.stderr));
  g = runGate({ UC_EXPECTED_SHA256: 'not-a-hash' });
  ck('a malformed hash stops the build', g.r.status !== 0 && /must be pinned/.test(g.r.stderr));
  g = runGate({ UC_ALLOW_UNPINNED: '1' });
  ck('UC_ALLOW_UNPINNED=1: latest, a loud warning, recorded as UNPINNED', g.r.status === 0 && g.url.includes('latest') && /Do not release this image/.test(g.r.stderr) && g.rec.startsWith('UNPINNED '), g.r.stderr + g.rec);
  const build = read('build.sh');
  ck('build.sh passes the pin overrides into the chroot', /UC_PIN_TAG="\$\{UC_PIN_TAG:-\}" UC_EXPECTED_SHA256="\$\{UC_EXPECTED_SHA256:-\}" UC_ALLOW_UNPINNED="\$\{UC_ALLOW_UNPINNED:-\}"/.test(build));
}

// ---- 7. Chromium policy: Paste without a permission prompt ----
// The Encrypted Notes Paste button reads the clipboard; without this
// policy Chromium asks for permission every time. Only file:// is allowed.
{
  const policyIn = (text, endTag) => {
    const m = text.match(new RegExp('safekeep\\.json"[^\\n]*<< \'?' + endTag + '\'?\\n([\\s\\S]*?)\\n' + endTag));
    return m ? JSON.parse(m[1].replace(/\$CHROMIUM_DOWNLOAD_DIR/g, '/x')) : null;
  };
  for (const [file, tag] of [['safekeep-boot.sh', 'POLICYEOF'], ['build.sh', 'POLICY_EOF']]) {
    const pol = policyIn(read(file), tag);
    ck(`${file}: the Chromium policy is valid JSON`, !!pol);
    ck(`${file}: clipboard reading is allowed for file:// only`, pol && JSON.stringify(pol.ClipboardAllowedForUrls) === '["file://*","file:///*"]' && !('DefaultClipboardSetting' in pol), JSON.stringify(pol));
  }
  ck('safekeep-boot.sh: DevTools stay disallowed', policyIn(read('safekeep-boot.sh'), 'POLICYEOF')?.DeveloperToolsAvailability === 2);
}

// ---- 8. Building on an arm64 computer (an Apple Silicon Mac's Ubuntu VM) ----
// The chroot's amd64 programs need a binfmt translator registered with the
// F flag (QEMU or Rosetta); legacy-boot GRUB files come from a pinned deb.
{
  const build = read('build.sh');
  const fn = build.match(/\n    (amd64_translator\(\) \{[\s\S]*?\n    \})\n/);
  ck('build.sh has the amd64 translator check', !!fn);
  if (fn) {
    const dir = mkdtempSync(join(tmpdir(), 'binfmt-'));
    const X86 = 'magic 7f454c4602010100000000000000000002003e00\nmask fffffffffffefe00fffffffffffffffffeffffff\n';
    const ARM = 'magic 7f454c460201010000000000000000000200b700\nmask ffffffffffffff00fffffffffffffffffeffffff\n';
    const run = (entries) => {
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
      for (const [name, text] of Object.entries(entries)) writeFileSync(join(dir, name), text);
      writeFileSync(join(dir, 'register'), ''); writeFileSync(join(dir, 'status'), 'enabled\n');
      const r = spawnSync('bash', ['-c', fn[1].replace(/\n {4}/g, '\n') + '\namd64_translator'], { env: { ...process.env, BINFMT_DIR: dir }, encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    };
    ck('QEMU for amd64 with the F flag is accepted', run({ 'qemu-x86_64': 'enabled\ninterpreter /usr/libexec/qemu-binfmt/x86_64-binfmt-P\nflags: POCF\noffset 0\n' + X86 }) === 'qemu-x86_64');
    ck('Rosetta with the F flag is accepted', run({ rosetta: 'enabled\ninterpreter /media/rosetta/rosetta\nflags: OCF\noffset 0\n' + X86 }) === 'rosetta');
    ck('a handler without the F flag is refused (it would fail inside the chroot)', run({ rosetta: 'enabled\ninterpreter /media/rosetta/rosetta\nflags: \noffset 0\n' + X86 }) === null);
    ck('a disabled handler is refused', run({ 'qemu-x86_64': 'disabled\ninterpreter /x\nflags: F\noffset 0\n' + X86 }) === null);
    ck('a handler for another architecture is refused', run({ 'qemu-aarch64': 'enabled\ninterpreter /x\nflags: F\noffset 0\n' + ARM }) === null);
    ck('no handlers: refused', run({}) === null);
    rmSync(dir, { recursive: true, force: true });
  }
  ck('build.sh pins grub-pc-bin at the signed GRUB\'s version, by SHA-256',
    /GRUB_PC_DEB="grub-pc-bin_2\.12-1ubuntu7\.3_amd64\.deb"/.test(build) && /SIGNED_GRUB_DEB="grub-efi-amd64-signed_1\.202\.5\+2\.12-1ubuntu7\.3_amd64\.deb"/.test(build)
    && /GRUB_PC_DEB_SHA256="[0-9a-f]{64}"/.test(build) && /fetch_pinned_deb g\/grub2 "\$GRUB_PC_DEB" "\$GRUB_PC_DEB_SHA256"/.test(build));
  ck('legacy-boot grub-install uses those files only on a non-amd64 computer',
    /--target=i386-pc \\\n    \$\{GRUB_BIOS_DIR:\+--directory="\$GRUB_BIOS_DIR"\}/.test(build) && /^GRUB_BIOS_DIR=""$/m.test(build));
  ck('amd64 build computers install the same packages as before',
    /if \[ "\$HOST_ARCH" = "amd64" \]; then\n    command -v grub-install >\/dev\/null \|\| DEPS_NEEDED="\$DEPS_NEEDED grub-pc-bin grub-efi-amd64-bin"/.test(build));
  ck('the build stops if the amd64 chroot\'s programs won\'t run', /if ! chroot "\$CHROOT_DIR" \/bin\/true; then/.test(build));
  const pts = build.match(/if \[ "\$HOST_ARCH" != "amd64" \]; then\n    mount --make-private "\$CHROOT_DIR\/dev"\n    mount -t devpts -o newinstance[^\n]*"\$CHROOT_DIR\/dev\/pts"\nfi/);
  ck('arm64 builds: the chroot gets a private /dev/pts (made private before mounting)', !!pts && build.indexOf(pts[0]) > build.indexOf('mount --bind /dev "$CHROOT_DIR/dev"'));
  const ptsUm = build.match(/umount -l "\$CHROOT_DIR\/dev\/pts"[^\n]*\n\s*umount -l "\$CHROOT_DIR\/dev" /g) || [];
  ck('/dev/pts is unmounted before /dev in both places', ptsUm.length === 2, ptsUm.length);
  const setup = read('chroot-setup.sh');
  ck('arm64 builds: the AppImage marker is zeroed only after the SHA-256 check, only on arm64',
    /BUILD_HOST_ARCH="\$HOST_ARCH"/.test(build) && /if \[ "\$\{BUILD_HOST_ARCH:-amd64\}" != "amd64" \]; then\n    printf '\\0\\0\\0' \| dd of=\/tmp\/uc\.AppImage bs=1 seek=8 count=3 conv=notrunc/.test(setup)
    && setup.indexOf('OK: AppImage SHA-256 matches') < setup.indexOf("printf '\\0\\0\\0' | dd of=/tmp/uc.AppImage"));
  ck('arm64 builds: the chroot steps read from /dev/null (apt is stopped by SIGTTOU otherwise)',
    /chroot_step\(\) \{\n    if \[ "\$HOST_ARCH" != "amd64" \]; then "\$@" <\/dev\/null; else "\$@"; fi\n\}/.test(build)
    && /chroot_step chroot "\$CHROOT_DIR" \/usr\/bin\/env SAFEKEEP_DEV_SHELL/.test(build) && /chroot_step chroot "\$CHROOT_DIR" \/bin\/bash -c "safekeep-harden"/.test(build));
}

// ---- 9. A Transfer Drive that fills a larger flash drive (TRANSFER_DRIVE_DESIGN.md) ----
{
  const r = spawnSync('python3', [join(OS, 'tests', 'test-grow-transfer.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (/^SKIP/m.test(r.stdout || '')) console.log('  (' + r.stdout.trim() + ')');
  else ck('grow-transfer.sh passes its tests (real sgdisk on disk images)', r.status === 0, (r.stdout || '').split('\n').filter((l) => /FAIL|passed/.test(l)).join(' | ') + (r.stderr || ''));
}

// ---- 10. Restore brings back data only (requests, links and devices never) ----
{
  const r = spawnSync('python3', [join(OS, 'tests', 'test-restore-copy.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  ck('Restore copies data only: no requests, links or special files (test-restore-copy.py)', r.status === 0, (r.stdout || '').split('\n').filter((l) => /FAIL|passed/.test(l)).join(' | ') + (r.stderr || ''));
  const boot = read('safekeep-boot.sh');
  ck('Restore no longer uses cp -a or copies top-level files', !/sudo cp -a "\$PROBE_ROOT\/\$VDIR\/\." /.test(boot) && !/root-level files copied/.test(boot));
}

// ---- 11. Audit fixes (Nov 2026): swap, DMA, sleep, crash restart, build checks ----
{
  const grub = readFileSync(join(OS, 'grub.cfg'), 'utf8');
  const lines = grub.split('\n').filter((l) => /^\s*linux\s/.test(l));
  ck('every boot entry turns swap off (noswap)', lines.length === 3 && lines.every((l) => / noswap /.test(l)), lines.join(' | '));
  ck('FireWire controllers are blocked (a FireWire device can read memory directly)',
    ['firewire_ohci', 'firewire_sbp2', 'firewire_core'].every((m) => new RegExp('^blacklist ' + m + '$', 'm').test(harden) && new RegExp('^install ' + m + ' /bin/false$', 'm').test(harden)));
  ck('the computer never sleeps or hibernates',
    /HandleLidSwitch=ignore/.test(harden) && /HandleSuspendKey=ignore/.test(harden) && /AllowSuspend=no/.test(harden) && /AllowHibernation=no/.test(harden)
    && /for _t in sleep\.target suspend\.target hibernate\.target hybrid-sleep\.target suspend-then-hibernate\.target; do\n    systemctl mask "\$_t"/.test(harden));
  const swapScript = harden.match(/cat > \/etc\/initramfs-tools\/scripts\/casper-bottom\/13swap << 'NOSWAP_EOF'\n([\s\S]*?)\nNOSWAP_EOF\n/);
  ck('casper\'s startup swap script is replaced by one that turns nothing on', !!swapScript && !/swapon/.test(swapScript[1]) && /exit 0\s*$/.test(swapScript[1])
    && harden.indexOf('NOSWAP_EOF') < harden.indexOf('update-initramfs -u -k all') && /systemctl mask swap\.target/.test(harden));
  if (swapScript) {
    const r1 = spawnSync('sh', ['-c', swapScript[1], 'sh', 'prereqs'], { encoding: 'utf8' });
    const r2 = spawnSync('sh', ['-c', swapScript[1]], { encoding: 'utf8' });
    ck('  it answers initramfs-tools\' prereqs call and exits cleanly', r1.status === 0 && r1.stdout.trim() === '' && r2.status === 0);
  }
  const build = read('build.sh');
  ck('the build unpacks the initramfs and stops if it would still turn on swap',
    /chroot "\$CHROOT_DIR" unmkinitramfs/.test(build) && /grep -q "SafeKeep: replaces casper's 13swap" "\$SK_SWAP" \|\| grep -q swapon "\$SK_SWAP"/.test(build));
  const chk = build.indexOf('INITRD_IN_CHROOT=');
  ck('the build checks the initramfs (no network drivers, has the module blocks) after hardening',
    chk > build.indexOf('chroot_step chroot "$CHROOT_DIR" /bin/bash -c "safekeep-harden"') && chk < build.indexOf('mksquashfs "$CHROOT_DIR"')
    && /lsinitramfs/.test(build) && /drivers\/net\|drivers\/bluetooth\|net\/wireless\|net\/bluetooth/.test(build) && /safekeep-no-host-storage\.conf' \\\n    \|\| \{ echo "ERROR/.test(build));
  ck('the build stops if the firewall isn\'t installed, set to drop, and enabled',
    /\[ -x "\$CHROOT_DIR\/usr\/sbin\/nft" \] \|\| \{ echo "ERROR/.test(build) && /policy drop;' "\$CHROOT_DIR\/etc\/nftables\.conf"/.test(build) && /nftables\.service >\/dev\/null 2>&1 \\\n    \|\| \{ echo "ERROR/.test(build));
  ck('the ruleset the build looks for is the one hardening writes', harden.includes('type filter hook output priority 0; policy drop;'));
  const boot = read('safekeep-boot.sh');
  const crash = between(boot, '# Still unlocked from a previous run?', '\nfi\n');
  ck('a restart after a crash locks the vault instead of reopening it',
    !/Vault already mounted\. Launching browser/.test(boot) && !/launch_browser/.test(crash) && /sudo cryptsetup close "\$MAPPER_NAME"/.test(crash) && /exec sleep infinity/.test(crash));
  ck('that check comes before first setup and the unlock prompt',
    boot.indexOf('# Still unlocked from a previous run?') < boot.indexOf('Vault mounted after setup') && boot.indexOf('# Still unlocked from a previous run?') < boot.indexOf('unlock-vault || UNLOCK_EXIT=$?'));
  const nameFn = boot.match(/\n\s*(_rlq_name_ok\(\) \{[\s\S]*?\n\s*\})\n/);
  ck('Restore checks the backup\'s file name', !!nameFn);
  if (nameFn) {
    const okName = (n) => spawnSync('bash', ['-c', nameFn[1] + '\n_rlq_name_ok "$1"', '_', n]).status === 0;
    ck('  accepts backup names', okName('SafeKeep-Backup-2026-11-23.7z') && okName('my backup.7Z'));
    ck('  refuses paths, hidden files, other types and control characters',
      !okName('../etc/x.7z') && !okName('a/b.7z') && !okName('.hidden.7z') && !okName('backup.zip') && !okName('') && !okName('bad\nname.7z'));
  }
  ck('Restore leaves no password or path file behind', !/\.archive_pw/.test(boot) && !/\.archive_path/.test(boot));
  ck('an inspected backup that is never restored is cleared after 10 minutes', /\.inspect_token/.test(boot) && /sleep 600/.test(boot), 'expects .inspect_token and sleep 600');
  const app = readFileSync(join(HERE, 'boot.html'), 'utf8');
  ck('passphrase generator: 6 words by default, shown as selected',
    /var pp_config = \{\n    wordCount: 6,/.test(app) && /id="pp-wc-6" style="flex: 1; background: var\(--skb-primary\)/.test(app) && /id="pp-wc-4" style="flex: 1; background: var\(--skb-bg-input\);"/.test(app));
  ck('Auto-Lock also checks the real time (a timer pauses while a computer sleeps)',
    /function _checkAutoLockDeadline\(\) \{/.test(app) && /setInterval\(_checkAutoLockDeadline, 5000\)/.test(app));
}

console.log(`\nOS LOCKDOWN: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

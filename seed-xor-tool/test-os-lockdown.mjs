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
  const build = read('build.sh');
  ck('build.sh passes SAFEKEEP_DEV_SHELL into the chroot', /\/usr\/bin\/env SAFEKEEP_DEV_SHELL="\$SAFEKEEP_DEV_SHELL" \/bin\/bash -c "\/chroot-setup.sh"/.test(build));
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

console.log(`\nOS LOCKDOWN: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

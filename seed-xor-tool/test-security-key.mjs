/**
 * test-security-key.mjs — unlocking the vault with a security key
 * (SECURITY_KEY_DESIGN.md, Part 1)
 *
 *   1. unlock-vault.sh and manage-security-key.sh, run for real on a LUKS2
 *      file, with stand-ins for zenity (answers played back), sudo, blkid,
 *      mount and losetup, and the real safekeep-fido2.py talking (through
 *      python-fido2) to a software FIDO2 key (usbbootdrive/tests/
 *      virtual_fido2.py). A whole story: add a key to a passphrase vault,
 *      unlock with it, a wrong PIN, a key that isn't the vault's, security
 *      keys only, the last key can't go, a spare, the passphrase back.
 *      Skipped, and said so, without cryptsetup or python3-fido2.
 *   2. Wiring: the "securitykey" power action, the image (package, files,
 *      udev rules, SysRq), and the app (Device Options, bridge, summary).
 *
 *   The helper itself is tested in usbbootdrive/tests/test-fido2-helper.py.
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, chmodSync, rmSync, truncateSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USB = new URL('../usbbootdrive/', import.meta.url);
const read = (f) => readFileSync(new URL(f, USB), 'utf8');
const path = (f) => new URL(f, USB).pathname;

let pass = 0, fail = 0, skipped = 0;
function ck(name, ok, detail) {
    if (ok) { pass++; } else { fail++; console.log('FAIL', name, detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1).slice(0, 3000))); }
}

const PASS = 'x7#Qp9!vLm2@Zr8$Tq4w';
const NEWPASS = 'Tq4w$Zr8@vLm2!Qp9#x7';
const PIN = '482916';
const haveCryptsetup = spawnSync('cryptsetup', ['--version']).status === 0;
const haveFido2 = spawnSync('python3', ['-c', 'import fido2']).status === 0;
const tmp = mkdtempSync(join(tmpdir(), 'seckey-'));

try {
    if (!haveCryptsetup || !haveFido2) {
        console.log(`SKIP: part 1 needs cryptsetup and python3-fido2 (cryptsetup: ${haveCryptsetup}, fido2: ${haveFido2}).`);
        skipped++;
    } else {
        const bin = join(tmp, 'bin');
        mkdirSync(bin);
        const stub = (name, body) => { writeFileSync(join(bin, name), '#!/bin/bash\n' + body + '\n'); chmodSync(join(bin, name), 0o755); };
        // zenity plays back "exit code<TAB>output[<TAB>key file to plug in]";
        // the third field swaps the plugged-in security key before answering.
        stub('zenity', `printf '%s\\n' "$*" >> "$ZLOG"
case " $* " in *" --progress "*) exec cat >/dev/null;; esac
line=$(head -n1 "$ZQUEUE"); sed -i 1d "$ZQUEUE"
if [ -z "$line" ]; then echo "QUEUE EMPTY" >> "$ZLOG"; kill -TERM "$TESTPID"; exit 1; fi
rc=\${line%%$'\\t'*}; rest=\${line#*$'\\t'}; out=\${rest%%$'\\t'*}; swap=""
[ "$rest" != "$out" ] && swap=\${rest#*$'\\t'}
[ -n "$swap" ] && printf '%s' "$swap" > "$KEY_POINTER"
printf '%s' "$out"; exit "$rc"`);
        stub('sudo', 'exec "$@"');
        stub('blkid', 'echo /dev/fake-data');
        stub('mount', 'exit 0');
        stub('umount', 'exit 0');
        stub('chmod', 'exit 0');
        stub('mountpoint', '[ "${@: -1}" = "$VAULT_MOUNT_TEST" ] && exit 1; exit 0');
        stub('losetup', 'case "$1" in -j) exit 0;; --find) echo "$3";; -d) exit 0;; esac');
        // cryptsetup open needs device-mapper: check the key with
        // --test-passphrase instead, and log what opened it.
        const realCs = spawnSync('bash', ['-c', 'command -v cryptsetup']).stdout.toString().trim();
        stub('cryptsetup', `if [ "$1" = open ] && [ "$2" != --test-passphrase ]; then
  dev=$2; mapper=$3; shift 3
  if [ "\${1:-}" = "--key-file=-" ]; then key=$(cat); printf '%s' "$key" | ${realCs} open --test-passphrase "$dev" --key-file=- || exit 2
  else ${realCs} open --test-passphrase "$dev" "$@" || exit 2; fi
  echo "opened $mapper $*" >> "$OPENLOG"; exit 0
fi
exec ${realCs} "$@"`);
        // The helper, with the software key that KEY_POINTER names "plugged in".
        const wrap = join(tmp, 'fido2-wrap.py');
        writeFileSync(wrap, `import os, runpy, sys
sys.path.insert(0, ${JSON.stringify(path('tests/'))})
import virtual_fido2
virtual_fido2.install(open(os.environ["KEY_POINTER"]).read().strip())
sys.argv = [${JSON.stringify(path('safekeep-fido2.py'))}] + sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`);
        const newKey = (name, state = {}) => { const p = join(tmp, name + '.json'); writeFileSync(p, JSON.stringify(state)); return p; };
        const keyA = newKey('keyA', { product: 'Blue' });
        const keyB = newKey('keyB', { pin: PIN });
        const stranger = newKey('stranger', { pin: PIN });
        const keyState = (p) => JSON.parse(readFileSync(p, 'utf8'));

        const dataDir = join(tmp, 'data');
        mkdirSync(dataDir);
        const vfile = join(dataDir, '.vault.luks');
        writeFileSync(vfile, '');
        truncateSync(vfile, 20 * 1024 * 1024);
        let r = spawnSync('cryptsetup', ['luksFormat', '-q', '--type', 'luks2', '--pbkdf', 'pbkdf2', '--pbkdf-force-iterations', '1000', vfile, '--key-file=-'], { input: PASS });
        if (r.status !== 0) throw new Error('luksFormat failed');
        const opens = (secret) => spawnSync('cryptsetup', ['open', '--test-passphrase', vfile, '--key-file=-'], { input: secret }).status === 0;
        const signals = join(tmp, 'signals');
        const status = () => {
            writeFileSync(join(tmp, 'ptr'), keyA);
            const s = spawnSync('python3', [wrap, 'status', vfile], { env: { PATH: bin + ':' + process.env.PATH, KEY_POINTER: join(tmp, 'ptr'), SAFEKEEP_FIDO2_TEST: '1' } });
            return s.status === 0 ? JSON.parse(s.stdout) : null;
        };

        const run = (script, answers, plugged = keyA) => {
            writeFileSync(join(tmp, 'queue'), answers.map((a) => a.join('\t')).join('\n') + '\n');
            writeFileSync(join(tmp, 'zlog'), '');
            writeFileSync(join(tmp, 'opens'), '');
            writeFileSync(join(tmp, 'ptr'), plugged);
            rmSync(signals, { recursive: true, force: true });
            const res = spawnSync('bash', ['-c', 'TESTPID=$$; exec bash "$0"', path(script)], {
                timeout: 120000,
                env: { PATH: bin + ':' + process.env.PATH, ZLOG: join(tmp, 'zlog'), ZQUEUE: join(tmp, 'queue'),
                    KEY_POINTER: join(tmp, 'ptr'), OPENLOG: join(tmp, 'opens'), VAULT_MOUNT_TEST: join(tmp, 'vault-mnt'),
                    HAS_CAMERA: 'false', QR_SCAN_TIMEOUT: '1', SAFEKEEP_DATA_MOUNT: dataDir, SAFEKEEP_VAULT_MOUNT: join(tmp, 'vault-mnt'),
                    SAFEKEEP_SIGNALS: signals, FIDO2_HELPER: wrap,
                    SAFEKEEP_SECURITY_KEY_DIALOGS: path('security-key-dialogs.sh'),
                    SAFEKEEP_PASSPHRASE_DIALOGS: path('passphrase-dialogs.sh'), SAFEKEEP_PASSPHRASE_HELPER: path('safekeep-passphrase.py'),
                    PWCHECK: path('safekeep-pwcheck.py'), SAFEKEEP_PWCHECK_LISTS: path('pwcheck-lists.json'),
                    SAFEKEEP_PASSPHRASE_TEST_FILE: '1', SAFEKEEP_FIDO2_TEST: '1', SAFEKEEP_FIDO2_FAST: '1' },
            });
            const summaryFile = join(signals, 'UNLOCK_METHODS.json');
            return { status: res.status, log: readFileSync(join(tmp, 'zlog'), 'utf8'),
                left: readFileSync(join(tmp, 'queue'), 'utf8').trim(), opens: readFileSync(join(tmp, 'opens'), 'utf8'),
                summary: existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : null,
                rating: existsSync(join(signals, 'PASSPHRASE_RATING.json')), stderr: res.stderr.toString() };
        };
        const OK = ['0', ''];
        const methodsShown = (log) => (log.split('\n').find((l) => l.includes('--title=Unlock Vault') && l.includes('--column=Method')) || '');

        // --- A passphrase-only vault unlocks as before ---
        let u = run('unlock-vault.sh', [['0', 'Type Password'], ['0', PASS]]);
        ck('unlock: a passphrase vault opens with the passphrase', u.status === 0 && u.opens.includes('opened vault') && !u.left, u);
        ck('unlock: no security key choice on a passphrase-only vault', !methodsShown(u.log).includes('Use a Security Key')
            && methodsShown(u.log).includes('How would you like to enter your Master Passphrase?'), methodsShown(u.log));
        ck('unlock: the summary says passphrase, no keys', JSON.stringify(u.summary) === JSON.stringify({ method: 'passphrase', passphrase: true, keys: [] }), u.summary);
        ck('unlock: the passphrase is still rated', u.rating);

        // --- Add a key (it has no PIN yet) ---
        let m = run('manage-security-key.sh', [OK, ['0', 'Type Password'], ['0', PASS], ['0', 'Add a security key'],
            ['0', ''], ['0', PIN], ['0', PIN], ['0', 'Blue YubiKey'], OK, ['0', 'Done'], OK]);
        let s = status();
        ck('manage: adds a key, setting its PIN first', m.status === 0 && s && s.keys.length === 1 && s.keys[0].name === 'Blue YubiKey' && s.passphrase && !m.left, { m, s });
        ck('manage: warns that 8 wrong PINs lock the key for good', m.log.includes('After 8 wrong PINs, the key locks for good'));
        ck('manage: the key got the PIN', keyState(keyA).pin === PIN);
        ck('manage: suggests a spare after the first key', m.log.includes('A spare security key, kept somewhere else'));
        ck('manage: the menu shows how the vault unlocks', m.log.includes('This vault unlocks with: Master Passphrase') && m.log.includes('This vault unlocks with: Passphrase or security key'), m.log);
        ck('manage: no dialog shows the passphrase or the PIN as text', !m.log.includes(PASS) && !m.log.split('\n').some((l) => l.includes(PIN) && !l.includes('--hide-text')), m.log);
        ck('manage: the PIN is typed into hidden entries', (m.log.match(/--entry --hide-text/g) || []).length === 2);
        ck('manage: the passphrase still opens the vault', opens(PASS));

        // --- Unlock with the key ---
        u = run('unlock-vault.sh', [['0', 'Use a Security Key'], ['0', PIN]]);
        ck('unlock: "Use a Security Key" is offered first', /--hide-header Use a Security Key Type Password Boot Temporary Session/.test(methodsShown(u.log)), methodsShown(u.log));
        ck('unlock: opens with the key, through its own key slot', u.status === 0 && /opened vault --key-slot \d+/.test(u.opens) && !u.left, u);
        ck('unlock: the summary says key, with the key\'s name', u.summary && u.summary.method === 'key' && u.summary.passphrase === true && u.summary.keys[0].name === 'Blue YubiKey', u.summary);
        ck('unlock: no passphrase rating after a key unlock', !u.rating);
        ck('unlock: asks to touch the key', u.log.includes('Touch your security key now'));

        u = run('unlock-vault.sh', [['0', 'Use a Security Key'], ['0', '000000'], OK, ['0', 'Use a Security Key'], ['0', PIN]]);
        ck('unlock: a wrong PIN says how many tries are left, then the right one opens', u.status === 0 && u.log.includes('Wrong PIN. 7 tries left') && !u.left, u.log);
        u = run('unlock-vault.sh', [['0', 'Use a Security Key'], ['0', PIN], OK, ['0', 'Type Password'], ['0', PASS]], stranger);
        ck('unlock: a key that isn\'t the vault\'s is refused; the passphrase still works', u.status === 0 && u.log.includes("isn't one of this vault's keys") && !u.left, u.log);
        u = run('unlock-vault.sh', [['0', 'Use a Security Key'], OK, ['0', PIN]], newKey('nothing', { count: 0 }));
        ck('unlock: no key plugged in → asks to plug it in', u.log.includes('No security key was found'), u.log);
        u = run('unlock-vault.sh', [['0', 'Boot Temporary Session (RAM Only)']]);
        ck('unlock: the Temporary Session is still offered', u.status === 3 && !u.left, u);

        // --- Security keys only ---
        m = run('manage-security-key.sh', [OK, ['0', 'Use a Security Key'], ['0', PIN], ['0', 'Use security keys only (remove the Master Passphrase)'],
            ['0', ''], ['0', 'Done'], OK]);
        ck('keys only: not done without checking the box', status().passphrase === true && opens(PASS) && !m.left, m);
        m = run('manage-security-key.sh', [OK, ['0', 'Use a Security Key'], ['0', PIN], ['0', 'Use security keys only (remove the Master Passphrase)'],
            ['0', 'I understand, and want security keys only'], OK, ['0', 'Done'], OK]);
        s = status();
        ck('keys only: the Master Passphrase is removed', m.status === 0 && s.passphrase === false && s.keys.length === 1 && !opens(PASS) && !m.left, { m, s });
        ck('keys only: the warning names the risk, the seed backup and the Encrypted Backup',
            m.log.includes("this vault can't be opened") && m.log.includes('Your seed backup still restores your wallet') && m.log.includes('Encrypted Backup'), m.log);
        ck('keys only: with one key, it says so', m.log.includes('Only one security key can open this vault'));
        ck('keys only: the box must be checked (a checklist)', m.log.includes('--list --checklist'));
        ck('keys only: the end message says how to unlock now', m.log.includes('Choose Use a Security Key'));

        u = run('unlock-vault.sh', [['0', 'Use a Security Key'], ['0', PIN]]);
        ck('unlock: a keys-only vault offers only the key (and a Temporary Session)',
            /This vault unlocks with a security key\..*--hide-header Use a Security Key Boot Temporary Session/.test(methodsShown(u.log)) && u.status === 0, methodsShown(u.log));
        ck('unlock: the summary says no passphrase', u.summary && u.summary.passphrase === false);

        // --- The last key can't go; a spare; then the passphrase back ---
        m = run('manage-security-key.sh', [OK, ['0', 'Use a Security Key'], ['0', PIN], ['0', 'Remove a security key'], ['0', String(s.keys[0].slot)], OK,
            ['0', 'Add a security key', keyB], ['0', PIN], ['0', 'Spare'], OK, ['0', 'Done'], OK]);
        s = status();
        ck('remove: the last key of a keys-only vault is refused', m.log.includes('That would leave no way to open this vault'), m.log);
        ck('add: a spare, while unlocked with the first key', s.keys.length === 2 && s.keys[1].name === 'Spare' && !m.left, { m: m.log, s });
        ck('add: the spare\'s PIN is asked with its tries left', m.log.includes('8 tries left'));

        const spareSlot = String(s.keys[1].slot), firstSlot = String(s.keys[0].slot);
        m = run('manage-security-key.sh', [OK, ['0', 'Use a Security Key'], ['0', PIN], ['0', 'Remove a security key'], ['0', firstSlot], OK,
            OK, ['0', 'Use a Security Key', keyB], ['0', PIN], OK, ['0', 'Done'], OK]);
        s = status();
        ck('remove: removing the key you unlocked with asks for another way, then removes it',
            m.log.includes('You unlocked with "Blue YubiKey"') && s.keys.length === 1 && s.keys[0].name === 'Spare' && !m.left, { log: m.log, s });

        m = run('manage-security-key.sh', [OK, ['0', 'Use a Security Key'], ['0', PIN], ['0', 'Add a Master Passphrase'],
            ['0', 'Type Password'], ['0', NEWPASS], ['0', NEWPASS], OK, ['0', 'Rename a security key'], ['0', spareSlot], ['0', 'Drawer key'], ['0', 'Done'], OK], keyB);
        s = status();
        ck('add passphrase: back to Passphrase or security key', s.passphrase === true && opens(NEWPASS) && !m.left, { log: m.log, s });
        ck('add passphrase: uses the setup screens and their strength check', m.log.includes('How would you like to set your Master Passphrase?'));
        ck('rename: renames a key', s.keys[0].name === 'Drawer key', s);
        m = run('manage-security-key.sh', [OK, ['0', 'Use a Security Key'], ['0', PIN], ['0', 'Done'], OK], stranger);
        ck('manage: a key that isn\'t the vault\'s can\'t unlock the settings', m.log.includes("isn't one of this vault's keys"), m.log);
        m = run('manage-security-key.sh', [['1', ''], ]);
        ck('manage: Cancel at the start changes nothing', m.status === 0 && !m.left, m);
        ck('manage: secrets never reach the dialogs', !/[A-Za-z0-9+/]{43}=/.test(m.log));
    }

    // --- 2. Wiring ---
    const boot = read('safekeep-boot.sh'), build = read('build.sh'), quick = read('quick-update.sh');
    const harden = read('safekeep-harden.sh'), chroot = read('chroot-setup.sh'), unlock = read('unlock-vault.sh');
    ck('boot: "securitykey" is an accepted power action', /reboot\|poweroff\|lock\|passphrase\|securitykey\)/.test(boot));
    ck('boot: it locks like Lock and re-runs with SAFEKEEP_MANAGE_SECURITY_KEYS=1',
        boot.includes('[ "$POWER_ACTION" = "securitykey" ]; then') && boot.includes('exec env SAFEKEEP_MANAGE_SECURITY_KEYS=1 /usr/local/bin/safekeep-boot'));
    const unlockAt = boot.indexOf('# ---- UNLOCK THE VAULT ----'), runAt = boot.indexOf('manage-security-key || MANAGE_EXIT=$?');
    ck('boot: manage-security-key runs before the unlock prompt, once',
        runAt > unlockAt && runAt < boot.indexOf('unlock-vault || UNLOCK_EXIT=$?') && boot.includes('unset SAFEKEEP_MANAGE_SECURITY_KEYS'));
    for (const f of ['safekeep-fido2.py', 'security-key-dialogs.sh', 'manage-security-key.sh']) {
        ck(`build.sh requires and installs ${f}`, build.includes(f + ' ') && (build.match(new RegExp(f.replace('.', '\\.'), 'g')) || []).length >= 2, f);
        ck(`quick-update.sh installs ${f}`, quick.includes('install -m') && quick.includes(f), f);
    }
    ck('image: python3-fido2 is installed and checked', chroot.includes('python3-fido2') && chroot.includes('import fido2.hid, fido2.ctap2'));
    ck('image: 60-fido-id.rules is checked at build', chroot.includes('/usr/lib/udev/rules.d/60-fido-id.rules') && harden.includes('/usr/lib/udev/rules.d/60-fido-id.rules'));
    ck('image: the security key library is checked after the build tools go', harden.includes('the security key library (python3-fido2) no longer imports'));
    const rules = (harden.match(/<< 'HID_EOF'\n([\s\S]*?)\nHID_EOF/) || [])[1] || '';
    ck('lockdown: late boot keyboards and mice are still turned off',
        rules.includes('ATTR{bInterfaceClass}=="03", ATTR{bInterfaceSubClass}=="01", RUN+="/bin/sh -c \'echo 0 > /sys$env{DEVPATH}/authorized\'"'));
    ck('lockdown: other late HID is kept only if marked a FIDO2 security token',
        /SUBSYSTEM=="hidraw", ACTION=="add", TEST=="\/run\/safekeep-hid-locked", SUBSYSTEMS=="usb", ENV\{ID_SECURITY_TOKEN\}!="1", RUN\+="[^"]*\.\.\/\.\.\/\.\.\/authorized'"/.test(rules));
    ck('lockdown: late keyboard or mouse input is inhibited', rules.includes('SUBSYSTEM=="input", KERNEL=="input[0-9]*", ACTION=="add", TEST=="/run/safekeep-hid-locked", SUBSYSTEMS=="usb", ATTR{inhibited}="1"'));
    ck('lockdown: the Coldcard exception is unchanged', rules.includes('ATTRS{idVendor}=="d13e", ATTRS{idProduct}=="cc10", GOTO="safekeep_hid_end"'));
    ck('lockdown: no rule lets a late HID device through by brand', !/1050/.test(rules));
    ck('SysRq keys are off', harden.includes('kernel.sysrq=0'));
    const udevadm = spawnSync('bash', ['-c', 'command -v udevadm']).stdout.toString().trim();
    if (udevadm) {
        const rf = join(tmp, '85-safekeep-hid-lockdown.rules');
        writeFileSync(rf, rules + '\n');
        const v = spawnSync(udevadm, ['verify', rf]);
        ck('lockdown: udevadm verify accepts the rules', v.status === 0, v.stdout.toString() + v.stderr.toString());
    } else {
        console.log('SKIP: udevadm is not installed here, so the rules\' syntax was not checked.');
        skipped++;
    }
    ck('unlock: the summary is cleared on every run', unlock.indexOf('rm -f "$UNLOCK_SUMMARY_FILE"') > 0 && unlock.indexOf('rm -f "$UNLOCK_SUMMARY_FILE"') < unlock.indexOf('1. CHECK IF ALREADY UNLOCKED'));
    ck('unlock: a vault without the helper stays passphrase-only', unlock.includes('if [ -f "$FIDO2_HELPER" ]; then') && unlock.includes('VAULT_HAS_PASSPHRASE=true'));

    const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
    const bootJs = readFileSync(new URL('./shared/boot.js', import.meta.url), 'utf8');
    ck('boot.js: "securitykey" is a power action the app can send', bootJs.includes("action !== 'securitykey'") && bootJs.includes("return _submitPowerAction('securitykey');"));
    ck('boot.js: exports manageSecurityKeys and getUnlockMethods', /\n\s+manageSecurityKeys,\n\s+getUnlockMethods,/.test(bootJs));
    ck('boot.js: reads only the summary file', bootJs.includes("'file:///tmp/safekeep-signals/UNLOCK_METHODS.json'"));
    ck('app: Device Options has the Security Keys section', html.includes('id="settings-security-key-section"') && html.includes('onclick="skSettingsLockAndManage()"'));
    ck('app: it wipes the session before locking', /function skSettingsLockAndManage\(\) \{[\s\S]*?_fullSessionWipe\(\);[\s\S]*?os\.manageSecurityKeys\(\)/.test(html));
    ck('app: Change Master Passphrase is hidden in a keys-only vault', /function skSettingsRefresh\(\)[\s\S]*?settings-pp-change-btn[\s\S]*?passphrase === false/.test(html));
    ck('app: the dev stand-in has both functions', /manageSecurityKeys: function \(\) \{[\s\S]*?getUnlockMethods: function \(\) \{/.test(html));
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? ', ' + skipped + ' skipped' : ''}`);
process.exit(fail ? 1 : 0);

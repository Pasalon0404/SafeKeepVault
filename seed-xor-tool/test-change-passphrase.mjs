/**
 * test-change-passphrase.mjs — Device Options → Change Master Passphrase
 * (PASSPHRASE_STRENGTH_DESIGN.md, Part 3)
 *
 *   1. safekeep-passphrase.py on a real LUKS2 file (cryptsetup): verify
 *      accepts the right passphrase and refuses a wrong one; change refuses
 *      a wrong current passphrase, the same passphrase, a missing NUL and
 *      a device that isn't a loop device; after a change the new
 *      passphrase opens the vault, the old one doesn't, one key slot is
 *      left. Skipped, and said so, where cryptsetup isn't installed.
 *   2. change-passphrase.sh, run for real on that LUKS file with stand-ins
 *      for zenity, blkid, mount and losetup: a wrong current passphrase is
 *      refused, the new one goes through the setup screens
 *      (passphrase-dialogs.sh, strength check included), the same
 *      passphrase is refused, and every way out leaves the vault opening
 *      with the passphrase it should.
 *   3. Wiring: safekeep-boot.sh's "passphrase" power action locks and runs
 *      change-passphrase before the unlock prompt; unlock-vault.sh leaves
 *      only the rating in RAM; the image installs everything; the app's
 *      Device Options section and dashboard banner.
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, chmodSync, rmSync, truncateSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USB = new URL('../usbbootdrive/', import.meta.url);
const read = (f) => readFileSync(new URL(f, USB), 'utf8');
const HELPER = new URL('safekeep-passphrase.py', USB).pathname;
const CHANGE = new URL('change-passphrase.sh', USB).pathname;
const DIALOGS = new URL('passphrase-dialogs.sh', USB).pathname;
const PWCHECK = new URL('safekeep-pwcheck.py', USB).pathname;
const LISTS = new URL('pwcheck-lists.json', USB).pathname;

let pass = 0, fail = 0, skipped = 0;
function ck(name, ok, detail) {
    if (ok) { pass++; } else { fail++; console.log('FAIL', name, detail === undefined ? '' : detail); }
}

const OLD = 'old correct horse 2014';
const STRONG = 'x7#Qp9!vLm2@Zr8$Tq4w';
const STRONG2 = 'Tq4w$Zr8@vLm2!Qp9#x7';
const haveCryptsetup = spawnSync('cryptsetup', ['--version']).status === 0;
const tmp = mkdtempSync(join(tmpdir(), 'chpass-'));

function makeVault(path, passphrase) {
    writeFileSync(path, '');
    truncateSync(path, 20 * 1024 * 1024);
    // pbkdf2 with few iterations: the test is about which passphrase opens
    // the vault, not about the cost of guessing it.
    const r = spawnSync('cryptsetup', ['luksFormat', '-q', '--type', 'luks2', '--pbkdf', 'pbkdf2',
        '--pbkdf-force-iterations', '1000', path, '--key-file=-'], { input: passphrase });
    if (r.status !== 0) throw new Error('luksFormat failed: ' + r.stderr);
}
const helper = (action, device, input, env = {}) => spawnSync('python3', ['-I', HELPER, action, device], {
    input, env: Object.assign({ PATH: process.env.PATH, SAFEKEEP_PASSPHRASE_TEST_FILE: '1' }, env) });
const opens = (device, p) => helper('verify', device, p).status === 0;

try {
    // --- 1. The root helper on a real LUKS2 file ---
    if (!haveCryptsetup) {
        console.log('SKIP: cryptsetup is not installed here, so the LUKS checks (parts 1 and 2) did not run.');
        skipped++;
    } else {
        const vault = join(tmp, 'vault.luks');
        makeVault(vault, OLD);
        ck('helper: verify accepts the right passphrase', helper('verify', vault, OLD).status === 0);
        ck('helper: verify refuses a wrong one (exit 2)', helper('verify', vault, 'wrong').status === 2);
        ck('helper: verify refuses an empty one', helper('verify', vault, '').status === 2);
        let r = helper('change', vault, Buffer.from('wrong\0' + STRONG));
        ck('helper: change refuses a wrong current passphrase (exit 2)', r.status === 2 && opens(vault, OLD), r.stderr.toString());
        r = helper('change', vault, Buffer.from(OLD + '\0' + OLD));
        ck('helper: change refuses the same passphrase', r.status === 1 && /same/.test(r.stderr), r.stderr.toString());
        r = helper('change', vault, Buffer.from(OLD + STRONG));
        ck('helper: change needs the current and new passphrase separated by a NUL', r.status === 1);
        r = helper('change', vault, Buffer.from(OLD + '\0' + STRONG), { SAFEKEEP_PASSPHRASE_TEST_FILE: '' });
        ck('helper: refuses anything but a /dev/loopN device', r.status === 1 && /not a vault device/.test(r.stderr) && opens(vault, OLD), r.stderr.toString());
        r = helper('change', vault, Buffer.alloc(5000, 'a'));
        ck('helper: refuses an over-long input', r.status === 1);
        r = helper('change', vault, Buffer.from(OLD + '\0' + STRONG));
        ck('helper: change succeeds', r.status === 0, r.stderr.toString());
        ck('helper: the new passphrase opens the vault', opens(vault, STRONG));
        ck('helper: the old passphrase no longer does', !opens(vault, OLD));
        const dump = spawnSync('cryptsetup', ['luksDump', vault]).stdout.toString();
        ck('helper: one key slot is left', (dump.match(/^\s+\d+: luks2$/gm) || []).length === 1, dump);
        const src = read('safekeep-passphrase.py');
        ck('helper: passphrases reach cryptsetup through pipes, not arguments or files',
            src.includes('pass_fds=') && src.includes('"/dev/fd/%d"') && !/open\([^)]*['"]w/.test(src));

        // --- 2. change-passphrase.sh, for real, with stand-in dialogs ---
        const bin = join(tmp, 'bin');
        mkdirSync(bin);
        const stub = (name, body) => { writeFileSync(join(bin, name), '#!/bin/bash\n' + body + '\n'); chmodSync(join(bin, name), 0o755); };
        // zenity plays back "exit code<TAB>output" lines; --progress reads its stdin.
        stub('zenity', `printf '%s\\n' "$*" >> "$ZLOG"
case " $* " in *" --progress "*) cat >/dev/null; exit 0;; esac
line=$(head -n1 "$ZQUEUE"); sed -i 1d "$ZQUEUE"
if [ -z "$line" ]; then echo "QUEUE EMPTY" >> "$ZLOG"; kill -TERM "$TESTPID"; exit 1; fi
rc=\${line%%$'\\t'*}; out=\${line#*$'\\t'}
printf '%s' "$out"; exit "$rc"`);
        stub('sudo', 'exec "$@"');
        stub('blkid', 'echo /dev/fake-data');
        stub('mount', 'exit 0');
        stub('umount', 'exit 0');
        stub('mountpoint', 'exit 0');
        // losetup: the "loop device" is the LUKS file itself.
        stub('losetup', 'case "$1" in -j) exit 0;; --find) echo "$3";; -d) exit 0;; esac');
        const dataDir = join(tmp, 'data');
        mkdirSync(dataDir);
        const vfile = join(dataDir, '.vault.luks');
        const runChange = (answers, initial = OLD) => {
            makeVault(vfile, initial);
            writeFileSync(join(tmp, 'queue'), answers.map((a) => a.join('\t')).join('\n') + '\n');
            writeFileSync(join(tmp, 'zlog'), '');
            const res = spawnSync('bash', ['-c', 'TESTPID=$$; exec bash "$0"', CHANGE], {
                timeout: 60000,
                env: { PATH: bin + ':' + process.env.PATH, ZLOG: join(tmp, 'zlog'), ZQUEUE: join(tmp, 'queue'),
                    HAS_CAMERA: 'false', QR_SCAN_TIMEOUT: '1', SAFEKEEP_DATA_MOUNT: dataDir,
                    SAFEKEEP_PASSPHRASE_HELPER: HELPER, SAFEKEEP_PASSPHRASE_DIALOGS: DIALOGS, PWCHECK,
                    SAFEKEEP_PWCHECK_LISTS: LISTS, SAFEKEEP_PASSPHRASE_TEST_FILE: '1' },
            });
            return { status: res.status, log: readFileSync(join(tmp, 'zlog'), 'utf8'),
                left: readFileSync(join(tmp, 'queue'), 'utf8').trim(), stderr: res.stderr.toString() };
        };
        const CONTINUE = ['0', ''], TYPE_CUR = ['0', 'Type Password'], OK = ['0', ''];
        let c = runChange([CONTINUE, TYPE_CUR, ['0', 'not it'], OK, TYPE_CUR, ['0', OLD],
            ['0', 'Type Password'], ['0', STRONG], ['0', STRONG], OK]);
        ck('change: a wrong current passphrase is refused, the right one goes on', c.log.includes('Not Your Current Passphrase'), c.log);
        ck('change: the new passphrase is chosen on the setup screens', /--title=Change Master Passphrase .*How would you like to set your new Master Passphrase\?/.test(c.log), c.log);
        ck('change: changed (exit 0), and says to unlock with the new one', c.status === 0 && c.log.includes('Master Passphrase Changed') && !c.left, c);
        ck('change: the vault now opens with the new passphrase only', opens(vfile, STRONG) && !opens(vfile, OLD));
        ck('change: no dialog shows a passphrase', !c.log.includes(OLD) && !c.log.includes(STRONG), c.log);

        c = runChange([['1', ''], OK]);
        ck('change: "Keep Current Passphrase" changes nothing (exit 2)', c.status === 2 && c.log.includes('was not changed') && opens(vfile, OLD) && !c.left, c);
        c = runChange([CONTINUE, ['1', ''], OK]);
        ck('change: closing the current-passphrase choice changes nothing', c.status === 2 && opens(vfile, OLD) && !c.left, c);
        c = runChange([CONTINUE, TYPE_CUR, ['0', OLD], ['1', ''], ['0', 'Keep my current passphrase'], OK]);
        ck('change: closing the new-passphrase choice, then "Keep my current passphrase"', c.status === 2 && opens(vfile, OLD) && !c.left, c);
        c = runChange([CONTINUE, TYPE_CUR, ['0', OLD], ['1', ''], ['0', 'Go back and choose a new passphrase'],
            ['0', 'Type Password'], ['0', STRONG2], ['0', STRONG2], OK]);
        ck('change: "Go back" returns to the new-passphrase choice', c.status === 0 && opens(vfile, STRONG2) && !c.left, c);
        c = runChange([CONTINUE, TYPE_CUR, ['0', OLD], ['0', 'Type Password'], ['0', 'bitcoin2024'], OK,
            ['1', ''], ['1', ''], ['0', 'Keep my current passphrase'], OK]);
        ck('change: a Weak new passphrase is refused', c.log.includes('Passphrase Too Easy to Guess') && c.status === 2 && opens(vfile, OLD) && !c.left, c);
        // The current passphrase must itself pass the strength check to reach this, so start from a strong one.
        c = runChange([CONTINUE, TYPE_CUR, ['0', STRONG], ['0', 'Type Password'], ['0', STRONG], ['0', STRONG], OK,
            ['1', ''], ['0', 'Keep my current passphrase'], OK], STRONG);
        ck('change: the same passphrase as now is refused', c.log.includes("That's Your Current Passphrase") && c.status === 2 && opens(vfile, STRONG) && !c.left, c);
    }

    // --- 3. Wiring ---
    const boot = read('safekeep-boot.sh'), unlock = read('unlock-vault.sh'), build = read('build.sh'), quick = read('quick-update.sh');
    const change = read('change-passphrase.sh');
    ck('boot: "passphrase" is an accepted power action', /reboot\|poweroff\|lock\|passphrase\)/.test(boot));
    ck('boot: it locks exactly like Lock', boot.includes('if [ "$POWER_ACTION" = "lock" ] || [ "$POWER_ACTION" = "passphrase" ]; then'));
    ck('boot: it re-runs with SAFEKEEP_CHANGE_PASSPHRASE=1', boot.includes('exec env SAFEKEEP_CHANGE_PASSPHRASE=1 /usr/local/bin/safekeep-boot'));
    const unlockAt = boot.indexOf('# ---- UNLOCK THE VAULT ----');
    const runAt = boot.indexOf('change-passphrase || CHANGE_EXIT=$?');
    ck('boot: change-passphrase runs before the unlock prompt, once',
        runAt > unlockAt && runAt < boot.indexOf('unlock-vault || UNLOCK_EXIT=$?') && boot.includes('unset SAFEKEEP_CHANGE_PASSPHRASE'));
    ck('change: the passphrases only go to the helper on stdin',
        change.includes(`printf '%s' "$CURRENT" | sudo python3 -I "$HELPER" verify "$LOOP_DEV"`) &&
        change.includes(`printf '%s\\0%s' "$CURRENT" "$PASSWORD" | sudo python3 -I "$HELPER" change "$LOOP_DEV"`));
    ck('change: uses the shared setup screens', change.includes('/usr/local/lib/safekeep/passphrase-dialogs.sh') && change.includes('choose_new_passphrase keep_current_or_go_back'));
    ck('unlock: rates the passphrase after a successful open, before clearing it',
        /cryptsetup open "\$LOOP_DEV" "\$MAPPER_NAME" --key-file=-; then\n[^\n]*\n\s*record_passphrase_rating\n\s*PASSWORD=""/.test(unlock));
    ck('unlock: clears the rating on every run', unlock.indexOf('rm -f "$RATING_FILE"') > 0 && unlock.indexOf('rm -f "$RATING_FILE"') < unlock.indexOf('1. CHECK IF ALREADY UNLOCKED'));
    // Run the real record_passphrase_rating.
    const fnStart = unlock.indexOf('record_passphrase_rating() {');
    const fn = unlock.slice(fnStart, unlock.indexOf('\n}\n', fnStart) + 3).replace('/usr/local/lib/safekeep/safekeep-pwcheck.py', PWCHECK);
    const ratingFile = join(tmp, 'rating.json');
    const rr = spawnSync('bash', ['-c', `RATING_FILE='${ratingFile}'; PASSWORD='bitcoin2024'\n${fn}\nrecord_passphrase_rating`], { env: { PATH: process.env.PATH, SAFEKEEP_PWCHECK_LISTS: LISTS } });
    const rating = existsSync(ratingFile) ? readFileSync(ratingFile, 'utf8') : '';
    ck('unlock: the rating file holds only the band and bits', rr.status === 0 && /^\{"band":"weak","bits":\d+\}\n$/.test(rating) && !rating.includes('bitcoin'), rating);
    for (const f of ['change-passphrase.sh', 'passphrase-dialogs.sh', 'safekeep-passphrase.py']) {
        ck(`build.sh requires and installs ${f}`, build.includes(f + ' ') || build.includes(f + ';'), f);
        ck(`quick-update.sh installs ${f}`, quick.includes(f));
    }
    ck('build.sh installs change-passphrase as a command', build.includes('cp change-passphrase.sh "$CHROOT_DIR/usr/local/bin/change-passphrase"'));

    const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
    const bootJs = readFileSync(new URL('./shared/boot.js', import.meta.url), 'utf8');
    ck('boot.js: "passphrase" is a power action the app can send', bootJs.includes("action !== 'passphrase'") && bootJs.includes("return _submitPowerAction('passphrase');"));
    ck('boot.js: exports changeMasterPassphrase and getPassphraseRating', /\n\s+changeMasterPassphrase,\n\s+getPassphraseRating,/.test(bootJs));
    ck('boot.js: reads only the rating file', bootJs.includes("'file:///tmp/safekeep-signals/PASSPHRASE_RATING.json'"));
    ck('app: Device Options has the Master Passphrase section, refreshed when opened',
        html.includes('id="settings-passphrase-section"') && html.includes("typeof ppSettingsRefresh === 'function') ppSettingsRefresh()"));
    ck('app: the change asks first, then wipes the session and locks',
        /function ppSettingsLockAndChange\(\) \{[\s\S]*?_fullSessionWipe\(\);[\s\S]*?os\.changeMasterPassphrase\(\)/.test(html) && html.includes('onclick="ppSettingsLockAndChange()"'));
    ck('app: the dashboard banner shows only for a Weak rating', html.includes("banner.style.display = rating && rating.band === 'weak' ? 'block' : 'none';"));
    ck('app: the dev stand-in has both functions', /changeMasterPassphrase: function \(\) \{[\s\S]*?getPassphraseRating: function \(\) \{ return Promise\.resolve\(null\); \}/.test(html));
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? ', ' + skipped + ' skipped (no cryptsetup)' : ''}`);
process.exit(fail ? 1 : 0);

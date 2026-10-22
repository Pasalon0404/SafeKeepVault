/**
 * test-pwcheck.mjs — password strength check (PASSPHRASE_STRENGTH_DESIGN.md)
 *
 *   1. Word lists: pwcheck-lists.json has every list, its licence, and the
 *      exact BIP39 English wordlist the app uses.
 *   2. Ratings: known passwords land in the expected band, for the vault
 *      and for an Encrypted Backup (common passwords, names, years, l33t,
 *      repeats and sequences are Weak; 4 random BIP39 words are Fair for
 *      the vault and Weak for a backup; 6 random words and password-manager
 *      passwords are Strong for both).
 *   3. The two copies agree: shared/pwcheck.js (the app's bar) and
 *      usbbootdrive/safekeep-pwcheck.py (which enforces the rule) give the
 *      same bits, band and reasons for a few thousand passwords.
 *   4. The Python command line: the password comes from stdin exactly as
 *      given (a trailing newline counts), never from the arguments.
 *   5. Wiring: the app bundles the module and refuses a Weak backup
 *      password; the image installs the checker with its lists. Then the
 *      real setup-vault.sh dialog function (with a stand-in zenity) and
 *      the real backup watcher helper (with a stand-in 7z) are run: Weak
 *      is refused, Fair needs a deliberate "Use this one anyway", Strong
 *      goes straight through, and the passphrase is never shown.
 */
import { buildDictionary, ratePassword, describeRating, BANDS } from './shared/pwcheck.js';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

const USB = new URL('../usbbootdrive/', import.meta.url);
const LISTS_PATH = new URL('pwcheck-lists.json', USB);
const PY = new URL('safekeep-pwcheck.py', USB).pathname;

let pass = 0, fail = 0;
function ck(name, ok, detail) {
    if (ok) { pass++; } else { fail++; console.log('FAIL', name, detail === undefined ? '' : detail); }
}

// --- 1. Word lists ---
const data = JSON.parse(readFileSync(LISTS_PATH, 'utf8'));
const lists = data.lists;
for (const [name, n] of [['passwords', 30000], ['english_wikipedia', 20000], ['us_tv_and_film', 10000], ['surnames', 5000], ['female_names', 2000], ['male_names', 983]]) {
    ck(`list ${name} has ${n} entries`, lists[name] && lists[name].split(',').length === n, lists[name] && lists[name].split(',').length);
}
ck('BIP39 list is the app\'s English wordlist', lists.bip39 === wordlist.join(','));
ck('licence notice kept', /MIT licence/.test(data._license) && /Dropbox/.test(data._license));
ck('lists are lowercase', !/[A-Z]/.test(Object.values(lists).join(',')));

const dict = buildDictionary(lists);

// --- 2. Ratings ---
const rate = (p, c) => ratePassword(p, c, dict);
const bip = wordlist;
const words = (n, sep) => Array.from({ length: n }, () => bip[randomInt(2048)]).join(sep);
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+';
const randomString = (n, cs = CHARS) => Array.from({ length: n }, () => cs[randomInt(cs.length)]).join('');

for (const p of ['', 'a', 'password', 'P@ssw0rd', 'bitcoin2024', 'Summer1990!', 'iloveyou!', 'qwerty123', 'aaaaaaaaaaaa',
    'abcdefghijkl', '123456789012', 'Michael1985', 'drowssap', 'Tr0ub4dor&3', 'satoshi nakamoto', 'letmein letmein']) {
    ck(`"${p}" is Weak for a backup`, rate(p, 'backup').band === 'weak', rate(p, 'backup'));
}
for (const p of ['', 'password', 'P@ssw0rd', 'bitcoin2024', 'Summer1990!', 'qwerty123', 'aaaaaaaaaaaa', 'abcdefghijkl', 'Michael1985', 'drowssap']) {
    ck(`"${p}" is Weak for the vault`, rate(p, 'vault').band === 'weak', rate(p, 'vault'));
}
ck('common password reason', rate('password', 'vault').reasons.join() === 'common');
ck('name and year reasons', rate('Michael1985', 'vault').reasons.join() === 'name,year');
ck('repeat reason', rate('aaaaaaaaaaaa', 'vault').reasons.join() === 'repeat');
ck('sequence reason', rate('abcdefghijkl', 'vault').reasons.join() === 'sequence');
ck('reversed word is still found', rate('drowssap', 'vault').bits < 10);
ck('l33t word is still found', rate('P@ssw0rd', 'vault').bits < 10);
ck('random words: say to use more of them', describeRating(rate(words(4, ' '), 'backup')).startsWith('Random words are good'));
ck('message names the reasons', describeRating(rate('Michael1985', 'vault')) === 'It is mostly a name and a year, which attackers try first.');
ck('message for a short random password', describeRating(rate('x7#', 'vault')) === 'It is too short.');
ck('no message when Strong', describeRating(rate('x7#Qp9!vLm2@Zr8$Tq4w', 'vault')) === '');
for (let k = 0; k < 50; k++) {
    for (const sep of [' ', '-']) {
        const four = words(4, sep), six = words(6, sep);
        ck('4 random BIP39 words: Fair for the vault', rate(four, 'vault').band === 'fair', four);
        ck('4 random BIP39 words: Weak for a backup', rate(four, 'backup').band === 'weak', four);
        ck('6 random BIP39 words: Strong for the vault', rate(six, 'vault').band === 'strong', six);
        ck('6 random BIP39 words: Strong for a backup', rate(six, 'backup').band === 'strong', six);
    }
    const pm = randomString(20);
    ck('20-character password-manager password: Strong for a backup', rate(pm, 'backup').band === 'strong', pm);
}
ck('bands as in the design note', BANDS.vault.weak === 40 && BANDS.vault.strong === 60 && BANDS.backup.weak === 50 && BANDS.backup.strong === 65);
ck('unknown context throws', (() => { try { rate('x', 'other'); return false; } catch { return true; } })());

// --- 3. Both copies agree ---
const corpus = ['', ' ', 'a', 'ab', 'abc', 'Ab', 'AB', 'aBcD', 'ü', 'pässwörd', '密码密码密码', '😀😀😀', 'naïve café 2020'];
const pw = lists.passwords.split(','), en = lists.english_wikipedia.split(','), nm = lists.surnames.split(',');
const pick = (a) => a[randomInt(Math.min(a.length, 5000))];
const mutate = (w) => {
    switch (randomInt(7)) {
        case 0: return w[0].toUpperCase() + w.slice(1);
        case 1: return w.toUpperCase();
        case 2: return w.replace(/a/g, '@').replace(/o/g, '0').replace(/e/g, '3').replace(/i/g, '1').replace(/s/g, '$');
        case 3: return Array.from(w).reverse().join('');
        case 4: return w + (1900 + randomInt(150));
        case 5: return w + randomString(randomInt(4), '0123456789!?');
        default: return Array.from(w).map((c) => (randomInt(2) ? c.toUpperCase() : c)).join('');
    }
};
for (let k = 0; k < 400; k++) {
    corpus.push(mutate(pick(pw)), mutate(pick(en)) + mutate(pick(nm)), pick(en) + ' ' + pick(en) + ' ' + pick(pw));
    corpus.push(words(2 + randomInt(6), [' ', '-', '', '.', '_'][randomInt(5)]));
    corpus.push(randomString(1 + randomInt(30)), randomString(3 + randomInt(8), 'abc123'));
    const unit = randomString(1 + randomInt(4));
    corpus.push(unit.repeat(2 + randomInt(4)));
    const start = randomInt(20);
    corpus.push('abcdefghijklmnopqrstuvwxyz'.slice(start, start + 3 + randomInt(6)), '9876543210'.slice(randomInt(5)));
}
corpus.push(randomString(200), words(12, ' '), 'correct horse battery staple', 'a b c', '- -', 'word word word');

for (const context of ['vault', 'backup']) {
    const py = JSON.parse(execFileSync('python3', ['-I', PY, '--batch', context], {
        input: JSON.stringify(corpus), env: { SAFEKEEP_PWCHECK_LISTS: LISTS_PATH.pathname }, maxBuffer: 64 << 20,
    }).toString());
    let mismatches = 0;
    corpus.forEach((p, i) => {
        const js = rate(p, context);
        const same = Math.abs(js.bits - py[i].bits) < 1e-9 && js.band === py[i].band &&
            js.reasons.join() === py[i].reasons.join() && describeRating(js) === py[i].message;
        if (!same && mismatches++ < 5) console.log('  mismatch', context, JSON.stringify(p), js, py[i]);
    });
    ck(`${context}: Python and JavaScript agree on ${corpus.length} passwords`, mismatches === 0, mismatches);
}

// --- 4. Python command line ---
const one = (input, context = 'vault') => JSON.parse(execFileSync('python3', ['-I', PY, context], {
    input, env: { SAFEKEEP_PWCHECK_LISTS: LISTS_PATH.pathname },
}).toString());
ck('CLI rates the password from stdin', one('password').band === 'weak' && one('password').message.includes('common password'));
ck('CLI keeps a trailing newline', Math.abs(one('x7#Qp9!vLm2@Zr8$Tq4w\n').bits - rate('x7#Qp9!vLm2@Zr8$Tq4w\n', 'vault').bits) < 1e-9);
ck('CLI backup context', one(words(4, ' '), 'backup').band === 'weak');
ck('CLI refuses a bad context', (() => {
    try { execFileSync('python3', ['-I', PY, 'nope'], { input: 'x', stdio: 'pipe' }); return false; } catch (e) { return e.status === 2; }
})());
ck('CLI non-UTF-8 bytes still rate', one(Buffer.from([0xff, 0xfe, 0x41])).band === 'weak');
const pySrc = readFileSync(PY, 'utf8');
ck('Python reads the password only from stdin', pySrc.includes('sys.stdin.buffer.read()') && !/argv\[\d\]\s*\)?\s*$/m.test(pySrc.split('def main')[0]));

// --- 5. Wiring and the OS-side checks ---
const read = (u) => readFileSync(new URL(u, USB), 'utf8');
const setup = read('setup-vault.sh'), bootSh = read('safekeep-boot.sh'), build = read('build.sh'), quick = read('quick-update.sh');
const entry = readFileSync(new URL('./boot-entry.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
ck('build.sh requires and installs the checker and its lists',
    build.includes('safekeep-pwcheck.py pwcheck-lists.json; do') &&
    build.includes('install -m 755 safekeep-pwcheck.py "$CHROOT_DIR/usr/local/lib/safekeep/safekeep-pwcheck.py"') &&
    build.includes('install -m 644 pwcheck-lists.json "$CHROOT_DIR/usr/local/share/safekeep/pwcheck-lists.json"'));
ck('quick-update.sh installs them too',
    quick.includes('install -m 755 safekeep-pwcheck.py') && quick.includes('install -m 644 pwcheck-lists.json'));
ck('the app bundles the module with the same lists',
    entry.includes("import pwcheckLists from '../usbbootdrive/pwcheck-lists.json'") && entry.includes('window.PwCheck'));
ck('setup checks a scanned passphrase', /if \[ -n "\$PASSWORD" \]; then\n\s*passphrase_ok && break/.test(setup));
ck('setup checks a typed passphrase before the confirmation',
    setup.indexOf('if ! passphrase_ok; then') > setup.indexOf('Enter your Master Passphrase (visible)') &&
    setup.indexOf('if ! passphrase_ok; then') < setup.indexOf('Type your Master Passphrase again to confirm'));
ck('setup passes the passphrase on stdin', setup.includes(`printf '%s' "$PASSWORD" | python3 -I /usr/local/lib/safekeep/safekeep-pwcheck.py --lines vault`));
const exportFn = html.slice(html.indexOf('async function rlq_export()'), html.indexOf('function rlq_showRestore()'));
ck('backup export refuses a Weak password before writing',
    exportFn.indexOf("rating.band === 'weak'") > 0 && exportFn.indexOf("rating.band === 'weak'") < exportFn.indexOf('os.createReliquary('));
ck('bar redraws on typing, after a scan and on reset',
    /function rlq_onBackupPasswordInput\(\) \{[^}]*rlq_renderStrength\(\);/.test(html) &&
    html.includes("_rlqSetBackupFromQr(true);\n                rlq_renderStrength();") &&
    html.includes("_rlqSetBackupFromQr(false);\n    rlq_renderStrength();"));
ck('bar uses the backup bands', html.includes("window.PwCheck.rate(password, 'backup')"));

const tmp = mkdtempSync(join(tmpdir(), 'pwcheck-'));
try {
    // setup-vault.sh: run its passphrase_ok() with a stand-in zenity.
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'zenity'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${tmp}/zenity.log"\nfor a in "$@"; do case "$a" in --list) printf '%s' "$ZENITY_PICK"; exit 0;; esac; done\nexit 0\n`);
    chmodSync(join(bin, 'zenity'), 0o755);
    const fnStart = setup.indexOf('    passphrase_ok() {');
    const fn = setup.slice(fnStart, setup.indexOf('\n    }\n', fnStart) + 7).replace('/usr/local/lib/safekeep/safekeep-pwcheck.py', '"$CHECKER"');
    const runSetup = (password, pick = '', checker = PY) => {
        rmSync(join(tmp, 'zenity.log'), { force: true });
        const r = spawnSync('bash', ['-c', fn + '\npassphrase_ok; echo "rc=$?"'], {
            env: { PATH: bin + ':' + process.env.PATH, PASSWORD: password, ZENITY_PICK: pick, CHECKER: checker, SAFEKEEP_PWCHECK_LISTS: LISTS_PATH.pathname },
        });
        const log = existsSync(join(tmp, 'zenity.log')) ? readFileSync(join(tmp, 'zenity.log'), 'utf8') : '';
        return { rc: r.stdout.toString().trim(), log };
    };
    const strong = runSetup('x7#Qp9!vLm2@Zr8$Tq4w');
    ck('setup: Strong is accepted with no dialog', strong.rc === 'rc=0' && strong.log === '', strong);
    const weak = runSetup('Michael1985');
    ck('setup: Weak is refused', weak.rc === 'rc=1' && weak.log.includes('Passphrase Too Easy to Guess') && weak.log.includes('a name and a year'), weak);
    ck('setup: the dialog never shows the passphrase', !weak.log.includes('Michael1985'));
    const four = words(4, ' ');
    const fairNo = runSetup(four, '');
    ck('setup: Fair, dialog closed → choose another', fairNo.rc === 'rc=1' && fairNo.log.includes('Passphrase Could Be Stronger'), fairNo);
    ck('setup: Fair, "Choose another" → choose another', runSetup(four, 'Choose another passphrase').rc === 'rc=1');
    ck('setup: Fair, "Use this one anyway" → accepted', runSetup(four, 'Use this one anyway').rc === 'rc=0');
    const broken = runSetup('Michael1985', '', join(tmp, 'missing.py'));
    ck('setup: a broken checker warns and continues', broken.rc === 'rc=0' && broken.log.includes('Strength Check Unavailable'), broken);

    // Backup watcher: run its Python helper with a stand-in 7z.
    const helper = bootSh.slice(bootSh.indexOf("<<'RELIQUARY_PY'\n") + 16, bootSh.indexOf('\nRELIQUARY_PY\n') + 1);
    writeFileSync(join(tmp, 'reliquary.py'), helper);
    writeFileSync(join(bin, '7z'), `#!/bin/bash\necho called >> "${tmp}/7z.log"\nexit 0\n`);
    chmodSync(join(bin, '7z'), 0o755);
    mkdirSync(join(tmp, 'vault', 'codex'), { recursive: true });
    mkdirSync(join(tmp, 'usb'));
    const runBackup = (password) => {
        rmSync(join(tmp, '7z.log'), { force: true });
        writeFileSync(join(tmp, 'trigger.json'), JSON.stringify({ action: 'create', selections: ['codex'], password, dateStr: '2026-10-22' }));
        const r = spawnSync('python3', [join(tmp, 'reliquary.py'), join(tmp, 'trigger.json'), join(tmp, 'usb'), join(tmp, 'vault')], {
            env: { PATH: bin + ':' + process.env.PATH, SAFEKEEP_PWCHECK: PY, SAFEKEEP_PWCHECK_LISTS: LISTS_PATH.pathname },
        });
        return { status: r.status, out: r.stdout.toString(), ran7z: existsSync(join(tmp, '7z.log')) };
    };
    const bWeak = runBackup(words(4, ' '));
    ck('backup watcher refuses a Weak password without running 7z', bWeak.status === 3 && bWeak.out.includes('too easy to guess') && !bWeak.ran7z, bWeak);
    const bStrong = runBackup('x7#Qp9!vLm2@Zr8$Tq4w');
    ck('backup watcher accepts a Strong password', bStrong.status === 0 && bStrong.out.includes('RELIQUARY_FILE=Safekeep_backup_2026-10-22.7z') && bStrong.ran7z, bStrong);
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

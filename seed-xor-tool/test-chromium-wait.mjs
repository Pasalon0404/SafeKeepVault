import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
/**
 * test-chromium-wait.mjs — starting a Temporary Session right after a Lock
 * left a blank screen once that session was closed: the Chromium process the
 * boot script started returned after 3-4 s (status 0) while another Chromium
 * kept showing the session, and the fast-fail check (under 5 s = launch
 * failure) halted safekeep-boot.sh for good. Now:
 *  - before launch it waits for (then stops) a previous Chromium;
 *  - after a fast return it waits while a Chromium is still running, and
 *    then carries on to the power sequence instead of halting;
 *  - only processes named "chrome" count (not zombies, not chrome_crashpad).
 * The blocks run for real with ps/pkill/sleep replaced by stubs.
 * Needs bash. Run: node test-chromium-wait.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SH = readFileSync(join(__dirname, '../usbbootdrive/safekeep-boot.sh'), 'utf8');
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

const fnA = SH.indexOf('    _skb_old_chromium() {'), start = SH.indexOf('    CHROMIUM_START_EPOCH=$(date +%s)');
const pre = SH.slice(fnA, start);
const pA = SH.indexOf('    if [ "$CHROMIUM_ELAPSED" -lt 5 ] && _skb_old_chromium; then');
const pB = SH.indexOf('    # FAST-FAIL DIAGNOSTIC HALT', pA) > 0 ? SH.indexOf('\n    fi\n', pA) + 8 : -1;
const post = SH.slice(pA, pB);
ck('pre-launch block found', fnA > 0 && start > fnA, '');
ck('post-launch block found, before the fast-fail check', pA > start && pB > pA && SH.indexOf('if [ "$CHROMIUM_ELAPSED" -lt 5 ]; then', pA) > pB, '');

// alive=N: a chrome process shows in ps for the first N looks; extra lines
// (a zombie chrome, chrome_crashpad) show every time.
const run = (body, alive, extra = '', vars = '') => {
  const stub = `
C=$(mktemp); K=$(mktemp); echo 0 > "$C"
# ps runs inside pipelines (subshells), so its count and the kill record live in files.
ps() { local n=$(( $(cat "$C") + 1 )); echo $n > "$C"; [ -n "${extra}" ] && printf '%b' "${extra}"; if [ "$n" -le ${alive} ] && [ ! -s "$K" ]; then echo "Sl chrome"; echo "4321 1 Sl 5 chrome"; fi; }
pkill() { echo "$*" >> "$K"; return 0; }
sleep() { :; }
date() { echo 1000; }
${vars}
${body}
echo "looks=$(cat "$C") killed=[$(tr '\\n' ' ' < "$K")] elapsed=\${CHROMIUM_ELAPSED:-}"; rm -f "$C" "$K"`;
  const r = spawnSync('bash', ['-c', stub], { encoding: 'utf8', timeout: 20000 });
  return r.stdout + r.stderr;
};
let o = run(pre, 0);
ck('pre: no old Chromium: no wait, nothing stopped', /killed=\[\]/.test(o) && !/waiting/.test(o), o);
o = run(pre, 6);
ck('pre: old Chromium exits while waiting: nothing stopped', /waiting for it to exit/.test(o) && /killed=\[\]/.test(o) && /Previous Chromium gone/.test(o), o);
o = run(pre, 100000);
ck('pre: still running after 10 s: stopped (TERM then KILL)', /stopping it/.test(o) && /-TERM -x chrome/.test(o) && /-KILL -x chrome/.test(o), o);
o = run(pre, 0, 'Z chrome\\nSl chrome_crashpad\\n');
ck('pre: a zombie chrome or chrome_crashpad does not count', /killed=\[\]/.test(o) && !/waiting/.test(o), o);

const fns = pre.slice(0, pre.indexOf('    # Wait for the browser'));
o = run(fns + post, 8, '', 'CHROMIUM_ELAPSED=3; CHROMIUM_START_EPOCH=900;');
ck('post: fast return with a Chromium still running: waits for it, then goes on', /still running: waiting for the session to close/.test(o) && /Chromium closed after 100s/.test(o) && /elapsed=100/.test(o), o);
o = run(fns + post, 0, '', 'CHROMIUM_ELAPSED=3; CHROMIUM_START_EPOCH=997;');
ck('post: fast return with no Chromium left: no wait (a real launch failure still halts)', !/waiting/.test(o) && /elapsed=3/.test(o), o);
o = run(fns + post, 8, '', 'CHROMIUM_ELAPSED=600; CHROMIUM_START_EPOCH=400;');
ck('post: a normal long session is untouched', !/waiting/.test(o) && /elapsed=600/.test(o), o);

// Each session gets its own fresh profile, so a new Chromium never hands its
// window to a leftover one; --disable-web-security (ignored until now) stays out.
const launch = SH.slice(SH.indexOf('    ungoogled-chromium \\'), SH.indexOf('    CHROMIUM_EXIT=$?'));
ck('launch uses a per-session --user-data-dir', /--user-data-dir="\$CHROMIUM_PROFILE_DIR"/.test(launch), launch.slice(0, 300));
ck('--disable-web-security is not passed', !/--disable-web-security/.test(launch));
ck('profile lives in RAM (/tmp) and is made fresh per launch', /CHROMIUM_PROFILE_DIR="\$SKB_PROFILE_ROOT\/session-\$\(date \+%s\)-\$\$"/.test(SH) && /SKB_PROFILE_ROOT="\/tmp\/safekeep-chromium"/.test(SH));
ck('old profiles deleted only when no Chromium is left', /_skb_old_chromium \|\| rm -rf "\$SKB_PROFILE_ROOT"/.test(SH));
ck('the log is saved to the data partition when Chromium returns early', /_skb_log_chromium\(\) \{[\s\S]{0,600}cp -a \/tmp\/safekeep-boot\.log "\$DATA_MOUNT\/safekeep-boot\.log"/.test(SH));
const sh = spawnSync('bash', ['-n', join(__dirname, '../usbbootdrive/safekeep-boot.sh')]);
ck('safekeep-boot.sh parses', sh.status === 0, String(sh.stderr));
console.log(`test-chromium-wait: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

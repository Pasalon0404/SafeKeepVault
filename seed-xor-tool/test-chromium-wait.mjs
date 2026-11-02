import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
/**
 * test-chromium-wait.mjs — safekeep-boot.sh waits for the previous session's
 * Chromium to exit before starting a new one. Without it, choosing "Boot
 * Temporary Session" right after a Lock started a Chromium that handed its
 * page to the still-closing old one and quit in ~3 s; the fast-fail check
 * then halted the boot script, and closing the session left a blank screen.
 * The block is run for real with pgrep/pkill replaced by stubs.
 * Needs bash. Run: node test-chromium-wait.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SH = readFileSync(join(__dirname, '../usbbootdrive/safekeep-boot.sh'), 'utf8');
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

const a = SH.indexOf('    _skb_old_chromium() {'), b = SH.indexOf('    CHROMIUM_START_EPOCH=$(date +%s)');
ck('wait block found before the Chromium start time', a > 0 && b > a, '');
const block = SH.slice(a, b);
ck('the fast-fail check still follows the launch', SH.indexOf('if [ "$CHROMIUM_ELAPSED" -lt 5 ]', b) > b);

// alive=N: the old Chromium is still there for the first N checks.
const run = (alive) => {
  const stub = `
n=0; killed=""
pgrep() { n=$((n+1)); [ "$n" -le ${alive} ] && [ -z "$killed" ]; }
pkill() { killed="$killed $*"; return 0; }
sleep() { :; }
${block}
echo "checks=$n killed=[$killed]"`;
  const r = spawnSync('bash', ['-c', stub], { encoding: 'utf8' });
  return r.stdout + r.stderr;
};
let o = run(0);
ck('no old Chromium: starts at once, nothing stopped', /killed=\[\]/.test(o) && !/waiting/.test(o), o);
o = run(6);
ck('old Chromium exits while waiting: waits, nothing stopped', /waiting for it to exit/.test(o) && /killed=\[\]/.test(o) && /Previous Chromium gone/.test(o), o);
o = run(10000);
ck('still running after 10 s: stopped (TERM then KILL)', /stopping it/.test(o) && /-TERM/.test(o) && /-KILL/.test(o), o);
const sh = spawnSync('bash', ['-n', join(__dirname, '../usbbootdrive/safekeep-boot.sh')]);
ck('safekeep-boot.sh parses', sh.status === 0, String(sh.stderr));
console.log(`test-chromium-wait: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

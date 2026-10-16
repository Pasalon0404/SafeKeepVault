/**
 * test-auto-off.mjs — Settings → Idle Timers → Auto-Off.
 *   1. In the app: after N idle minutes a 60 s warning, then power off via the
 *      dashboard's Power Off path; activity cancels; 0 = stay on; website demo
 *      (not file://) never powers off. (skbIdleTimers run in a VM with a fake clock.)
 *   2. At the unlock prompt (unlock-vault.sh, browser closed): the prompts get
 *      --timeout from the stored minutes (default 30, 0 = none, bad values
 *      ignored); a timeout exits 4.
 *   3. safekeep-boot.sh powers off on exit 4, and its Settings Watcher keeps
 *      the minutes as a plain number next to the vault (only valid values).
 * Needs bash and python3. Run: node test-auto-off.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'boot.html'), 'utf8');
const OS = join(HERE, '..', 'usbbootdrive');
let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c || x === undefined ? '' : '  -> ' + x)); };

// ---- 1. In the app ----
function idleTimers({ minutes, protocol = 'file:' }) {
  const start = SRC.indexOf('window.skbIdleTimers = (function _installIdleTimers() {');
  const end = SRC.indexOf('})();', start) + 5;
  let now = 0; const timers = []; let nextId = 1;
  const addTimer = (fn, ms, repeat) => { const id = nextId++; timers.push({ id, at: now + ms, fn, ms, repeat }); return id; };
  const clear = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const advance = (ms) => {
    const target = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > target) break;
      now = t.at;
      if (t.repeat) t.at += t.ms; else clear(t.id);
      t.fn();
    }
    now = target;
  };
  const els = {}; const listeners = {}; const body = { children: [], appendChild(c) { this.children.push(c); els[c.id] = c; c.remove = () => { delete els[c.id]; body.children.splice(body.children.indexOf(c), 1); }; } };
  const mk = () => { const e = { style: {}, children: [], setAttribute() {}, appendChild(c) { this.children.push(c); }, textContent: '' }; return e; };
  const ls = { safekeepIdleTimers: JSON.stringify({ displaySleepMinutes: 0, autoLockMinutes: 0, autoOffMinutes: minutes }) };
  const off = [];
  const ctx = vm.createContext({
    window: { location: { protocol }, SafeKeepOS: {} }, Date: { now: () => now }, Math, JSON, parseInt, isNaN, String,
    setTimeout: (f, ms) => addTimer(f, ms, false), clearTimeout: clear, setInterval: (f, ms) => addTimer(f, ms, true), clearInterval: clear,
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = v; } },
    document: { readyState: 'complete', body, documentElement: body, createElement: mk,
      getElementById: (id) => els[id] || (id === 'settings-auto-off-min' ? (els[id] = { value: '' }) : null),
      addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); } },
    _skui_execPowerAction: (a) => off.push(a),
  });
  vm.runInContext(SRC.slice(start, end), ctx);
  ctx.window.skbIdleTimers = ctx.window.skbIdleTimers || vm.runInContext('window.skbIdleTimers', ctx);
  const activity = () => (listeners.mousemove || []).forEach((f) => f());
  const warning = () => els['sk-auto-off-warning'];
  return { advance, activity, warning, off, ls, api: ctx.window.skbIdleTimers, input: els['settings-auto-off-min'] };
}
{
  const t = idleTimers({ minutes: 30 });
  ck('setting shown in the Auto-Off box', t.input.value === '30', t.input.value);
  t.advance(29 * 60e3 - 1);
  ck('no warning before 29 min', !t.warning() && t.off.length === 0);
  t.advance(1);
  ck('warning appears 60 s before Auto-Off', !!t.warning());
  t.advance(59e3);
  ck('still counting down at 59 s', t.off.length === 0 && !!t.warning());
  t.advance(1e3);
  ck('powers off at 30 min, through the dashboard Power Off path', t.off.length === 1 && t.off[0] === 'poweroff', JSON.stringify(t.off));
  ck('warning removed when powering off', !t.warning());
}
{
  const t = idleTimers({ minutes: 30 });
  t.advance(29.5 * 60e3);
  t.activity();
  ck('activity during the warning cancels it', !t.warning() && t.off.length === 0);
  t.advance(29 * 60e3);
  ck('… and restarts the full countdown', t.off.length === 0 && !!t.warning());
  t.api.stayOn();
  ck('"Stay On" button also cancels it', !t.warning());
}
{
  const t = idleTimers({ minutes: 0 });
  t.advance(10 * 3600e3);
  ck('0 = stay on (nothing after 10 h)', t.off.length === 0 && !t.warning());
  t.api.onAutoOffInput('1');
  t.advance(60e3);
  ck('changing the setting re-arms it (1 min → warning at once, off after 60 s)', t.off.length === 1);
  ck('setting saved with the other idle timers', JSON.parse(t.ls.safekeepIdleTimers).autoOffMinutes === 1, t.ls.safekeepIdleTimers);
  t.api.onAutoOffInput('9999');
  ck('values capped at 240 min', JSON.parse(t.ls.safekeepIdleTimers).autoOffMinutes === 240);
}
{
  const t = idleTimers({ minutes: 1, protocol: 'https:' });
  t.advance(3600e3);
  ck('website demo (not the stick) never powers off', t.off.length === 0);
}
ck('Auto-Off box present in Idle Timers', /id="settings-auto-off-min"[^>]*oninput="skbIdleTimers\.onAutoOffInput\(this\.value\)"/.test(SRC));

// ---- 2. At the unlock prompt ----
function unlockRun({ file, zenity }) {
  const root = mkdtempSync(join(tmpdir(), 'sk-unlock-'));
  const data = join(root, 'data'), bin = join(root, 'bin'), log = join(root, 'zenity.log');
  mkdirSync(data); mkdirSync(bin);
  writeFileSync(join(data, '.vault.luks'), '');
  if (file !== undefined) writeFileSync(join(data, 'auto-off-minutes'), file);
  const script = readFileSync(join(OS, 'unlock-vault.sh'), 'utf8').replaceAll('/mnt/safekeep-data', data);
  writeFileSync(join(root, 'unlock.sh'), script);
  const stub = (n, body) => writeFileSync(join(bin, n), '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
  stub('blkid', 'echo /dev/fake');
  stub('sudo', 'exec "$@"');
  stub('mount', 'exit 0'); stub('umount', 'exit 0');
  stub('mountpoint', `[ "\${@: -1}" = "${data}" ]`);
  stub('zenity', `echo "$*" >> "${log}"\n${zenity}`);
  const r = spawnSync('bash', [join(root, 'unlock.sh')], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH } });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  rmSync(root, { recursive: true, force: true });
  return { status: r.status, calls, out: r.stdout + r.stderr };
}
{
  let r = unlockRun({ zenity: 'exit 5' });
  ck('no saved setting: prompt times out after 30 min (1800 s)', r.calls[0] && r.calls[0].includes('--timeout=1800'), r.calls[0]);
  ck('prompt timed out → exit 4 (Auto-Off)', r.status === 4, r.status + ' ' + r.out.slice(-200));
  r = unlockRun({ file: '7\n', zenity: 'exit 5' });
  ck('saved 7 min → --timeout=420', r.calls[0] && r.calls[0].includes('--timeout=420') && r.status === 4, r.calls[0]);
  r = unlockRun({ file: '0\n', zenity: 'exit 1' });
  ck('saved 0 (stay on) → no timeout; Cancel still exits 2', r.calls[0] && !r.calls[0].includes('--timeout') && r.status === 2, r.calls[0] + ' ' + r.status);
  for (const bad of ['999', 'abc', '-5', '']) {
    r = unlockRun({ file: bad, zenity: 'exit 5' });
    ck(`invalid saved value "${bad}" → default 30 min`, r.calls[0] && r.calls[0].includes('--timeout=1800'), r.calls[0]);
  }
  r = unlockRun({ zenity: 'if [[ "$*" == *--list* ]]; then echo "Type Password"; exit 0; fi\nexit 5' });
  ck('password box times out too → exit 4', r.status === 4 && r.calls.some((c) => c.includes('--entry') && c.includes('--timeout=1800')), r.calls.join(' | '));
  r = unlockRun({ zenity: 'if [[ "$*" == *--list* ]]; then echo "Boot Temporary Session (RAM Only)"; exit 0; fi\nexit 1' });
  ck('choosing a temporary session still exits 3', r.status === 3, r.status);
}

// ---- 3. safekeep-boot.sh ----
{
  const boot = readFileSync(join(OS, 'safekeep-boot.sh'), 'utf8');
  ck('exit 4 from the unlock prompt powers off', /elif \[ "\$UNLOCK_EXIT" -eq 4 \]; then[\s\S]{0,400}sudo poweroff/.test(boot));
  const py = boot.slice(boot.indexOf("<<'DSPYEOF'\n") + 12, boot.indexOf('\nDSPYEOF', boot.indexOf("<<'DSPYEOF'\n")));
  const root = mkdtempSync(join(tmpdir(), 'sk-ds-'));
  writeFileSync(join(root, 'w.py'), py);
  const save = (idle) => {
    for (const f of ['out.json', 'auto-off']) rmSync(join(root, f), { force: true });
    writeFileSync(join(root, 'in.json'), JSON.stringify({ settings: { safekeepTheme: 'dark', safekeepIdleTimers: idle } }));
    const r = spawnSync('python3', ['-I', join(root, 'w.py'), join(root, 'in.json'), join(root, 'out.json'), join(root, 'auto-off')], { encoding: 'utf8' });
    return { ok: r.status === 0, file: existsSync(join(root, 'auto-off')) ? readFileSync(join(root, 'auto-off'), 'utf8') : null, err: r.stderr };
  };
  let r = save(JSON.stringify({ displaySleepMinutes: 10, autoLockMinutes: 15, autoOffMinutes: 45 }));
  ck('Settings Watcher stores the Auto-Off minutes as a plain number', r.ok && r.file === '45\n', JSON.stringify(r));
  r = save(JSON.stringify({ autoOffMinutes: 0 }));
  ck('… including 0 (stay on)', r.ok && r.file === '0\n', JSON.stringify(r));
  for (const bad of [999, -1, 'x', true, 1.5]) {
    r = save(JSON.stringify({ autoOffMinutes: bad }));
    ck(`… but not an invalid value (${JSON.stringify(bad)}); settings still saved`, r.ok && r.file === null, JSON.stringify(r));
  }
  r = save('not json');
  ck('… and survives a malformed timers value', r.ok && r.file === null, JSON.stringify(r));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nAUTO-OFF: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

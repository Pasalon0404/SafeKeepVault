import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
/**
 * test-seed-storage.mjs — Device Options → Seed storage: a flash drive can be
 * set not to keep the master seed. The vault still opens (passphrases, saved
 * wallets, notes, settings); the seed is scanned or typed at each start.
 *  - safekeep-boot.sh Seed Storage Watcher: SEED_STORAGE.json { keepSeed }
 *    validated by SSPYEOF; false writes settings/seed-storage.json and deletes
 *    master-seed*.json, and keeps deleting any that appears; true removes the
 *    flag; invalid requests change nothing; the boot probe removes a stored
 *    seed first; the File Router never takes the request.
 *  - shared/boot.js: boot() skips the stored seed, generate/restore don't
 *    write it, setKeepSeed / isSeedKept exported.
 *  - boot.html: the backup check before deleting compares words exactly
 *    (case and spacing aside) with the seed loaded now.
 * Needs python3 and bash. Run: node test-seed-storage.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSH = readFileSync(join(__dirname, '../usbbootdrive/safekeep-boot.sh'), 'utf8');
const BOOTJS = readFileSync(join(__dirname, 'shared/boot.js'), 'utf8');
const HTML = readFileSync(join(__dirname, 'boot.html'), 'utf8');
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

// ---- The request validator (SSPYEOF) ----
const m = /<<'SSPYEOF'\n([\s\S]*?)\nSSPYEOF\n/.exec(BOOTSH);
ck('Seed Storage Watcher validator found', !!m, '');
const W = mkdtempSync(join(tmpdir(), 'sk-ss-'));
const val = (content) => {
  const src = join(W, 'req.json');
  writeFileSync(src, typeof content === 'string' ? content : JSON.stringify(content));
  const r = spawnSync('python3', ['-I', '-', src], { input: m[1] });
  return r.status === 0 ? String(r.stdout).trim() : null;
};
ck('keepSeed false accepted', val({ version: 1, keepSeed: false }) === 'false');
ck('keepSeed true accepted', val({ keepSeed: true }) === 'true');
ck('refused: keepSeed as a string', val({ keepSeed: 'false' }) === null);
ck('refused: missing keepSeed', val({ version: 1 }) === null);
ck('refused: extra keys', val({ keepSeed: false, mnemonic: 'x' }) === null);
ck('refused: not an object', val('[false]') === null && val('nope') === null);
ck('refused: over 1 KB', val(JSON.stringify({ keepSeed: false, version: 'x'.repeat(1100) })) === null);

// ---- The watcher loop, run for real (3 rounds instead of forever) ----
const blk = /\n    SEED_STORAGE_FLAG="[\s\S]*?\n    \) &\n/.exec(BOOTSH);
ck('watcher block found', !!blk, '');
// The start-up line deletes requests left from an earlier boot; the test drops
// it so a request written before the run is processed like one sent live.
ck('stale requests are deleted at start-up', /\n    rm -f "\$CHROMIUM_DOWNLOAD_DIR"\/SEED_STORAGE\*\.json 2>\/dev\/null\n/.test(blk[0]));
const loop = blk[0].replace('    ) &\n', '    )\n').replace('while true; do', 'for _round in 1 2 3; do')
  .replace(/\n    rm -f "\$CHROMIUM_DOWNLOAD_DIR"\/SEED_STORAGE\*\.json 2>\/dev\/null\n/, '\n');
const runWatcher = (vault) => spawnSync('bash', ['-c', loop], {
  env: { PATH: process.env.PATH, VAULT_MOUNT: vault, SEED_DIR: join(vault, 'seeds'), CHROMIUM_DOWNLOAD_DIR: join(vault, 'seeds'), EPHEMERAL_MODE: '0' },
  timeout: 30000,
});
const V = join(W, 'vault'); mkdirSync(join(V, 'seeds'), { recursive: true });
const seedFile = join(V, 'seeds', 'master-seed.json');
const flag = join(V, 'settings', 'seed-storage.json');
writeFileSync(seedFile, '{"mnemonic":"abandon art"}');
writeFileSync(join(V, 'seeds', 'note.html'), 'keep me');
writeFileSync(join(V, 'seeds', 'SEED_STORAGE.json'), '{"version":1,"keepSeed":false}');
let r = runWatcher(V);
ck('off: flag written', existsSync(flag) && JSON.parse(readFileSync(flag, 'utf8')).keepSeed === false, String(r.stdout) + String(r.stderr));
ck('off: stored seed deleted', !existsSync(seedFile));
ck('off: request consumed', !existsSync(join(V, 'seeds', 'SEED_STORAGE.json')));
ck('off: other files untouched', existsSync(join(V, 'seeds', 'note.html')));
writeFileSync(join(V, 'seeds', 'master-seed (1).json'), '{"mnemonic":"x"}');
runWatcher(V);
ck('off: a seed that appears later is deleted too', !readdirSync(join(V, 'seeds')).some(f => f.startsWith('master-seed')));
writeFileSync(join(V, 'seeds', 'SEED_STORAGE.json'), '{"keepSeed":"yes"}');
runWatcher(V);
ck('invalid request: flag unchanged', existsSync(flag) && !existsSync(join(V, 'seeds', 'SEED_STORAGE.json')));
writeFileSync(join(V, 'seeds', 'SEED_STORAGE (1).json'), '{"keepSeed":true}');
runWatcher(V);
ck('on: flag removed', !existsSync(flag));
writeFileSync(seedFile, '{"mnemonic":"abandon art"}');
runWatcher(V);
ck('on: a saved seed stays', existsSync(seedFile));
const V2 = join(W, 'v2'); mkdirSync(join(V2, 'seeds'), { recursive: true });
writeFileSync(join(V2, 'seeds', 'master-seed.json'), '{}');
writeFileSync(join(V2, 'seeds', 'SEED_STORAGE.json'), '{"keepSeed":false}');
spawnSync('bash', ['-c', loop], { env: { PATH: process.env.PATH, VAULT_MOUNT: V2, SEED_DIR: join(V2, 'seeds'), CHROMIUM_DOWNLOAD_DIR: join(V2, 'seeds'), EPHEMERAL_MODE: '1' }, timeout: 30000 });
ck('Temporary Session: nothing done', existsSync(join(V2, 'seeds', 'master-seed.json')) && !existsSync(join(V2, 'settings', 'seed-storage.json')));
rmSync(W, { recursive: true, force: true });

ck('boot probe removes a stored seed when not kept', /if \[ "\$EPHEMERAL_MODE" != "1" \] && \[ -f "\$VAULT_MOUNT\/settings\/seed-storage\.json" \][\s\S]{0,400}shred -u[\s\S]{0,600}elif \[ -f "\$SEED_FILE" \]/.test(BOOTSH));
ck('File Router skips SEED_STORAGE files', /\|SEED_STORAGE\*\|/.test(BOOTSH));
const sh = spawnSync('bash', ['-n', join(__dirname, '../usbbootdrive/safekeep-boot.sh')]);
ck('safekeep-boot.sh parses', sh.status === 0, String(sh.stderr));

// ---- shared/boot.js ----
ck('boot(): reads the setting', /_keepSeed = await _readKeepSeed\(\);/.test(BOOTJS));
ck('boot(): skips the stored seed when not kept', /if \(!_keepSeed\) return _welcomeState\(\);\n\n    \/\/ Cold boot: try to load master-seed\.json/.test(BOOTJS));
ck('generate and restore: no write when not kept', (BOOTJS.match(/const writeResult = _keepSeed\n      \? await _silentSaveMasterSeed\(/g) || []).length === 2);
ck('setting read from settings/seed-storage.json', /SEED_STORAGE_URL  = `file:\/\/\$\{VAULT_ROOT\}\/settings\/seed-storage\.json`/.test(BOOTJS));
ck('only an explicit keepSeed:false turns it off', /return !\(data && data\.keepSeed === false\);/.test(BOOTJS));
ck('never in a Temporary Session', /if \(_ccTemporarySession\(\)\) return \{ ok: false/.test(BOOTJS) && /if \(!isBootDrive\(\) \|\| _ccTemporarySession\(\)\) return true;/.test(BOOTJS));
ck('isSeedKept / setKeepSeed exported', /\n\s+isSeedKept,\n\s+setKeepSeed,/.test(BOOTJS));
ck('request has no "passphrase" key (File Router)', !/SEED_STORAGE_FILE, JSON\.stringify\(\{[^}]*passphrase/.test(BOOTJS));

// ---- boot.html backup check ----
function extract(name) {
  const mm = new RegExp('(^|\\n)(async\\s+)?function\\s+' + name + '\\s*\\(').exec(HTML);
  let i = HTML.indexOf('{', HTML.indexOf(')', mm.index)), j = i, depth = 0, str = null;
  for (; j < HTML.length; j++) {
    const c = HTML[j], n = HTML[j + 1];
    if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
    if (c === '/' && n === '/') { j = HTML.indexOf('\n', j); continue; }
    if (c === '/' && n === '*') { j = HTML.indexOf('*/', j) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return HTML.slice(mm.index, j + 1);
}
const MN = 'abandon '.repeat(23) + 'art';
const els = { 'settings-seed-check': { innerHTML: '', style: {} }, 'settings-seed-delete-btn': { disabled: true }, 'settings-seed-words': { value: '' } };
const ctx = vm.createContext({ window: { SeedSession: { get: () => ({ mnemonic: MN }) } }, document: { getElementById: (id) => els[id] || null }, String });
vm.runInContext('var _ssMatched = false;\n' + ['_ssNormWords', '_ssLoadedMnemonic', '_ssSetCheck', 'ssSettingsCheck'].map(extract).join('\n'), ctx);
ck('check: matching words (any case/spacing) pass', ctx.ssSettingsCheck('  ' + MN.toUpperCase().replace(/ /g, '  \n')) === true && els['settings-seed-delete-btn'].disabled === false);
ck('check: different seed fails and keeps Delete off', ctx.ssSettingsCheck('abandon '.repeat(11) + 'about') === false && els['settings-seed-delete-btn'].disabled === true);
ck('check: one word off fails', ctx.ssSettingsCheck('abandon '.repeat(22) + 'ability art') === false);
ck('check: wrong word count explained', ctx.ssSettingsCheck('abandon art') === false && /2 words/.test(els['settings-seed-check'].innerHTML));
els['settings-seed-words'].value = MN;
ck('check: typed words cleared after a match', ctx.ssSettingsCheck() === true && els['settings-seed-words'].value === '');
ck('Delete starts disabled', /id="settings-seed-delete-btn" disabled/.test(HTML));
ck('welcome: seed-free buttons wired', /onclick="welcome_seedFreeScan\(\)"/.test(HTML) && /welcome-actions--seedfree/.test(HTML));
ck('backup screen hides the Master Seed item when not kept', /_rlqSeedItem\.style\.display = _rlqSeedKept \? 'flex' : 'none'/.test(HTML));
ck('dev mock has the API', /isSeedKept: function \(\) \{ return _devKeepSeed; \}/.test(HTML) && /setKeepSeed: async function \(keep, mnemonic\)/.test(HTML));

console.log(`test-seed-storage: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

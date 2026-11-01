import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
/**
 * test-receive-index.mjs — "Show an address" remembers, per wallet, the last
 * receive address it showed (SafeKeep is offline and can't see which ones
 * received money):
 *  - the Receive Watcher's Python (usbbootdrive/safekeep-boot.sh, RIPYEOF)
 *    stores only { wallets: { id: n } }: ids of 4-80 [A-Za-z0-9:_-], n an
 *    integer 0..2^31-1, at most 200, at most 32 KB; anything else is refused;
 *  - shared/boot.js _cleanReceiveMap applies the same rules on the app side;
 *  - boot.html: within one session reopening shows the same address and only
 *    "New address" moves on (so the gap limit isn't run past); a new session
 *    offers the next one; the wallet ids hold no key material.
 * Needs python3. Run: node test-receive-index.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSH = readFileSync(join(__dirname, '../usbbootdrive/safekeep-boot.sh'), 'utf8');
const BOOTJS = readFileSync(join(__dirname, 'shared/boot.js'), 'utf8');
const HTML = readFileSync(join(__dirname, 'boot.html'), 'utf8');
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); };

// ---- The watcher's Python ----
const m = /<<'RIPYEOF'\n([\s\S]*?)\nRIPYEOF\n/.exec(BOOTSH);
ck('Receive Watcher script found', !!m, '');
const W = mkdtempSync(join(tmpdir(), 'sk-rcv-'));
const run = (content) => {
  const src = join(W, 'in.json'), dst = join(W, 'out.json');
  rmSync(dst, { force: true });
  writeFileSync(src, typeof content === 'string' ? content : JSON.stringify(content));
  const r = spawnSync('python3', ['-I', '-', src, dst], { input: m[1] });
  return { ok: r.status === 0, out: existsSync(dst) ? JSON.parse(readFileSync(dst, 'utf8')) : null, err: String(r.stderr) };
};
let r = run({ version: 1, wallets: { 'seed:73c5da0a:84': 4, 'saved:abcd1234': 0 } });
ck('valid map stored as { version: 1, wallets }', r.ok && JSON.stringify(r.out) === '{"version": 1, "wallets": {"seed:73c5da0a:84": 4, "saved:abcd1234": 0}}'.replace(/: /g, ':').replace(/, /g, ',') || (r.ok && r.out.wallets['seed:73c5da0a:84'] === 4 && r.out.version === 1), JSON.stringify(r));
ck('refused: negative index', !run({ wallets: { 'seed:73c5da0a:84': -1 } }).ok);
ck('refused: fractional index', !run({ wallets: { 'seed:73c5da0a:84': 1.5 } }).ok);
ck('refused: true as an index', !run({ wallets: { 'seed:73c5da0a:84': true } }).ok);
ck('refused: index past 2^31-1', !run({ wallets: { 'seed:73c5da0a:84': 2147483648 } }).ok);
ck('refused: id with a slash or space', !run({ wallets: { 'seed/../x': 1 } }).ok && !run({ wallets: { 'a b c d': 1 } }).ok);
ck('refused: id too short / too long', !run({ wallets: { 'ab': 1 } }).ok && !run({ wallets: { ['x'.repeat(81)]: 1 } }).ok);
const many = {}; for (let i = 0; i < 201; i++) many['seed:' + String(i).padStart(8, '0') + ':84'] = i;
ck('refused: more than 200 wallets', !run({ wallets: many }).ok);
ck('refused: larger than 32 KB', !run(JSON.stringify({ wallets: {}, pad: 'x'.repeat(33000) })).ok);
ck('refused: not a map', !run({ wallets: [1, 2] }).ok && !run('[]').ok);
ck('nothing written when refused', !existsSync(join(W, 'out.json')));
rmSync(W, { recursive: true, force: true });
ck('stored in settings/ (carried by Encrypted Backup)', /RECEIVE_INDEX_STORED="\$VAULT_MOUNT\/settings\/receive-index\.json"/.test(BOOTSH));
ck('normal boots only', /RI_FILES\[@\]\}" -gt 0 \] && \[ "\$EPHEMERAL_MODE" != "1" \]/.test(BOOTSH));
const sh = spawnSync('bash', ['-n', join(__dirname, '../usbbootdrive/safekeep-boot.sh')]);
ck('safekeep-boot.sh parses', sh.status === 0, String(sh.stderr));

// ---- shared/boot.js _cleanReceiveMap ----
const fnSrc = BOOTJS.slice(BOOTJS.indexOf('  function _cleanReceiveMap('), BOOTJS.indexOf('\n  }\n', BOOTJS.indexOf('  function _cleanReceiveMap(')) + 4);
const jctx = vm.createContext({});
vm.runInContext("const RECEIVE_ID_RE = /^[A-Za-z0-9:_-]{4,80}$/;\n" + fnSrc + '\nthis.clean = _cleanReceiveMap;', jctx);
ck('app: valid map kept', JSON.stringify(jctx.clean({ 'seed:73c5da0a:84': 3 })) === '{"seed:73c5da0a:84":3}');
ck('app: bad maps refused', jctx.clean({ 'x/y/z/w': 1 }) === null && jctx.clean({ 'seed:73c5da0a:84': -2 }) === null && jctx.clean([]) === null);
ck('app: loadReceiveIndex / saveReceiveIndex exported', /\n\s+loadReceiveIndex,\n\s+saveReceiveIndex,/.test(BOOTJS));

// ---- boot.html session logic (rcv_selectWallet / rcv_new / rcv_record) ----
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
const saved = [];
const ctx = vm.createContext({ window: { SafeKeepOS: { saveReceiveIndex: async (mp) => { saved.push(JSON.stringify(mp)); return { saved: true }; } } }, console, Object, Math, JSON });
vm.runInContext("var _rcv = { wallets: [], cur: null, index: 0, map: {}, session: {} }; var shown = [];\nfunction rcv_show(i) { _rcv.index = i; shown.push(i); }\n" +
  ['rcv_selectWallet', 'rcv_record', 'rcv_new'].map(extract).join('\n') + '\nthis.T = { sel: rcv_selectWallet, nw: rcv_new, get: () => ({ shown: shown.slice(), map: _rcv.map }), reset: (m) => { _rcv.session = {}; _rcv.map = m; shown.length = 0; } };', ctx);
vm.runInContext("_rcv.wallets = [{ id: 'seed:73c5da0a:84' }, { id: 'saved:abcd1234' }];", ctx);
ctx.T.reset({});
ctx.T.sel('seed:73c5da0a:84'); ctx.T.sel('seed:73c5da0a:84');
let g = ctx.T.get();
ck('first open shows #0 and records it; reopening in the same session shows #0 again', JSON.stringify(g.shown) === '[0,0]' && g.map['seed:73c5da0a:84'] === 0, JSON.stringify(g));
ctx.T.nw();
g = ctx.T.get();
ck('New address moves to #1 and records it', g.shown[g.shown.length - 1] === 1 && g.map['seed:73c5da0a:84'] === 1, JSON.stringify(g));
ctx.T.reset({ 'seed:73c5da0a:84': 1 });
ctx.T.sel('seed:73c5da0a:84');
ck('a new session offers the one after the last shown (#2)', ctx.T.get().shown[0] === 2 && ctx.T.get().map['seed:73c5da0a:84'] === 2, JSON.stringify(ctx.T.get()));
ctx.T.sel('saved:abcd1234');
ck('each wallet has its own position', ctx.T.get().shown[1] === 0 && ctx.T.get().map['saved:abcd1234'] === 0);
ck('positions are saved to the vault', saved.length >= 3 && /"saved:abcd1234":0/.test(saved[saved.length - 1]), saved.join(' '));
ck('wallet ids: fingerprint + type, or a descriptor checksum (no keys)', /id: 'seed:' \+ d\.fingerprint \+ ':' \+ t\[0\]/.test(HTML) && /id: 'saved:' \+ cs/.test(HTML));
ck('Dashboard tile and sidebar card open the screen', (HTML.match(/onclick="rcv_open\('state-receive'\)"/g) || []).length === 2);

// ---- Addresses: the screen's own derivation against published test vectors ----
// (BIP-84/86/49/44 for "abandon … about": receive #0 and #1.)
{
  const btc = await import('@scure/btc-signer');
  const bip39 = await import('@scure/bip39');
  const { HDKey } = await import('@scure/bip32');
  function extractVar(name) {
    const mm = new RegExp('\\nvar ' + name + '\\s*=').exec(HTML);
    const after = HTML.slice(mm.index + mm[0].length).trimStart();
    if (after[0] === '{') { const st = mm.index + mm[0].length + HTML.slice(mm.index + mm[0].length).indexOf('{'); let d = 0, j = st; for (; j < HTML.length; j++) { if (HTML[j] === '{') d++; else if (HTML[j] === '}') { d--; if (!d) break; } } return HTML.slice(mm.index, j + 1) + ';'; }
    return HTML.slice(mm.index, HTML.indexOf(';', mm.index) + 1);
  }
  const actx = vm.createContext({ window: { BtcMath: { btcSigner: btc, HDKey, bip39 } }, console, Uint8Array, Uint32Array, DataView, BigInt, Number, String, Array, Object, Math, Error, ArrayBuffer, parseInt, isNaN, PSBT_NETWORK: btc.NETWORK });
  vm.runInContext([
    ...['DESC_BIP32_PUBLIC_MAINNET', 'DESC_BIP32_PUBLIC_TESTNET', '_DESC_MAINNET_VERS', '_DESC_TESTNET_VERS', '_WREC_SCRIPTS', '_sha256K', '_B58_ALPHABET'].map(extractVar),
    ...['desc_checksum', 'desc_parseKeyOrigin', '_base58decode', '_base58checkDecode', '_base58check', '_base58encode', '_sha256sync', '_sha256impl', '_rr',
        '_descNormalizeXpub', '_wrecSplitArgs', '_wrecCall', '_wrecParseDescriptor', '_wrecIndexZeroPubkey', '_wrecCompareBytes', '_wrecFirstAddress', '_wrecAddressFromPubkeys',
        '_descChainNodes', '_descImportPrivateCheck', '_descSingleSig', 'rcv_addressAt'].map(extract),
    'this.A = { single: _descSingleSig, parse: _wrecParseDescriptor, at: rcv_addressAt };'].join('\n'), actx);
  const seed = await bip39.mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');
  const VEC = {
    84: ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'],
    86: ['bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh'],
    49: ['37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf', '3LtMnn87fqUeHBUG414p9CWwnoV6E2pNKS'],
    44: ['1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA', '1Ak8PffB2meyfYnbXZR9EGfLfFZVpzJvQP'],
  };
  const wallets = Object.keys(VEC).map((t) => ({ t, w: { parsed: actx.A.parse(actx.A.single(seed, t).descriptor) } }));
  for (const { t, w } of wallets) {
    const got = [actx.A.at(w, 0), actx.A.at(w, 1)];
    ck('BIP-' + t + ' receive #0 and #1 match the published vectors', got[0] === VEC[t][0] && got[1] === VEC[t][1], got.join(' '));
  }
  // Interleaved calls across wallets must not mix their keys (the bug this guards against).
  const again = wallets.map(({ t, w }) => actx.A.at(w, 0) === VEC[t][0]);
  ck('switching between wallets keeps each wallet\'s own keys', again.every(Boolean), again.join(','));
  ck('the screen never uses Output Descriptor\'s key cache (_descRecv)', !/_descRecv\.|_descRecvAddressAt/.test(extract('rcv_addressAt') + extract('_rcvShow') + extract('rcv_init')));
}

console.log(`\ntest-receive-index: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * test-psbt-sighash-policy.mjs — SafeKeep only signs with SIGHASH_DEFAULT/ALL.
 *
 * A PSBT can ask for a different sighash type per input (PSBT_IN_SIGHASH_TYPE).
 * NONE, SINGLE and the ANYONECANPAY variants give a signature that does not
 * cover every input and output, so its holder can change the transaction
 * afterwards. btc-signer's signIdx refuses them by default, but the Silent
 * Payment spend signer signs directly and used to honour whatever the PSBT
 * asked for. These tests extract the real functions from boot.html and check:
 *   - the SP signer still signs with no sighash, 0x00 and 0x01 (and the
 *     signature verifies), and refuses 0x02, 0x03, 0x81, 0x82, 0x83 without
 *     writing a signature;
 *   - _psbtUnsafeSighashInputs (used by the review gate and psbtDoSign) flags
 *     exactly the unsafe inputs;
 *   - btc-signer's own signIdx still refuses a non-ALL request (the normal path).
 *
 * Run: node test-psbt-sighash-policy.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import * as bip39 from '@scure/bip39';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
function extract(name) {
  const re = new RegExp('(^|\\n)([ \\t]*)(async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(SRC); if (!m) throw new Error('not found: ' + name);
  let p = m.index + m[0].length - 1, depth = 0;
  for (; p < SRC.length; p++) { const c = SRC[p]; if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) break; } }
  let i = SRC.indexOf('{', p), j = i, str = null;
  depth = 0;
  for (; j < SRC.length; j++) {
    const c = SRC[j], n = SRC[j + 1];
    if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
    if (c === '/' && n === '/') { j = SRC.indexOf('\n', j); continue; }
    if (c === '/' && n === '*') { j = SRC.indexOf('*/', j) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(m.index, j + 1);
}
const SAFE_CONST = SRC.match(/^const _PSBT_SAFE_SIGHASH = .*$/m);
if (!SAFE_CONST) throw new Error('not found: _PSBT_SAFE_SIGHASH');

const G = secp256k1.Point.BASE;
const N = secp256k1.Point.Fn.ORDER;
const bnBE = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const beBytes = (n, len = 32) => { const o = new Uint8Array(len); let x = n; for (let i = len - 1; i >= 0; i--) { o[i] = Number(x & 255n); x >>= 8n; } return o; };
const modN = (x) => ((x % N) + N) % N;

const FNS = ['_psbtSighashIsSafe', '_psbtSighashName', '_psbtUnsafeSighashInputs', '_psbtTrySignSilentPaymentInput'];
const ctx = vm.createContext({
  window: {
    BtcMath: { btcSigner: btc, HDKey, schnorr },
    SilentPayments: { _internal: { modN, bytesToNumberBE: bnBE, numberToBytesBE: beBytes, G } },
  },
  console: { log() {}, warn() {}, error() {} },
  Uint8Array, BigInt, Number, String, Array, Object, Math, Error,
});
vm.runInContext(SAFE_CONST[0] + '\n' + FNS.map(extract).join('\n') + '\nthis.__fns = { ' + FNS.join(', ') + ' };', ctx);
const F = ctx.__fns;

let pass = 0, fail = 0;
function check(name, ok, detail = '') { ok ? pass++ : fail++; console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '   ' + detail : '')); }

// ---------------------------------------------------------------------------
// A Silent Payment input for "abandon ... about", in Sparrow's 0x1f/0x20 form
// ---------------------------------------------------------------------------
const master = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', ''));
const pathComps = [0x80000160, 0x80000000, 0x80000000, 0, 0];  // m/352'/0'/0'/0/0
let node = master; for (const c of pathComps) node = node.deriveChild(c);
const tBytes = hexToBytes('137278c4744472282400bc4b0c60afe74101bb7fe789f88803d0ef3f0fbd4b07');
const Q = secp256k1.Point.fromBytes(node.publicKey).add(G.multiply(modN(bnBE(tBytes))));
const Qx = Q.toBytes(true).slice(1);
const spk = concatBytes(Uint8Array.from([0x51, 0x20]), Qx);

const u8 = (a) => Uint8Array.from(a);
const vi = (n) => n < 0xfd ? u8([n]) : u8([0xfd, n & 255, n >> 8]);
const u32le = (v) => u8([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
const u64le = (v) => { const b = new Uint8Array(8); let x = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
const kv = (key, val) => concatBytes(vi(key.length), key, vi(val.length), val);

// sighash: undefined = no PSBT_IN_SIGHASH_TYPE field
function spPsbt(sighash) {
  const outScript = concatBytes(u8([0x00, 0x14]), hexToBytes('33'.repeat(20)));
  const utx = concatBytes(u32le(2), vi(1), hexToBytes('aa'.repeat(32)), u32le(0), vi(0), u32le(0xfffffffd),
    vi(1), u64le(9000), vi(outScript.length), outScript, u32le(0));
  const fpBytes = beBytes(BigInt(master.fingerprint >>> 0), 4);
  const f31val = concatBytes(fpBytes, ...pathComps.map(u32le));
  const input = [
    kv(u8([0x01]), concatBytes(u64le(10000), vi(spk.length), spk)),
    ...(sighash === undefined ? [] : [kv(u8([0x03]), u32le(sighash))]),
    kv(concatBytes(u8([0x1f]), node.publicKey), f31val),
    kv(u8([0x20]), tBytes),
  ];
  const bytes = concatBytes(u8([0x70, 0x73, 0x62, 0x74, 0xff]), kv(u8([0x00]), utx), u8([0x00]), ...input, u8([0x00]), u8([0x00]));
  return btc.Transaction.fromPSBT(bytes, { allowUnknownInputs: true, allowUnknownOutputs: true });
}

function verifies(tx, sighash) {
  const sig = tx.inputs[0].tapKeySig;
  const hash = tx.preimageWitnessV1(0, [spk], sighash, [10000n]);
  return schnorr.verify(sig.slice(0, 64), hash, Qx);
}

console.log('Silent Payment signer, safe sighash types:');
for (const [label, sh] of [['no sighash field', undefined], ['SIGHASH_DEFAULT 0x00', 0x00], ['SIGHASH_ALL 0x01', 0x01]]) {
  const tx = spPsbt(sh);
  let ok = false, err = '';
  try { ok = F._psbtTrySignSilentPaymentInput(tx, 0, master, null); } catch (e) { err = e.message; }
  const sig = tx.inputs[0].tapKeySig;
  const wantLen = (sh === 0x01) ? 65 : 64;
  check(label + ' signs', ok === true && !!sig, err);
  check(label + ' signature length ' + wantLen + (sh === 0x01 ? ' with 0x01 byte' : ''),
    !!sig && sig.length === wantLen && (wantLen === 64 || sig[64] === 0x01));
  check(label + ' signature verifies', !!sig && verifies(tx, sh ?? 0x00));
}

console.log('Silent Payment signer, unsafe sighash types are refused:');
for (const sh of [0x02, 0x03, 0x81, 0x82, 0x83]) {
  const tx = spPsbt(sh);
  let threw = false, msg = '';
  try { F._psbtTrySignSilentPaymentInput(tx, 0, master, null); } catch (e) { threw = true; msg = e.message; }
  check(F._psbtSighashName(sh) + ' refused', threw && /only SIGHASH_DEFAULT or SIGHASH_ALL/.test(msg), msg);
  check(F._psbtSighashName(sh) + ' wrote no signature', !tx.inputs[0].tapKeySig);
}

console.log('Review gate detection (_psbtUnsafeSighashInputs):');
const me = master.derive("m/84'/0'/0'/0/0");
function wpkhTx(sighashes) {
  const t = new btc.Transaction({ allowUnknownInputs: true });
  sighashes.forEach((sh, i) => t.addInput({ txid: new Uint8Array(32).fill(i + 1), index: 0,
    witnessUtxo: { script: btc.p2wpkh(me.publicKey).script, amount: 50_000n }, ...(sh === undefined ? {} : { sighashType: sh }) }));
  t.addOutputAddress('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 90_000n);
  return btc.Transaction.fromPSBT(t.toPSBT());
}
const none = F._psbtUnsafeSighashInputs(wpkhTx([undefined, 0x01]));
check('no field + SIGHASH_ALL -> nothing flagged', none.length === 0, JSON.stringify(none));
const mixed = F._psbtUnsafeSighashInputs(wpkhTx([0x01, 0x02, undefined, 0x83]));
check('flags exactly inputs 1 (0x02) and 3 (0x83)',
  mixed.length === 2 && mixed[0].index === 1 && mixed[0].sighash === 0x02 && mixed[1].index === 3 && mixed[1].sighash === 0x83,
  JSON.stringify(mixed));
check('flags the SP input too', F._psbtUnsafeSighashInputs(spPsbt(0x02)).length === 1);
check('names: 0x83 -> SIGHASH_SINGLE|ANYONECANPAY (0x83)', F._psbtSighashName(0x83) === 'SIGHASH_SINGLE|ANYONECANPAY (0x83)');

console.log('Normal path (btc-signer signIdx default) still refuses non-ALL:');
const t2 = wpkhTx([0x02]);
let refused = false;
try { t2.signIdx(me.privateKey, 0); } catch (e) { refused = /not allowed sigHash/i.test(e.message); }
check('signIdx refuses SIGHASH_NONE', refused);

console.log(`\nPSBT SIGHASH POLICY: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

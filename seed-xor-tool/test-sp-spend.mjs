/**
 * test-sp-spend.mjs
 *
 * Validates the Silent Payment SPEND signing algorithm end to end against real
 * cryptography, exactly as boot.html will implement it.
 *
 * Spending an SP UTXO = a BIP-340 key-path Schnorr signature over a P2TR input
 * whose output key is P_output = B_spend + t_k·G (BIP-352). Sparrow signals it
 * with two proprietary PSBT input fields:
 *   0x1f : key = 33-byte base spend pubkey B_spend ; value = fp(4) || path(N*4 LE)
 *   0x20 : value = 32-byte scalar tweak t_k
 * The signing key is d = (b_spend + t_k) mod n.
 *
 * The test: derive b_spend from a seed, build a real P2TR input + PSBT carrying
 * 0x1f/0x20, run the algorithm, and prove the produced tapKeySig verifies under
 * the output key + BIP-341 sighash, and that the tx finalizes/extracts.
 *
 * Run:  node test-sp-spend.mjs
 */
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils.js';

const G = secp256k1.Point.BASE;
const N = secp256k1.Point.Fn.ORDER;
const bnBE = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const beBytes = (n, len = 32) => { const o = new Uint8Array(len); let x = n; for (let i = len - 1; i >= 0; i--) { o[i] = Number(x & 255n); x >>= 8n; } return o; };
const modN = (x) => ((x % N) + N) % N;

let pass = 0, fail = 0;
const ck = (n, c, x) => { (c ? pass++ : fail++); console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${x && !c ? '  ' + x : ''}`); };

// ---------------------------------------------------------------------------
// Build a real SP UTXO + spending PSBT
// ---------------------------------------------------------------------------
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = bip39.mnemonicToSeedSync(mnemonic, '');
const master = HDKey.fromMasterSeed(seed);
const fp = master.fingerprint >>> 0;
const fpBytes = beBytes(BigInt(fp), 4); // big-endian master fingerprint

// Base spend key at the path Sparrow signalled in the diagnostic: m/352'/0'/0'/0/0
const pathComps = [0x80000160, 0x80000000, 0x80000000, 0x00000000, 0x00000000];
let node = master;
for (const c of pathComps) node = node.deriveChild(c);
const bSpend = node.privateKey;        // 32-byte private scan-spend key
const Bspend = node.publicKey;         // 33-byte compressed

// A tweak t_k (any scalar < n). In reality = hash_BIP0352/SharedSecret(...).
const tBytes = hexToBytes('137278c4744472282400bc4b0c60afe74101bb7fe789f88803d0ef3f0fbd4b07');
const tNum = modN(bnBE(tBytes));

// Output key Q = B_spend + t_k·G ; signing key d = b_spend + t_k
const Q = secp256k1.Point.fromBytes(Bspend).add(G.multiply(tNum));
const Qxonly = Q.toBytes(true).slice(1);
const dNum = modN(bnBE(bSpend) + tNum);
ck('d·G equals output key Q', bytesToHex(G.multiply(dNum).toBytes(true).slice(1)) === bytesToHex(Qxonly));

const spk = concatBytes(Uint8Array.from([0x51, 0x20]), Qxonly); // P2TR scriptPubKey

// Hand-build a v0 PSBT: 1 taproot input (with 0x1f/0x20), 1 output.
const u8 = (a) => Uint8Array.from(a);
const vi = (n) => n < 0xfd ? u8([n]) : u8([0xfd, n & 255, n >> 8]);
const u32le = (v) => u8([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
const u64le = (v) => { const b = new Uint8Array(8); let x = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
const kv = (key, val) => concatBytes(vi(key.length), key, vi(val.length), val);
const txid = hexToBytes('aa'.repeat(32));
const outScript = concatBytes(u8([0x00, 0x14]), hexToBytes('33'.repeat(20))); // p2wpkh dest
const utx = concatBytes(u32le(2), vi(1), txid, u32le(0), vi(0), u32le(0xfffffffd), vi(1), u64le(9000), vi(outScript.length), outScript, u32le(0));
const f31key = concatBytes(u8([0x1f]), Bspend);
const f31val = concatBytes(fpBytes, u32le(pathComps[0]), u32le(pathComps[1]), u32le(pathComps[2]), u32le(pathComps[3]), u32le(pathComps[4]));
const f32 = kv(u8([0x20]), tBytes);
const wu = concatBytes(u64le(10000), vi(spk.length), spk);
const psbtBytes = concatBytes(
  u8([0x70, 0x73, 0x62, 0x74, 0xff]),
  kv(u8([0x00]), utx), u8([0x00]),
  kv(u8([0x01]), wu), kv(f31key, f31val), f32, u8([0x00]),
  u8([0x00]),
);

const tx = btc.Transaction.fromPSBT(psbtBytes, { allowUnknownInputs: true });

// ---------------------------------------------------------------------------
// The signing algorithm (mirrors _psbtTrySignSilentPaymentInput in boot.html)
// ---------------------------------------------------------------------------
function signSilentPaymentInput(tx, idx, masterKey, myFpNum) {
  const inp = tx.inputs[idx];
  const script = inp.witnessUtxo && inp.witnessUtxo.script;
  if (!script || script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) return false; // not P2TR
  const unk = inp.unknown;
  if (!Array.isArray(unk)) return false;

  let baseSpendPub = null, fpPath = null, tweak = null;
  for (const [k, v] of unk) {
    if (!k) continue;
    if (k.type === 0x1f) { baseSpendPub = k.key; fpPath = v; }
    else if (k.type === 0x20) { tweak = v; }
  }
  if (!fpPath || !tweak || tweak.length !== 32) return false;
  if (fpPath.length < 4 || (fpPath.length - 4) % 4 !== 0) return false;

  // fingerprint gate
  const entryFp = (fpPath[0] << 24 | fpPath[1] << 16 | fpPath[2] << 8 | fpPath[3]) >>> 0;
  const WILDCARD = 0x00000000;
  if (entryFp !== (myFpNum >>> 0) && entryFp !== WILDCARD) {
    console.log('     (fp mismatch: entry=' + entryFp.toString(16) + ' mine=' + (myFpNum>>>0).toString(16) + ')');
    return false;
  }

  // parse LE path components
  const path = [];
  for (let o = 4; o + 4 <= fpPath.length; o += 4) {
    path.push((fpPath[o] | fpPath[o + 1] << 8 | fpPath[o + 2] << 16 | fpPath[o + 3] << 24) >>> 0);
  }
  // derive base spend private key
  let child = masterKey;
  for (const c of path) child = child.deriveChild(c);
  if (!child.privateKey) return false;
  if (baseSpendPub && bytesToHex(child.publicKey) !== bytesToHex(baseSpendPub)) {
    console.log('     (derived pubkey != field 0x1f base spend pubkey)');
    return false;
  }

  // d = (b_spend + t_k) mod n
  const d = modN(bnBE(child.privateKey) + bnBE(tweak));
  if (d === 0n) return false;
  const dBytes = beBytes(d, 32);

  // confirm d·G matches the taproot output key before signing
  if (bytesToHex(G.multiply(d).toBytes(true).slice(1)) !== bytesToHex(script.slice(2, 34))) {
    console.log('     (tweaked key does not match output key — refusing to sign)');
    return false;
  }

  // BIP-341 key-path sighash via btc-signer, then BIP-340 Schnorr sign (no taptweak)
  const sighashType = (inp.sighashType !== undefined && inp.sighashType !== null) ? inp.sighashType : 0x00; // DEFAULT
  const prevOutScript = tx.inputs.map((i) => i.witnessUtxo.script);
  const amount = tx.inputs.map((i) => i.witnessUtxo.amount);
  const hash = tx.preimageWitnessV1(idx, prevOutScript, sighashType, amount);
  const sig64 = schnorr.sign(hash, dBytes);
  const tapKeySig = sighashType === 0x00 ? sig64 : concatBytes(sig64, u8([sighashType]));
  tx.updateInput(idx, { tapKeySig }, true);
  return { hash, sig64, Qxonly: script.slice(2, 34) };
}

console.log('\n[SP-SPEND] sign a Silent Payment taproot input');
const res = signSilentPaymentInput(tx, 0, master, fp);
ck('signing routine returned success', !!res);
if (res) {
  ck('tapKeySig set on input', !!tx.inputs[0].tapKeySig);
  ck('Schnorr sig verifies against output key + sighash', schnorr.verify(res.sig64, res.hash, res.Qxonly) === true);
  // finalize + extract → proves a broadcastable witness
  let extracted = false, rawLen = 0;
  try { tx.finalizeIdx(0); const raw = tx.extract(); rawLen = raw.length; extracted = true; } catch (e) { console.log('     finalize/extract error: ' + e.message); }
  ck('tx finalizes and extracts a raw tx', extracted, '');
  if (extracted) console.log('     raw tx bytes: ' + rawLen);
}

// negative: wrong tweak must NOT verify
console.log('\n[SP-SPEND] tamper check');
{
  const tx2 = btc.Transaction.fromPSBT(psbtBytes, { allowUnknownInputs: true });
  // corrupt the tweak via a fresh PSBT with a different t
  const badT = hexToBytes('00'.repeat(31) + '02');
  const dBad = modN(bnBE(bSpend) + bnBE(badT));
  const prevOutScript = tx2.inputs.map((i) => i.witnessUtxo.script);
  const amount = tx2.inputs.map((i) => i.witnessUtxo.amount);
  const hash = tx2.preimageWitnessV1(0, prevOutScript, 0x00, amount);
  const badSig = schnorr.sign(hash, beBytes(dBad, 32));
  ck('wrong-tweak signature is REJECTED by output key', schnorr.verify(badSig, hash, Qxonly) === false);
}

console.log('\n--------------------------------------------------');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('Silent Payment spend signing verified against real crypto.');

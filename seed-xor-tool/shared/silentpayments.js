/**
 * SafeKeep Vault — Silent Payments (BIP-352) — Phase 1: Single-Signer
 * ===================================================================
 *
 * A standalone, air-gapped implementation of the BIP-352 *sender* derivation
 * built directly on the primitives we already ship (@noble/curves,
 * @noble/hashes, @scure/base). No new dependencies. @scure/btc-signer 2.0.1
 * does NOT expose Silent Payment helpers, so we compute the math ourselves.
 *
 * Scope of Phase 1 (single signer, one party controls every input key):
 *   - Parse a BIP-375 PSBT_OUT_SP_V0_INFO (0x09) value into B_scan / B_spend.
 *   - Sum the eligible input private keys, applying BIP-341 even-Y parity
 *     negation for Taproot (P2TR) inputs.
 *   - Compute input_hash = tagged_hash("BIP0352/Inputs", outpoint_L || A).
 *   - Compute the ECDH shared secret  (input_hash * a) * B_scan.
 *   - Derive the per-output tweak t_k and the final Taproot output key P_k,
 *     returning the 34-byte scriptPubKey (OP_1 <32-byte x-only>).
 *   - Encode / decode human-readable  sp1...  addresses (custom-length
 *     Bech32m, because they exceed the default 90-char BIP-173 limit).
 *
 * BIP-352 tagged-hash tags (verified against the finalized spec):
 *   "BIP0352/Inputs", "BIP0352/SharedSecret", "BIP0352/Label".
 *
 * BIP-375 field constants (verified against the spec):
 *   PSBT_OUT_SP_V0_INFO  = 0x09  (value = version(1) || B_scan(33) || B_spend(33) = 67 bytes)
 *   PSBT_OUT_SP_V0_LABEL = 0x0a
 *
 * Multi-party signing (DLEQ proofs, PSBT_*_SP_ECDH_SHARE / _SP_DLEQ) is
 * intentionally OUT OF SCOPE for Phase 1 and will be added later.
 *
 * Consumption:
 *   - ESM:    import { deriveSilentPaymentOutputs } from './shared/silentpayments.js'
 *   - Browser: bundled by boot-entry.js (Vite); also attaches window.SilentPayments.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32m } from '@scure/base';

// ---------------------------------------------------------------------------
// Curve handles
// ---------------------------------------------------------------------------
const Point = secp256k1.Point;     // noble v2 point class
const G = Point.BASE;              // generator
const N = Point.Fn.ORDER;          // group order n

// Default Bech32m character-limit override. Silent payment addresses are
// ~116 chars, well past BIP-173's default 90-char ceiling, so every encode /
// decode call must pass an explicit limit or @scure/base throws.
const SP_BECH32M_LIMIT = 1023;

// PSBT_OUT_SP_V0_INFO value layout. The canonical BIP-375 form (as emitted by
// Sparrow) is 66 bytes: B_scan(33) || B_spend(33) — the silent-payment version
// is encoded in the key-type name ("V0"), not the value. Some earlier drafts
// prepended a 1-byte version → 67 bytes; we accept both.
const SP_V0_INFO_LEN = 66;       // canonical: no version byte
const SP_V0_INFO_LEN_VER = 67;   // legacy: 1-byte version prefix

// ---------------------------------------------------------------------------
// Byte / scalar helpers
// ---------------------------------------------------------------------------

/** Concatenate any number of Uint8Arrays into one. */
function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

/** Big-endian 32-byte integer -> bigint. */
function bytesToNumberBE(bytes) {
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/** bigint -> fixed-length big-endian Uint8Array (default 32 bytes). */
function numberToBytesBE(num, len = 32) {
  const out = new Uint8Array(len);
  let n = num;
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

/** 4-byte big-endian serialization of a non-negative integer (BIP-352 ser32). */
function ser32(k) {
  if (k < 0 || k > 0xffffffff) throw new Error('ser32: out of range');
  return new Uint8Array([(k >>> 24) & 0xff, (k >>> 16) & 0xff, (k >>> 8) & 0xff, k & 0xff]);
}

/** Positive modulo over the group order n. */
function modN(x) {
  const r = x % N;
  return r < 0n ? r + N : r;
}

/** Lowercase hex (no 0x) -> Uint8Array. */
function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hexToBytes: odd-length string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** Uint8Array -> lowercase hex. */
function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Normalize a key argument that may arrive as hex string or Uint8Array. */
function asBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (typeof x === 'string') return hexToBytes(x);
  throw new Error('expected Uint8Array or hex string');
}

// ---------------------------------------------------------------------------
// Tagged hash (BIP-340 style): sha256( sha256(tag) || sha256(tag) || msg... )
// ---------------------------------------------------------------------------
const _tagCache = new Map();
function taggedHash(tag, ...parts) {
  let th = _tagCache.get(tag);
  if (!th) {
    th = sha256(new TextEncoder().encode(tag));
    _tagCache.set(tag, th);
  }
  return sha256(concatBytes(th, th, ...parts));
}

// ===========================================================================
// 1. Parse PSBT_OUT_SP_V0_INFO (BIP-375, key type 0x09)
// ===========================================================================
/**
 * Parse a PSBT_OUT_SP_V0_INFO value into the recipient's two keys.
 *
 * Accepts both real-world layouts:
 *   - 66 bytes (canonical, Sparrow): B_scan(33) || B_spend(33)         [no version byte]
 *   - 67 bytes (legacy draft):       version(1) || B_scan(33) || B_spend(33)
 *
 * @param {Uint8Array|string} value  raw 66- or 67-byte value (or hex)
 * @returns {{version:number, scanKey:Uint8Array, spendKey:Uint8Array}}
 */
export function parseSpOutInfo(value) {
  const v = asBytes(value);
  let off, version;
  if (v.length === SP_V0_INFO_LEN) {            // 66 — no version byte
    off = 0;
    version = 0;
  } else if (v.length === SP_V0_INFO_LEN_VER) { // 67 — legacy version prefix
    off = 1;
    version = v[0];
    if (version !== 0x00) {
      throw new Error(`unsupported Silent Payment version 0x${version.toString(16)} (only v0 supported)`);
    }
  } else {
    throw new Error(`PSBT_OUT_SP_V0_INFO must be ${SP_V0_INFO_LEN} or ${SP_V0_INFO_LEN_VER} bytes, got ${v.length}`);
  }
  const scanKey = v.slice(off, off + 33);
  const spendKey = v.slice(off + 33, off + 66);
  // Validate both are points on the curve (throws if not).
  Point.fromBytes(scanKey);
  Point.fromBytes(spendKey);
  return { version, scanKey, spendKey };
}

/**
 * Inverse of parseSpOutInfo. Builds the canonical 66-byte value
 * (B_scan || B_spend). Pass includeVersion:true for the legacy 67-byte form.
 */
export function buildSpOutInfo(scanKey, spendKey, opts) {
  const s = asBytes(scanKey), p = asBytes(spendKey);
  if (s.length !== 33 || p.length !== 33) throw new Error('scan/spend keys must be 33-byte compressed');
  if (opts && opts.includeVersion) {
    return concatBytes(new Uint8Array([(opts.version | 0) & 0xff]), s, p);
  }
  return concatBytes(s, p);
}

// ===========================================================================
// 2. Custom-length Bech32m  sp1...  address encode / decode
// ===========================================================================
/**
 * Encode a silent payment address.
 * data = [version_word(0)] ++ convertbits(B_scan || B_spend, 8->5).
 *
 * @param {Uint8Array|string} scanKey   33-byte compressed B_scan
 * @param {Uint8Array|string} spendKey  33-byte compressed B_spend
 * @param {string} hrp                  'sp' (mainnet), 'tsp' (testnet), 'sprt' (regtest)
 * @param {number} version              silent payment version (default 0)
 * @returns {string} sp1...
 */
export function encodeSilentPaymentAddress(scanKey, spendKey, hrp = 'sp', version = 0) {
  const s = asBytes(scanKey), p = asBytes(spendKey);
  if (s.length !== 33 || p.length !== 33) throw new Error('scan/spend keys must be 33-byte compressed');
  const payload = concatBytes(s, p);                 // 66 bytes
  const words = [version, ...bech32m.toWords(payload)];
  return bech32m.encode(hrp, words, SP_BECH32M_LIMIT);
}

/**
 * Decode a silent payment address back into its parts.
 * @param {string} address  sp1...
 * @returns {{hrp:string, version:number, scanKey:Uint8Array, spendKey:Uint8Array}}
 */
export function decodeSilentPaymentAddress(address) {
  const { prefix, words } = bech32m.decode(address, SP_BECH32M_LIMIT);
  const version = words[0];
  if (version !== 0) {
    // Per BIP-352, v31 is reserved; unknown future versions should be rejected
    // by software that doesn't understand them.
    throw new Error(`unsupported silent payment address version ${version}`);
  }
  const payload = bech32m.fromWords(words.slice(1));
  if (payload.length !== 66) {
    throw new Error(`silent payment v0 payload must be 66 bytes, got ${payload.length}`);
  }
  const scanKey = payload.slice(0, 33);
  const spendKey = payload.slice(33, 66);
  Point.fromBytes(scanKey);
  Point.fromBytes(spendKey);
  return { hrp: prefix, version, scanKey, spendKey };
}

// ===========================================================================
// BIP-392 Silent Payment WATCH KEY (spscan...) encode / decode
// ===========================================================================
// A silent-payment watch-only wallet needs the PRIVATE scan key (to detect
// payments) plus the PUBLIC spend key (to derive output keys). They are bundled
// into a Bech32m string with HRP "spscan".
//   payload = b_scan(32 priv) || B_spend(33 compressed pub) = 65 bytes
// A version word (0) is prepended before Bech32m, mirroring BIP-352 sp1
// addresses — hence the "spscan1q..." form (q = version 0).
/**
 * @param {Uint8Array|string} scanPrivKey  32-byte private scan key (b_scan)
 * @param {Uint8Array|string} spendPubKey  33-byte compressed public spend key (B_spend)
 * @param {string} hrp                      'spscan' (mainnet); 'tspscan' etc. for test
 * @returns {string} spscan1...
 */
export function encodeSpscan(scanPrivKey, spendPubKey, hrp = 'spscan') {
  const sk = asBytes(scanPrivKey), pk = asBytes(spendPubKey);
  if (sk.length !== 32) throw new Error('scan private key must be 32 bytes');
  if (pk.length !== 33) throw new Error('spend public key must be 33-byte compressed');
  Point.fromBytes(pk); // validate the spend key is a real curve point
  const payload = concatBytes(sk, pk); // 65 bytes
  return bech32m.encode(hrp, [0, ...bech32m.toWords(payload)], SP_BECH32M_LIMIT);
}

/**
 * Decode an spscan... watch key back into its parts.
 * @param {string} str  spscan1...
 * @returns {{hrp:string, version:number, scanPrivKey:Uint8Array, spendPubKey:Uint8Array}}
 */
export function decodeSpscan(str) {
  const { prefix, words } = bech32m.decode(str, SP_BECH32M_LIMIT);
  const version = words[0];
  if (version !== 0) throw new Error(`unsupported spscan version ${version}`);
  const payload = bech32m.fromWords(words.slice(1));
  if (payload.length !== 65) throw new Error(`spscan payload must be 65 bytes, got ${payload.length}`);
  const scanPrivKey = payload.slice(0, 32);
  const spendPubKey = payload.slice(32, 65);
  Point.fromBytes(spendPubKey);
  return { hrp: prefix, version, scanPrivKey, spendPubKey };
}

// ===========================================================================
// 3. Sum eligible input private keys  (a = Σ a_i mod n), with BIP-341 parity
// ===========================================================================
/**
 * @param {Array<{privKey:Uint8Array|string, isTaproot:boolean}>} inputs
 *   One entry per *eligible* input the signer controls. For Taproot (P2TR)
 *   inputs the output key is x-only (implicitly even-Y), so if d*G has odd Y
 *   we must use (n - d) for the sum — BIP-341 even-Y parity handling.
 *   Non-Taproot inputs (P2WPKH / P2SH-P2WPKH / P2PKH) use the key as-is.
 * @returns {{aScalar:bigint, sumPubkey:Uint8Array}}  a (mod n) and A = a*G (33 bytes)
 */
export function sumInputPrivateKeys(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('sumInputPrivateKeys: need at least one eligible input');
  }
  let aSum = 0n;
  for (const input of inputs) {
    const d = asBytes(input.privKey);
    if (d.length !== 32) throw new Error('private key must be 32 bytes');
    let scalar = modN(bytesToNumberBE(d));
    if (scalar === 0n) throw new Error('private key is zero (invalid)');
    if (input.isTaproot) {
      // If the public key for this key has odd Y, negate the scalar so the
      // effective key matches the x-only (even-Y) Taproot output key.
      const P = G.multiply(scalar);
      if (!P.hasEvenY()) scalar = N - scalar;
    }
    aSum = modN(aSum + scalar);
  }
  if (aSum === 0n) throw new Error('summed private key is zero — cannot derive');
  const sumPubkey = G.multiply(aSum).toBytes(true);
  return { aScalar: aSum, sumPubkey };
}

// ===========================================================================
// 4. Outpoint serialization + smallest-outpoint selection
// ===========================================================================
/**
 * Serialize an outpoint the way it appears inside a transaction:
 *   txid in INTERNAL byte order (reverse of RPC/display hex) || vout uint32 LE.
 * Result is 36 bytes.
 * @param {string} txidDisplayHex  64-char big-endian (display) txid
 * @param {number} vout
 */
export function serializeOutpoint(txidDisplayHex, vout) {
  const txidBE = hexToBytes(txidDisplayHex);
  if (txidBE.length !== 32) throw new Error('txid must be 32 bytes');
  const txidLE = txidBE.slice().reverse();
  const voutLE = new Uint8Array([vout & 0xff, (vout >>> 8) & 0xff, (vout >>> 16) & 0xff, (vout >>> 24) & 0xff]);
  return concatBytes(txidLE, voutLE);
}

/** Lexicographic byte compare of two equal-length Uint8Arrays. */
function compareBytes(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return a.length - b.length;
}

/**
 * Pick the lexicographically smallest serialized outpoint.
 * @param {Array<{txid:string, vout:number}>} outpoints
 * @returns {Uint8Array} 36-byte serialized smallest outpoint
 */
export function smallestOutpoint(outpoints) {
  if (!Array.isArray(outpoints) || outpoints.length === 0) {
    throw new Error('smallestOutpoint: need at least one outpoint');
  }
  let smallest = null;
  for (const op of outpoints) {
    const ser = serializeOutpoint(op.txid, op.vout);
    if (smallest === null || compareBytes(ser, smallest) < 0) smallest = ser;
  }
  return smallest;
}

// ===========================================================================
// 5. input_hash = tagged_hash("BIP0352/Inputs", outpoint_L || A)
// ===========================================================================
/**
 * @param {Array<{txid:string, vout:number}>} outpoints  all input outpoints
 * @param {Uint8Array} sumPubkey  A = a*G (33-byte compressed)
 * @returns {{inputHash:Uint8Array, inputHashScalar:bigint}}
 */
export function computeInputHash(outpoints, sumPubkey) {
  const A = asBytes(sumPubkey);
  if (A.length !== 33) throw new Error('sumPubkey must be 33-byte compressed');
  const outpointL = smallestOutpoint(outpoints);
  const inputHash = taggedHash('BIP0352/Inputs', outpointL, A);
  return { inputHash, inputHashScalar: modN(bytesToNumberBE(inputHash)) };
}

// ===========================================================================
// 6. ECDH shared secret  =  (input_hash * a) * B_scan
// ===========================================================================
/**
 * @param {bigint} inputHashScalar   input_hash interpreted as a scalar (mod n)
 * @param {bigint} aScalar           summed input private key a (mod n)
 * @param {Uint8Array|string} scanKey  recipient B_scan (33-byte compressed)
 * @returns {Uint8Array} 33-byte compressed shared-secret point
 */
export function computeEcdhSharedSecret(inputHashScalar, aScalar, scanKey) {
  const Bscan = Point.fromBytes(asBytes(scanKey));
  const scalar = modN(inputHashScalar * aScalar);
  if (scalar === 0n) throw new Error('ECDH scalar is zero');
  return Bscan.multiply(scalar).toBytes(true);
}

// ===========================================================================
// 7. Per-output tweak + final Taproot output key P_k
// ===========================================================================
/**
 * t_k    = tagged_hash("BIP0352/SharedSecret", shared_secret || ser32(k))
 * P_k    = B_spend + t_k * G
 * script = OP_1 (0x51) PUSH32 (0x20) <x-only(P_k)>
 *
 * @param {Uint8Array} sharedSecret  33-byte compressed ECDH shared secret
 * @param {Uint8Array|string} spendKey  recipient B_spend (33-byte compressed)
 * @param {number} k                 output index for this recipient (0,1,2,...)
 * @returns {{tweak:Uint8Array, outputKey:Uint8Array, xOnly:Uint8Array, scriptPubKey:Uint8Array}}
 */
export function deriveOutputScript(sharedSecret, spendKey, k = 0) {
  const ss = asBytes(sharedSecret);
  if (ss.length !== 33) throw new Error('shared secret must be 33-byte compressed');
  const tweakBytes = taggedHash('BIP0352/SharedSecret', ss, ser32(k));
  const t = modN(bytesToNumberBE(tweakBytes));
  if (t === 0n || t >= N) throw new Error('invalid tweak t_k (>= n)');
  const Bspend = Point.fromBytes(asBytes(spendKey));
  const Pk = Bspend.add(G.multiply(t));
  if (Pk.is0()) throw new Error('derived output key is point at infinity');
  const outputKey = Pk.toBytes(true);          // 33-byte compressed
  const xOnly = outputKey.slice(1);            // 32-byte x-only
  const scriptPubKey = concatBytes(new Uint8Array([0x51, 0x20]), xOnly); // OP_1 <32>
  return { tweak: tweakBytes, outputKey, xOnly, scriptPubKey };
}

// ===========================================================================
// 8. High-level: derive every silent payment output for a transaction
// ===========================================================================
/**
 * Phase-1 single-signer entry point.
 *
 * @param {Object}   params
 * @param {Array<{privKey:Uint8Array|string, isTaproot:boolean}>} params.inputPrivKeys
 *        Eligible input keys the signer controls.
 * @param {Array<{txid:string, vout:number}>} params.outpoints
 *        ALL input outpoints of the transaction (used for input_hash).
 * @param {Array<string|{scanKey:(Uint8Array|string), spendKey:(Uint8Array|string)}>} params.recipients
 *        Recipients as sp1... addresses or {scanKey, spendKey} pairs.
 *        Multiple outputs to the same B_scan get k = 0,1,2,... in order.
 * @returns {Array<{recipientIndex:number, k:number, scanKey:Uint8Array, spendKey:Uint8Array,
 *                  sharedSecret:Uint8Array, tweak:Uint8Array, outputKey:Uint8Array,
 *                  xOnly:Uint8Array, scriptPubKey:Uint8Array}>}
 */
export function deriveSilentPaymentOutputs(params) {
  const { inputPrivKeys, outpoints, recipients } = params;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('deriveSilentPaymentOutputs: need at least one recipient');
  }

  // Sender-side scalars.
  const { aScalar, sumPubkey } = sumInputPrivateKeys(inputPrivKeys);
  const { inputHashScalar } = computeInputHash(outpoints, sumPubkey);

  // Normalize recipients to {scanKey, spendKey} byte pairs.
  const normalized = recipients.map((r) => {
    if (typeof r === 'string') {
      const d = decodeSilentPaymentAddress(r);
      return { scanKey: d.scanKey, spendKey: d.spendKey };
    }
    return { scanKey: asBytes(r.scanKey), spendKey: asBytes(r.spendKey) };
  });

  // k counter per scan key (BIP-352 groups outputs by B_scan).
  const kByScan = new Map();
  const results = [];
  normalized.forEach((r, recipientIndex) => {
    const scanHex = bytesToHex(r.scanKey);
    const k = kByScan.get(scanHex) || 0;
    kByScan.set(scanHex, k + 1);

    const sharedSecret = computeEcdhSharedSecret(inputHashScalar, aScalar, r.scanKey);
    const out = deriveOutputScript(sharedSecret, r.spendKey, k);
    results.push({
      recipientIndex, k,
      scanKey: r.scanKey, spendKey: r.spendKey,
      sharedSecret, tweak: out.tweak,
      outputKey: out.outputKey, xOnly: out.xOnly, scriptPubKey: out.scriptPubKey,
    });
  });
  return results;
}

// ===========================================================================
// BIP-341 / BIP-86 taproot key-path tweak
// ===========================================================================
/**
 * Turn a derived *internal* private key into the on-chain Taproot key-path
 * spending key. For BIP-86 single-key wallets the merkle root is empty, so
 * the output key is  P_out = lift_even(P_int) + t*G  with
 * t = tagged_hash("TapTweak", x(P_int_even) [|| merkleRoot]).
 *
 * The returned scalar corresponds to the x-only key embedded in the input's
 * 5120... scriptPubKey, which is exactly what BIP-352 needs to feed into the
 * input-key sum (with isTaproot:true, so the final even-Y negation is applied
 * by sumInputPrivateKeys).
 *
 * @param {Uint8Array|string} internalPrivKey  32-byte BIP-86 internal key
 * @param {Uint8Array|string|null} merkleRoot  optional 32-byte tap merkle root
 * @returns {Uint8Array} 32-byte tweaked output private key
 */
export function tweakTaprootPrivKey(internalPrivKey, merkleRoot = null) {
  let d = modN(bytesToNumberBE(asBytes(internalPrivKey)));
  if (d === 0n) throw new Error('internal taproot key is zero');
  // Lift internal key to even Y (BIP-341).
  if (!G.multiply(d).hasEvenY()) d = N - d;
  const xonly = G.multiply(d).toBytes(true).slice(1); // 32-byte x of even-Y P_int
  const tweakMsg = merkleRoot ? concatBytes(xonly, asBytes(merkleRoot)) : xonly;
  const t = modN(bytesToNumberBE(taggedHash('TapTweak', tweakMsg)));
  if (t === 0n || t >= N) throw new Error('invalid taproot tweak');
  const dOut = modN(d + t);
  if (dOut === 0n) throw new Error('tweaked taproot key is zero');
  return numberToBytesBE(dOut, 32);
}

// ===========================================================================
// Receiver-side helpers (used for round-trip self-tests; full scanning is a
// later phase). Mirrors the sender ECDH from the recipient's perspective.
// ===========================================================================
/**
 * Receiver shared secret = b_scan * (input_hash * A).
 * Must equal the sender's (input_hash * a) * B_scan by ECDH symmetry.
 * @param {bigint} inputHashScalar
 * @param {Uint8Array|string} scanPrivKey  b_scan (32 bytes)
 * @param {Uint8Array|string} sumPubkey    A (33-byte compressed)
 */
export function computeReceiverSharedSecret(inputHashScalar, scanPrivKey, sumPubkey) {
  const bScan = modN(bytesToNumberBE(asBytes(scanPrivKey)));
  const A = Point.fromBytes(asBytes(sumPubkey));
  const scalar = modN(inputHashScalar * bScan);
  return A.multiply(scalar).toBytes(true);
}

// ===========================================================================
// BIP-375 multi-party proofs: per-input ECDH share + BIP-374 DLEQ proof
// ===========================================================================
// For each eligible input, BIP-375 requires a PSBT_IN_SP_ECDH_SHARE and a
// PSBT_IN_SP_DLEQ so a coordinator can assemble the shared secret without any
// single party holding every input key:
//   share_i  = a_i · B_scan                       (per input, per recipient scan key)
//   Σ share_i = (Σ a_i) · B_scan = a · B_scan ; the coordinator then multiplies
//   by input_hash to obtain the full BIP-352 ECDH secret.
// The DLEQ proves log_G(a_i·G) == log_{B_scan}(share_i) (same a_i) without
// revealing a_i, so the share can be trusted.
//
// a_i is the SP-adjusted input scalar (BIP-341 even-Y negation for Taproot).

/** SP-adjusted input scalar: parity-negate for Taproot so it matches the x-only key. */
export function spInputScalar(privKey, isTaproot) {
  let s = modN(bytesToNumberBE(asBytes(privKey)));
  if (s === 0n) throw new Error('input private key is zero');
  if (isTaproot && !G.multiply(s).hasEvenY()) s = N - s;
  return s;
}

/** Per-input ECDH share = inputScalar · B_scan (33-byte compressed). */
export function computeInputEcdhShare(inputScalar, scanPub) {
  const s = (typeof inputScalar === 'bigint') ? modN(inputScalar) : modN(bytesToNumberBE(asBytes(inputScalar)));
  if (s === 0n) throw new Error('input scalar is zero');
  return Point.fromBytes(asBytes(scanPub)).multiply(s).toBytes(true);
}

function xorBytes(a, b) {
  const n = Math.min(a.length, b.length);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] ^ b[i];
  return out;
}

/**
 * BIP-374 discrete-log-equality proof that A=a·G and C=a·B share the scalar a.
 *
 * !! IMPORTANT — UNVERIFIED AGAINST OFFICIAL BIP-374 VECTORS. This follows
 * BIP-374's standard Fiat–Shamir structure (nonce → R1=k·G, R2=k·B →
 * e = challenge(...) → s = k + e·a, proof = e‖s, 64 bytes), but the exact
 * tagged-hash labels, point-serialization, and field ordering below were
 * reconstructed from memory (could not reach the spec this session). The
 * pairing generateDleqProof/verifyDleqProof is internally consistent, but
 * validate against official BIP-374 test vectors before trusting it.
 *
 * @param {bigint|Uint8Array|string} scalar  a (the input scalar)
 * @param {Uint8Array|string} scanPub        B (the recipient scan pubkey, 33B)
 * @param {Uint8Array|string} [auxRand]      32 bytes; defaults to zero (deterministic)
 * @returns {Uint8Array} 64-byte proof (e ‖ s)
 */
export function generateDleqProof(scalar, scanPub, auxRand) {
  const a = (typeof scalar === 'bigint') ? modN(scalar) : modN(bytesToNumberBE(asBytes(scalar)));
  if (a === 0n) throw new Error('DLEQ scalar is zero');
  const Bp = Point.fromBytes(asBytes(scanPub));
  const Bbytes = Bp.toBytes(true);
  const A = G.multiply(a).toBytes(true);
  const C = Bp.multiply(a).toBytes(true);
  const r = auxRand ? asBytes(auxRand) : new Uint8Array(32);
  const t = xorBytes(numberToBytesBE(a, 32), taggedHash('BIP0374/aux', r));
  let k = modN(bytesToNumberBE(taggedHash('BIP0374/nonce', t, A, C)));
  if (k === 0n) throw new Error('DLEQ nonce is zero');
  const R1 = G.multiply(k).toBytes(true);
  const R2 = Bp.multiply(k).toBytes(true);
  const e = modN(bytesToNumberBE(taggedHash('BIP0374/challenge', A, Bbytes, C, R1, R2)));
  if (e === 0n) throw new Error('DLEQ challenge is zero');
  const s = modN(k + e * a);
  return concatBytes(numberToBytesBE(e, 32), numberToBytesBE(s, 32));
}

/** Verify a BIP-374 DLEQ proof (same construction caveat as generateDleqProof). */
export function verifyDleqProof(Apub, scanPub, Cpub, proof) {
  try {
    const pr = asBytes(proof);
    if (pr.length !== 64) return false;
    const e = modN(bytesToNumberBE(pr.slice(0, 32)));
    const s = modN(bytesToNumberBE(pr.slice(32, 64)));
    if (e === 0n || s === 0n) return false;
    const A = Point.fromBytes(asBytes(Apub));
    const Bp = Point.fromBytes(asBytes(scanPub));
    const C = Point.fromBytes(asBytes(Cpub));
    // R1 = s·G − e·A ; R2 = s·B − e·C
    const R1 = G.multiply(s).add(A.multiply(e).negate()).toBytes(true);
    const R2 = Bp.multiply(s).add(C.multiply(e).negate()).toBytes(true);
    const e2 = modN(bytesToNumberBE(taggedHash('BIP0374/challenge', A.toBytes(true), Bp.toBytes(true), C.toBytes(true), R1, R2)));
    return e2 === e;
  } catch (_) {
    return false;
  }
}

// Expose low-level utilities for tests / advanced callers.
export const _internal = {
  Point, G, N, taggedHash, concatBytes, bytesToHex, hexToBytes,
  bytesToNumberBE, numberToBytesBE, ser32, modN, serializeOutpoint,
  compareBytes, SP_BECH32M_LIMIT,
};

// ---------------------------------------------------------------------------
// Browser global (for boot.html inline scripts after Vite bundling).
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.SilentPayments = {
    parseSpOutInfo, buildSpOutInfo,
    encodeSilentPaymentAddress, decodeSilentPaymentAddress,
    encodeSpscan, decodeSpscan,
    sumInputPrivateKeys, serializeOutpoint, smallestOutpoint,
    computeInputHash, computeEcdhSharedSecret, deriveOutputScript,
    deriveSilentPaymentOutputs, computeReceiverSharedSecret,
    tweakTaprootPrivKey,
    spInputScalar, computeInputEcdhShare, generateDleqProof, verifyDleqProof,
    _internal,
  };
}

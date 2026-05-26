/**
 * test-psbt-merge-proofs.mjs
 *
 * Byte-plumbing test for the BIP-375 v2 export merge.
 *
 * It extracts the REAL _psbtMergeSignaturesIntoV2 + its byte helpers
 * (_psbtReadVarint / _psbtWriteVarint / _psbtCountTxInputs) straight out of
 * boot.html, wires them into a single scope that shares the module global
 * `_psbtSpInputProofs` (exactly as the live page does), then drives synthetic
 * PSBTs through the merge and asserts that the exported v2 *physically*
 * contains PSBT_IN_SP_ECDH_SHARE (0x1d) and PSBT_IN_SP_DLEQ (0x1e) keyed by
 * the recipient scan key, plus the resolved PSBT_OUT_SCRIPT (0x04).
 *
 * Three paths are exercised:
 *   A) stash path      — _psbtSpInputProofs populated (the new primary carrier)
 *   B) bytes fallback  — stash empty, proofs read from proofSrcBytes
 *   C) fail-closed     — SP output present but NO proofs anywhere → must throw
 *
 * Run:  node test-psbt-merge-proofs.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOT = join(__dirname, 'boot.html');

// ---------------------------------------------------------------------------
// 1. Extract the four functions verbatim from boot.html.
// ---------------------------------------------------------------------------
const src = readFileSync(BOOT, 'utf8');

function extractTopLevelFn(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) throw new Error('could not find ' + signature);
  // The function is top-level, so its closing brace is "}" at column 0.
  const close = text.indexOf('\n}\n', start);
  if (close < 0) throw new Error('could not find close for ' + signature);
  return text.slice(start, close + 2); // include "\n}"
}

const fnReadVarint   = extractTopLevelFn(src, 'function _psbtReadVarint(');
const fnWriteVarint  = extractTopLevelFn(src, 'function _psbtWriteVarint(');
const fnCountInputs  = extractTopLevelFn(src, 'function _psbtCountTxInputs(');
const fnMerge        = extractTopLevelFn(src, 'function _psbtMergeSignaturesIntoV2(');

// Build one shared scope. `_psbtSpInputProofs` lives here, so the merge reads
// it via closure exactly like it reads the module global on the live page.
const harnessSrc = `
  let _psbtSpInputProofs = null;
  ${fnReadVarint}
  ${fnWriteVarint}
  ${fnCountInputs}
  ${fnMerge}
  return {
    merge: _psbtMergeSignaturesIntoV2,
    setStash: (s) => { _psbtSpInputProofs = s; },
    getStash: () => _psbtSpInputProofs,
    _writeVarint: _psbtWriteVarint,
  };
`;
const harness = new Function(harnessSrc)();
const { merge, setStash, _writeVarint } = harness;

// ---------------------------------------------------------------------------
// 2. Tiny PSBT byte builders.
// ---------------------------------------------------------------------------
const MAGIC = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff]);

function cat(...arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let p = 0; for (const a of arrs) { out.set(a, p); p += a.length; }
  return out;
}
function u32le(v) { return Uint8Array.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
function u64le(v) { const b = new Uint8Array(8); let x = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; }
function varint(n) { return _writeVarint(n); } // use the page's own writer
function bytes(n, fill = 0) { const b = new Uint8Array(n); b.fill(fill); return b; }

// One <keylen><keytype||keydata><vallen><value> record.
function kv(keyType, keyData, value) {
  const key = keyData && keyData.length
    ? cat(Uint8Array.from([keyType]), keyData)
    : Uint8Array.from([keyType]);
  return cat(varint(key.length), key, varint(value.length), value);
}
const TERM = Uint8Array.from([0x00]);

// A legacy unsigned tx with `scripts` as the output scriptPubKeys.
function legacyUnsignedTx({ version = 2, txid, vout = 0, sequence = 0xfffffffd, outAmounts, outScripts, locktime = 0 }) {
  const parts = [u32le(version), varint(1), txid, u32le(vout), varint(0), u32le(sequence), varint(outScripts.length)];
  for (let i = 0; i < outScripts.length; i++) {
    parts.push(u64le(outAmounts[i]), varint(outScripts[i].length), outScripts[i]);
  }
  parts.push(u32le(locktime));
  return cat(...parts);
}

// ---------------------------------------------------------------------------
// 3. Fixtures.
// ---------------------------------------------------------------------------
const txid       = bytes(32, 0xab);                  // internal-order prev txid
const scanKey    = cat(Uint8Array.from([0x02]), bytes(32, 0x11)); // 33B recipient scan key
const spInfo66   = cat(scanKey, cat(Uint8Array.from([0x03]), bytes(32, 0x22))); // B_scan||B_spend (66B)
const normScript = cat(Uint8Array.from([0x00, 0x14]), bytes(20, 0x33));          // P2WPKH (22B)
const spScript   = cat(Uint8Array.from([0x51, 0x20]), bytes(32, 0x44));          // resolved P2TR (34B)
const sigPubkey  = cat(Uint8Array.from([0x02]), bytes(32, 0x55));                // 33B
const sigValue   = bytes(72, 0x30);                                              // DER-ish blob

const ecdhShare  = bytes(33, 0x66); ecdhShare[0] = 0x02;  // 33B share value
const dleqProof  = bytes(64, 0x77);                       // 64B proof value

// --- signed v0: unsigned tx (resolved SP script in vout[1]) + input0 partial sig ---
const v0UnsignedTx = legacyUnsignedTx({
  txid, outAmounts: [50000, 10000], outScripts: [normScript, spScript],
});
const signedV0 = cat(
  MAGIC,
  kv(0x00, null, v0UnsignedTx), TERM,           // global
  kv(0x02, sigPubkey, sigValue), TERM,          // input 0: partial sig
  TERM,                                          // output 0
  TERM,                                          // output 1
);

// --- original v2 envelope: SP output (0x09) unresolved (no 0x04) ---
const originalV2 = cat(
  MAGIC,
  // globals
  kv(0x02, null, u32le(2)),                      // TX_VERSION
  kv(0x04, null, varint(1)),                     // INPUT_COUNT
  kv(0x05, null, varint(2)),                     // OUTPUT_COUNT
  kv(0xfb, null, u32le(2)),                      // PSBT_VERSION = 2
  TERM,
  // input 0
  kv(0x0e, null, txid),                          // PREVIOUS_TXID
  kv(0x0f, null, u32le(0)),                       // OUTPUT_INDEX
  kv(0x10, null, u32le(0xfffffffd)),              // SEQUENCE
  TERM,
  // output 0 (normal)
  kv(0x03, null, u64le(50000)),
  kv(0x04, null, normScript),
  TERM,
  // output 1 (SILENT PAYMENT — unresolved: 0x09 present, NO 0x04)
  kv(0x03, null, u64le(10000)),
  kv(0x09, null, spInfo66),
  TERM,
);

// --- proofSrc v0 (for the bytes-fallback path): input 0 carries 0x1d / 0x1e ---
const proofSrcV0 = cat(
  MAGIC,
  kv(0x00, null, v0UnsignedTx), TERM,
  cat(kv(0x1d, scanKey, ecdhShare), kv(0x1e, scanKey, dleqProof)), TERM, // input 0
  TERM, TERM,                                                            // outputs
);

// stash (the new primary carrier), shaped exactly like downgradePSBTv2 builds it
function buildStash() {
  return [[
    { type: 0x1d, keyData: scanKey, kvBytes: kv(0x1d, scanKey, ecdhShare) },
    { type: 0x1e, keyData: scanKey, kvBytes: kv(0x1e, scanKey, dleqProof) },
  ]];
}

// ---------------------------------------------------------------------------
// 4. Assertions over a merged v2 — walk it and find the fields.
// ---------------------------------------------------------------------------
function hex(u) { return Array.from(u).map(b => b.toString(16).padStart(2, '0')).join(''); }

function readVarintJS(buf, off) { // independent reader for the test
  let v = buf[off];
  if (v < 0xfd) return { value: v, next: off + 1 };
  if (v === 0xfd) return { value: buf[off + 1] | (buf[off + 2] << 8), next: off + 3 };
  if (v === 0xfe) return { value: (buf[off + 1] | (buf[off + 2] << 8) | (buf[off + 3] << 16) | (buf[off + 4] << 24)) >>> 0, next: off + 5 };
  throw new Error('64-bit varint not supported in test');
}

// Walk the v2 and return { inputs:[{0x1d:[keydata...],0x1e:[...]}], outputs:[{has04, has09}] }
function analyzeV2(b) {
  if (!(b[0] === 0x70 && b[4] === 0xff)) throw new Error('bad magic');
  let o = 5, inCount = null, outCount = null;
  // globals
  while (o < b.length) {
    const k = readVarintJS(b, o); o = k.next;
    if (k.value === 0) break;
    const keyType = b[o]; o += k.value;
    const v = readVarintJS(b, o); o = v.next; const ve = o + v.value;
    if (keyType === 0x04) inCount = readVarintJS(b, o).value;
    if (keyType === 0x05) outCount = readVarintJS(b, o).value;
    o = ve;
  }
  const inputs = [];
  for (let i = 0; i < inCount; i++) {
    const rec = {};
    while (o < b.length) {
      const k = readVarintJS(b, o); o = k.next;
      if (k.value === 0) break;
      const keyType = b[o];
      const keyData = b.slice(o + 1, o + k.value);
      o += k.value;
      const v = readVarintJS(b, o); o = v.next; const ve = o + v.value;
      (rec[keyType] = rec[keyType] || []).push(hex(keyData));
      o = ve;
    }
    inputs.push(rec);
  }
  const outputs = [];
  for (let i = 0; i < outCount; i++) {
    const rec = { types: {} };
    while (o < b.length) {
      const k = readVarintJS(b, o); o = k.next;
      if (k.value === 0) break;
      const keyType = b[o]; o += k.value;
      const v = readVarintJS(b, o); o = v.next; const ve = o + v.value;
      rec.types[keyType] = true;
      o = ve;
    }
    outputs.push(rec);
  }
  return { inCount, outCount, inputs, outputs };
}

// ---------------------------------------------------------------------------
// 5. Run the three paths.
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name); }
}

const scanHex = hex(scanKey);

console.log('\n=== A) STASH PATH (primary) ===');
setStash(buildStash());
const mergedA = merge(signedV0, originalV2, /* proofSrcBytes */ null);
const a = analyzeV2(mergedA);
check('input 0 carries 0x1d (ECDH share)', !!(a.inputs[0][0x1d]));
check('input 0 carries 0x1e (DLEQ)',       !!(a.inputs[0][0x1e]));
check('0x1d keyed by recipient scan key',  a.inputs[0][0x1d] && a.inputs[0][0x1d].includes(scanHex));
check('0x1e keyed by recipient scan key',  a.inputs[0][0x1e] && a.inputs[0][0x1e].includes(scanHex));
check('input 0 still carries its 0x02 sig', !!(a.inputs[0][0x02]));
check('SP output (idx 1) now has 0x04',     a.outputs[1].types[0x04] === true);
check('SP output (idx 1) keeps 0x09',       a.outputs[1].types[0x09] === true);

console.log('\n=== B) BYTES FALLBACK (stash empty, proofs from proofSrcBytes) ===');
setStash(null);
const mergedB = merge(signedV0, originalV2, /* proofSrcBytes */ proofSrcV0);
const bAnalysis = analyzeV2(mergedB);
check('input 0 carries 0x1d from bytes', !!(bAnalysis.inputs[0][0x1d]));
check('input 0 carries 0x1e from bytes', !!(bAnalysis.inputs[0][0x1e]));
check('0x1d keyed by scan key (bytes)',  bAnalysis.inputs[0][0x1d] && bAnalysis.inputs[0][0x1d].includes(scanHex));

console.log('\n=== C) FAIL-CLOSED (SP output, but NO proofs anywhere) ===');
setStash(null);
let threw = false, msg = '';
try {
  merge(signedV0, originalV2, /* proofSrcBytes */ signedV0); // signedV0 has no 0x1d/0x1e
} catch (e) { threw = true; msg = e.message; }
check('merge throws when SP proofs are absent', threw);
check('error names the missing ECDH/DLEQ proofs', /ECDH share|DLEQ|0x1d|0x1e/i.test(msg));

console.log('\n=== D) STASH SURVIVES A SIMULATED SIGN STRIP ===');
// Real-flow regression: even if the signed v0 lost the proofs (signIdx strips
// unknown fields) AND proofSrcBytes also lacks them, the stash still delivers.
setStash(buildStash());
const mergedD = merge(signedV0, originalV2, /* proofSrcBytes */ signedV0); // proofSrc stripped
const d = analyzeV2(mergedD);
check('stash injects 0x1d despite stripped proofSrc', !!(d.inputs[0][0x1d]));
check('stash injects 0x1e despite stripped proofSrc', !!(d.inputs[0][0x1e]));

console.log('\n--------------------------------------------------');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('All byte-plumbing checks passed: the exported v2 physically carries 0x1d/0x1e.');

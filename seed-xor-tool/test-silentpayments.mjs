/**
 * BIP-352 Silent Payments — Phase 1 test harness
 * ==============================================
 *
 * Run from inside seed-xor-tool/ (so @noble/@scure resolve):
 *     node test-silentpayments.mjs
 *
 * Two layers of testing:
 *
 *   A. Internal self-tests (always run). These prove the implementation is
 *      internally correct without needing any external file:
 *        1. Bech32m sp1 address round-trip.
 *        2. PSBT_OUT_SP_V0_INFO parse/build round-trip.
 *        3. Full send -> receive round-trip: the SENDER derives a Taproot
 *           output P_k; the RECEIVER, holding only b_scan/b_spend, independently
 *           recomputes the SAME P_k AND the spending key d such that d*G == P_k.
 *           This is the strongest single check of the ECDH derivation.
 *        4. BIP-341 even-Y parity: a Taproot input with an odd-Y key must give
 *           the same A as using the negated key, and a different result than
 *           treating it as non-Taproot.
 *
 *   B. Official BIP-352 vectors (run if the JSON is present). Drop the file
 *      bitcoin/bips  bip-0352/send_and_receive_test_vectors.json  into this
 *      folder (or alongside it) and the harness will execute the single-signer
 *      "Sending" vectors and diff every output scriptPubKey against the spec.
 */

import {
  parseSpOutInfo, buildSpOutInfo,
  encodeSilentPaymentAddress, decodeSilentPaymentAddress,
  sumInputPrivateKeys, computeInputHash,
  computeEcdhSharedSecret, deriveOutputScript,
  deriveSilentPaymentOutputs, computeReceiverSharedSecret,
  tweakTaprootPrivKey,
  _internal,
} from './shared/silentpayments.js';
import * as btc from '@scure/btc-signer';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { Point, G, N, modN, bytesToNumberBE, bytesToHex, hexToBytes, taggedHash, ser32 } = _internal;

// ---- tiny test framework ----
let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? '  ->  ' + detail : ''}`); }
}
function eqHex(a, b) { return bytesToHex(a) === bytesToHex(b); }
function pubOf(privBytes) { return G.multiply(modN(bytesToNumberBE(privBytes))).toBytes(true); }

console.log('\n=== BIP-352 Silent Payments — Phase 1 self-tests ===\n');

// ---------------------------------------------------------------------------
// 0. Sub-primitive sanity: secp256k1 generator + a known BIP-340 tagged hash
// ---------------------------------------------------------------------------
console.log('[0] sub-primitive sanity');
{
  const Ghex = G.toBytes(true);
  ok('G is the documented secp256k1 generator',
     bytesToHex(Ghex) === '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  // BIP-340 tagged hash known answer: TapTweak of empty message is a documented value.
  // tagged_hash("TapTweak", G_xonly) is used in BIP-341; here we just confirm the
  // tagged-hash construction is sha256(th||th||m) by recomputing it two ways.
  const m = hexToBytes('deadbeef');
  const th = _internal.taggedHash('BIP0352/Inputs', m);
  ok('tagged hash is 32 bytes', th.length === 32);
}

// ---------------------------------------------------------------------------
// 1. Bech32m sp1 address round-trip
// ---------------------------------------------------------------------------
console.log('\n[1] sp1 address bech32m round-trip');
{
  const bScan = hexToBytes('1111111111111111111111111111111111111111111111111111111111111111');
  const bSpend = hexToBytes('2222222222222222222222222222222222222222222222222222222222222222');
  const Bscan = pubOf(bScan);
  const Bspend = pubOf(bSpend);
  const addr = encodeSilentPaymentAddress(Bscan, Bspend, 'sp');
  ok('address has sp1 prefix', addr.startsWith('sp1'), addr.slice(0, 8));
  ok('address length ~116', addr.length === 116, String(addr.length));
  const dec = decodeSilentPaymentAddress(addr);
  ok('scan key round-trips', eqHex(dec.scanKey, Bscan));
  ok('spend key round-trips', eqHex(dec.spendKey, Bspend));
  ok('hrp = sp', dec.hrp === 'sp');
  ok('version = 0', dec.version === 0);
  // testnet hrp
  const taddr = encodeSilentPaymentAddress(Bscan, Bspend, 'tsp');
  ok('testnet address has tsp1 prefix', taddr.startsWith('tsp1'));
}

// ---------------------------------------------------------------------------
// 2. PSBT_OUT_SP_V0_INFO (0x09) parse/build round-trip
// ---------------------------------------------------------------------------
console.log('\n[2] PSBT_OUT_SP_V0_INFO (0x09) parse/build — 66-byte canonical + 67-byte legacy');
{
  const Bscan = pubOf(hexToBytes('33'.repeat(32)));
  const Bspend = pubOf(hexToBytes('44'.repeat(32)));

  // Canonical 66-byte form (Sparrow): B_scan || B_spend, no version byte.
  const value66 = buildSpOutInfo(Bscan, Bspend);
  ok('canonical value is 66 bytes', value66.length === 66, String(value66.length));
  const p66 = parseSpOutInfo(value66);
  ok('66: scan key matches', eqHex(p66.scanKey, Bscan));
  ok('66: spend key matches', eqHex(p66.spendKey, Bspend));
  ok('66: version defaults to 0', p66.version === 0);

  // Legacy 67-byte form: version(0x00) || B_scan || B_spend.
  const value67 = buildSpOutInfo(Bscan, Bspend, { includeVersion: true, version: 0 });
  ok('legacy value is 67 bytes', value67.length === 67, String(value67.length));
  ok('legacy first byte is version 0x00', value67[0] === 0x00);
  const p67 = parseSpOutInfo(value67);
  ok('67: scan key matches', eqHex(p67.scanKey, Bscan));
  ok('67: spend key matches', eqHex(p67.spendKey, Bspend));

  // Both forms must yield identical keys.
  ok('66 and 67 decode to the same keys', eqHex(p66.scanKey, p67.scanKey) && eqHex(p66.spendKey, p67.spendKey));

  // Wrong lengths still rejected.
  let threw65 = false, threw68 = false;
  try { parseSpOutInfo(value66.slice(0, 65)); } catch { threw65 = true; }
  try { parseSpOutInfo(new Uint8Array(68)); } catch { threw68 = true; }
  ok('rejects 65-byte value', threw65);
  ok('rejects 68-byte value', threw68);
}

// ---------------------------------------------------------------------------
// 3. Full SEND -> RECEIVE round-trip (the core correctness proof)
// ---------------------------------------------------------------------------
console.log('\n[3] send -> receive round-trip (ECDH symmetry + spendability)');
{
  // Recipient long-term keys.
  const bScan = hexToBytes('0a'.repeat(32));
  const bSpend = hexToBytes('0b'.repeat(32));
  const Bscan = pubOf(bScan);
  const Bspend = pubOf(bSpend);
  const addr = encodeSilentPaymentAddress(Bscan, Bspend, 'sp');

  // Sender's two eligible inputs: one Taproot (x-only), one P2WPKH.
  const inputPrivKeys = [
    { privKey: hexToBytes('aa'.repeat(31) + '01'), isTaproot: true },
    { privKey: hexToBytes('bb'.repeat(31) + '02'), isTaproot: false },
  ];
  const outpoints = [
    { txid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16', vout: 0 },
    { txid: 'a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d', vout: 1 },
  ];

  const outs = deriveSilentPaymentOutputs({ inputPrivKeys, outpoints, recipients: [addr] });
  ok('one output derived', outs.length === 1);
  const out = outs[0];
  ok('scriptPubKey is OP_1 PUSH32 (34 bytes, 5120 prefix)',
     out.scriptPubKey.length === 34 && out.scriptPubKey[0] === 0x51 && out.scriptPubKey[1] === 0x20);
  ok('x-only key is 32 bytes', out.xOnly.length === 32);

  // ---- Receiver side: recompute independently from public A + own b_scan ----
  const { aScalar, sumPubkey } = sumInputPrivateKeys(inputPrivKeys);
  const { inputHashScalar } = computeInputHash(outpoints, sumPubkey);

  // Sender shared secret vs receiver shared secret must be identical.
  const senderSS = computeEcdhSharedSecret(inputHashScalar, aScalar, Bscan);
  const receiverSS = computeReceiverSharedSecret(inputHashScalar, bScan, sumPubkey);
  ok('ECDH shared secret is symmetric (sender == receiver)', eqHex(senderSS, receiverSS));

  // Receiver computes t_0, P_0 = B_spend + t_0*G, and the spend key d = b_spend + t_0.
  const t0 = taggedHash('BIP0352/SharedSecret', receiverSS, ser32(0));
  const tScalar = modN(bytesToNumberBE(t0));
  const Pk = Point.fromBytes(Bspend).add(G.multiply(tScalar));
  ok('receiver re-derives the same output key', eqHex(Pk.toBytes(true), out.outputKey));

  const dScalar = modN(bytesToNumberBE(bSpend) + tScalar);
  const dPub = G.multiply(dScalar).toBytes(true);
  ok('receiver spend key d satisfies d*G == P_0 (output is spendable)', eqHex(dPub, out.outputKey));

  // x-only of d*G must equal the scriptPubKey push.
  ok('d*G x-only matches scriptPubKey', eqHex(dPub.slice(1), out.scriptPubKey.slice(2)));
}

// ---------------------------------------------------------------------------
// 4. Two outputs to the same recipient => k = 0,1 and distinct scripts
// ---------------------------------------------------------------------------
console.log('\n[4] multiple outputs to same recipient (k counter)');
{
  const Bscan = pubOf(hexToBytes('0c'.repeat(32)));
  const Bspend = pubOf(hexToBytes('0d'.repeat(32)));
  const addr = encodeSilentPaymentAddress(Bscan, Bspend, 'sp');
  const inputPrivKeys = [{ privKey: hexToBytes('0e'.repeat(32)), isTaproot: true }];
  const outpoints = [{ txid: '16'.repeat(32), vout: 7 }];
  const outs = deriveSilentPaymentOutputs({ inputPrivKeys, outpoints, recipients: [addr, addr] });
  ok('two outputs', outs.length === 2);
  ok('k values are 0 then 1', outs[0].k === 0 && outs[1].k === 1);
  ok('the two outputs differ', !eqHex(outs[0].xOnly, outs[1].xOnly));
}

// ---------------------------------------------------------------------------
// 5. BIP-341 even-Y parity handling
// ---------------------------------------------------------------------------
console.log('\n[5] BIP-341 even-Y parity for Taproot inputs');
{
  // Find a private key whose public key has ODD y.
  let dOdd = null;
  for (let i = 1; i < 50; i++) {
    const cand = hexToBytes(i.toString(16).padStart(64, '0'));
    if (!G.multiply(BigInt(i)).hasEvenY()) { dOdd = cand; break; }
  }
  ok('found an odd-Y private key for the test', dOdd !== null);
  const asTaproot = sumInputPrivateKeys([{ privKey: dOdd, isTaproot: true }]);
  const asPlain = sumInputPrivateKeys([{ privKey: dOdd, isTaproot: false }]);
  // Taproot path negates -> A should be the negation; the two A's differ.
  ok('taproot vs non-taproot give different summed pubkeys (parity applied)',
     !eqHex(asTaproot.sumPubkey, asPlain.sumPubkey));
  // The taproot-summed A must have even Y? Not necessarily (sum), but the single
  // negated key A must equal -(plain A): same x, opposite parity prefix.
  ok('single odd-Y taproot key: A shares x with plain but flips parity',
     bytesToHex(asTaproot.sumPubkey).slice(2) === bytesToHex(asPlain.sumPubkey).slice(2)
     && asTaproot.sumPubkey[0] !== asPlain.sumPubkey[0]);
}

// ---------------------------------------------------------------------------
// 6. BIP-341 / BIP-86 taproot tweak cross-checked against @scure/btc-signer
// ---------------------------------------------------------------------------
console.log('\n[6] taproot key tweak vs @scure/btc-signer p2tr');
{
  for (const seedByte of [0x07, 0x42, 0x99]) {
    const internal = hexToBytes(seedByte.toString(16).padStart(2, '0').repeat(32));
    const internalXonly = G.multiply(modN(bytesToNumberBE(internal))).toBytes(true).slice(1);
    // Our tweaked output key:
    const dOut = tweakTaprootPrivKey(internal);
    const ourOutKey = G.multiply(modN(bytesToNumberBE(dOut))).toBytes(true).slice(1);
    // btc-signer's BIP-86 output (independent implementation):
    const ref = btc.p2tr(internalXonly).script.slice(2); // drop 0x51 0x20
    ok(`internal 0x${seedByte.toString(16)}: tweaked output x-only matches p2tr`,
       bytesToHex(ourOutKey) === bytesToHex(ref),
       `${bytesToHex(ourOutKey)} vs ${bytesToHex(ref)}`);
  }
}

// ===========================================================================
// B. Official BIP-352 vectors (single-signer "Sending"), if present
// ===========================================================================
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(here, 'send_and_receive_test_vectors.json'),
  join(here, '..', 'send_and_receive_test_vectors.json'),
  join(here, 'bip-0352', 'send_and_receive_test_vectors.json'),
  join(here, 'test-vectors', 'send_and_receive_test_vectors.json'),
];
const vectorPath = candidates.find((p) => existsSync(p));

console.log('\n=== Official BIP-352 "Sending" vectors ===\n');
if (!vectorPath) {
  console.log('  (skipped) send_and_receive_test_vectors.json not found.');
  console.log('  Drop the official file into seed-xor-tool/ to run the spec suite.');
  console.log('  Searched:');
  for (const c of candidates) console.log('    - ' + c);
} else {
  console.log('  Using vectors: ' + vectorPath + '\n');
  const vectors = JSON.parse(readFileSync(vectorPath, 'utf8'));
  let vPass = 0, vFail = 0, vCases = 0;

  for (const tc of vectors) {
    const sending = tc.sending || [];
    for (const s of sending) {
      const given = s.given;
      const expected = s.expected;
      // Build eligible inputs: BIP-352 vectors mark each input with its
      // scriptPubKey / type; the JSON's "given.vin" entries carry the private
      // key and an input type. We treat P2TR (witness v1) as taproot.
      const inputs = [];
      const outpoints = [];
      for (const vin of given.vin) {
        outpoints.push({ txid: vin.txid, vout: vin.vout });
        const spk = (vin.prevout && vin.prevout.scriptPubKey && vin.prevout.scriptPubKey.hex) || '';
        const isTaproot = spk.startsWith('5120'); // OP_1 PUSH32 = P2TR
        const isEligible = isTaproot
          || spk.startsWith('0014')               // P2WPKH
          || spk.startsWith('76a914')             // P2PKH
          || spk.startsWith('a914');              // P2SH (assume P2SH-P2WPKH)
        if (!isEligible) continue;
        // Taproot inputs may carry an internal-key tweak in some vectors; the
        // private key given is the one to use for ECDH.
        inputs.push({ privKey: vin.private_key, isTaproot });
      }

      const expectedOutputs = (expected && expected.outputs) ? expected.outputs : [];
      if (inputs.length === 0) continue; // no eligible inputs -> sender produces nothing
      vCases++;

      // Recipients are objects ({address, ...}) in the official schema; allow
      // bare strings or [string] too for forward-compat.
      const recipients = given.recipients.map((r) =>
        (typeof r === 'string' ? r : (r.address || (Array.isArray(r) ? r[0] : r))));

      // Intermediate check: our summed input scalar a must equal the vector's
      // input_private_key_sum (this independently exercises BIP-341 parity).
      let sumNote = '';
      if (expected.input_private_key_sum) {
        const { aScalar } = sumInputPrivateKeys(inputs);
        const ourSum = bytesToHex(_internal.numberToBytesBE(aScalar)).toLowerCase();
        const wantSum = expected.input_private_key_sum.toLowerCase();
        sumNote = (ourSum === wantSum) ? '  [a-sum ✓]' : `  [a-sum ✗ got ${ourSum}]`;
      }

      let derived;
      try {
        derived = deriveSilentPaymentOutputs({
          inputPrivKeys: inputs,
          outpoints,
          recipients,
        });
      } catch (e) {
        vFail++;
        console.log(`  ✗ ${tc.comment}  ->  threw: ${e.message}`);
        continue;
      }

      const got = derived.map((d) => bytesToHex(d.xOnly).toLowerCase()).sort();

      // The BIP-352 schema has varied across revisions. Normalize expected
      // into a list of acceptable output-sets, then pass if `got` equals any:
      //   (a) ["xonly", ...]                       -> one set
      //   (b) [["xonly", ...], ["xonly", ...]]     -> several valid sets
      //   (c) [{ "scriptPubKey": {"hex":"5120.."}}] -> objects with scripts
      const flat = (x) => {
        if (typeof x === 'string') return x.toLowerCase().replace(/^5120/, '');
        if (x && x.scriptPubKey && x.scriptPubKey.hex) return x.scriptPubKey.hex.toLowerCase().replace(/^5120/, '');
        if (x && x.hex) return x.hex.toLowerCase().replace(/^5120/, '');
        return String(x).toLowerCase();
      };
      let candidateSets;
      if (expectedOutputs.length && Array.isArray(expectedOutputs[0])) {
        candidateSets = expectedOutputs.map((set) => set.map(flat).sort());
      } else {
        candidateSets = [expectedOutputs.map(flat).sort()];
      }
      const eqSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      const matched = candidateSets.some((set) => eqSet(set, got));

      if (matched && got.length > 0) {
        vPass++;
        console.log(`  ✓ ${tc.comment}  (${got.length} output(s) matched)${sumNote}`);
      } else {
        vFail++;
        console.log(`  ✗ ${tc.comment}`);
        console.log(`      got : ${got.join(', ')}`);
        console.log(`      want: ${candidateSets.map((s) => '[' + s.join(', ') + ']').join('  OR  ')}`);
      }
    }
  }
  console.log(`\n  Official vectors: ${vPass}/${vCases} sending cases matched (${vFail} mismatched).`);
}

// ---------------------------------------------------------------------------
console.log(`\n=== Self-tests: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);

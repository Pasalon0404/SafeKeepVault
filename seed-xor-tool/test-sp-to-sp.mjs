/**
 * test-sp-to-sp.mjs
 *
 * SP -> SP signing scenario: an input that's itself a Silent Payment UTXO
 * (P2TR keyed by B_spend + t_k·G, signalled with the proprietary 0x1f/0x20
 * PSBT fields) AND an unresolved Silent Payment output (PSBT_OUT_SP_V0_INFO).
 *
 * The bug: downgradePSBTv2's derive-and-fill calls _psbtDeriveInputKeyForSP,
 * which only inspects bip32Derivation / tapBip32Derivation entries. An SP
 * input has NEITHER (it carries 0x1f + 0x20 instead), so the helper returns
 * null and downgrade throws "could not derive the private key for input N."
 *
 * The fix: extract the SP input's true spending key d = (b_spend + t_k) mod n
 * from the 0x1f/0x20 fields and feed it (with isTaproot=true) into the BIP-352
 * input-key sum. The math after that is exactly the same as a normal taproot
 * input.
 *
 * This test exercises the FAILURE PATH (no SP detection -> can't derive) and
 * the FIX (parse 0x1f/0x20 -> derive b_spend -> form d -> sum -> derive output).
 * The receiver re-derives the output script independently from b_scan and the
 * input pubkeys, and we assert the two scripts match — the canonical end-to-end
 * BIP-352 check.
 *
 * Run:  node test-sp-to-sp.mjs
 */

import { _internal, sumInputPrivateKeys, computeInputHash, computeEcdhSharedSecret,
         deriveOutputScript, computeReceiverSharedSecret } from './shared/silentpayments.js';
import { HDKey } from '@scure/bip32';
import * as bip39 from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

const { Point, G, N, modN, bytesToNumberBE, numberToBytesBE } = _internal;

let pass = 0, fail = 0;
const ck = (n, c, x) => { (c ? pass++ : fail++); console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${x && !c ? '  ' + x : ''}`); };

// ---------------------------------------------------------------------------
// 1.  Mirror of the existing _psbtDeriveInputKeyForSP behaviour. It walks
//     bip32Derivation / tapBip32Derivation only — exactly the codepath that
//     fails for SP inputs.
// ---------------------------------------------------------------------------
function deriveInputKey_currentBehaviour(masterKey, im) {
    const script = im.synth && im.synth.witnessUtxo && im.synth.witnessUtxo.script;
    if (!script) return null;
    // P2WPKH (a normal segwit input)
    if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) {
        const entries = im.synth.bip32Derivation || [];
        for (const [pub, der] of entries) {
            let child = masterKey;
            for (const c of der.path) child = child.deriveChild(c);
            if (bytesToHex(child.publicKey) === bytesToHex(pub)) return { privKey: child.privateKey, isTaproot: false };
        }
        return null;
    }
    // P2TR (taproot — current code uses tapBip32Derivation only)
    if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
        const entries = im.synth.tapBip32Derivation || [];
        if (!entries.length) return null;     // <-- this is where an SP input fails today
        // (normal taproot internal-key path omitted; not needed for this test)
        return null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// 2.  The PROPOSED helper: handle SP inputs that signal via 0x1f / 0x20 in
//     im.keep. Mirrors what we'll add to boot.html in downgradePSBTv2.
//     Returns {privKey, isTaproot:true} on success, null otherwise.
// ---------------------------------------------------------------------------
function tryDeriveSpInputKey(masterKey, myFpNum, im) {
    const script = im.synth && im.synth.witnessUtxo && im.synth.witnessUtxo.script;
    if (!script || script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) return null;
    let baseSpendPub = null, fpPath = null, tweak = null;
    for (const kv of im.keep || []) {
        const k = kv.key;
        if (!k || !k.length) continue;
        if (k[0] === 0x1f) { baseSpendPub = k.slice(1); fpPath = kv.value; }
        else if (k[0] === 0x20) { tweak = kv.value; }
    }
    if (!fpPath || !tweak || tweak.length !== 32) return null;
    if (fpPath.length < 4 || (fpPath.length - 4) % 4 !== 0) return null;

    // big-endian fp; 0x00000000 = wildcard
    const entryFp = ((fpPath[0] << 24) | (fpPath[1] << 16) | (fpPath[2] << 8) | fpPath[3]) >>> 0;
    if (entryFp !== (myFpNum >>> 0) && entryFp !== 0) return null;

    // little-endian uint32 path components after the fp
    const path = [];
    for (let o = 4; o + 4 <= fpPath.length; o += 4) {
        path.push(((fpPath[o]) | (fpPath[o+1] << 8) | (fpPath[o+2] << 16) | (fpPath[o+3] << 24)) >>> 0);
    }

    let child = masterKey;
    try { for (const c of path) child = child.deriveChild(c); }
    catch (_) { return null; }
    if (!child.privateKey) return null;
    if (baseSpendPub && bytesToHex(child.publicKey) !== bytesToHex(baseSpendPub)) return null;

    // d = (b_spend + t_k) mod n  (the SP-tweaked spending key)
    const d = modN(bytesToNumberBE(child.privateKey) + bytesToNumberBE(tweak));
    if (d === 0n) return null;
    // Confirm d·G matches the input's taproot output key before using it.
    const dXonly = G.multiply(d).toBytes(true).slice(1);
    if (bytesToHex(dXonly) !== bytesToHex(script.slice(2, 34))) return null;
    return { privKey: numberToBytesBE(d, 32), isTaproot: true };
}

// ---------------------------------------------------------------------------
// 3.  Build a synthetic SP -> SP scenario.
// ---------------------------------------------------------------------------
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = bip39.mnemonicToSeedSync(mnemonic, '');
const master = HDKey.fromMasterSeed(seed);
const fpNum = master.fingerprint >>> 0;
const fpBytesBE = Uint8Array.from([
    (fpNum >>> 24) & 0xff, (fpNum >>> 16) & 0xff, (fpNum >>> 8) & 0xff, fpNum & 0xff,
]);
const u32le = (v) => Uint8Array.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);

// Input 0: an SP UTXO whose base spend key is at m/352'/0'/0'/0/0 (Sparrow path).
const spPath = [0x80000160, 0x80000000, 0x80000000, 0x00000000, 0x00000000];
let spNode = master; for (const c of spPath) spNode = spNode.deriveChild(c);
const bSpend = spNode.privateKey;
const Bspend = spNode.publicKey;
const tBytes = hexToBytes('137278c4744472282400bc4b0c60afe74101bb7fe789f88803d0ef3f0fbd4b07');
const tNum = modN(bytesToNumberBE(tBytes));
const dNum = modN(bytesToNumberBE(bSpend) + tNum);
const dBytes = numberToBytesBE(dNum, 32);
const spOutputKey = Point.fromBytes(Bspend).add(G.multiply(tNum));
const Qxonly = spOutputKey.toBytes(true).slice(1);
const spInputScript = Uint8Array.from([0x51, 0x20, ...Qxonly]);

// Input 1: a normal P2WPKH input under our seed at m/84'/0'/0'/0/0.
const wpkhPath = [0x80000054, 0x80000000, 0x80000000, 0, 0];
let wNode = master; for (const c of wpkhPath) wNode = wNode.deriveChild(c);
const bWpkh = wNode.privateKey;
const Bwpkh = wNode.publicKey;
// P2WPKH scriptPubKey = OP_0 PUSH20 HASH160(pubkey)
import { hash160 } from '@scure/btc-signer/utils.js';
const wpkhScript = Uint8Array.from([0x00, 0x14, ...hash160(Bwpkh)]);

// Recipient SP keys (the "to" address). The recipient owns b_scan; we only need B_scan + B_spend.
const recvScan = master.deriveChild(0x80000160).deriveChild(0x80000000).deriveChild(0x80000001).deriveChild(0x80000001).deriveChild(0);
const recvSpend = master.deriveChild(0x80000160).deriveChild(0x80000000).deriveChild(0x80000001).deriveChild(0x80000000).deriveChild(0);
const bScanRecv = recvScan.privateKey;
const Bscan_recv = recvScan.publicKey;
const Bspend_recv = recvSpend.publicKey;

// inputMaps the way downgradePSBTv2 builds them: synth with witnessUtxo + bip32/tap
// derivation, plus keep[] for unknowns (where 0x1f/0x20 live for SP inputs).
const inputMaps = [
    {
        prevTxid: hexToBytes('aa'.repeat(32)), vout: 0,
        synth: {
            witnessUtxo: { script: spInputScript },
            bip32Derivation: [],
            tapBip32Derivation: [],   // <-- SP inputs have NO tap derivation; only 0x1f/0x20
        },
        keep: [
            { key: Uint8Array.from([0x1f, ...Bspend]),
              value: Uint8Array.from([...fpBytesBE, ...u32le(spPath[0]), ...u32le(spPath[1]), ...u32le(spPath[2]), ...u32le(spPath[3]), ...u32le(spPath[4])]) },
            { key: Uint8Array.from([0x20]), value: tBytes },
        ],
    },
    {
        prevTxid: hexToBytes('bb'.repeat(32)), vout: 1,
        synth: {
            witnessUtxo: { script: wpkhScript },
            bip32Derivation: [[Bwpkh, { fingerprint: fpNum, path: wpkhPath }]],
            tapBip32Derivation: [],
        },
        keep: [],
    },
];

// ---------------------------------------------------------------------------
// 4.  Confirm the CURRENT behaviour: SP input -> null -> downgrade would throw.
// ---------------------------------------------------------------------------
console.log('\n[1] CURRENT behaviour: SP input is unrecoverable by the existing matcher');
{
    const k0 = deriveInputKey_currentBehaviour(master, inputMaps[0]);
    const k1 = deriveInputKey_currentBehaviour(master, inputMaps[1]);
    ck('SP input (input 0) returns null from current code',  k0 === null);
    ck('normal P2WPKH input (input 1) still resolves',       !!k1);
    if (k0 === null) console.log('     -> downgradePSBTv2 throws "could not derive the private key for input 1"');
}

// ---------------------------------------------------------------------------
// 5.  The FIX: SP input now resolves via the 0x1f/0x20 helper, with the
//     correct tweaked private key d = b_spend + t_k.
// ---------------------------------------------------------------------------
console.log('\n[2] FIXED behaviour: tryDeriveSpInputKey recovers d = b_spend + t_k');
{
    const k = tryDeriveSpInputKey(master, fpNum, inputMaps[0]);
    ck('SP input now resolves to a (privKey, isTaproot) pair', !!k);
    ck('returned privKey == (b_spend + t_k) mod n',            !!k && bytesToHex(k.privKey) === bytesToHex(dBytes));
    ck('isTaproot flag is true (so sumInputPrivateKeys applies BIP-341 parity)', !!k && k.isTaproot === true);
    ck('d·G x-only matches the SP input scriptPubKey (P2TR output key)',
       !!k && bytesToHex(G.multiply(bytesToNumberBE(k.privKey)).toBytes(true).slice(1)) === bytesToHex(Qxonly));
}

// ---------------------------------------------------------------------------
// 6.  Full SP -> SP derivation: sum all input scalars (SP + P2WPKH), compute
//     the BIP-352 shared secret + output script, and verify the receiver
//     re-derives the same script from b_scan + the input pubkeys. This is the
//     end-to-end check that an SP -> SP transaction produces a spendable
//     output under the spec.
// ---------------------------------------------------------------------------
console.log('\n[3] End-to-end SP -> SP: sender output == receiver-derived output');
{
    const k0 = tryDeriveSpInputKey(master, fpNum, inputMaps[0]);
    const k1 = deriveInputKey_currentBehaviour(master, inputMaps[1]);
    const sumInputs = [k0, k1];
    const aSum = sumInputPrivateKeys(sumInputs);

    // input pubkeys for the BIP-352 input hash: the SP input contributes the
    // P2TR output key (= d·G); the P2WPKH input contributes its bip32 pubkey.
    const outpoints = inputMaps.map((im) => ({ txid: bytesToHex(im.prevTxid.slice().reverse()), vout: im.vout }));
    const inputHash = computeInputHash(outpoints, aSum.sumPubkey).inputHashScalar;
    const senderShared = computeEcdhSharedSecret(inputHash, aSum.aScalar, Bscan_recv);
    const senderScript = deriveOutputScript(senderShared, Bspend_recv, 0).scriptPubKey;

    // Receiver side: same input_hash, A_sum from input PUBKEYS, scan private key.
    const A_sp = G.multiply(bytesToNumberBE(k0.privKey)); // = output key Q
    const A_wpkh = Point.fromBytes(Bwpkh);
    const A_sum_pub = A_sp.add(A_wpkh).toBytes(true);
    const recvShared = computeReceiverSharedSecret(inputHash, bScanRecv, A_sum_pub);
    const recvScript = deriveOutputScript(recvShared, Bspend_recv, 0).scriptPubKey;

    ck('sender-derived SP output script == receiver-derived script (end to end)',
       bytesToHex(senderScript) === bytesToHex(recvScript));
}

console.log('\n--------------------------------------------------');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('SP -> SP derivation works once the input matcher recognises 0x1f/0x20.');

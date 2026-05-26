// Validate GLOBAL ECDH share + DLEQ against the official BIP-375 global vector.
import { _internal, generateDleqProof, verifyDleqProof, sumInputPrivateKeys, computeEcdhSharedSecret } from './shared/silentpayments.js';
const { Point, G, N, bytesToHex, hexToBytes, modN, bytesToNumberBE } = _internal;

const B  = '027a487fc19fb769877b8742d6ea18118f3c4e72b1ea8c6de602a7ad4a41dbe068';
const k0 = '7e31eeeb1aa2597b6d63b357541461d75ddae76b7603d24619f5ebed9e88ec31';
const k1 = '295c2eedddd8331d20b5d4cf9e69bb523ed85cb0bf35ab12e04fea66fe6d4a4a';
const P0 = '02c817bb7521afc35ea96f3bfb270e6eb50ddffa5560627b961fec00f2996508bf';
const P1 = '02f5b59fa5e492221ebf55ba78ad442605beae95166ba1eba3250d0bbaac7e2edc';
const C_off = '02d3262723352607e84fcaf7651f8d2d637e020aea86dfad80d306cd4f48cfcc62';
const Proof_off = 'c653b71f946818a95bdc39f0918445bc903a0876b738060e9e5db1dcec30abdf'
                + '54e0b5f178573f5119de71aa63ad19b449e3bcb65463936c8baeea4d917392b9';

let pass=0, fail=0;
const ck=(n,c,x)=>{(c?pass++:fail++);console.log(`  [${c?'PASS':'FAIL'}] ${n}${x&&!c?'  '+x:''}`);};
const eq=(a,b)=>a.toLowerCase()===b.toLowerCase();

// an = sum of the (P2WPKH => unmodified) input scalars, via the SP module's summer.
const sum = sumInputPrivateKeys([
  { privKey: hexToBytes(k0), isTaproot: false },
  { privKey: hexToBytes(k1), isTaproot: false },
]);
const an = sum.aScalar;

// A = an*G must equal Σ input pubkeys
const An_fromScalar = bytesToHex(G.multiply(modN(an)).toBytes(true));
const An_fromPubs   = bytesToHex(Point.fromBytes(hexToBytes(P0)).add(Point.fromBytes(hexToBytes(P1))).toBytes(true));
ck('an*G == Σ(input pubkeys)', eq(An_fromScalar, An_fromPubs), `\n     an*G=${An_fromScalar}\n     ΣP =${An_fromPubs}`);
ck('an*G matches sumInputPrivateKeys.sumPubkey', eq(An_fromScalar, bytesToHex(sum.sumPubkey)));

// C = an * B_scan  (global share, no input_hash) must equal the official share
const C_ours = bytesToHex(Point.fromBytes(hexToBytes(B)).multiply(modN(an)).toBytes(true));
ck('an*B_scan == official global ECDH share', eq(C_ours, C_off), `\n     ours=${C_ours}\n     off =${C_off}`);

// Our verifier must accept the official global proof with A = an*G
const okOff = verifyDleqProof(hexToBytes(An_fromScalar), hexToBytes(B), hexToBytes(C_off), hexToBytes(Proof_off));
ck('verifyDleqProof ACCEPTS the official GLOBAL proof', okOff===true);

// And a fresh proof we generate for (an, B) must verify
const Pours = generateDleqProof(an, hexToBytes(B));
ck('our fresh global proof verifies', verifyDleqProof(hexToBytes(An_fromScalar), hexToBytes(B), hexToBytes(C_ours), Pours)===true);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

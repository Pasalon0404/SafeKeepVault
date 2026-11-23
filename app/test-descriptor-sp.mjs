/**
 * test-descriptor-sp.mjs
 *
 * Verifies the Silent Payment (BIP-352 / BIP-392) descriptor + address logic
 * that the Output Descriptor builder will emit:
 *
 *  [1] Address encoding against an OFFICIAL BIP-352 receiving test vector
 *      (scan_priv, spend_priv -> sp1q...).
 *  [2] Full seed -> SP derivation: scan key m/352'/0'/0'/1'/0 (private),
 *      spend key m/352'/0'/0'/0'/0 (public); build the sp1q address, the
 *      spscan1q watch key, and the BIP-392 watch-only descriptor
 *      sp([fp/352h/0h/0h]spscan1q...)#cksum, and assert internal consistency
 *      (spscan decodes back to the same keys; address uses B_scan=b_scan*G).
 *  [3] BIP-380 checksum sanity (8 bech32 chars; charset accepted).
 *
 * Spec: BIP-392 (Craig Raw / Sparrow) — sp(KEY) with an spscan-encoded key,
 *       optional key origin to the m/352'/0'/0' account depth.
 *
 * Run:  node test-descriptor-sp.mjs
 */
import { _internal, encodeSilentPaymentAddress, encodeSpscan, decodeSpscan } from './shared/silentpayments.js';
import { HDKey } from '@scure/bip32';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const { Point, G, bytesToHex, hexToBytes, bytesToNumberBE, modN } = _internal;

let pass = 0, fail = 0;
const ck = (n, c, x) => { (c ? pass++ : fail++); console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${x && !c ? '  ' + x : ''}`); };
const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
const pub = (privHex) => G.multiply(modN(bytesToNumberBE(hexToBytes(privHex)))).toBytes(true);

// --- BIP-380 checksum (copy of descriptor/index.html descriptorChecksum) ---
function descriptorChecksum(desc) {
  const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
  const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];
  const polymod = (c, val) => {
    let c0 = c >> 35n;
    c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
    if (c0 & 1n) c ^= GENERATOR[0]; if (c0 & 2n) c ^= GENERATOR[1];
    if (c0 & 4n) c ^= GENERATOR[2]; if (c0 & 8n) c ^= GENERATOR[3];
    if (c0 & 16n) c ^= GENERATOR[4];
    return c;
  };
  let c = 1n, cls = 0, clscount = 0;
  for (const ch of desc) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos === -1) return "";
    c = polymod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++clscount === 3) { c = polymod(c, cls); cls = 0; clscount = 0; }
  }
  if (clscount > 0) c = polymod(c, cls);
  for (let j = 0; j < 8; j++) c = polymod(c, 0);
  c ^= 1n;
  let ret = "";
  for (let j = 0; j < 8; j++) ret += CHECKSUM_CHARSET[Number((c >> (5n * BigInt(7 - j))) & 31n)];
  return ret;
}

// ===========================================================================
console.log('\n[1] Official BIP-352 receiving vector: keys -> sp1q address');
{
  const scanPriv  = '0f694e068028a717f8af6b9411f9a133dd3565258714cc226594b34db90c1f2c';
  const spendPriv = '9d6ad855ce3417ef84e836892e5a56392bfba05fa5d97ccea30e266f540e08b3';
  const expected  = 'sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv';
  const addr = encodeSilentPaymentAddress(pub(scanPriv), pub(spendPriv));
  ck('encoded sp1q matches official vector', eq(addr, expected), `\n     ours=${addr}\n     off =${expected}`);
}

// ===========================================================================
console.log('\n[2] Full seed -> BIP-352 derivation -> descriptor + address');
{
  // deterministic test mnemonic (BIP-39 vector)
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = bip39.mnemonicToSeedSync(mnemonic, '');
  const root = HDKey.fromMasterSeed(seed);
  const fp = (root.fingerprint >>> 0).toString(16).padStart(8, '0');

  const scanNode  = root.derive("m/352'/0'/0'/1'/0"); // BIP-352 scan key
  const spendNode = root.derive("m/352'/0'/0'/0'/0"); // BIP-352 spend key
  const bScan   = scanNode.privateKey;   // 32-byte private scan key
  const Bscan   = scanNode.publicKey;    // 33-byte compressed
  const Bspend  = spendNode.publicKey;   // 33-byte compressed public spend key

  ck('scan private key is 32 bytes', bScan && bScan.length === 32);
  ck('spend public key is 33-byte compressed', Bspend && Bspend.length === 33 && (Bspend[0] === 0x02 || Bspend[0] === 0x03));

  // B_scan used in the address must equal b_scan*G
  ck('B_scan == b_scan*G', eq(bytesToHex(Bscan), bytesToHex(pub(bytesToHex(bScan)))));

  const sp1q = encodeSilentPaymentAddress(Bscan, Bspend);
  ck('sp1q address builds and has sp1q prefix', sp1q.startsWith('sp1q'));

  const spscan = encodeSpscan(bScan, Bspend);
  ck('spscan watch key has spscan1q prefix', spscan.startsWith('spscan1q'));

  // spscan must decode back to the exact same keys
  const dec = decodeSpscan(spscan);
  ck('spscan decodes to same scan priv', eq(bytesToHex(dec.scanPrivKey), bytesToHex(bScan)));
  ck('spscan decodes to same spend pub', eq(bytesToHex(dec.spendPubKey), bytesToHex(Bspend)));

  // BIP-392 watch-only descriptor: sp([fp/352h/0h/0h]spscan1q...)#cksum
  const body = `sp([${fp}/352h/0h/0h]${spscan})`;
  const cksum = descriptorChecksum(body);
  const descriptor = `${body}#${cksum}`;
  ck('descriptor checksum is 8 bech32 chars', /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/.test(cksum));
  ck('descriptor matches BIP-392 sp() watch-only shape',
     /^sp\(\[[0-9a-f]{8}\/352h\/0h\/0h\]spscan1q[0-9a-z]+\)#[a-z0-9]{8}$/.test(descriptor),
     `\n     ${descriptor}`);

  console.log('\n     --- sample output (mnemonic = abandon...about) ---');
  console.log('     fingerprint :', fp);
  console.log('     sp1q address:', sp1q);
  console.log('     descriptor  :', descriptor);
}

console.log('\n--------------------------------------------------');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('Silent Payment descriptor + address logic verified.');

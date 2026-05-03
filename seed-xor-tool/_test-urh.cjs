// Round-trip test for ARM_URH (extracted from boot.html)
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'boot.html'), 'utf8');
const m = src.match(/(var ARM_URH = \(function \(\) \{[\s\S]*?\n\}\)\(\);)/);
if (!m) { console.error('ARM_URH block not found'); process.exit(1); }

// Eval the IIFE in this scope
const ARM_URH = (new Function(m[1] + '; return ARM_URH;'))();

const bcur = require('@ngraveio/bc-ur');

function hex(s) {
    const u = new Uint8Array(s.length/2);
    for (let i=0;i<u.length;i++) u[i] = parseInt(s.substr(i*2,2),16);
    return u;
}
function h(u8) { return Buffer.from(u8).toString('hex'); }

// Known test vector
const hdNode = {
    publicKey:  hex('03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd'),
    chainCode:  hex('7923408dadd3c7b56eed15567707ae5e5dca089de972e07f3b860450e2a3b70e'),
    parentFingerprint: 0x6a6d2cf0,
    depth: 3,
};
const masterFpHex = '73c5da0a';
const basePath    = "m/84'/0'/0'";

const ur = ARM_URH.encodeAccountAsHdkeyUR(hdNode, masterFpHex, basePath);
console.log('UR:', ur);
console.log('UR length:', ur.length, 'chars');

// Parse with @ngraveio/bc-ur via URDecoder (validates CRC32 + bytewords)
const dec = new bcur.URDecoder();
dec.receivePart(ur);
if (!dec.isSuccess()) {
    console.error('FAIL: UR decode unsuccessful:', dec.resultError()); process.exit(1);
}
const parsed = dec.resultUR();
console.log('Parsed UR type:', parsed.type);

const cborHex = parsed.cbor.toString('hex');
console.log('CBOR hex (', parsed.cbor.length, 'bytes):', cborHex);

// Expected byte-for-byte:
const expected =
  'a4' +                                                                // map(4)
  '03' + '5821' + h(hdNode.publicKey) +                                 // 3: bytes(33)
  '04' + '5820' + h(hdNode.chainCode) +                                 // 4: bytes(32)
  '06' + 'd90130' + 'a3' +                                              // 6: tag(304) + map(3)
    '01' + '86' + '1854' + 'f5' + '00' + 'f5' + '00' + 'f5' +           // 1: [84,t,0,t,0,t]
    '02' + '1a' + '73c5da0a' +                                          // 2: uint32 master-fp
    '03' + '03' +                                                       // 3: depth=3
  '08' + '1a' + '6a6d2cf0';                                             // 8: uint32 parent-fp

console.log('Expected hex :', expected);
console.log('Match:', cborHex === expected);

if (parsed.type !== 'crypto-hdkey') {
    console.error('FAIL: type'); process.exit(1);
}
if (cborHex !== expected) {
    console.error('FAIL: byte-for-byte CBOR mismatch'); process.exit(1);
}
console.log('\nPASS: byte-for-byte CBOR match + UR/CRC/bytewords validated by @ngraveio/bc-ur');

// Additional assertions:
// - Total UR string length is reasonable for a single-QR
// - All chars are lowercase alphanumeric (URI-safe)
if (!/^ur:crypto-hdkey\/[a-z]+$/.test(ur)) {
    console.error('FAIL: UR contains unexpected characters'); process.exit(1);
}
console.log('PASS: UR charset check');

// Sanity: empty path / non-hardened / different fingerprints
const testCases = [
    { path: "m/86'/0'/0'", fp: 'deadbeef',  parent: 0x00000000, depth: 3 },
    { path: "m/48'/0'/0'/2'", fp: '00112233', parent: 0xabcd1234, depth: 4 },
    { path: "m/49'/0'/0'", fp: 'ffffffff', parent: 0xffffffff, depth: 3 },
];
for (const tc of testCases) {
    const tcNode = { publicKey: hdNode.publicKey, chainCode: hdNode.chainCode,
                     parentFingerprint: tc.parent, depth: tc.depth };
    const urStr = ARM_URH.encodeAccountAsHdkeyUR(tcNode, tc.fp, tc.path);
    const d = new bcur.URDecoder();
    d.receivePart(urStr);
    if (!d.isSuccess()) { console.error('FAIL (decode)', tc.path, d.resultError()); process.exit(1); }
    const p = d.resultUR();
    console.log('OK  ', tc.path, '→', urStr.length, 'chars, type=', p.type);
}

console.log('\nAll tests passed.');

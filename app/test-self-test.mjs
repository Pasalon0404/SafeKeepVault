/**
 * test-self-test.mjs — start-up known-answer self-check
 *
 *   1. Every self-test passes against the real bundled libraries.
 *   2. Expected values agree with INDEPENDENT implementations where one is at
 *      hand: node:crypto SHA-256, PBKDF2-HMAC-SHA512 and ECDSA verify, and the
 *      separate `bip39` npm package for mnemonic encoding.
 *   3. The gate fails closed: a library returning a wrong value, a test that
 *      throws, and a malformed entry (no expectation) are each reported.
 *   4. The gate records its outcome on the root element.
 *   5. boot-entry.js runs the gate before SafeKeepOS.boot() and returns early
 *      on failure.
 *
 * Run:  node test-self-test.mjs
 */

import { buildSelfTests, runSelfTests, selfTestGate } from './shared/self-test.js';
import * as sp from './shared/silentpayments.js';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import * as btcSigner from '@scure/btc-signer';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import legacyBip39 from 'bip39';
import { createHash, pbkdf2Sync, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };

const LIB = { bip39, wordlist, HDKey, btcSigner, secp256k1, schnorr };
const ENV = { subtle: crypto.subtle, getRandomValues: (u8) => crypto.getRandomValues(u8), sp };
const tests = buildSelfTests(LIB, ENV);
const byName = Object.fromEntries(tests.map((t) => [t.name, t]));
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

console.log('\n1. Every self-test passes against the real libraries');
const failed = await runSelfTests(tests);
ck(`all ${tests.length} tests pass`, failed.length === 0, failed.join(', '));
ck('test names are unique', new Set(tests.map((t) => t.name)).size === tests.length);

console.log('\n2. Expected values agree with independent implementations');
ck('SHA-256("abc") matches node:crypto',
    byName['Browser SHA-256'].expected === createHash('sha256').update('abc').digest('hex'));
ck('BIP-39 seed matches node:crypto PBKDF2-HMAC-SHA512',
    byName['BIP-39 seed (PBKDF2-HMAC-SHA512)'].expected ===
    pbkdf2Sync(ABANDON, 'mnemonicTREZOR', 2048, 64, 'sha512').toString('hex'));
ck('BIP-39 mnemonic matches the separate bip39 package',
    byName['BIP-39 mnemonic encoding'].expected === legacyBip39.entropyToMnemonic('7f'.repeat(16)));
{
    // Secret key 1's public key is the generator point G.
    const G = {
        x: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        y: '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
    };
    const key = createPublicKey({ key: {
        kty: 'EC', crv: 'secp256k1',
        x: Buffer.from(G.x, 'hex').toString('base64url'),
        y: Buffer.from(G.y, 'hex').toString('base64url'),
    }, format: 'jwk' });
    const sig = Buffer.from(byName['ECDSA signing (RFC 6979)'].expected, 'hex');
    ck('ECDSA signature verifies under node:crypto',
        verify('sha256', Buffer.from('Satoshi Nakamoto'), { key, dsaEncoding: 'ieee-p1363' }, sig));
}

console.log('\n3. The gate fails closed');
{
    const brokenHD = {
        fromMasterSeed: (...a) => {
            const root = HDKey.fromMasterSeed(...a);
            return { derive: (p) => { const k = root.derive(p); return { get privateExtendedKey() { return k.privateExtendedKey.slice(0, -1) + 'X'; }, publicKey: k.publicKey }; } };
        },
        fromExtendedKey: HDKey.fromExtendedKey,
    };
    const f = await runSelfTests(buildSelfTests({ ...LIB, HDKey: brokenHD }, ENV));
    ck('a wrong BIP-32 result is reported', f.includes('BIP-32 private derivation'), f.join(', '));
}
{
    const lenient = { ...bip39, validateMnemonic: () => true };
    const f = await runSelfTests(buildSelfTests({ ...LIB, bip39: lenient }, ENV));
    ck('a checksum validator that accepts everything is reported', f.includes('BIP-39 checksum validation'), f.join(', '));
}
{
    const forgiving = { ...secp256k1, verify: () => true };
    const f = await runSelfTests(buildSelfTests({ ...LIB, secp256k1: forgiving }, ENV));
    ck('an ECDSA verifier that accepts forgeries is reported', f.includes('ECDSA verification'), f.join(', '));
}
{
    const f = await runSelfTests(buildSelfTests(LIB, { ...ENV, getRandomValues: (u8) => u8 }));
    ck('a random generator returning zeros is reported', f.includes('Browser random number generator'), f.join(', '));
}
{
    const f = await runSelfTests(buildSelfTests(LIB, { ...ENV, subtle: undefined }));
    ck('a missing crypto.subtle is reported (throw = fail)', f.includes('Browser SHA-256'), f.join(', '));
}
{
    const f = await runSelfTests(buildSelfTests(LIB, { ...ENV, sp: { selfTestDleqOfficialVector: () => false } }));
    ck('a failing DLEQ canary is reported', f.includes('Silent Payments DLEQ proof (BIP-374/375)'), f.join(', '));
}
{
    const f = await runSelfTests([
        { name: 'no expectation', run: () => undefined },
        { name: 'empty expectation', expected: '', run: () => '' },
    ]);
    ck('malformed entries never pass', f.length === 2, f.join(', '));
}

console.log('\n4. The gate records its outcome');
{
    const root = { dataset: {} };
    const ok = await selfTestGate(root, tests);
    ck('passing run: empty failure list', ok.length === 0);
    ck('passing run: data-self-tests set', root.dataset.selfTests === String(tests.length));
    ck('passing run: data-self-tests-failed = 0', root.dataset.selfTestsFailed === '0');
    const bad = await selfTestGate(root, [{ name: 'x', expected: 'a', run: () => 'b' }]);
    ck('failing run: failure list returned', bad.length === 1 && bad[0] === 'x');
    ck('failing run: data-self-tests-failed = 1', root.dataset.selfTestsFailed === '1');
}

console.log('\n5. boot-entry.js halts boot on failure');
{
    const src = readFileSync(new URL('./boot-entry.js', import.meta.url), 'utf8');
    const gate = src.indexOf('await selfTestGate(');
    const halt = src.indexOf('return;', gate);
    const boot = src.indexOf('window.SafeKeepOS.boot()');
    ck('gate runs before SafeKeepOS.boot()', gate !== -1 && boot !== -1 && gate < boot);
    ck('failure path returns before boot', halt !== -1 && halt < boot);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

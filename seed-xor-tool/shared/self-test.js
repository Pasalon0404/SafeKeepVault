/**
 * self-test.js — start-up known-answer self-check
 *
 * Before the boot sequence wires up a single tool, run published test vectors
 * through the same crypto libraries the app uses (window.BtcMath: @scure/bip39,
 * @scure/bip32, @scure/btc-signer, @noble/curves) plus the browser's own
 * SHA-256 and random number generator. If this machine computes any of them
 * wrong, refuse to start. A miscompiled engine, a corrupted bundle, or a broken
 * library would otherwise produce wrong seeds, keys or addresses silently; a
 * fixed vector turns that into a visible failure.
 *
 * What this cannot catch: a targeted exploit that recognises these inputs, or a
 * bug confined to inputs no vector exercises. It is a floor under the host, not
 * a proof about it.
 *
 * Every expected value is a published vector: BIP-39 reference vectors, BIP-32
 * test vector 1, the BIP-44/49/84/86 "abandon ... about" first receive
 * addresses, the d = 1 "Satoshi Nakamoto" RFC 6979 signature, BIP-340 test
 * vector 0, the NIST "abc" SHA-256 digest, and the official BIP-375 DLEQ
 * vector. No secret material is touched; only the RNG test draws randomness,
 * and it discards it. test-self-test.mjs checks the expectations against
 * independent implementations.
 *
 * Inspired by EntropyLab's boot self-test (src/js/self-test.js).
 */

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BIP32_V1_SEED = '000102030405060708090a0b0c0d0e0f';
const BIP32_V1_XPUB_M_0H_1_2H = 'xpub6D4BDPcP2GT577Vvch3R8wDkScZWzQzMMUm3PWbmWvVJrZwQY4VUNgqFJPMM3No2dFDFGTsxxpG5uJh7n7epu4trkrX7x7DogT5Uv6fcLW5';
// sha256("Satoshi Nakamoto"), signed with secret key 1 (RFC 6979, low-S).
const ECDSA_MSGHASH = 'a0dc65ffca799873cbea0ac274015b9526505daaaed385155425f7337704883e';
const ECDSA_SIG =
    '934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8' +
    '2442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5';
// BIP-340 test vector 0: secret key 3, aux_rand = 0, message = 0.
const SCHNORR_SIG =
    'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca8215' +
    '25f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0';
const SCHNORR_PUB = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';

const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const scalar = (n) => { const k = new Uint8Array(32); k[31] = n; return k; };

/**
 * Build the test list against a crypto library bundle shaped like
 * window.BtcMath: { bip39, wordlist, HDKey, btcSigner, secp256k1, schnorr }.
 * `env` supplies the browser primitives: { subtle, getRandomValues, sp }.
 * Names are plain text; the failure screen renders them with textContent.
 */
export function buildSelfTests(lib, env = {}) {
    const { bip39, wordlist, HDKey, btcSigner, secp256k1, schnorr } = lib;

    // The four address tests share one root so PBKDF2 runs once, not four
    // times. It is a published test key, so holding it briefly is harmless.
    let abandonRoot = null;
    const firstReceive = (purpose) => {
        if (!abandonRoot) abandonRoot = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(ABANDON));
        const pub = abandonRoot.derive(`m/${purpose}'/0'/0'/0/0`).publicKey;
        if (purpose === 44) return btcSigner.p2pkh(pub).address;
        if (purpose === 49) return btcSigner.p2sh(btcSigner.p2wpkh(pub)).address;
        if (purpose === 84) return btcSigner.p2wpkh(pub).address;
        return btcSigner.p2tr(pub.slice(1)).address;
    };

    return [
        {
            name: 'BIP-39 mnemonic encoding',
            expected: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
            run: () => bip39.entropyToMnemonic(fromHex('7f'.repeat(16)), wordlist),
        },
        {
            // Fail-open is the dangerous direction: a checker that accepts
            // anything would let a mistyped backup through. Require both answers.
            name: 'BIP-39 checksum validation',
            expected: 'valid:true tampered:false',
            run: () => `valid:${bip39.validateMnemonic(ABANDON, wordlist)} ` +
                `tampered:${bip39.validateMnemonic(ABANDON.replace(/about$/, 'above'), wordlist)}`,
        },
        {
            name: 'BIP-39 seed (PBKDF2-HMAC-SHA512)',
            expected:
                'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553' +
                '1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
            run: () => toHex(bip39.mnemonicToSeedSync(ABANDON, 'TREZOR')),
        },
        {
            name: 'BIP-32 private derivation',
            expected: 'xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76',
            run: () => HDKey.fromMasterSeed(fromHex(BIP32_V1_SEED)).derive("m/0'/1/2'/2/1000000000").privateExtendedKey,
        },
        {
            // Public-only derivation from the published m/0'/1/2' xpub must
            // land on the same child as private derivation does.
            name: 'BIP-32 public derivation',
            expected: 'xpub6H1LXWLaKsWFhvm6RVpEL9P4KfRZSW7abD2ttkWP3SSQvnyA8FSVqNTEcYFgJS2UaFcxupHiYkro49S8yGasTvXEYBVPamhGW6cFJodrTHy',
            run: () => HDKey.fromExtendedKey(BIP32_V1_XPUB_M_0H_1_2H).derive('m/2/1000000000').publicExtendedKey,
        },
        { name: 'Legacy address (BIP-44)', expected: '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA', run: () => firstReceive(44) },
        { name: 'Nested SegWit address (BIP-49)', expected: '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf', run: () => firstReceive(49) },
        { name: 'Native SegWit address (BIP-84)', expected: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', run: () => firstReceive(84) },
        { name: 'Taproot address (BIP-86)', expected: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', run: () => firstReceive(86) },
        {
            name: 'ECDSA signing (RFC 6979)',
            expected: ECDSA_SIG,
            run: () => toHex(secp256k1.sign(fromHex(ECDSA_MSGHASH), scalar(1), { prehash: false, extraEntropy: false })),
        },
        {
            name: 'ECDSA verification',
            expected: 'valid:true tampered:false',
            run: () => {
                const pub = secp256k1.getPublicKey(scalar(1), true);
                const tampered = fromHex(ECDSA_SIG);
                tampered[63] ^= 1;
                const ok = secp256k1.verify(fromHex(ECDSA_SIG), fromHex(ECDSA_MSGHASH), pub, { prehash: false });
                const forged = secp256k1.verify(tampered, fromHex(ECDSA_MSGHASH), pub, { prehash: false });
                return `valid:${ok} tampered:${forged}`;
            },
        },
        {
            name: 'Schnorr signing (BIP-340)',
            expected: `pub:${SCHNORR_PUB} sig:${SCHNORR_SIG}`,
            run: () => `pub:${toHex(schnorr.getPublicKey(scalar(3)))} ` +
                `sig:${toHex(schnorr.sign(new Uint8Array(32), scalar(3), new Uint8Array(32)))}`,
        },
        {
            name: 'Schnorr verification (BIP-340)',
            expected: 'valid:true tampered:false',
            run: () => {
                const tampered = fromHex(SCHNORR_SIG);
                tampered[63] ^= 1;
                const msg = new Uint8Array(32);
                return `valid:${schnorr.verify(fromHex(SCHNORR_SIG), msg, fromHex(SCHNORR_PUB))} ` +
                    `tampered:${schnorr.verify(tampered, msg, fromHex(SCHNORR_PUB))}`;
            },
        },
        {
            // The entropy hardening and several tools hash with the browser's
            // own SHA-256, not the bundled one.
            name: 'Browser SHA-256',
            expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
            run: async () => toHex(new Uint8Array(await env.subtle.digest('SHA-256', new TextEncoder().encode('abc')))),
        },
        {
            // Not a known-answer test (randomness has none): it only catches a
            // generator that is missing, stuck, or returning zeros.
            name: 'Browser random number generator',
            expected: 'ok',
            run: () => {
                const a = env.getRandomValues(new Uint8Array(32));
                const b = env.getRandomValues(new Uint8Array(32));
                const zero = (u8) => u8.every((x) => x === 0);
                return (!zero(a) && !zero(b) && toHex(a) !== toHex(b)) ? 'ok' : 'stuck';
            },
        },
        {
            name: 'Silent Payments DLEQ proof (BIP-374/375)',
            expected: 'true',
            run: () => String(env.sp.selfTestDleqOfficialVector() === true),
        },
    ];
}

/**
 * Run every test and return the names of the ones this host fails. A test
 * passes only when it returns exactly its expected string; a throw, a missing
 * or empty expectation, or any other value is a failure, so a malformed entry
 * can never pass by comparing undefined to undefined.
 */
export async function runSelfTests(tests) {
    const failed = [];
    for (const { name, expected, run } of tests) {
        let ok = false;
        try {
            ok = typeof expected === 'string' && expected !== '' && (await run()) === expected;
        } catch (_) {
            ok = false;
        }
        if (!ok) failed.push(name);
    }
    return failed;
}

/**
 * The boot gate. Records the outcome on <html> (data-self-tests and
 * data-self-tests-failed) so tests and support can confirm it ran. Returns
 * the list of failed test names; an empty list means boot may proceed.
 */
export async function selfTestGate(root, tests) {
    const failed = await runSelfTests(tests);
    if (root) {
        root.dataset.selfTests = String(tests.length);
        root.dataset.selfTestsFailed = String(failed.length);
    }
    return failed;
}

/**
 * test-entropy-harden.mjs — hardened 1-click entropy wrapper
 *
 * Proves the wrapper is correct AND can never weaken the CSPRNG base:
 *   1. Known-answer: output === SHA-256(base32 || saltBytes) truncated, checked
 *      against an INDEPENDENT node:crypto SHA-256 (not the module's own).
 *   2. Lengths: returns exactly 16 / 24 / 32 bytes.
 *   3. BIP-39: each output is accepted by @scure/bip39 entropyToMnemonic and
 *      the resulting mnemonic passes validateMnemonic (correct checksum) —
 *      i.e. it plugs straight into the existing generator.
 *   4. CSPRNG drives the output: changing only the base flips the output.
 *   5. Determinism: identical inputs → identical output.
 *   6. Guard: a non-BIP-39 byteLen throws.
 *
 * Run:  node test-entropy-harden.mjs
 */

import { generateHardenedEntropy } from './shared/entropy-harden.js';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createHash } from 'node:crypto';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const hex = (u8) => Buffer.from(u8).toString('hex');

// Independent SHA-256 (node), NOT the module's crypto.subtle.
function sha256(u8) { return new Uint8Array(createHash('sha256').update(Buffer.from(u8)).digest()); }

const base = new Uint8Array(32);
for (let i = 0; i < 32; i++) base[i] = i;                 // deterministic 00..1f
const salt = 'p123.456|d1700000000000|w1920x1080';
const saltBytes = new TextEncoder().encode(salt);
const preimage = new Uint8Array(base.length + saltBytes.length);
preimage.set(base, 0); preimage.set(saltBytes, base.length);
const expectedFull = sha256(preimage);                    // 32-byte expected digest

console.log('\n1. Known-answer vs independent node SHA-256 (truncation correctness)');
for (const n of [16, 24, 32]) {
    const out = await generateHardenedEntropy(n, { baseBytes: base, salt });
    ck(`byteLen ${n}: matches SHA-256(base||salt)[0:${n}]`,
       hex(out) === hex(expectedFull.slice(0, n)),
       `got ${hex(out)} want ${hex(expectedFull.slice(0, n))}`);
    ck(`byteLen ${n}: length is exactly ${n}`, out.length === n, `got ${out.length}`);
}

console.log('\n2. Output is valid BIP-39 entropy (plugs into the generator)');
for (const [n, words] of [[16, 12], [24, 18], [32, 24]]) {
    const out = await generateHardenedEntropy(n, { baseBytes: base, salt });
    const mnemonic = bip39.entropyToMnemonic(out, wordlist);
    const wc = mnemonic.trim().split(/\s+/).length;
    ck(`byteLen ${n} → ${words}-word mnemonic`, wc === words, `got ${wc} words`);
    ck(`byteLen ${n} → valid BIP-39 checksum`, bip39.validateMnemonic(mnemonic, wordlist));
}

console.log('\n3. CSPRNG base drives the output (salt is not load-bearing)');
{
    const base2 = new Uint8Array(32); base2.set(base); base2[0] ^= 0xff;   // flip one base bit-block
    const a = await generateHardenedEntropy(32, { baseBytes: base, salt });
    const b = await generateHardenedEntropy(32, { baseBytes: base2, salt });
    ck('different base → different output', hex(a) !== hex(b));
    // Same base, different salt → different output (salt does mix in)
    const c = await generateHardenedEntropy(32, { baseBytes: base, salt: salt + '!' });
    ck('different salt → different output', hex(a) !== hex(c));
}

console.log('\n4. Determinism + live call shape');
{
    const a = await generateHardenedEntropy(32, { baseBytes: base, salt });
    const b = await generateHardenedEntropy(32, { baseBytes: base, salt });
    ck('identical inputs → identical output', hex(a) === hex(b));
    // Live call (real CSPRNG + real salt): correct length, and two draws differ.
    const live1 = await generateHardenedEntropy(32);
    const live2 = await generateHardenedEntropy(32);
    ck('live draw length 32', live1.length === 32);
    ck('two live draws differ', hex(live1) !== hex(live2));
}

console.log('\n5. Guards');
{
    let threw = false;
    try { await generateHardenedEntropy(20, { baseBytes: base, salt }); } catch (_) { threw = true; }
    ck('non-BIP-39 byteLen (20) throws', threw);
}

console.log(`\n========================================`);
console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
console.log(`========================================`);
process.exit(fail === 0 ? 0 : 1);

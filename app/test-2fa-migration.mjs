/**
 * test-2fa-migration.mjs  —  Tool 16 (2FA Backup) parser known-answer tests
 *
 * Anchored against authoritative, non-circular sources:
 *
 *   1. base32 encoder  → RFC 4648 §10 official test vectors ("foobar" series),
 *      padding stripped (we emit no padding).
 *   2. varint reader   → the canonical Protocol Buffers documentation example
 *      (field 1 = 150 encodes as 08 96 01), plus a multi-byte case.
 *   3. otpauth-migration decode → the canonical Google Authenticator export
 *      vector documented by Alexander Bakker and reproduced across many
 *      independent decoders. Expected field values were verified by an
 *      INDEPENDENT (Python) protobuf walk, not by this module:
 *          secret bytes 48656c6c6f21deadbeef → base32 JBSWY3DPEHPK3PXP
 *          name "Example:alice@google.com", issuer "Example", type TOTP.
 *   4. otpauth:// single-URI parse → known-answer URI.
 *   5. multi-account round-trip → a test-side protobuf ENCODER (independent of
 *      the decoder) builds a 2-account payload exercising SHA256 / 8-digit /
 *      HOTP+counter enum branches; we assert the decoder recovers every field.
 *
 * Run:  node test-2fa-migration.mjs
 */

import {
    base32Encode, base64ToBytes, readVarint, readFields,
    decodeMigrationPayload, parseMigrationUri, parseOtpauthUri,
    buildOtpauthUri, accountKey, mergeAccounts,
    classify, parseQrPayload
} from './shared/twofa-parser.js';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => {
    (cond ? pass++ : fail++);
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`);
};
const eq = (name, got, want) => ck(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const enc = (s) => new TextEncoder().encode(s);

// ===========================================================================
console.log('\n1. base32 encoder — RFC 4648 §10 official vectors (no padding)');
// ===========================================================================
eq('base32("")',       base32Encode(enc('')),       '');
eq('base32("f")',      base32Encode(enc('f')),      'MY');
eq('base32("fo")',     base32Encode(enc('fo')),     'MZXQ');
eq('base32("foo")',    base32Encode(enc('foo')),    'MZXW6');
eq('base32("foob")',   base32Encode(enc('foob')),   'MZXW6YQ');
eq('base32("fooba")',  base32Encode(enc('fooba')),  'MZXW6YTB');
eq('base32("foobar")', base32Encode(enc('foobar')), 'MZXW6YTBOI');
// The exact 10 secret bytes from the canonical migration vector:
eq('base32(48656c6c6f21deadbeef)',
   base32Encode(new Uint8Array([0x48,0x65,0x6c,0x6c,0x6f,0x21,0xde,0xad,0xbe,0xef])),
   'JBSWY3DPEHPK3PXP');

// ===========================================================================
console.log('\n2. LEB128 varint reader — Protocol Buffers spec known-answers');
// ===========================================================================
{
    // protobuf docs: the message {field 1: 150} serializes to 08 96 01.
    const buf = new Uint8Array([0x08, 0x96, 0x01]);
    const [tag, p1] = readVarint(buf, 0);
    eq('tag byte 0x08 → varint 8', tag, 8);
    eq('  field number (tag>>3)', Math.floor(tag / 8), 1);
    eq('  wire type (tag&7)', tag & 7, 0);
    const [val, p2] = readVarint(buf, p1);
    eq('value 96 01 → 150', val, 150);
    eq('consumed all 3 bytes', p2, 3);

    // Multi-byte: AC 02 → 300.
    const [v300] = readVarint(new Uint8Array([0xac, 0x02]), 0);
    eq('AC 02 → 300', v300, 300);

    // Truncation must throw, not silently under-read.
    let threw = false;
    try { readVarint(new Uint8Array([0x80]), 0); } catch (_) { threw = true; }
    ck('truncated varint throws', threw);
}

// ===========================================================================
console.log('\n3. otpauth-migration decode — canonical Bakker / multi-decoder vector');
// ===========================================================================
{
    const uri = 'otpauth-migration://offline?data=' +
        'CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZTAC';
    const accts = parseMigrationUri(uri);
    eq('account count', accts.length, 1);
    const a = accts[0];
    eq('  type',    a.otpType, 'TOTP');
    eq('  issuer',  a.issuer,  'Example');
    eq('  account', a.account, 'alice@google.com');   // "Example:" prefix stripped
    eq('  secret',  a.secret,  'JBSWY3DPEHPK3PXP');
    eq('  digits (default)', a.digits, 6);
    eq('  algorithm (default)', a.algorithm, 'SHA1');

    // classify() + parseQrPayload() agree
    eq('classify migration', classify(uri), 'migration');
    eq('parseQrPayload kind', parseQrPayload(uri).kind, 'migration');
}

// ===========================================================================
console.log('\n4. otpauth:// single-URI parse — known-answer');
// ===========================================================================
{
    const uri = 'otpauth://totp/Example:alice@google.com' +
        '?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA1&digits=6&period=30';
    const a = parseOtpauthUri(uri);
    eq('  type',    a.otpType, 'TOTP');
    eq('  issuer',  a.issuer,  'Example');
    eq('  account', a.account, 'alice@google.com');
    eq('  secret',  a.secret,  'JBSWY3DPEHPK3PXP');
    eq('  digits',  a.digits,  6);
    eq('  algorithm', a.algorithm, 'SHA1');
    eq('classify otpauth', classify(uri), 'otpauth');

    // HOTP with a counter and lowercase secret (must be normalized to upper).
    const h = parseOtpauthUri('otpauth://hotp/ACME%20Co%3Abob?secret=mzxw6ytboi&counter=5&issuer=ACME%20Co');
    eq('  HOTP type', h.otpType, 'HOTP');
    eq('  HOTP issuer', h.issuer, 'ACME Co');
    eq('  HOTP account', h.account, 'bob');
    eq('  HOTP secret upper', h.secret, 'MZXW6YTBOI');
    eq('  HOTP counter', h.counter, 5);
}

// ===========================================================================
console.log('\n5. Multi-account round-trip — independent encoder exercises enums');
// ===========================================================================
{
    // --- test-side protobuf encoder (independent of the decoder) ---
    const vint = (n) => { const o = []; n = Math.floor(n); do { let b = n & 0x7f; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return o; };
    const tagB = (field, wire) => vint((field << 3) | wire);
    const lenF = (field, bytes) => [...tagB(field, 2), ...vint(bytes.length), ...bytes];
    const varF = (field, val) => [...tagB(field, 0), ...vint(val)];

    const otpParams = (secretBytes, name, issuer, algo, digits, type, counter) => {
        let b = [];
        b = b.concat(lenF(1, [...secretBytes]));
        b = b.concat(lenF(2, [...enc(name)]));
        if (issuer) b = b.concat(lenF(3, [...enc(issuer)]));
        if (algo)   b = b.concat(varF(4, algo));
        if (digits) b = b.concat(varF(5, digits));
        if (type)   b = b.concat(varF(6, type));
        if (counter != null) b = b.concat(varF(7, counter));
        return b;
    };

    // Account A: TOTP, SHA256, 8 digits. secret = "foobar" → MZXW6YTBOI.
    const acctA = otpParams(enc('foobar'), 'ACME:bob', 'ACME', 2, 2, 2, null);
    // Account B: HOTP, SHA1, 6 digits, counter 42. secret = "f" → MY.
    const acctB = otpParams(enc('f'), 'GitHub:carol', 'GitHub', 1, 1, 1, 42);

    let payload = [];
    payload = payload.concat(lenF(1, acctA));   // otp_parameters
    payload = payload.concat(lenF(1, acctB));
    payload = payload.concat(varF(2, 1));       // version = 1
    payload = payload.concat(varF(3, 2));       // batch_size = 2
    payload = payload.concat(varF(4, 0));       // batch_index = 0

    const bytes = new Uint8Array(payload);
    const accts = decodeMigrationPayload(bytes);
    eq('round-trip account count', accts.length, 2);

    eq('A type',   accts[0].otpType, 'TOTP');
    eq('A issuer', accts[0].issuer, 'ACME');
    eq('A account', accts[0].account, 'bob');
    eq('A secret', accts[0].secret, 'MZXW6YTBOI');
    eq('A algorithm', accts[0].algorithm, 'SHA256');
    eq('A digits', accts[0].digits, 8);
    eq('A counter (TOTP→null)', accts[0].counter, null);

    eq('B type',   accts[1].otpType, 'HOTP');
    eq('B issuer', accts[1].issuer, 'GitHub');
    eq('B account', accts[1].account, 'carol');
    eq('B secret', accts[1].secret, 'MY');
    eq('B algorithm', accts[1].algorithm, 'SHA1');
    eq('B digits', accts[1].digits, 6);
    eq('B counter', accts[1].counter, 42);

    // Also prove base64 transport survives the full URI path.
    const b64 = Buffer.from(bytes).toString('base64');
    const viaUri = parseMigrationUri('otpauth-migration://offline?data=' + encodeURIComponent(b64));
    eq('via-URI account count', viaUri.length, 2);
    eq('via-URI A secret', viaUri[0].secret, 'MZXW6YTBOI');
}

// ===========================================================================
console.log('\n6. buildOtpauthUri — round-trips through parseOtpauthUri');
// ===========================================================================
{
    // Round-trip the canonical migration account back out to a URI.
    const acct = parseMigrationUri('otpauth-migration://offline?data=' +
        'CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZTAC')[0];
    const uri = buildOtpauthUri(acct);
    eq('built URI', uri,
       'otpauth://totp/Example:alice%40google.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&period=30');
    const back = parseOtpauthUri(uri);
    eq('  round-trip issuer', back.issuer, 'Example');
    eq('  round-trip account', back.account, 'alice@google.com');
    eq('  round-trip secret', back.secret, 'JBSWY3DPEHPK3PXP');
    eq('  round-trip type', back.otpType, 'TOTP');

    // SHA256 / 8-digit emit explicit params; HOTP carries the counter.
    const totp8 = buildOtpauthUri({ otpType: 'TOTP', issuer: 'ACME', account: 'bob', secret: 'MZXW6YTBOI', algorithm: 'SHA256', digits: 8 });
    ck('8-digit URI carries digits=8', /[?&]digits=8\b/.test(totp8), totp8);
    ck('SHA256 URI carries algorithm', /[?&]algorithm=SHA256\b/.test(totp8), totp8);
    const hotp = buildOtpauthUri({ otpType: 'HOTP', issuer: 'GitHub', account: 'carol', secret: 'MY', counter: 42 });
    ck('HOTP URI is hotp scheme', /^otpauth:\/\/hotp\//.test(hotp), hotp);
    ck('HOTP URI carries counter=42', /[?&]counter=42\b/.test(hotp), hotp);
    eq('HOTP round-trip counter', parseOtpauthUri(hotp).counter, 42);
}

// ===========================================================================
console.log('\n7. accountKey + mergeAccounts — append/update dedupe');
// ===========================================================================
{
    const a = { issuer: 'ACME', account: 'bob', secret: 'MZXW6YTBOI' };
    const aDup = { issuer: 'ACME', account: 'bob', secret: 'MZXW6YTBOI', otpType: 'TOTP' };
    const b = { issuer: 'GitHub', account: 'carol', secret: 'MY' };
    const aNewSecret = { issuer: 'ACME', account: 'bob', secret: 'GEZDGNBV' };

    eq('identical key', accountKey(a), accountKey(aDup));
    ck('distinct secret → distinct key', accountKey(a) !== accountKey(aNewSecret));

    let m = mergeAccounts([a], [aDup, b]);
    eq('dup ignored, new appended (count)', m.accounts.length, 2);
    eq('  added', m.added, 1);

    m = mergeAccounts([a], [aNewSecret]);
    eq('rotated secret kept as new entry', m.accounts.length, 2);

    // Purity: inputs untouched.
    const orig = [a];
    mergeAccounts(orig, [b]);
    eq('mergeAccounts does not mutate input', orig.length, 1);
}

// ===========================================================================
console.log(`\n========================================`);
console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
console.log(`========================================`);
process.exit(fail === 0 ? 0 : 1);

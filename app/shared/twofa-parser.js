/**
 * SafeKeep 2FA / Authenticator Backup — Parser  (Tool 16, tfa_ family)
 * ====================================================================
 *
 * Pure, dependency-free decoder for the two QR payload shapes a TOTP/HOTP
 * authenticator emits:
 *
 *   1. Standard single-account URI
 *        otpauth://TYPE/LABEL?secret=BASE32&issuer=...&algorithm=...&digits=...
 *      Parsed with the WHATWG URL / URLSearchParams APIs.
 *
 *   2. Google Authenticator batch export
 *        otpauth-migration://offline?data=<url-encoded base64 protobuf>
 *      Decoded with a hand-rolled LEB128 varint wire reader + a fixed
 *      field-number schema walk — NO protobuf library, so boot.html stays
 *      dependency-free and lean.
 *
 * Why hand-rolled protobuf: the MigrationPayload schema is tiny and fixed,
 * and we only ever need wire type 0 (varint) and 2 (length-delimited). A
 * full protobuf runtime would add tens of KB for a single message type.
 *
 * MigrationPayload schema (Google Authenticator):
 *   message MigrationPayload {
 *     repeated OtpParameters otp_parameters = 1;
 *     int32 version      = 2;
 *     int32 batch_size   = 3;
 *     int32 batch_index  = 4;
 *     int32 batch_id     = 5;
 *   }
 *   message OtpParameters {
 *     bytes   secret    = 1;   // RAW secret bytes — re-encoded to base32 here
 *     string  name      = 2;   // account name (often "Issuer:account")
 *     string  issuer    = 3;
 *     Algorithm algorithm = 4; // 0=UNSPECIFIED 1=SHA1 2=SHA256 3=SHA512 4=MD5
 *     DigitCount digits = 5;   // 0=UNSPECIFIED 1=SIX 2=EIGHT
 *     OtpType type      = 6;   // 0=UNSPECIFIED 1=HOTP 2=TOTP
 *     int64   counter   = 7;   // HOTP only
 *   }
 *
 * The `secret` field is RAW bytes, NOT base32 — a common trap. We re-encode
 * to RFC 4648 base32 (no padding, uppercase), the canonical form users and
 * other authenticators expect.
 *
 * Exposed both as ES module exports (for node test harnesses) and on
 * window.TwoFA (for the inline scripts in boot.html), mirroring the
 * SilentPayments / QRParser convention.
 */

// ---------------------------------------------------------------------------
// Enum maps
// ---------------------------------------------------------------------------
var ALGO_MAP   = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
var DIGITS_MAP = { 0: 6, 1: 6, 2: 8 };          // SIX=1, EIGHT=2 (0 unspecified → 6)
var TYPE_MAP   = { 0: 'UNKNOWN', 1: 'HOTP', 2: 'TOTP' };

var B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ---------------------------------------------------------------------------
// base32 encoder — RFC 4648, uppercase, NO padding.
// ---------------------------------------------------------------------------
// `value` is kept bounded to the residual `bits` after every drain, so the
// 32-bit `<<` never overflows regardless of input length.
export function base32Encode(bytes) {
    var value = 0, bits = 0, out = '';
    for (var i = 0; i < bytes.length; i++) {
        value = (value << 8) | (bytes[i] & 0xff);
        bits += 8;
        while (bits >= 5) {
            out += B32_ALPHABET[(value >> (bits - 5)) & 31];
            bits -= 5;
        }
        value &= (1 << bits) - 1; // discard the bits we just emitted
    }
    if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

// ---------------------------------------------------------------------------
// base64 → Uint8Array. Tolerates URL-safe alphabet and missing padding.
// ---------------------------------------------------------------------------
export function base64ToBytes(b64) {
    var s = String(b64).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    while (s.length % 4) s += '=';
    var bin;
    if (typeof atob === 'function') {
        bin = atob(s);
    } else if (typeof Buffer !== 'undefined') {
        bin = Buffer.from(s, 'base64').toString('binary');
    } else {
        throw new Error('No base64 decoder available in this environment');
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// ---------------------------------------------------------------------------
// LEB128 varint reader. Returns [value, nextPos].
// ---------------------------------------------------------------------------
// Uses multiplication (not <<) so values up to 2^53 stay exact — protobuf
// int64 counters never realistically exceed that. Throws on truncation
// rather than silently reading past the buffer.
export function readVarint(buf, pos) {
    var result = 0, shift = 0, p = pos, b;
    do {
        if (p >= buf.length) throw new Error('Truncated varint at offset ' + pos);
        b = buf[p++];
        result += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
    } while (b & 0x80);
    return [result, p];
}

// ---------------------------------------------------------------------------
// Generic protobuf field walker for [start, end). Returns an array of
// { field, wire, value } where value is a Number (wire 0) or a Uint8Array
// subview (wire 2). Wire types 1/5 (fixed64/32) are skipped over — the
// MigrationPayload schema never uses them.
// ---------------------------------------------------------------------------
export function readFields(buf, start, end) {
    var fields = [];
    var pos = start;
    while (pos < end) {
        var tag, len;
        var r = readVarint(buf, pos); tag = r[0]; pos = r[1];
        var field = Math.floor(tag / 8);
        var wire = tag & 0x07;
        if (wire === 0) {                 // varint
            var v = readVarint(buf, pos); pos = v[1];
            fields.push({ field: field, wire: wire, value: v[0] });
        } else if (wire === 2) {          // length-delimited
            var l = readVarint(buf, pos); len = l[0]; pos = l[1];
            if (pos + len > end) throw new Error('Length-delimited field overruns buffer');
            fields.push({ field: field, wire: wire, value: buf.subarray(pos, pos + len) });
            pos += len;
        } else if (wire === 5) {          // fixed32 — skip
            pos += 4;
        } else if (wire === 1) {          // fixed64 — skip
            pos += 8;
        } else {
            throw new Error('Unsupported protobuf wire type ' + wire + ' at offset ' + pos);
        }
    }
    return fields;
}

function bytesToUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    // Fallback (boot.html always has TextDecoder; this is belt-and-braces).
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
}

// ---------------------------------------------------------------------------
// Split a "Issuer:account" label. If an explicit issuer is already known,
// strip a matching "issuer:" prefix from the account; otherwise adopt the
// prefix as the issuer.
// ---------------------------------------------------------------------------
function splitLabel(label, explicitIssuer) {
    var name = (label || '').trim();
    var issuer = (explicitIssuer || '').trim();
    var idx = name.indexOf(':');
    if (idx !== -1) {
        var prefix = name.slice(0, idx).trim();
        var rest = name.slice(idx + 1).trim();
        if (!issuer) issuer = prefix;
        name = rest;
    }
    return { issuer: issuer, account: name };
}

function normalizeSecret(s) {
    return String(s || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Decode one OtpParameters sub-message → canonical account object.
// ---------------------------------------------------------------------------
export function parseOtpParameters(buf) {
    var secretBytes = null, name = '', issuer = '';
    var algoEnum = 0, digitsEnum = 0, typeEnum = 0, counter = 0;
    var fields = readFields(buf, 0, buf.length);
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        switch (f.field) {
            case 1: secretBytes = f.value; break;
            case 2: name = bytesToUtf8(f.value); break;
            case 3: issuer = bytesToUtf8(f.value); break;
            case 4: algoEnum = f.value; break;
            case 5: digitsEnum = f.value; break;
            case 6: typeEnum = f.value; break;
            case 7: counter = f.value; break;
            default: break;
        }
    }
    var parts = splitLabel(name, issuer);
    return {
        otpType: TYPE_MAP[typeEnum] || 'UNKNOWN',
        issuer: parts.issuer,
        account: parts.account,
        secret: secretBytes ? base32Encode(secretBytes) : '',
        digits: DIGITS_MAP[digitsEnum] || 6,
        algorithm: ALGO_MAP[algoEnum] || 'SHA1',
        counter: (typeEnum === 1) ? counter : null,
        source: 'migration'
    };
}

// ---------------------------------------------------------------------------
// Decode a full MigrationPayload byte buffer → array of account objects.
// ---------------------------------------------------------------------------
export function decodeMigrationPayload(bytes) {
    var accounts = [];
    var fields = readFields(bytes, 0, bytes.length);
    for (var i = 0; i < fields.length; i++) {
        if (fields[i].field === 1 && fields[i].wire === 2) {
            accounts.push(parseOtpParameters(fields[i].value));
        }
        // fields 2..5 (version / batch_*) are not needed for backup.
    }
    return accounts;
}

// ---------------------------------------------------------------------------
// otpauth-migration://offline?data=... → array of account objects.
// ---------------------------------------------------------------------------
export function parseMigrationUri(uri) {
    var m = String(uri).match(/[?&]data=([^&]*)/);
    if (!m) throw new Error('migration URI has no data= parameter');
    var b64 = decodeURIComponent(m[1]);
    var bytes = base64ToBytes(b64);
    return decodeMigrationPayload(bytes);
}

// ---------------------------------------------------------------------------
// otpauth://totp/Label?secret=...&issuer=... → single account object.
// ---------------------------------------------------------------------------
export function parseOtpauthUri(uri) {
    var u = new URL(uri);                       // scheme 'otpauth:'
    var type = (u.host || u.hostname || '').toLowerCase(); // 'totp' | 'hotp'
    var label = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    var p = u.searchParams;
    var parts = splitLabel(label, p.get('issuer') || '');
    var digits = parseInt(p.get('digits') || '6', 10);
    var counterRaw = p.get('counter');
    return {
        otpType: (type === 'hotp') ? 'HOTP' : (type === 'totp') ? 'TOTP' : 'UNKNOWN',
        issuer: parts.issuer,
        account: parts.account,
        secret: normalizeSecret(p.get('secret')),
        digits: Number.isFinite(digits) ? digits : 6,
        algorithm: (p.get('algorithm') || 'SHA1').toUpperCase(),
        counter: counterRaw != null ? parseInt(counterRaw, 10) : null,
        source: 'otpauth'
    };
}

// ---------------------------------------------------------------------------
// Build a standard otpauth:// URI from a canonical account object — the
// restoration side of the loop (re-import onto a new device by QR).
// Issuer and account are encoded as separate path segments joined by a
// literal ':' (the conventional Key URI label separator), so the URI round-
// trips cleanly through parseOtpauthUri.
// ---------------------------------------------------------------------------
export function buildOtpauthUri(a) {
    var type = (a.otpType === 'HOTP') ? 'hotp' : 'totp';
    var issuer = a.issuer || '';
    var account = a.account || '';
    var label = issuer
        ? (encodeURIComponent(issuer) + ':' + encodeURIComponent(account))
        : encodeURIComponent(account);
    var params = ['secret=' + encodeURIComponent(a.secret || '')];
    if (issuer) params.push('issuer=' + encodeURIComponent(issuer));
    if (a.algorithm && a.algorithm !== 'SHA1') params.push('algorithm=' + encodeURIComponent(a.algorithm));
    if (a.digits && a.digits !== 6) params.push('digits=' + a.digits);
    if (type === 'hotp' && a.counter != null) params.push('counter=' + a.counter);
    if (type === 'totp') params.push('period=30');
    return 'otpauth://' + type + '/' + label + '?' + params.join('&');
}

// ---------------------------------------------------------------------------
// Stable identity key for an account — used to dedupe across overlapping
// scans and to merge a scan batch into the persisted vault set. Keyed on
// issuer + account + secret so a genuinely distinct secret is never
// silently dropped, while re-scanning the same QR is a no-op.
// ---------------------------------------------------------------------------
export function accountKey(a) {
    return [(a.issuer || ''), (a.account || ''), (a.secret || '')].join('\u0000');
}

// ---------------------------------------------------------------------------
// Merge `incoming` accounts into `existing`, skipping identity duplicates.
// Returns { accounts, added }. Pure — does not mutate the inputs.
// ---------------------------------------------------------------------------
export function mergeAccounts(existing, incoming) {
    var out = (existing || []).slice();
    var seen = Object.create(null);
    for (var i = 0; i < out.length; i++) seen[accountKey(out[i])] = true;
    var added = 0;
    var inc = incoming || [];
    for (var j = 0; j < inc.length; j++) {
        var k = accountKey(inc[j]);
        if (seen[k]) continue;
        seen[k] = true;
        out.push(inc[j]);
        added++;
    }
    return { accounts: out, added: added };
}

// ---------------------------------------------------------------------------
// Cheap prefix classifier — no decoding.
// ---------------------------------------------------------------------------
export function classify(raw) {
    if (/^otpauth-migration:\/\//i.test(raw)) return 'migration';
    if (/^otpauth:\/\//i.test(raw)) return 'otpauth';
    return 'unknown';
}

// ---------------------------------------------------------------------------
// Unified entry point used by tfa_onScan. Returns:
//   { kind: 'migration'|'otpauth'|'unknown', accounts: [...] }
// Never throws on classification; decoding errors are surfaced via `.error`.
// ---------------------------------------------------------------------------
export function parseQrPayload(raw) {
    var kind = classify(raw);
    try {
        if (kind === 'migration') return { kind: kind, accounts: parseMigrationUri(raw) };
        if (kind === 'otpauth')   return { kind: kind, accounts: [parseOtpauthUri(raw)] };
        return { kind: 'unknown', accounts: [] };
    } catch (err) {
        return { kind: kind, accounts: [], error: (err && err.message) ? err.message : String(err) };
    }
}

// Expose globally for boot.html inline scripts (same pattern as
// window.QRParser, window.SilentPayments, etc.).
if (typeof window !== 'undefined') {
    window.TwoFA = {
        base32Encode: base32Encode,
        base64ToBytes: base64ToBytes,
        readVarint: readVarint,
        readFields: readFields,
        parseOtpParameters: parseOtpParameters,
        decodeMigrationPayload: decodeMigrationPayload,
        parseMigrationUri: parseMigrationUri,
        parseOtpauthUri: parseOtpauthUri,
        buildOtpauthUri: buildOtpauthUri,
        accountKey: accountKey,
        mergeAccounts: mergeAccounts,
        classify: classify,
        parseQrPayload: parseQrPayload
    };
}

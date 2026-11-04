/**
 * coldcard-backup.js — read a COLDCARD backup file (Backup System → backup.7z)
 *
 * A COLDCARD backup is a 7z archive the device writes itself (firmware
 * shared/compat7z.py): one text file, stored without compression and
 * encrypted with 7z's AES-256 + SHA-256 method. The password is the 12
 * BIP-39 words the COLDCARD shows (joined with single spaces, lowercase),
 * or on a COLDCARD Q a typed password of 32+ characters. The 7z header is
 * not encrypted, so the inner file name, its size and the CRC-32 of the
 * plaintext can be read first; the CRC tells a wrong password from a good
 * one.
 *
 * The text inside (firmware shared/backups.py) is "key = <JSON value>"
 * lines, starting with "# Coldcard backup file! DO NOT CHANGE." and ending
 * with "# EOF":
 *   mnemonic       the recovery words (absent if a BIP-39 passphrase was in
 *                  effect: then only the passphrase wallet's xprv is there)
 *   xprv, xpub     the master keys of the wallet backed up
 *   raw_secret     the encoded secret (hex); everything else duplicates it
 *   chain          "BTC" or "XTN" (testnet)
 *   fw_version...  informational
 *   setting.multisig  multisig wallets: [name, [M, N], keys, opts, (0)]
 *   setting.notes / setting.seeds  Secure Notes, Seed Vault (read in Part 2)
 *
 * Everything here runs in memory; nothing is written. Used by the welcome
 * screen's "COLDCARD backup" restore (boot.html, ccb_*).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { mnemonicToSeedSync, validateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist as ENGLISH } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';

const b58c = createBase58check(sha256);
const SIG = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];   // "7z\xBC\xAF'\x1C"
const MAX_TEXT = 128 * 1024;                          // COLDCARD's own limit
export const MAX_FILE = 256 * 1024;

// ---- small helpers ----
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

let CRC_TABLE = null;
export function crc32(u8) {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64le = (b, o) => u32le(b, o) + u32le(b, o + 4) * 2 ** 32;

// 7z's variable-length number (compat7z.py read_var64).
function readVar(buf, pos) {
    const first = buf[pos];
    if (first === undefined) throw new Error('truncated');
    if (first < 0x80) return [first, pos + 1];
    let mask = 0x80, n = 0;
    while (n < 8 && (first & mask)) { n++; mask >>= 1; }
    let value = 0;
    for (let i = 0; i < n; i++) value += buf[pos + 1 + i] * 2 ** (8 * i);
    if (n < 8) value += (first & (mask - 1)) * 2 ** (8 * n);
    return [value, pos + 1 + n];
}

function find(buf, pattern, from = 0) {
    outer: for (let i = from; i <= buf.length - pattern.length; i++) {
        for (let j = 0; j < pattern.length; j++) if (buf[i + j] !== pattern[j]) continue outer;
        return i;
    }
    return -1;
}

const H = (s) => Uint8Array.from(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));

/** True if the bytes start like a 7z archive. */
export function is7z(bytes) {
    return bytes && bytes.length > 32 && SIG.every((v, i) => bytes[i] === v);
}

/**
 * Read the unencrypted parts of a COLDCARD 7z: the inner file name, sizes,
 * key-stretching rounds, salt, IV, CRC-32 of the plaintext, and the
 * encrypted body. Mirrors compat7z.py (FileHeader, SectionHeader,
 * parse_section_hdr) and refuses anything else.
 */
export function parseColdcard7z(bytes) {
    if (!is7z(bytes)) throw new Error('This isn’t a 7z file.');
    if (bytes[6] !== 0 || bytes[7] < 3) throw new Error('This 7z version isn’t supported.');
    const startCrc = u32le(bytes, 8);
    if (crc32(bytes.subarray(12, 32)) !== startCrc) throw new Error('The file is damaged (its start header doesn’t check out).');
    const nextOffset = u64le(bytes, 12), nextSize = u64le(bytes, 20), nextCrc = u32le(bytes, 28);
    if (32 + nextOffset + nextSize !== bytes.length) throw new Error('The file is damaged or incomplete (its size doesn’t match).');
    const hdr = bytes.subarray(32 + nextOffset, 32 + nextOffset + nextSize);
    if (crc32(hdr) !== nextCrc) throw new Error('The file is damaged (its header doesn’t check out).');
    if (hdr[0] === 0x17) throw new Error('This 7z file wasn’t made by a COLDCARD (its file list is encrypted or compressed).');

    const fail = () => { throw new Error('This 7z file wasn’t made by a COLDCARD backup.'); };
    // kHeader, kMainStreamsInfo, kPackInfo, pack pos 0, 1 stream, kSize
    let p = find(hdr, H('01 04 06 00 01 09')); if (p < 0) fail();
    let bodySize; [bodySize, p] = readVar(hdr, p + 6);
    // kUnPackInfo, kFolder, 1 folder, not external, 1 coder, 4-byte id + props, AES-256+SHA-256
    p = find(hdr, H('07 0b 01 00 01 24 06 f1 07 01'), p); if (p < 0) fail();
    let propsLen; [propsLen, p] = readVar(hdr, p + 10);
    const propsStart = p;
    const first = hdr[p], second = hdr[p + 1]; p += 2;
    const roundsPow = first & 0x3f;
    if (roundsPow > 24) throw new Error('This file asks for too much key stretching to be a COLDCARD backup.');
    if ((first & 0xc0) !== 0xc0) fail();
    const saltLen = ((second >> 4) & 0xf) + 1, ivLen = (second & 0xf) + 1;
    if (saltLen !== 16 || ivLen !== 16) fail();
    const salt = hdr.slice(p, p + saltLen); p += saltLen;
    const iv = hdr.slice(p, p + ivLen); p += ivLen;
    if (p - propsStart !== propsLen) fail();
    // InIndex 1, OutIndex 0, kCodersUnPackSize
    p = find(hdr, H('01 00 0c'), p); if (p < 0) fail();
    let unpackedSize; [unpackedSize, p] = readVar(hdr, p + 3);
    if (hdr[p] !== 0) fail();
    // kSubStreamsInfo, kCRC, all defined
    p = find(hdr, H('08 0a 01'), p); if (p < 0) fail();
    const plainCrc = u32le(hdr, p + 3);
    // kFilesInfo, 1 file, kName
    p = find(hdr, H('05 01 11'), p + 8); if (p < 0) fail();
    let nameLen; [nameLen, p] = readVar(hdr, p + 3);
    if (hdr[p] !== 0) fail();
    const nameBytes = hdr.subarray(p + 1, p + nameLen);
    let name = '';
    for (let i = 0; i + 1 < nameBytes.length; i += 2) name += String.fromCharCode(nameBytes[i] | (nameBytes[i + 1] << 8));
    name = name.replace(/\u0000+$/, '');

    if (bodySize !== nextOffset || bodySize % 16 || bodySize < unpackedSize || bodySize > unpackedSize + 16) fail();
    if (unpackedSize > MAX_TEXT) throw new Error('The backup inside is too large to be a COLDCARD backup.');
    return { name, roundsPow, salt, iv, unpackedSize, plainCrc, body: bytes.subarray(32, 32 + bodySize) };
}

/**
 * 7z's AES key: SHA-256 over 2^roundsPow repetitions of
 * salt || password || counter(8 bytes, little-endian). The password is
 * encoded as COLDCARD does (encode_utf_16_le: each UTF-8 byte followed by a
 * zero byte), which is plain UTF-16LE for the ASCII words and passwords it
 * makes.
 */
export function deriveKey(password, salt, roundsPow) {
    const utf8 = new TextEncoder().encode(password);
    const pw = new Uint8Array(utf8.length * 2);
    utf8.forEach((b, i) => { pw[i * 2] = b; });
    const block = new Uint8Array(salt.length + pw.length + 8);
    block.set(salt, 0); block.set(pw, salt.length);
    const cnt = salt.length + pw.length;
    const h = sha256.create();
    const rounds = 2 ** roundsPow;
    for (let i = 0; i < rounds; i++) {
        let v = i;
        for (let k = 0; k < 8; k++) { block[cnt + k] = v & 0xff; v = Math.floor(v / 256); }
        h.update(block);
    }
    pw.fill(0); block.fill(0); utf8.fill(0);
    return h.digest();
}

/**
 * AES-256-CBC decryption of zero-padded data with WebCrypto, which only
 * accepts PKCS#7 padding: append one block that decrypts to a full block of
 * padding (E(K, 0x10… XOR last block)), then let WebCrypto strip it.
 */
async function aesCbcDecryptRaw(key, iv, body) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw new Error('This browser can’t decrypt the backup (no WebCrypto).');
    const k = await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
    const last = body.slice(body.length - 16);
    const pad = new Uint8Array(16).fill(16);
    const extra = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: last }, k, pad)).slice(0, 16);
    const ct = new Uint8Array(body.length + 16);
    ct.set(body, 0); ct.set(extra, body.length);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, k, ct));
}

/**
 * Open a COLDCARD backup: bytes of backup.7z (or a clear-text backup.txt)
 * and the password. Returns { name, text }. A wrong password shows as a
 * CRC mismatch.
 */
export async function openColdcardBackup(bytes, password) {
    if (!bytes || !bytes.length) throw new Error('The file is empty.');
    if (bytes.length > MAX_FILE) throw new Error('The file is too large to be a COLDCARD backup.');
    if (!is7z(bytes)) {
        // COLDCARD can also write the backup unencrypted (backup.txt).
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        if (!/^# Coldcard backup file/.test(text)) throw new Error('This isn’t a COLDCARD backup file (backup.7z).');
        return { name: 'backup.txt', text, encrypted: false };
    }
    const info = parseColdcard7z(bytes);
    // Used exactly as given: the 12 words arrive lowercase with single
    // spaces from the word boxes; a COLDCARD Q password is case-sensitive.
    const pw = String(password || '');
    if (!pw.trim()) throw new Error('Enter the backup password first.');
    const key = deriveKey(pw, info.salt, info.roundsPow);
    let plain;
    try {
        plain = await aesCbcDecryptRaw(key, info.iv, info.body);
    } finally {
        key.fill(0);
    }
    const out = plain.slice(0, info.unpackedSize);
    plain.fill(0);
    if (crc32(out) !== info.plainCrc) {
        out.fill(0);
        throw new Error('Wrong password, or the file is damaged.');
    }
    const text = new TextDecoder('utf-8').decode(out);
    out.fill(0);
    if (!text.startsWith('#')) throw new Error('The file opened, but what’s inside isn’t a COLDCARD backup.');
    return { name: info.name, text, encrypted: true };
}

/** The "key = <JSON>" lines of a backup as an object (comments skipped). */
export function parseBackupText(text) {
    const out = {};
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const at = line.indexOf(' = ');
        if (at < 1) continue;
        const key = line.slice(0, at).trim();
        try { out[key] = JSON.parse(line.slice(at + 3)); } catch (_) { out[key] = line.slice(at + 3); }
    }
    return out;
}

// ---- multisig wallets ----
const AF = { 8: 'p2sh', 14: 'p2wsh', 26: 'p2sh-p2wsh' };   // ckcc-protocol AF_P2SH / AF_P2WSH / AF_P2WSH_P2SH

/** COLDCARD's fingerprint integer (stored little-endian) as 8 hex digits, uppercase. */
export function xfpToHex(n) {
    const v = Number(n) >>> 0;
    return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// xpub / tpub version bytes; SLIP-132 forms (Ypub, Zpub, …) are converted.
const XPUB = 0x0488b21e, TPUB = 0x043587cf;
const MAIN_PUB = new Set([0x0488b21e, 0x049d7cb2, 0x04b24746, 0x0295b43f, 0x02aa7ed3]);
const TEST_PUB = new Set([0x043587cf, 0x044a5262, 0x045f1cf6, 0x024289ef, 0x02575483]);
export function toStandardXpub(key) {
    const raw = b58c.decode(String(key).trim());
    if (raw.length !== 78) throw new Error('not an extended public key');
    const ver = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
    const want = MAIN_PUB.has(ver) ? XPUB : TEST_PUB.has(ver) ? TPUB : null;
    if (want === null) throw new Error('not an extended public key');
    const out = raw.slice();
    out[0] = want >>> 24; out[1] = (want >>> 16) & 255; out[2] = (want >>> 8) & 255; out[3] = want & 255;
    return { xpub: b58c.encode(out), testnet: want === TPUB };
}

/**
 * One entry of setting.multisig (MultisigWallet.serialize in firmware
 * shared/multisig.py) as a descriptor:
 *   [name, [M, N], keys, opts]  or  [name, [M, N], keys, opts, 0]
 *   keys: [[xfp, xpub], …] with opts.pp the shared path, or
 *         [[xfp, i, xpub], …] with opts.d the list of paths
 *   opts.ft: address format (default P2SH), opts.ch: chain (default BTC)
 *   a 5th element 0: keys in the given order (multi), else sortedmulti
 */
export function multisigToDescriptor(rec) {
    if (!Array.isArray(rec) || rec.length < 4) throw new Error('unreadable multisig record');
    const [name, mn, keys, opts = {}] = rec;
    const bip67 = rec.length === 5 ? !!rec[4] : true;
    const [M, N] = mn || [];
    if (!(M >= 1 && N >= M && N <= 15) || !Array.isArray(keys) || keys.length !== N) throw new Error('unreadable M-of-N');
    const fmt = AF[opts.ft == null ? 8 : opts.ft];
    if (!fmt) throw new Error('address type ' + opts.ft + ' isn’t supported');
    const legs = keys.map((k) => {
        let xfp, path, xpub;
        if (k.length === 2) { [xfp, xpub] = k; path = opts.pp || 'm'; }
        else if (k.length === 3) { [xfp, , xpub] = k; path = (opts.d || [])[k[1]]; if (path == null) throw new Error('missing key path'); }
        else throw new Error('unreadable key');
        const std = toStandardXpub(xpub);
        const p = String(path).replace(/h/g, "'").replace(/^m\/?/, '');
        return { fingerprint: xfpToHex(xfp), path: p ? 'm/' + p : 'm', xpub: std.xpub, testnet: std.testnet,
                 key: '[' + xfpToHex(xfp).toLowerCase() + (p ? '/' + p : '') + ']' + std.xpub + '/<0;1>/*' };
    });
    const inner = (bip67 ? 'sortedmulti(' : 'multi(') + M + ',' + legs.map((l) => l.key).join(',') + ')';
    const descriptor = fmt === 'p2wsh' ? 'wsh(' + inner + ')' : fmt === 'p2sh' ? 'sh(' + inner + ')' : 'sh(wsh(' + inner + '))';
    return { name: String(name || 'COLDCARD multisig'), M, N, format: fmt, sorted: bip67,
             chain: opts.ch || 'BTC', testnet: legs.some((l) => l.testnet), keys: legs, descriptor };
}

/** Fingerprint (8 hex, uppercase) of a mnemonic with no passphrase. */
export function mnemonicFingerprint(mnemonic) {
    const seed = mnemonicToSeedSync(mnemonic);
    const fp = HDKey.fromMasterSeed(seed).fingerprint;
    seed.fill(0);
    return fp.toString(16).padStart(8, '0').toUpperCase();
}

/**
 * What a decrypted backup holds, checked:
 *   { mnemonic, words, fingerprint, chain, firmware, passphraseWallet,
 *     multisig: [{ …multisigToDescriptor, mine }], problems: [...],
 *     notes, seedVault, notesForUser: [...], problems: [...] }
 * `problems` are reasons not to trust the seed (parts that disagree);
 * `notesForUser` are things to tell the user that don't stop an import.
 */
export function summarizeBackup(fields) {
    const problems = [];
    const r = {
        mnemonic: '', words: 0, fingerprint: '', chain: fields.chain || fields['setting.chain'] || 'BTC',
        firmware: [fields.fw_version, fields.fw_date].filter(Boolean).join(' · '),
        passphraseWallet: false, multisig: [], multisigErrors: [], problems, notesForUser: [],
        notes: Array.isArray(fields['setting.notes']) ? fields['setting.notes'].length : 0,
        seedVault: Array.isArray(fields['setting.seeds']) ? fields['setting.seeds'].length : 0,
    };
    if (typeof fields.mnemonic === 'string') {
        const m = fields.mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
        if (!validateMnemonic(m, ENGLISH)) problems.push('The recovery words in the file aren’t a valid BIP-39 phrase.');
        else {
            r.mnemonic = m;
            r.words = m.split(' ').length;
            r.fingerprint = mnemonicFingerprint(m);
            // raw_secret: a marker byte, then the seed words' entropy
            // (trailing '0' characters removed when written).
            if (typeof fields.raw_secret === 'string') {
                const ent = hex(mnemonicToEntropy(m, ENGLISH));
                const rest = fields.raw_secret.slice(2);
                if (!(ent.startsWith(rest) && /^0*$/.test(ent.slice(rest.length)))) problems.push('The recovery words don’t match the rest of the file.');
            }
            // xprv: the master key of the words with no passphrase.
            if (typeof fields.xprv === 'string' && /^[xt]prv/.test(fields.xprv)) {
                try {
                    const seed = mnemonicToSeedSync(m);
                    const fromWords = HDKey.fromMasterSeed(seed, fields.xprv.startsWith('t') ? { private: 0x04358394, public: 0x043587cf } : undefined).privateExtendedKey;
                    seed.fill(0);
                    // Not a reason to refuse: raw_secret above is the
                    // authoritative copy, and a key that differs is most
                    // likely a passphrase wallet's (the words stay valid).
                    if (fromWords !== fields.xprv) r.notesForUser.push('The master key in the file isn’t the one these words make without a passphrase. If you used a BIP-39 passphrase on the COLDCARD, add it in SafeKeep afterwards.');
                } catch (_) { r.notesForUser.push('The master key in the file couldn’t be read; the recovery words were checked instead.'); }
            }
            // Old firmware wrote setting.xfp (current firmware leaves it
            // out); 2018 files hold it byte-reversed, so accept either order.
            if (fields['setting.xfp'] != null) {
                const a = xfpToHex(fields['setting.xfp']);
                const b = a.match(/../g).reverse().join('');
                if (a !== r.fingerprint && b !== r.fingerprint) problems.push('The recovery words don’t match the fingerprint the COLDCARD recorded.');
            }
        }
    } else if (fields.xprv || fields.bip32_master_key) {
        // A BIP-39 passphrase was in effect: COLDCARD backs up that wallet's
        // master key only, never the words or the passphrase.
        r.passphraseWallet = true;
    } else {
        problems.push('The file has no recovery words or master key.');
    }
    const ms = Array.isArray(fields['setting.multisig']) ? fields['setting.multisig'] : [];
    ms.forEach((rec, i) => {
        try {
            const w = multisigToDescriptor(rec);
            w.mine = r.fingerprint ? w.keys.findIndex((k) => k.fingerprint === r.fingerprint) : -1;
            r.multisig.push(w);
        } catch (e) {
            r.multisigErrors.push('Multisig wallet ' + (i + 1) + (rec && rec[0] ? ' (“' + rec[0] + '”)' : '') + ': ' + e.message);
        }
    });
    return r;
}

if (typeof window !== 'undefined') {
    window.ColdcardBackup = Object.freeze({
        openColdcardBackup, parseColdcard7z, is7z, parseBackupText, summarizeBackup, multisigToDescriptor, xfpToHex, MAX_FILE,
    });
}

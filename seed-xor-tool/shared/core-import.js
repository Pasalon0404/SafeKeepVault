/**
 * core-import.js — Bitcoin Core `importdescriptors` export (watch-only)
 *
 * Turns the Descriptor tool's output (single-sig or multisig, written with the
 * BIP-389 multipath step `/<0;1>/*`) into the JSON array Bitcoin Core's
 * `importdescriptors` RPC loads into a blank, private-key-free wallet.
 *
 * The multipath step is split into two descriptors, receive (`/0/*`,
 * internal: false) and change (`/1/*`, internal: true), each with its own
 * BIP-380 checksum. Every descriptor-wallet release of Core (0.21+) imports
 * that form; only recent releases accept `<0;1>` directly.
 *
 * Pure transformation: no keys are derived and nothing is read or written.
 * Private extended keys and descriptors Core cannot import (Silent Payments
 * `sp(...)`) are refused.
 *
 * Inspired by EntropyLab's watch-only export (src/js/core-importdescriptors.js).
 */

export const CORE_RANGE_END = 999; // 1,000 addresses per chain (Core's default keypool size)

// BIP-380 descriptor checksum (same algorithm as Bitcoin Core's descriptor.cpp).
const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function polymod(c, val) {
    const c0 = c >> 35n;
    c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATOR[i];
    return c;
}

export function descriptorChecksum(body) {
    let c = 1n, cls = 0, clscount = 0;
    for (const ch of body) {
        const pos = INPUT_CHARSET.indexOf(ch);
        if (pos === -1) throw new Error(`Invalid descriptor character: ${JSON.stringify(ch)}`);
        c = polymod(c, pos & 31);
        cls = cls * 3 + (pos >> 5);
        if (++clscount === 3) { c = polymod(c, cls); cls = 0; clscount = 0; }
    }
    if (clscount > 0) c = polymod(c, cls);
    for (let j = 0; j < 8; j++) c = polymod(c, 0);
    c ^= 1n;
    let out = '';
    for (let j = 0; j < 8; j++) out += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - j))) & 31n)];
    return out;
}

const PRIVATE_KEY = /\b[xtyzuvYZUV]prv[1-9A-HJ-NP-Za-km-z]{20,}/;

/**
 * Build the `importdescriptors` request array.
 *   descriptor  the tool's output, with or without `#checksum`
 *   timestamp   0 (rescan from genesis; safe default) or 'now' (new wallet)
 * Returns an array of request objects (JSON.stringify it for the file).
 */
export function buildCoreImport(descriptor, { timestamp = 0 } = {}) {
    const text = String(descriptor ?? '').trim();
    if (!text) throw new Error('No descriptor to export.');
    if (PRIVATE_KEY.test(text)) throw new Error('Descriptor contains a private key. Watch-only export refused.');

    const hash = text.lastIndexOf('#');
    const body = hash >= 0 ? text.slice(0, hash) : text;
    if (hash >= 0 && text.slice(hash + 1) !== descriptorChecksum(body)) {
        throw new Error('Descriptor checksum does not match.');
    }
    if (/^sp\(/.test(body)) {
        throw new Error('Bitcoin Core cannot import Silent Payments descriptors. Use a Silent Payments wallet instead.');
    }
    if (timestamp !== 0 && timestamp !== 'now') throw new Error('timestamp must be 0 or "now".');

    const steps = body.match(/<[^>]*>/g) || [];
    if (steps.some((s) => s !== '<0;1>')) {
        throw new Error('Only the receive/change multipath step <0;1> is supported.');
    }

    const ranged = body.includes('*');
    const entry = (b, internal) => {
        const e = { desc: `${b}#${descriptorChecksum(b)}`, timestamp };
        if (ranged) { e.active = true; e.internal = internal; e.range = [0, CORE_RANGE_END]; }
        return e;
    };

    if (steps.length) {
        return [entry(body.split('<0;1>').join('0'), false), entry(body.split('<0;1>').join('1'), true)];
    }
    // Already split: infer the chain from the final step before the wildcard.
    const change = /\/1\/\*\)*$/.test(body);
    return [entry(body, change)];
}

/** The shell commands that create a watch-only wallet and import the file. */
export function coreImportInstructions(filename, walletName = 'safekeep-watch') {
    return [
        `bitcoin-cli -named createwallet wallet_name=${walletName} disable_private_keys=true blank=true`,
        `bitcoin-cli -rpcwallet=${walletName} importdescriptors "$(cat ${filename})"`,
    ];
}

if (typeof window !== 'undefined') {
    window.CoreImport = { buildCoreImport, coreImportInstructions, descriptorChecksum, CORE_RANGE_END };
}

/**
 * SafeKeep — Implicit Entropy Hardening for the 1-click seed path
 * ===============================================================
 *
 * The standard "Create Seed" flow generates entropy from the browser CSPRNG
 * (window.crypto.getRandomValues), which is already cryptographically secure.
 * This wrapper adds a defense-in-depth salt WITHOUT weakening that base:
 *
 *     output = SHA-256( base32 || backgroundNoiseSalt )   truncated to byteLen
 *
 * where base32 is a full 32-byte CSPRNG draw that is ALWAYS part of the hash
 * preimage. Because a secure 256-bit value is always mixed in, the output is
 * at least as unpredictable as the CSPRNG alone — adding more bytes to a
 * SHA-256 preimage can never reduce the entropy contributed by the bytes
 * already there. The salt therefore can only help, never hurt.
 *
 * IMPORTANT — honest threat model: the salt sources (sub-millisecond timing,
 * last pointer position, viewport/screen dimensions) are LOW entropy and
 * partially observable. They are NOT a security substitute for the CSPRNG and
 * must not be counted as meaningful bits. Their only value is hedging against
 * a hypothetically biased/backdoored CSPRNG (the paranoid air-gapped threat
 * model) — exactly the rationale hardware wallets use when they XOR dice rolls
 * into a TRNG. The CSPRNG remains the security foundation.
 *
 * Truncating a SHA-256 digest to 16/24/32 bytes is sound: any fixed-length
 * prefix of a (pseudo)random-oracle output is itself uniformly distributed,
 * so the result plugs directly into BIP-39 entropyToMnemonic (which appends
 * the checksum and splits into 11-bit word indices).
 *
 * Exposed as an ES module export (for boot.js + node tests) and on
 * window.generateHardenedEntropy (for the inline amnesia/ephemeral paths in
 * boot.html), mirroring the SilentPayments / QRParser / TwoFA convention.
 */

/**
 * Generate hardened BIP-39 entropy.
 *
 * @param {number} byteLen  16 (12 words), 24 (18 words), or 32 (24 words).
 * @param {object} [opts]   Test/override hooks — all optional:
 *   - baseBytes {Uint8Array} : substitute the 32-byte CSPRNG base (testing).
 *   - salt      {string}     : substitute the background-noise salt (testing).
 * @returns {Promise<Uint8Array>} entropy of exactly `byteLen` bytes.
 */
export async function generateHardenedEntropy(byteLen, opts) {
    opts = opts || {};
    if (byteLen !== 16 && byteLen !== 24 && byteLen !== 32) {
        throw new Error('generateHardenedEntropy: byteLen must be 16, 24, or 32 (got ' + byteLen + ')');
    }

    // 1. Hardware base — a FULL 32-byte secure CSPRNG draw, always present in
    //    the preimage so the output is never weaker than the CSPRNG itself.
    var ownBase = !opts.baseBytes;
    var base = opts.baseBytes || new Uint8Array(32);
    if (ownBase) crypto.getRandomValues(base);

    // 2. Background-noise salt (timing jitter + interaction + viewport).
    var salt = (opts.salt != null) ? String(opts.salt) : _collectSalt();
    var saltBytes = new TextEncoder().encode(salt);

    // 3. Mix: SHA-256(base || salt).
    var preimage = new Uint8Array(base.length + saltBytes.length);
    preimage.set(base, 0);
    preimage.set(saltBytes, base.length);
    var digestBuf = await crypto.subtle.digest('SHA-256', preimage);
    var digest = new Uint8Array(digestBuf);

    // 4. Truncate to the requested entropy length.
    var out = digest.slice(0, byteLen);

    // Best-effort zeroization of transient buffers (not the digest tail).
    try { preimage.fill(0); } catch (_) {}
    try { if (ownBase) base.fill(0); } catch (_) {}
    try { digest.fill(0); } catch (_) {}

    return out;
}

/**
 * Collect a low-entropy background-noise salt string. Every source is wrapped
 * defensively so a missing global (e.g. running in a worker or node) can never
 * throw — the salt is non-load-bearing, so a partial salt is fine.
 */
function _collectSalt() {
    var parts = [];
    try { parts.push('p' + ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0)); } catch (_) {}
    try { parts.push('d' + Date.now()); } catch (_) {}
    try {
        var g = (typeof window !== 'undefined') ? window : globalThis;
        if (g && g._skbPointer) {
            parts.push('m' + g._skbPointer.x + ',' + g._skbPointer.y + ',' + g._skbPointer.t);
        }
        if (g && typeof g.innerWidth !== 'undefined') {
            parts.push('w' + g.innerWidth + 'x' + g.innerHeight);
        }
        if (g && g.screen) {
            parts.push('s' + g.screen.width + 'x' + g.screen.height + 'x' + (g.screen.colorDepth || 0));
        }
        if (g && typeof g.devicePixelRatio !== 'undefined') {
            parts.push('r' + g.devicePixelRatio);
        }
    } catch (_) {}
    return parts.join('|');
}

/**
 * Passive pointer tracker — records the last cursor position so the salt can
 * include genuine interaction noise. Purely additive: if it never fires (no
 * mouse, kiosk), the salt simply omits the 'm' component. Registered once.
 */
function _installPointerTracker() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    if (window._skbPointerTracked) return;
    window._skbPointerTracked = true;
    window.addEventListener('mousemove', function (e) {
        window._skbPointer = {
            x: e.screenX,
            y: e.screenY,
            t: (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
        };
    }, { passive: true });
}

// Expose for inline scripts in boot.html and install the tracker (browser only;
// guarded so node test imports are side-effect-free).
if (typeof window !== 'undefined') {
    window.generateHardenedEntropy = generateHardenedEntropy;
    _installPointerTracker();
}

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
    var base = opts.baseBytes || await drawCheckedRandom(32);

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

/*
 * Device random number generator health check
 * ===========================================
 *
 * COLDCARD's 2021–2026 seed flaw came from a build change that quietly
 * swapped the hardware generator for a weak one, and nothing checked at run
 * time. A statistical test can't prove a generator is good: a weak but
 * well-mixed generator passes them all, and the defence against that is
 * mixing in the user's own randomness (Entropy Generator). What a check can
 * do is refuse to make a seed when the generator is plainly broken: it was
 * replaced by page script, it returns zeros or a constant, it repeats its last
 * output, or its output is far from even. Every seed draw goes through here.
 *
 * Limits are set so a working generator fails about never (each is many
 * standard deviations out), and a broken one fails at once:
 *   - a throwaway sample of 1024 bytes: share of 1 bits within 0.5 ± 0.05
 *     (σ ≈ 0.0055 over 8192 bits, so ±9σ), no byte value more than 20
 *     times (about 4 expected; ≥ 21 has probability ~10^-9 per value), and
 *     no step from one byte to the next (mod 256) more than 20 times either,
 *     which catches a counter or other simple sequence with even counts;
 *   - the draw itself: no byte repeated 5 or more times in a row (~10^-8 for
 *     32 bytes), not identical to the previous draw.
 */
var _lastDrawDigest = null;

function _isNative(fn) {
    try { return typeof fn === 'function' && /\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn)); }
    catch (_) { return false; }
}

/**
 * Why `sample` (a fresh throwaway draw, ideally 1024 bytes) and `draw` (the
 * bytes about to be used) look broken, or null if they look fine. Pure, for
 * tests. `prevDigestHex` / `drawDigestHex` let the caller reject a repeat.
 */
export function rngHealthProblem(sample, draw, prevDigestHex, drawDigestHex) {
    if (!sample || sample.length < 256) return 'sample too small';
    var ones = 0, counts = new Uint16Array(256), steps = new Uint16Array(256);
    for (var i = 0; i < sample.length; i++) {
        var x = sample[i];
        counts[x]++;
        if (i) steps[(x - sample[i - 1]) & 255]++;
        x = x - ((x >> 1) & 0x55); x = (x & 0x33) + ((x >> 2) & 0x33); ones += (x + (x >> 4)) & 0x0f;
    }
    var share = ones / (sample.length * 8);
    if (share < 0.45 || share > 0.55) return 'uneven bits (' + share.toFixed(3) + ' ones)';
    var limit = Math.max(20, Math.ceil(sample.length / 256 * 5));
    for (var v = 0; v < 256; v++) {
        if (counts[v] > limit) return 'byte ' + v + ' repeated ' + counts[v] + ' times';
        if (steps[v] > limit) return 'bytes follow a sequence (step ' + v + ', ' + steps[v] + ' times)';
    }
    for (var j = 1, run = 1; j < draw.length; j++) {
        run = draw[j] === draw[j - 1] ? run + 1 : 1;
        if (run >= 5) return 'same byte ' + run + ' times in a row';
    }
    if (prevDigestHex && drawDigestHex && prevDigestHex === drawDigestHex) return 'repeated its previous output';
    return null;
}

/**
 * `len` bytes from the browser's random number generator, checked first.
 * Throws if the generator has been replaced by script or looks broken; a seed
 * is never made from such output.
 */
export async function drawCheckedRandom(len) {
    var c = (typeof crypto !== 'undefined') ? crypto : null;
    // In the browser getRandomValues is built in, so script source here means
    // something replaced it. (Node's own is written in JS, so node tests skip
    // this part; test-entropy-built.mjs checks it in Chromium.)
    var inBrowser = typeof window !== 'undefined';
    if (!c || typeof c.getRandomValues !== 'function' || (inBrowser && !_isNative(c.getRandomValues))) {
        throw new Error('The random number generator is missing or has been replaced. No seed was made.');
    }
    var sample = new Uint8Array(1024);
    c.getRandomValues(sample);
    var draw = new Uint8Array(len);
    c.getRandomValues(draw);
    var d = new Uint8Array(await c.subtle.digest('SHA-256', draw));
    var dHex = Array.from(d, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    var problem = rngHealthProblem(sample, draw, _lastDrawDigest, dHex);
    sample.fill(0); d.fill(0);
    if (problem) {
        draw.fill(0);
        throw new Error('The random number generator failed its health check (' + problem + '). No seed was made.');
    }
    _lastDrawDigest = dHex;
    return draw;
}

/**
 * Mixed-mode combiner for the Entropy Generator:
 *
 *     output = SHA-256( MIX_LABEL || deviceRandom32 || userDigest )  truncated to byteLen
 *
 * userDigest is the SHA-256 of everything the user added. Hashing both
 * together (rather than XOR) means the result is unpredictable if EITHER
 * input is, and a faulty or hostile generator that could see the user's
 * input still can't steer the output towards a value of its choosing. The
 * label keeps this hash separate from every other SHA-256 in the app.
 *
 * @param {Uint8Array} userDigest 32-byte SHA-256 of the user's entropy pool.
 * @param {number} byteLen 16 or 32.
 * @param {object} [opts] test hook: deviceBytes {Uint8Array(32)} replaces the draw.
 */
export const MIX_LABEL = 'SafeKeepVault/entropy-mix/v1';

export async function mixWithDeviceRandom(userDigest, byteLen, opts) {
    opts = opts || {};
    if (byteLen !== 16 && byteLen !== 24 && byteLen !== 32) {
        throw new Error('mixWithDeviceRandom: byteLen must be 16, 24, or 32 (got ' + byteLen + ')');
    }
    if (!userDigest || userDigest.length !== 32) throw new Error('mixWithDeviceRandom: userDigest must be 32 bytes');
    var ownDevice = !opts.deviceBytes;
    var device = opts.deviceBytes || await drawCheckedRandom(32);
    if (device.length !== 32) throw new Error('mixWithDeviceRandom: deviceBytes must be 32 bytes');
    var label = new TextEncoder().encode(MIX_LABEL);
    var preimage = new Uint8Array(label.length + 64);
    preimage.set(label, 0);
    preimage.set(device, label.length);
    preimage.set(userDigest, label.length + 32);
    var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', preimage));
    var out = digest.slice(0, byteLen);
    try { preimage.fill(0); } catch (_) {}
    try { if (ownDevice) device.fill(0); } catch (_) {}
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
    window.SKEntropyMix = { mixWithDeviceRandom: mixWithDeviceRandom, drawCheckedRandom: drawCheckedRandom };
    _installPointerTracker();
}

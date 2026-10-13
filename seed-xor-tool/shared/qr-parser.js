/**
 * SafeKeep Universal QR Parser
 * ============================
 *
 * Central waterfall router for every QR scan in the vault. Takes a raw
 * scanner payload (decoded text + optional raw bytes from jsQR) and
 * returns a single canonical string that downstream consumers can hand
 * off to their existing logic without branching on parser internals.
 *
 * Detection order:
 *   1. Numeric SeedQR (Sparrow Standard)
 *        - Exactly 48 ASCII digits (12 words) or 96 ASCII digits (24 words).
 *        - Each 4-digit chunk is a 0-indexed BIP-39 word array position
 *          in [0, 2047]. So "0000" = wordlist[0] ("abandon"), "2047" =
 *          wordlist[2047] ("zoo"). This is the encoding Sparrow Wallet
 *          and SeedSigner actually emit (verified empirically against a
 *          live Sparrow-generated SeedQR with a BIP-39-valid checksum).
 *        - Returns: "word1 word2 ... wordN" (space-separated mnemonic).
 *
 *   2. Compact SeedQR (Binary, SeedSigner format)
 *        - Exactly 16 raw entropy bytes (12 words) or 32 bytes (24 words),
 *          as exposed by jsQR's `code.binaryData` Uint8ClampedArray.
 *        - Decoded via @scure/bip39 entropyToMnemonic, which appends the
 *          SHA-256 checksum bits and chunks into 11-bit word indices.
 *        - Returns: "word1 word2 ... wordN" (space-separated mnemonic).
 *
 *   3. Standard text fallback (CRITICAL — preserves existing behavior)
 *        - Anything else: xpubs, PSBT base64, URv2 frames, BBQr frames,
 *          descriptors, passwords, SLIP-39 share words, plain prose.
 *        - Returns: the scanner's `text` string EXACTLY as-is (no trim,
 *          no case change, no normalization) so the caller's existing
 *          downstream logic continues to work unchanged.
 *
 * Idempotency: calling parseQRScan on its own output is a no-op for the
 * text-fallback case, and yields the same mnemonic for the seed cases —
 * so callers can wrap nested parser calls without worrying about
 * double-decoding.
 *
 * Dependencies:
 *   - English BIP-39 wordlist (2048 strings). Looked up in this order:
 *       1. window.BtcMath.wordlist  (kiosk / signer / seedxor / bip85 / descriptor)
 *       2. window.QR_PARSER_WORDLIST (fallback for tools that don't expose BtcMath
 *          but have their own local wordlist array — e.g. the legacy seedqr tool)
 *     If neither is present, Numeric SeedQR detection silently degrades to
 *     text passthrough, which is the correct behavior for tools that only
 *     ever scan non-seed text (qr-transfer, secure-note).
 *   - window.BtcMath.bip39 (@scure/bip39 entropyToMnemonic) — required only for
 *     Compact SeedQR (binary) detection. Standalone tools using html5-qrcode
 *     never see binary data and so don't need this.
 *
 * Exposed as window.QRParser.parseQRScan for inline scripts and standalone
 * tools (matching the pattern used by SKScanner, BtcMath, etc.).
 */

function parseQRScan(text, binaryData) {
    // Normalize the text input; preserve the original for the fallback path.
    var rawText = (text == null) ? '' : String(text);
    var trimmed = rawText.trim();

    // ---------------------------------------------------------------
    // Priority 1: Numeric SeedQR (Sparrow Standard)
    // ---------------------------------------------------------------
    // Anchored regex — must be EXACTLY 48 or 96 digits, nothing else.
    // Forbids the 48-or-96-digit-substring-inside-other-text case.
    if (/^\d{48}$/.test(trimmed) || /^\d{96}$/.test(trimmed)) {
        var numericWords = _numericSeedQrToWords(trimmed);
        if (numericWords) return numericWords.join(' ');
        // Indices out of range, wordlist unavailable, etc. — fall through
        // to other detectors rather than returning a malformed mnemonic.
    }

    // ---------------------------------------------------------------
    // Priority 2: Compact SeedQR (raw entropy bytes)
    // ---------------------------------------------------------------
    // jsQR delivers code.binaryData as a Uint8ClampedArray of the QR's
    // byte segments, un-mangled by any UTF-8 / charset round-trip. 16
    // bytes for 12 words (128-bit entropy), 32 bytes for 24 words
    // (256-bit entropy).
    if (binaryData && (binaryData.length === 16 || binaryData.length === 32)) {
        var compactWords = _compactSeedQrToWords(binaryData);
        if (compactWords) return compactWords.join(' ');
        // Library not loaded, conversion errored, etc. — fall through.
    }

    // ---------------------------------------------------------------
    // Priority 3: Standard text fallback
    // ---------------------------------------------------------------
    // Return the scanner's raw text exactly as-is so xpubs, PSBTs,
    // descriptors, passwords, and SLIP-39 shares continue to scan
    // perfectly through the existing per-tool downstream logic.
    return rawText;
}

/**
 * Decode a 48 or 96-digit Sparrow Numeric SeedQR string to a BIP-39
 * word array. Returns null if any 4-digit chunk is out of the
 * 0-2047 range or the wordlist is unavailable.
 *
 * Sparrow's Standard SeedQR encodes each BIP-39 word as its 0-indexed
 * position in the wordlist array (0000 = first word "abandon", 2047 =
 * last word "zoo"), concatenated and zero-padded to 4 digits per word.
 *
 * Verified empirically against a live Sparrow-generated SeedQR:
 *   "118513101065108603670751118201010885153715700335"
 * decodes (0-indexed) to "neither phrase lunch march combine fuel need
 * arrow huge scan session clarify" — BIP-39 checksum valid. The
 * 1-indexed interpretation of the same payload yields a different
 * 12-word string with a failing checksum.
 */
function _numericSeedQrToWords(digitString) {
    // Wordlist lookup chain: BtcMath (kiosk + most standalone tools) →
    // explicit fallback global (legacy seedqr tool exposes its local
    // 2048-word array here). Both shapes are just plain arrays of 2048
    // lowercase strings — interchangeable for index lookup.
    var wl = null;
    if (typeof window !== 'undefined') {
        if (window.BtcMath && window.BtcMath.wordlist) wl = window.BtcMath.wordlist;
        else if (window.QR_PARSER_WORDLIST) wl = window.QR_PARSER_WORDLIST;
    }
    if (!wl || wl.length !== 2048) return null;

    var words = [];
    for (var i = 0; i < digitString.length; i += 4) {
        var chunk = digitString.slice(i, i + 4);
        var idx = parseInt(chunk, 10);
        // 0-indexed: 0000 → wordlist[0] ("abandon"), 2047 → wordlist[2047] ("zoo")
        if (!Number.isFinite(idx) || idx < 0 || idx > 2047) return null;
        words.push(wl[idx]);
    }
    return words;
}

/**
 * Decode a 16 or 32-byte raw entropy buffer (Compact SeedQR / SeedSigner
 * format) to a BIP-39 word array. Returns null if the BIP-39 library
 * isn't loaded or entropyToMnemonic throws.
 *
 * The checksum (first 4 bits of SHA-256(entropy) for 16-byte input,
 * first 8 bits for 32-byte input) is computed and appended internally
 * by @scure/bip39 before the 11-bit word-index split — so the words
 * we return always have a valid BIP-39 checksum.
 */
function _compactSeedQrToWords(binaryData) {
    var btc = (typeof window !== 'undefined') ? window.BtcMath : null;
    if (!btc || !btc.bip39 || !btc.wordlist) return null;

    // Coerce Uint8ClampedArray (or array-like) to plain Uint8Array
    // since @scure/bip39 expects that exact type.
    var entropy = (binaryData instanceof Uint8Array)
        ? binaryData
        : new Uint8Array(binaryData);

    try {
        var mnemonic = btc.bip39.entropyToMnemonic(entropy, btc.wordlist);
        return mnemonic.split(/\s+/);
    } catch (_) {
        return null;
    }
}

/* =====================================================================
 * The Courier — animated file frames
 * =====================================================================
 * The Courier (and the vault's QR Transfer tool) send a file as a loop of
 * QR frames:
 *
 *     loop/index/total~name~ext~mime~base64data~checksum
 *
 *   - loop: which pass of the loop (ignored when collecting)
 *   - index: 0-based chunk number; total: number of chunks
 *   - name, ext: URI-encoded file name and extension
 *   - checksum: sum of the chunk's bytes, as hex, zero-padded to 8 digits
 *
 * Frames repeat, so they can be picked up from any point in the loop and
 * in any order. These helpers are separate from parseQRScan, which is
 * unchanged: callers that want Courier files ask for them explicitly.
 */

/**
 * Parse one Courier frame. Returns
 *   { loop, index, total, name, ext, mime, data, checksum }
 * or null if the text isn't a Courier frame. Fields are read from both
 * ends, so a '~' inside the file name (encodeURIComponent leaves it as
 * is) doesn't break the frame.
 */
function parseCourierFrame(text) {
    if (typeof text !== 'string') return null;
    var parts = text.split('~');
    if (parts.length < 6) return null;
    var head = /^(\d+)\/(\d+)\/(\d+)$/.exec(parts[0]);
    if (!head) return null;
    var index = parseInt(head[2], 10), total = parseInt(head[3], 10);
    if (!(total >= 1) || !(index >= 0) || index >= total) return null;
    var n = parts.length;
    var checksum = parts[n - 1], data = parts[n - 2], mime = parts[n - 3], ext = parts[n - 4];
    if (!/^[0-9a-f]{8,}$/i.test(checksum)) return null;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
    function dec(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }
    return {
        loop: parseInt(head[1], 10), index: index, total: total,
        name: dec(parts.slice(1, n - 4).join('~')), ext: dec(ext), mime: mime,
        data: data, checksum: checksum.toLowerCase()
    };
}

function _courierChecksum(bytes) {
    var sum = 0;
    for (var i = 0; i < bytes.length; i++) sum += bytes[i];
    var s = sum.toString(16);
    while (s.length < 8) s = '0' + s;
    return s;
}

function _courierBase64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Collects the chunks of one Courier file. add(frame) takes a frame from
 * parseCourierFrame and returns
 *   { status, received, total, filename, done, bytes }
 * status: 'added' | 'duplicate' | 'bad-checksum' | 'new-file' (a frame from
 * a different file arrived: collection restarted with it).
 * When every chunk is in, done is true and bytes holds the whole file.
 */
function createCourierCollector() {
    var cur = null;
    function start(f) {
        cur = { key: f.total + '~' + f.name + '~' + f.ext + '~' + f.mime, total: f.total,
                filename: f.ext ? f.name + '.' + f.ext : f.name, mime: f.mime, chunks: {}, count: 0 };
    }
    function report(status) {
        var done = cur.count === cur.total, bytes = null;
        if (done) {
            var len = 0, i;
            for (i = 0; i < cur.total; i++) len += cur.chunks[i].length;
            bytes = new Uint8Array(len);
            var off = 0;
            for (i = 0; i < cur.total; i++) { bytes.set(cur.chunks[i], off); off += cur.chunks[i].length; }
        }
        return { status: status, received: cur.count, total: cur.total, filename: cur.filename, mime: cur.mime, done: done, bytes: bytes };
    }
    return {
        add: function(f) {
            var status = 'added';
            var key = f.total + '~' + f.name + '~' + f.ext + '~' + f.mime;
            if (!cur) start(f);
            else if (cur.key !== key) { start(f); status = 'new-file'; }
            if (cur.chunks[f.index]) return report('duplicate');
            var bytes;
            try { bytes = _courierBase64ToBytes(f.data); } catch (_) { return report('bad-checksum'); }
            if (_courierChecksum(bytes) !== f.checksum) return report('bad-checksum');
            cur.chunks[f.index] = bytes;
            cur.count++;
            return report(status);
        },
        reset: function() { cur = null; }
    };
}

// Expose globally for inline scripts in boot.html (same pattern as
// SKScanner, BtcMath, SafeKeepOS, etc.). Inline ES module syntax isn't
// used inside boot.html — everything reaches the bundled libraries via
// window globals.
if (typeof window !== 'undefined') {
    window.QRParser = {
        parseQRScan: parseQRScan,
        parseCourierFrame: parseCourierFrame,
        createCourierCollector: createCourierCollector
    };
}

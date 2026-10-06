/**
 * release-tools.mjs — helpers shared by the release workflow and
 * verify-release.mjs (see VERIFYING.md at the repository root).
 */

import { createHash } from 'node:crypto';

/**
 * Read the version stamp build-offline.mjs writes into boot.html:
 *   "v1.35 · build 61 · 9e2016a · 2026-10-06"  (+ " + local changes")
 * Returns { text, release, build, commit, date, dirty } or null.
 */
export function parseStamp(html) {
    const text = String(html);
    const m = text.match(/v(\d+(?:\.\d+)*) · build (\d+) · ([0-9a-f]{7,40}) · (\d{4}-\d{2}-\d{2})( \+ local changes)?/);
    if (!m) return null;
    return {
        text: m[0],
        release: m[1],
        build: Number(m[2]),
        commit: m[3],
        date: m[4],
        dirty: Boolean(m[5]),
    };
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** One "<sha256>  <name>" line per file, as sha256sum writes it. */
export function formatSums(entries) {
    return entries.map(({ name, sha256 }) => {
        if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`bad sha256 for ${name}`);
        if (/[\n\r\\]/.test(name)) throw new Error(`unsupported file name: ${name}`);
        return `${sha256}  ${name}\n`;
    }).join('');
}

/** Parse sha256sum output (text or binary mode markers). Returns Map name → sha256. */
export function parseSums(text) {
    const out = new Map();
    for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        const m = line.match(/^([0-9a-fA-F]{64}) [ *](.+)$/);
        if (!m) throw new Error(`malformed SHA256SUMS line: ${line}`);
        out.set(m[2], m[1].toLowerCase());
    }
    return out;
}

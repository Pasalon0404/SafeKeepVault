/**
 * verify-release.mjs — rebuild a released boot.html from source and compare
 *
 *   npm run verify-release -- <path/to/boot.html> [--sums <SHA256SUMS>]
 *
 * 1. Hashes the file and, with --sums, checks it against the release's
 *    SHA256SUMS.
 * 2. Reads the commit stamped in the file ("v1.35 · build 61 · 9e2016a · …")
 *    and refuses a "+ local changes" build: it cannot be reproduced.
 * 3. Checks out that commit into a temporary git worktree of THIS clone,
 *    runs `npm ci` and `npm run build` there, and compares the rebuilt
 *    dist/boot.html with the file, byte for byte.
 *
 * Needs a full (non-shallow) clone that contains the commit: the build number
 * in the stamp is the commit count, so a shallow clone stamps a different
 * number and cannot match. Exit codes: 0 match, 1 mismatch, 2 could not check.
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStamp, parseSums, sha256Hex } from './release-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = (msg, code = 2) => { console.error(`\n✗ ${msg}`); process.exit(code); };
const git = (...args) => execFileSync('git', args, { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const argv = process.argv.slice(2);
const si = argv.indexOf('--sums');
const sumsPath = si >= 0 ? argv[si + 1] : null;
const target = argv.find((a, i) => !a.startsWith('--') && i !== si + 1);
if (!target) fail('usage: npm run verify-release -- <path/to/boot.html> [--sums <SHA256SUMS>]');

const file = resolve(process.env.INIT_CWD || process.cwd(), target);
const bytes = readFileSync(file);
const digest = sha256Hex(bytes);
console.log(`File:     ${file}`);
console.log(`SHA-256:  ${digest}`);

if (sumsPath) {
    const sums = parseSums(readFileSync(resolve(process.env.INIT_CWD || process.cwd(), sumsPath), 'utf8'));
    const want = sums.get(basename(file)) || sums.get('boot.html');
    if (!want) fail(`${sumsPath} has no entry for ${basename(file)}`);
    if (want !== digest) fail(`SHA-256 does not match ${sumsPath} (expected ${want})`, 1);
    console.log(`Checksum: matches ${sumsPath}`);
}

const stamp = parseStamp(bytes.toString('utf8'));
if (!stamp) fail('no version stamp found in the file.');
console.log(`Stamp:    ${stamp.text}`);
if (stamp.dirty) fail('this build was made from uncommitted changes ("+ local changes") and cannot be reproduced.');

if (git('rev-parse', '--is-shallow-repository') === 'true') {
    fail('this clone is shallow. Run `git fetch --unshallow` first (the build number is the commit count).');
}
let commit;
try { commit = git('rev-parse', '--verify', '--quiet', `${stamp.commit}^{commit}`); } catch (_) {
    fail(`commit ${stamp.commit} is not in this clone. Run \`git fetch origin\` (or fetch the release tag) first.`);
}
console.log(`Commit:   ${commit}`);

const work = mkdtempSync(join(tmpdir(), 'skv-verify-'));
let rebuilt;
try {
    console.log(`\nRebuilding in ${work} …`);
    git('worktree', 'add', '--detach', work, commit);
    const app = join(work, 'seed-xor-tool');
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: app, stdio: ['ignore', 'inherit', 'inherit'] });
    run('npm', ['ci', '--no-audit', '--no-fund']);
    run('npm', ['run', 'build']);
    rebuilt = readFileSync(join(app, 'dist', 'boot.html'));
} catch (e) {
    fail(`rebuild failed: ${e.message}`);
} finally {
    try { git('worktree', 'remove', '--force', work); } catch (_) { rmSync(work, { recursive: true, force: true }); }
}

const rebuiltDigest = sha256Hex(rebuilt);
console.log(`\nRebuilt:  ${rebuiltDigest}`);
if (rebuilt.equals(bytes)) {
    console.log(`\n✓ MATCH: ${basename(file)} is byte-for-byte the build of commit ${stamp.commit}.`);
    process.exit(0);
}
const rebuiltStamp = parseStamp(rebuilt.toString('utf8'));
console.error(`\n✗ MISMATCH: the rebuild of ${stamp.commit} differs from ${basename(file)}.`);
if (rebuiltStamp && rebuiltStamp.text !== stamp.text) console.error(`  Rebuilt stamp: ${rebuiltStamp.text}`);
process.exit(1);

/**
 * test-release.mjs — release verification tooling
 *
 *   1. parseStamp reads build-offline.mjs's stamp (and the real dist/boot.html
 *      when one has been built); "+ local changes" is detected.
 *   2. SHA256SUMS: formatSums/parseSums round-trip and agree with sha256sum.
 *   3. Reproducibility inputs: the manifest uses the commit time, the stamp a
 *      fixed-length hash.
 *   4. release.yml: tag trigger, least-privilege permissions, full-history
 *      checkout, tests, double build + cmp, stamp checks, attestation,
 *      hash-pinned OpenTimestamps, publish; every action pinned to a SHA.
 *   5. ots-upgrade.yml: schedule + manual, checksum before stamping, upgrade.
 *   6. ots-requirements.txt is fully hash-pinned.
 *   7. VERIFYING.md's key fingerprint matches developer-pubkey.asc.
 *   8. Wiring: npm script, .nvmrc, quick-update shows the full hash, README.
 *
 * The end-to-end rebuild (npm run verify-release) runs npm ci and a full
 * build; set VERIFY_RELEASE_E2E=1 to include it.
 *
 * Run:  node test-release.mjs
 */

import { parseStamp, formatSums, parseSums, sha256Hex } from './release-tools.mjs';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const skip = (name) => console.log(`  [SKIP] ${name}`);
const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

console.log('\n1. parseStamp');
{
    const s = parseStamp('<span data-skv-version>v1.35 · build 61 · 9e2016a · 2026-10-06</span>');
    ck('fields', s && s.release === '1.35' && s.build === 61 && s.commit === '9e2016a' && s.date === '2026-10-06' && !s.dirty, JSON.stringify(s));
    ck('"+ local changes" is dirty', parseStamp('v1.35 · build 61 · 9e2016a · 2026-10-06 + local changes').dirty === true);
    ck('"+ shallow clone" is flagged', parseStamp('v1.35 · build 57 · 6638175 · 2026-10-06 + shallow clone').shallow === true);
    ck('both markers together', (() => { const s = parseStamp('v1.35 · build 57 · 6638175 · 2026-10-06 + local changes + shallow clone'); return s.dirty && s.shallow; })());
    ck('no stamp → null', parseStamp('<html>nothing here</html>') === null);
    ck('"build unknown" is not a usable stamp', parseStamp('v1.35 · build unknown') === null);
    const dist = new URL('./dist/boot.html', import.meta.url);
    if (existsSync(dist)) {
        const st = parseStamp(readFileSync(dist, 'utf8'));
        ck(`stamp found in dist/boot.html (${st?.text})`, !!st && /^[0-9a-f]{7}$/.test(st.commit));
        const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).stdout.trim() === 'true';
        ck('dist stamp\'s shallow marker matches this clone', st?.shallow === shallow, `stamp ${st?.shallow}, clone ${shallow} (rebuild?)`);
    } else skip('dist/boot.html not built');
}

console.log('\n2. SHA256SUMS');
{
    const a = sha256Hex(Buffer.from('a')), b = sha256Hex(Buffer.from('b'));
    const text = formatSums([{ name: 'boot.html', sha256: a }, { name: 'x.ots', sha256: b }]);
    ck('format: two-space sha256sum lines', text === `${a}  boot.html\n${b}  x.ots\n`);
    const m = parseSums(text);
    ck('round trip', m.get('boot.html') === a && m.get('x.ots') === b);
    ck('binary-mode marker accepted', parseSums(`${a} *boot.html\n`).get('boot.html') === a);
    ck('malformed line rejected', (() => { try { parseSums('nope  boot.html'); return false; } catch { return true; } })());
    ck('bad digest rejected', (() => { try { formatSums([{ name: 'f', sha256: 'zz' }]); return false; } catch { return true; } })());
    const dir = mkdtempSync(join(tmpdir(), 'skv-sums-'));
    writeFileSync(join(dir, 'boot.html'), 'hello');
    const r = spawnSync('sha256sum', ['boot.html'], { cwd: dir, encoding: 'utf8' });
    if (r.status === 0) {
        ck('agrees with sha256sum', r.stdout === formatSums([{ name: 'boot.html', sha256: sha256Hex(Buffer.from('hello')) }]), r.stdout);
        writeFileSync(join(dir, 'SHA256SUMS'), formatSums([{ name: 'boot.html', sha256: sha256Hex(Buffer.from('hello')) }]));
        ck('sha256sum -c accepts our file', spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: dir }).status === 0);
    } else skip('sha256sum not installed');
}

console.log('\n3. Reproducibility inputs (build-offline.mjs)');
{
    const src = readFileSync(new URL('./build-offline.mjs', import.meta.url), 'utf8');
    ck('manifest generatedAt uses the commit time', /generatedAt: commitTime\(\)/.test(src) && src.includes("'--format=%cI'"));
    ck('no build-time clock in the manifest', !/generatedAt: new Date\(\)/.test(src));
    ck('shallow clones are marked in the stamp', src.includes("'--is-shallow-repository'") && src.includes("' + shallow clone'"));
    ck('stamp hash has a fixed length (--short=7)', src.includes("'--short=7'") && !src.includes("'rev-parse', '--short', 'HEAD'"));
}

// YAML → JSON via PyYAML (no YAML parser in this project's dependencies).
const yaml = (p) => {
    const r = spawnSync('python3', ['-c', 'import sys,json,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', new URL(p, root).pathname], { encoding: 'utf8' });
    if (r.status === 0) return JSON.parse(r.stdout);
    // A parse error is a broken workflow; only a missing PyYAML is a skip.
    if (spawnSync('python3', ['-c', 'import yaml']).status === 0) throw new Error(`${p} is not valid YAML:\n${r.stderr}`);
    return null;
};
const usesPinned = (wf) => {
    const uses = Object.values(wf.jobs).flatMap((j) => j.steps.filter((s) => s.uses).map((s) => s.uses));
    return { uses, ok: uses.length > 0 && uses.every((u) => /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(u)) };
};

console.log('\n4. release.yml');
const rel = yaml('.github/workflows/release.yml');
if (!rel) skip('python3 + PyYAML not available');
else {
    const relText = read('.github/workflows/release.yml');
    const job = rel.jobs.release;
    const run = job.steps.map((s) => s.run || '').join('\n');
    // PyYAML reads the bare key `on` as boolean true.
    const on = rel.on || rel[true];
    ck('runs on v* tag pushes only', JSON.stringify(on) === JSON.stringify({ push: { tags: ['v*'] } }), JSON.stringify(on));
    ck('workflow default permissions read-only', rel.permissions.contents === 'read');
    ck('job permissions: contents/id-token/attestations write, nothing else',
        JSON.stringify(job.permissions) === JSON.stringify({ contents: 'write', 'id-token': 'write', attestations: 'write' }));
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    ck('full-history checkout (build number = commit count)', checkout?.with?.['fetch-depth'] === 0);
    ck('checkout does not persist credentials', checkout?.with?.['persist-credentials'] === false);
    ck('Node version from .nvmrc', job.steps.some((s) => s.with?.['node-version-file'] === 'seed-xor-tool/.nvmrc'));
    ck('tag must equal v$(cat VERSION)', run.includes('want="v$(cat VERSION)"') && run.includes('"$TAG" != "$want"'));
    ck('npm ci', run.includes('npm ci'));
    ck('runs every test-*.mjs', run.includes('for f in test-*.mjs') && run.includes('node "$f"'));
    ck('builds twice and compares bytes', (run.match(/npm run build/g) || []).length >= 2 && run.includes('cmp "$RUNNER_TEMP/boot-first.html" dist/boot.html'));
    ck('refuses "+ local changes" and "+ shallow clone"', run.includes("for mark in '+ local changes' '+ shallow clone'") && run.includes('grep -qF "$mark" dist/boot.html'));
    ck('stamp must name VERSION and HEAD', run.includes('$(git rev-parse --short=7 HEAD)'));
    ck('writes SHA256SUMS with sha256sum', run.includes('sha256sum boot.html > SHA256SUMS'));
    const attest = job.steps.find((s) => s.uses?.startsWith('actions/attest-build-provenance@'));
    ck('attests release/boot.html', attest?.with?.['subject-path'] === 'release/boot.html');
    ck('attestation comes after the checksums', job.steps.indexOf(attest) > job.steps.findIndex((s) => s.name === 'Checksums'));
    ck('OTS client installed with --require-hashes', run.includes('--require-hashes -r "$GITHUB_WORKSPACE/.github/ots-requirements.txt"'));
    ck('stamps boot.html', run.includes('ots stamp "$GITHUB_WORKSPACE/release/boot.html"'));
    ck('OTS failure does not block the release', job.steps.find((s) => s.name === 'OpenTimestamps proof')?.['continue-on-error'] === true);
    ck('publishes with --verify-tag', run.includes('gh release create "$TAG" "${files[@]}"') && run.includes('--verify-tag'));
    const { uses, ok } = usesPinned(rel);
    ck(`every action pinned to a commit SHA (${uses.length})`, ok, uses.join(', '));
    ck('every pin carries its tag as a comment', (relText.match(/uses: \S+@[0-9a-f]{40} # v[\d.]+/g) || []).length === uses.length);
    ck('no pull_request / pull_request_target trigger', !/pull_request/.test(relText));
}

console.log('\n5. ots-upgrade.yml');
const up = yaml('.github/workflows/ots-upgrade.yml');
if (!up) skip('python3 + PyYAML not available');
else {
    const on = up.on || up[true];
    const run = up.jobs.upgrade.steps.map((s) => s.run || '').join('\n');
    ck('scheduled and manual', Array.isArray(on.schedule) && 'workflow_dispatch' in on);
    ck('job may only write contents', JSON.stringify(up.jobs.upgrade.permissions) === JSON.stringify({ contents: 'write' }) && up.permissions.contents === 'read');
    ck('OTS client installed with --require-hashes', run.includes('--require-hashes -r .github/ots-requirements.txt'));
    ck('checks SHA256SUMS before touching the proof', run.indexOf('sha256sum -c SHA256SUMS') !== -1 && run.indexOf('sha256sum -c SHA256SUMS') < run.indexOf('ots upgrade'));
    ck('skips complete proofs', run.includes('BitcoinBlockHeaderAttestation'));
    ck('replaces the asset', run.includes('gh release upload "$tag" boot.html.ots') && run.includes('--clobber'));
    const { uses, ok } = usesPinned(up);
    ck(`every action pinned to a commit SHA (${uses.length})`, ok, uses.join(', '));
}

console.log('\n6. ots-requirements.txt');
{
    const lines = read('.github/ots-requirements.txt').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    ck('every requirement is name==version --hash=sha256:<64 hex>', lines.length > 0 && lines.every((l) => /^[a-z0-9-]+==[\w.]+ --hash=sha256:[0-9a-f]{64}$/.test(l)), lines.join(' | '));
    ck('pins opentimestamps-client', lines.some((l) => l.startsWith('opentimestamps-client==')));
}

console.log('\n7. Maintainer key');
{
    const doc = read('VERIFYING.md');
    const docFp = (doc.match(/A333 EB82[0-9A-F ]+/) || [''])[0].replace(/\s+/g, '');
    const r = spawnSync('gpg', ['--batch', '--with-colons', '--show-keys', new URL('developer-pubkey.asc', root).pathname], { encoding: 'utf8' });
    if (r.status === 0) {
        const keyFp = (r.stdout.split('\n').find((l) => l.startsWith('fpr:')) || '').split(':')[9];
        ck(`VERIFYING.md fingerprint matches developer-pubkey.asc (${keyFp})`, docFp === keyFp && docFp.length === 40, `${docFp} vs ${keyFp}`);
        ck('signing command uses that key', doc.includes(`--local-user ${keyFp}`));
    } else skip('gpg not installed');
}

console.log('\n8. Wiring');
{
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    ck('npm run verify-release defined', pkg.scripts['verify-release'] === 'node verify-release.mjs');
    ck('.nvmrc pins Node 22', readFileSync(new URL('./.nvmrc', import.meta.url), 'utf8').trim() === '22');
    ck('quick-update.sh prints the full app sha256', read('usbbootdrive/quick-update.sh').includes("app sha256 : $(sha256sum src/dist/boot.html"));
    ck('README links VERIFYING.md', read('README.md').includes('(VERIFYING.md)'));
}

if (process.env.VERIFY_RELEASE_E2E === '1') {
    console.log('\n9. End-to-end rebuild (VERIFY_RELEASE_E2E=1)');
    const dist = new URL('./dist/boot.html', import.meta.url).pathname;
    const r = spawnSync('node', ['verify-release.mjs', dist], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
    ck('verify-release reports MATCH for a clean build', r.status === 0 && r.stdout.includes('✓ MATCH'), (r.stdout + r.stderr).slice(-400));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * test-residue-audit.mjs — unit tests for the memory residue harness
 *
 * The harness itself (npm run residue-audit) needs a browser and ptrace
 * access, so it is a manual developer tool. These tests cover its logic:
 *   1. Fixture and needles: the mnemonic is the published BIP-39 vector for
 *      entropy 0x80 × 16, and the seed and master key the harness searches for
 *      match an independent derivation (@scure/bip39 rather than node PBKDF2).
 *   2. countInChunks: matches split across chunk boundaries are counted once,
 *      gaps reset the overlap, nothing is double-counted.
 *   3. evaluate: valid run; contaminated control; failed positive control;
 *      unreadable process; missing checkpoint; calibration.
 *   4. renderMarkdown flags invalid runs and uncalibrated secrets.
 *   5. scanProcess on this test's own memory (Linux only) finds a marker.
 *   6. npm script and gitignore wiring.
 *
 * Run:  node test-residue-audit.mjs
 */

import { FIXTURE, CHECKPOINTS, buildNeedles, countInChunks, evaluate, renderMarkdown, scanProcess } from './residue-audit.mjs';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const needles = await buildNeedles();
const find = (secret, encoding) => needles.find((n) => n.secret === secret && n.encoding === encoding);

console.log('\n1. Fixture and needles');
ck('mnemonic is the BIP-39 vector for entropy 0x80 × 16', bip39.entropyToMnemonic(new Uint8Array(16).fill(0x80), wordlist) === FIXTURE.mnemonic);
ck('passphrase is marked public test data', /PUBLIC TEST ONLY/.test(FIXTURE.passphrase));
const seed = bip39.mnemonicToSeedSync(FIXTURE.mnemonic, FIXTURE.passphrase);
ck('seed needle matches @scure/bip39', find('bip39-seed', 'raw').bytes.equals(Buffer.from(seed)));
ck('seed hex needle matches', find('bip39-seed', 'utf8').bytes.toString() === Buffer.from(seed).toString('hex'));
const root = HDKey.fromMasterSeed(seed);
ck('master xprv needle matches', find('master-xprv', 'utf8').bytes.toString() === root.privateExtendedKey);
ck('master private key needle matches', find('master-private-key', 'raw').bytes.equals(Buffer.from(root.privateKey)));
ck('first key raw needle matches m/84\'/0\'/0\'/0/0', find("first-key (m/84'/0'/0'/0/0)", 'raw').bytes.equals(Buffer.from(root.derive("m/84'/0'/0'/0/0").privateKey)));
ck('text secrets have UTF-16LE forms', ['mnemonic', 'passphrase', 'master-xprv'].every((s) => find(s, 'utf16le')?.bytes.equals(Buffer.from(find(s, 'utf8').bytes.toString(), 'utf16le'))));
ck('every needle is at least 32 bytes (no accidental matches)', needles.every((n) => n.bytes.length >= 32), needles.map((n) => n.bytes.length).join());

console.log('\n2. countInChunks');
{
    const n = [{ bytes: Buffer.from('SECRET-NEEDLE') }, { bytes: Buffer.from('OTHER') }];
    const hay = Buffer.from('xxSECRET-NEEDLExxOTHERxxSECRET-NEEDLE');
    ck('whole buffer', countInChunks([hay], n).join() === '2,1');
    let allSplits = true;
    for (let cut = 1; cut < hay.length; cut++) {
        if (countInChunks([hay.subarray(0, cut), hay.subarray(cut)], n).join() !== '2,1') { allSplits = false; break; }
    }
    ck('every two-way split gives the same counts', allSplits);
    const bytes = [...hay].map((b) => Buffer.from([b]));
    ck('one-byte chunks give the same counts', countInChunks(bytes, n).join() === '2,1');
    ck('a gap breaks a match across it', countInChunks([Buffer.from('xxSECRET-'), null, Buffer.from('NEEDLExx')], n).join() === '0,0');
    ck('adjacent repeats all counted', countInChunks([Buffer.from('OTHEROTHER'), Buffer.from('OTHER')], n).join() === '0,3');
}

console.log('\n3. evaluate');
const idx = (secret) => needles.findIndex((n) => n.secret === secret);
const proc = (hits = {}) => ({ pid: 1, type: 'renderer', read: 1000, counts: needles.map((_, k) => hits[k] || 0) });
const good = { 'before-input': [proc()], 'after-load': [proc({ [idx('mnemonic')]: 2, [idx('passphrase')]: 1 })], 'after-lock': [proc({ [idx('mnemonic')]: 1 })], 'after-close': [proc()] };
{
    const r = evaluate(good, needles);
    ck('valid run', r.valid, r.reasons.join('; '));
    ck('table totals', r.table.mnemonic['after-load'] === 2 && r.table.mnemonic['after-lock'] === 1 && r.table.mnemonic['after-close'] === 0);
    ck('seen secrets calibrated', r.calibrated.mnemonic && r.calibrated.passphrase);
    ck('unseen secrets not calibrated', !r.calibrated['master-xprv']);
}
ck('contaminated before-input → invalid', !evaluate({ ...good, 'before-input': [proc({ [idx('passphrase')]: 1 })] }, needles).valid);
ck('mnemonic missing after load → invalid', !evaluate({ ...good, 'after-load': [proc()] }, needles).valid);
ck('unreadable process → invalid', !evaluate({ ...good, 'after-lock': [proc(), { pid: 2, type: 'renderer', read: 0, error: 'EACCES' }] }, needles).valid);
ck('zero bytes read → invalid', !evaluate({ ...good, 'after-close': [{ ...proc(), read: 0 }] }, needles).valid);
ck('missing checkpoint → invalid', !evaluate({ 'before-input': good['before-input'], 'after-load': good['after-load'] }, needles).valid);
ck('empty checkpoint → invalid', !evaluate({ ...good, 'after-close': [] }, needles).valid);

console.log('\n4. renderMarkdown');
{
    const meta = { date: 'd', browser: 'b', build: 'v', options: 'none' };
    const okMd = renderMarkdown(meta, evaluate(good, needles), good, needles);
    ck('valid report says VALID and lists checkpoints', okMd.includes('**VALID**') && CHECKPOINTS.every((c) => okMd.includes(c)));
    ck('uncalibrated secrets flagged', okMd.includes('| master-xprv | 0 | 0 | 0 | 0 | **NOT CALIBRATED** |'));
    const bad = { ...good, 'after-load': [proc()] };
    const badMd = renderMarkdown(meta, evaluate(bad, needles), bad, needles);
    ck('invalid report says INVALID with reasons', badMd.includes('**INVALID**') && badMd.includes('positive control failed'));
}

console.log('\n5. scanProcess on this process');
if (process.platform === 'linux') {
    const marker = Buffer.from(`skv-residue-self-test-${process.pid}-${Date.now()}-marker`);
    const held = Buffer.concat([Buffer.from('....'), marker, Buffer.from('....')]); // keep a live copy
    const r = scanProcess(process.pid, [{ secret: 'marker', encoding: 'utf8', bytes: marker }]);
    ck(`marker found in own memory (${(r.read / 1e6).toFixed(0)} MB read)`, r.counts[0] >= 1 && held.length > 0, JSON.stringify(r));
} else {
    console.log('  [SKIP] not Linux');
}

console.log('\n6. Wiring');
{
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    ck('npm run residue-audit is defined', pkg.scripts['residue-audit'] === 'node residue-audit.mjs');
    ck('playwright-core is a dev dependency', !!pkg.devDependencies['playwright-core']);
    ck('out/ is gitignored', readFileSync(new URL('./.gitignore', import.meta.url), 'utf8').split('\n').includes('out/'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

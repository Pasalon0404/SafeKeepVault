/**
 * test-lifehash.mjs — LifeHash icons beside master fingerprints
 *
 *   1. Sparrow compatibility: the bundled `lifehash` package reproduces
 *      toucan's (Sparrow Wallet's LifeHash library) published test vector:
 *      makeFromUTF8("Hello", version2) first 30 RGB bytes.
 *   2. Fingerprint icons: SHA-256 of the 32×32 RGB pixels for four
 *      fingerprints hashed as RAW bytes (Sparrow's convention), pinned from
 *      the canonical package (the same vectors EntropyLab pins), including
 *      73c5da0a, the "abandon … about" wallet.
 *   3. Raw bytes, not the hex string: hashing the text gives a different icon.
 *   4. fingerprintFromText: picks out the fingerprint in each display format
 *      the app uses, and rejects placeholders and longer hex runs.
 *   5. Wiring: the three fingerprint elements are marked, the module is loaded.
 *
 * Run:  node test-lifehash.mjs
 */

import { LifeHash } from 'lifehash';
import { lifeHashImage, fingerprintFromText } from './shared/lifehash-icons.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const sha = (arr) => createHash('sha256').update(Buffer.from(arr)).digest('hex');

console.log('\n1. Sparrow (toucan) published vector');
{
    const img = LifeHash.makeFrom('Hello');
    const toucan = [146, 126, 130, 178, 104, 92, 182, 101, 87, 202, 88, 64, 199, 89, 66, 197, 90, 69, 182, 101, 87, 180, 102, 89, 159, 117, 114, 210, 82, 54];
    ck('32×32', img.width === 32 && img.height === 32);
    ck('first 30 RGB bytes match toucan LifeHashTest', img.colors.slice(0, 30).join() === toucan.join(), img.colors.slice(0, 30).join());
}

console.log('\n2. Fingerprint icons (raw bytes)');
for (const [fp, rgb] of [
    ['73c5da0a', '09da10ffd57a4f58616a5eda313d3f0c861e79b93e1b609a012f9c3530b427b5'],
    ['00000000', '9003d9fd366ec3aa06f54d6797485114ec00c61bf85c0efafa91bd2e40176d5b'],
    ['ffffffff', 'e856f1b33dfd8eef83151de7407c3d4861581ce09f11f11f2dfc6b0219a1e51b'],
    ['b8688df1', 'd44ba038c1389003c955a6f17accfb87c98fce4e8c98c9e2a44c71067b6521fe'],
]) {
    const img = lifeHashImage(fp);
    ck(`${fp}`, img.colors.length === 32 * 32 * 3 && sha(img.colors) === rgb, sha(img.colors));
}
ck('upper-case input gives the same icon', sha(lifeHashImage('73C5DA0A').colors) === sha(lifeHashImage('73c5da0a').colors));
ck('bad input throws', (() => { try { lifeHashImage('73c5da0'); return false; } catch { return true; } })());

console.log('\n3. Raw bytes, not the hex string');
ck('hashing "73c5da0a" as text gives a different icon', sha(LifeHash.makeFrom('73c5da0a').colors) !== sha(lifeHashImage('73c5da0a').colors));

console.log('\n4. fingerprintFromText');
for (const [text, want] of [
    ['73C5DA0A', '73c5da0a'],              // dashboard badge
    ['[73C5DA0A]', '73c5da0a'],            // sidebar
    ['  b8688df1\n', 'b8688df1'],          // whitespace
    ['--------', null],                    // placeholder
    ['No seed loaded', null],
    ['73c5da0a1', null],                   // nine hex digits is not a fingerprint
    ['73c5da0', null],
    ['', null],
]) ck(`${JSON.stringify(text)} → ${want}`, fingerprintFromText(text) === want, fingerprintFromText(text));

console.log('\n5. Wiring');
{
    const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
    const entry = readFileSync(new URL('./boot-entry.js', import.meta.url), 'utf8');
    ck('boot-entry.js imports the module', entry.includes("import './shared/lifehash-icons.js'"));
    ck('dashboard badge marked', /id="dash-fingerprint" data-lifehash="\d+"/.test(html));
    ck('sidebar fingerprint marked', /id="sidebar-seed-fp" data-lifehash="\d+" data-lifehash-place="parent-right"/.test(html));
    ck('PSBT signer fingerprint marked', /id="psbt-vault-fp" data-lifehash="\d+"/.test(html));
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    ck('lifehash pinned as a dependency', pkg.dependencies.lifehash === '1.0.0');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

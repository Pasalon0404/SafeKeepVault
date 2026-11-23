/**
 * test-core-import.mjs — Bitcoin Core importdescriptors export
 *
 *   1. Checksum: Bitcoin Core's documented vectors, and agreement with the
 *      Descriptor tool's own desc_checksum (extracted from boot.html).
 *   2. Single-sig: the multipath descriptor splits into receive (/0/*,
 *      internal false) and change (/1/*, internal true) entries with valid
 *      checksums, range and timestamp; the split descriptors' first addresses
 *      equal the published BIP-84 "abandon … about" receive and change
 *      addresses.
 *   3. Multisig: every key's <0;1> is split consistently.
 *   4. Refusals: private keys, sp(), a wrong checksum, other multipath steps,
 *      bad timestamps, empty input.
 *   5. Already-split and non-ranged descriptors.
 *   6. boot.html / boot-entry.js wiring.
 *
 * Run:  node test-core-import.mjs
 */

import { buildCoreImport, coreImportInstructions, descriptorChecksum, CORE_RANGE_END } from './shared/core-import.js';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');

// The Descriptor tool's own checksum function, extracted verbatim from boot.html.
const descChecksumSrc = (() => {
    const start = html.indexOf('function desc_checksum(');
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
})();
const desc_checksum = new Function(`${descChecksumSrc}; return desc_checksum;`)();

const valid = (d) => { const i = d.lastIndexOf('#'); return descriptorChecksum(d.slice(0, i)) === d.slice(i + 1); };

console.log('\n1. Checksum');
ck('raw(deadbeef)#89f8spxm (Core doc/descriptors.md)', descriptorChecksum('raw(deadbeef)') === '89f8spxm');
ck('pkh([d34db33f/44\'/0\'/0\']xpub…/1/*)#ml40v0wf (Core doc/descriptors.md)',
    descriptorChecksum("pkh([d34db33f/44'/0'/0']xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL/1/*)") === 'ml40v0wf');

// Build the BIP-84 "abandon … about" descriptor the way the Descriptor tool does.
const root = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'));
const fp = root.fingerprint.toString(16).padStart(8, '0');
const acct = root.derive("m/84'/0'/0'");
const body84 = `wpkh([${fp}/84'/0'/0']${acct.publicExtendedKey}/<0;1>/*)`;
const desc84 = `${body84}#${descriptorChecksum(body84)}`;
ck('agrees with boot.html desc_checksum on the tool\'s descriptor', desc_checksum(body84) === descriptorChecksum(body84));
for (const b of ['raw(deadbeef)', "tr([00000000/86'/0'/0']xpubX/1/*)", 'wsh(sortedmulti(2,a,b,c))', 'addr(bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu)']) {
    ck(`agrees with boot.html desc_checksum: ${b.slice(0, 32)}`, desc_checksum(b) === descriptorChecksum(b));
}

console.log('\n2. Single-sig split (BIP-84 abandon)');
const req = buildCoreImport(desc84);
ck('two entries', req.length === 2);
ck('receive is /0/*, internal false', req[0].desc.includes(`${acct.publicExtendedKey}/0/*)`) && req[0].internal === false);
ck('change is /1/*, internal true', req[1].desc.includes(`${acct.publicExtendedKey}/1/*)`) && req[1].internal === true);
ck('no multipath step left', !req.some((r) => r.desc.includes('<')));
ck('both checksums valid', req.every((r) => valid(r.desc)));
ck('both active, range [0, 999], timestamp 0', req.every((r) => r.active === true && r.range[0] === 0 && r.range[1] === CORE_RANGE_END && r.timestamp === 0));
ck('timestamp "now" honoured', buildCoreImport(desc84, { timestamp: 'now' }).every((r) => r.timestamp === 'now'));
ck('checksum-less input accepted', JSON.stringify(buildCoreImport(body84)) === JSON.stringify(req));
{
    // Derive index 0 from each split descriptor's own key + path.
    const firstAddr = (d) => {
        const m = d.match(/\](xpub[1-9A-HJ-NP-Za-km-z]+)\/(\d)\/\*/);
        return btc.p2wpkh(HDKey.fromExtendedKey(m[1]).deriveChild(Number(m[2])).deriveChild(0).publicKey).address;
    };
    ck('receive #0 = bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu (BIP-84)', firstAddr(req[0].desc) === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', firstAddr(req[0].desc));
    ck('change #0 = bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el (BIP-84)', firstAddr(req[1].desc) === 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el', firstAddr(req[1].desc));
}

console.log('\n3. Multisig split');
{
    const keys = [0, 1, 2].map((i) => `[${String(i).repeat(8)}/48'/0'/0'/2']${root.derive(`m/48'/0'/${i}'/2'`).publicExtendedKey}/<0;1>/*`);
    const body = `wsh(sortedmulti(2,${keys.join(',')}))`;
    const [r, c] = buildCoreImport(`${body}#${descriptorChecksum(body)}`);
    ck('receive: all three keys on /0/*', (r.desc.match(/\/0\/\*/g) || []).length === 3 && !r.desc.includes('/1/*'));
    ck('change: all three keys on /1/*', (c.desc.match(/\/1\/\*/g) || []).length === 3 && !c.desc.includes('/0/*'));
    ck('checksums valid', valid(r.desc) && valid(c.desc));
}

console.log('\n4. Refusals');
ck('xprv refused', throws(() => buildCoreImport(`wpkh(${root.derive("m/84'/0'/0'").privateExtendedKey}/<0;1>/*)`), /private key/));
ck('sp() refused', throws(() => buildCoreImport('sp(spscan1qexample)'), /Silent Payments/));
ck('wrong checksum refused', throws(() => buildCoreImport(`${body84}#aaaaaaaa`), /checksum/));
ck('<0;2> refused', throws(() => buildCoreImport(body84.replace('<0;1>', '<0;2>')), /multipath/));
ck('<0;1;2> refused', throws(() => buildCoreImport(body84.replace('<0;1>', '<0;1;2>')), /multipath/));
ck('bad timestamp refused', throws(() => buildCoreImport(desc84, { timestamp: 12345 }), /timestamp/));
ck('empty refused', throws(() => buildCoreImport('  '), /No descriptor/));

console.log('\n5. Already split / non-ranged');
{
    const [r] = buildCoreImport(body84.replace('<0;1>', '1'));
    ck('/1/* alone → one internal entry', r.internal === true && r.active === true);
    const [a] = buildCoreImport('addr(bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu)');
    ck('non-ranged → no range/active/internal', !('range' in a) && !('active' in a) && !('internal' in a) && valid(a.desc));
}
{
    const cmds = coreImportInstructions('X.json');
    ck('instructions create a blank watch-only wallet', /disable_private_keys=true/.test(cmds[0]) && /blank=true/.test(cmds[0]));
    ck('instructions import the file into it', cmds[1].includes('-rpcwallet=safekeep-watch importdescriptors "$(cat X.json)"'));
}

console.log('\n6. Wiring');
{
    const entry = readFileSync(new URL('./boot-entry.js', import.meta.url), 'utf8');
    ck('boot-entry.js imports the module', entry.includes("import './shared/core-import.js'"));
    ck('export button present', html.includes('onclick="desc_exportCore()"'));
    const fn = html.slice(html.indexOf('function desc_exportCore('), html.indexOf('function desc_toggleQR('));
    ck('export uses CoreImport.buildCoreImport and the shared save helper', fn.includes('CI.buildCoreImport(') && fn.includes('_descSaveFile('));
    ck('"brand-new wallet" box maps to timestamp "now", else 0', fn.includes("fresh.checked ? 'now' : 0"));
    ck('.txt export still saves through the helper', html.includes("_descSaveFile('CUSTOM-DESCRIPTOR-' + ts + '.txt', content, 'text/plain');"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * test-bcur-account.mjs — Seed Management's BC-UR account export
 * (ARM_URH.encodeAccountAsCryptoAccountUR) decodes with a standard BC-UR
 * decoder to the right fingerprint, key, path and script type.
 *
 * It used to be written as "ur:crypto-account/1-1/…": a sequence header on
 * a part that isn't fountain-coded, which standard decoders reject, so
 * Sparrow kept scanning without ever reading it.
 *
 * Run: node test-bcur-account.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { URDecoder } from '@ngraveio/bc-ur';
import CBOR from 'cbor-sync';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'boot.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  got: ' + x)); };

// The ARM_URH module: `var ARM_URH = (function () { … })();`
const start = SRC.indexOf('var ARM_URH = (function () {');
const end = SRC.indexOf('\n})();', start) + 6;
const ctx = vm.createContext({});
vm.runInContext(SRC.slice(start, end), ctx);
const URH = ctx.ARM_URH;

const seed = bip39.mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const root = HDKey.fromMasterSeed(seed);
const fp = root.fingerprint.toString(16).padStart(8, '0');

// cbor-sync drops CBOR tags when decoding, so the script tags are checked
// in the raw bytes: tag n (256..65535) is d9 <n as 2 bytes>.
const tagBytes = (tags) => Buffer.concat(tags.map((t) => Buffer.from([0xd9, t >> 8, t & 0xff])));

for (const [type, isMulti, path, tags] of [
    ['84', false, "m/84'/0'/0'", [404, 303]],
    ['86', false, "m/86'/0'/0'", [409, 303]],
    ['84', true, "m/48'/0'/0'/2'", [401, 303]],
]) {
    const node = root.derive(path);
    const ur = URH.encodeAccountAsCryptoAccountUR(node, fp, path, type, isMulti);
    const label = `${isMulti ? 'multisig' : 'single-sig'} ${path}`;
    ck(`${label}: single-part UR, no sequence header`, /^ur:crypto-account\/[a-z]+$/.test(ur), ur.slice(0, 30));
    const dec = new URDecoder();
    let result = null;
    try { dec.receivePart(ur.toUpperCase()); result = dec.isSuccess() ? dec.resultUR() : null; } catch (e) { result = null; }
    ck(`${label}: a standard decoder reads it (also upper-case, as shown)`, result && result.type === 'crypto-account');
    if (!result) continue;
    const acct = CBOR.decode(result.cbor);
    ck(`${label}: master fingerprint ${fp}`, (acct[1] >>> 0) === root.fingerprint, acct[1]);
    ck(`${label}: script tags ${tags.join(' → ')} (crypto-account 311 outside)`,
        result.cbor.indexOf(tagBytes([311])) === 0 && result.cbor.indexOf(tagBytes(tags)) > 0);
    const key = Buffer.from(acct[2][0][3]);
    ck(`${label}: public key matches ${path}`, key.equals(Buffer.from(node.publicKey)));
}

console.log(`\nBC-UR ACCOUNT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

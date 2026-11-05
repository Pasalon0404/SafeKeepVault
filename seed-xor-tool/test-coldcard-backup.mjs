/**
 * test-coldcard-backup.mjs — reading a COLDCARD backup (shared/coldcard-backup.js)
 *
 *   1. COLDCARD's own sample backups (from its firmware repository) open
 *      with their published 12-word passwords and give the documented
 *      recovery words; a wrong password is refused.
 *   2. Backups built here in COLDCARD's exact layout (a port of
 *      compat7z.py's Builder, below) open the same way, at other key
 *      stretching levels and with a Q's typed password. If the standard 7z
 *      tool is installed, it must open them too: proof the layout is the
 *      real 7z format and not only our reading of it.
 *   3. Damaged and foreign files are refused before any password is tried.
 *   4. The backup text: the words, raw_secret, xprv and fingerprint are
 *      cross-checked; a passphrase-wallet backup (no words) is recognised.
 *   5. Multisig wallets (setting.multisig, MultisigWallet.serialize) become
 *      descriptors whose first receive address matches one worked out here
 *      independently with @scure/btc-signer, for P2WSH, P2SH-P2WSH, P2SH,
 *      per-key paths, unsorted keys, SLIP-132 keys and old 2-element keys.
 *   6. Wiring: boot.html (file, USB and Courier all go through one check),
 *      SafeKeepOS.coldcardBackup and the COLDCARD helper's backup action
 *      (its behaviour is tested with a fake COLDCARD in
 *      usbbootdrive/tests/test-coldcard-helper.py).
 *
 * Run:  node test-coldcard-backup.mjs
 */
import {
    openColdcardBackup, parseColdcard7z, parseBackupText, summarizeBackup,
    multisigToDescriptor, xfpToHex, crc32, deriveKey, toStandardXpub,
} from './shared/coldcard-backup.js';
import { createHash, randomBytes, createCipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

// COLDCARD's sample backups, copied byte for byte from
// https://github.com/Coldcard/firmware: docs/backup.7z (password published
// in docs/backup-files.md) and testing/data/tip-index-…-initial.7z (the
// password is its file name).
// (c) Copyright 2020 by Coinkite Inc. Permission is hereby granted, free of
// charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without
// restriction … The above copyright notice and this permission notice shall
// be included in all copies or substantial portions of the Software.
const SAMPLE_DOCS = Buffer.from('N3q8ryccAANG3l66MAIAAAAAAABuAAAAAAAAAOBcoA5oGlcK7Vt3iepKhHLUdda9RRP8amY0RzAeyAiOvE9PTR2k/JMuCP8opHHN9/5INWk6a8jr5JBs9SQSVUC7IFnlrtVie80ntkwV9c9obOkwh5bdHdGY5ePPzrOBR/N6FLjB8khVaQk/qqV+nzxZqcG2caaHv50OJrwUnu082QyQWn3q2EorFaLPmzg6/aiitUnYVgNqJmXGsslaZ7DHRApnOjYpQ+aG2Pe5NizYvDE2Rru6rncfsCXmznpYZ8GKmWmEiZTcw2/MG+hOAMp7OYJqjcpPgSGV17ii+e3TePiiGzEAQGCjoiafCPmcS9v0hvNCi5tqfpWpRxiigxNABh/wAuZIWQjKN63OKGIvqxt6lxpJwwTcift7RNTBRaN+ldhHRIrz0rrv1/0R4FW5HvnukW2cSz2IvNf7BxASQbi3TmortHI4Srv5ZTIAb+wKuPYaC7iaaqctQOTKB6oPQo+0YpWwArjHJQZISzvVvVBxJrIIlQCqOUZ0RXPl/lmuFNTxJUfIE0K873/TVlJd5ngZaBwZRlI07RiEp1+ISUuJBmcU3DRZt5rtk8qxs6mLtzm5H6Dtl/oMFN0IuqUYNLdITRqyLj0mRywotWWRxjuGaVFxIIjBxw01vxajIKTDHugCHpn4J1PfFDA3IggQ5GJVcU0l6QB0deCeplE8KVsnqzdx8SNv5CCvdGiTLD8uINtW8F9YICeoax+JKybASwDj6jWH9WmfCfbgo8erwvM1qAEEBgABCcAwAgAHCwEAASQG8QcBIs3/CgEBKDelZywfg9Z0rTFlJSmVFCj8wUaTUYOWiv0wmX8BAAzALwIACAoBlds7cQAABQERIQBjAGsAYwBjAC0AYgBhAGMAawB1AHAALgB0AHgAdAAAAAAA', 'base64');
const SAMPLE_TIP = Buffer.from('N3q8ryccAAM918tHIAMAAAAAAABuAAAAAAAAAIWrMibVaat48XTshOggEJYFGryymlwmPD3NtpB053cQ0vmZv6UnLk1CZwjzgb9Nohoaqroaku/rdaOP5I0XXJ4VPqBrLO0F2MPsJWuc23OzOuj96/SrewRBAaQdiOvNzIiXw54Kk9MX5cIvvH51IAcG6t+aHvk6bXjIv2dgPOnoesLOl60wGZWUYHJIPxLuEzaExDPydgEIFp79eBt0N7qjlLaNKsVWvyPze5+ZoJeuvw2qKdLan17g/ltt3NCsQuMZkwkqjGsWMdFcL3ThZt59QDebajHenVFrsLsckx5xTbRn5dFOJZxXOeMm2nbco/VJMWNSMXWZyGt5/93EVy0ul0Ep3pXNHb730ktgcuL/p3FeqBAbCCUA8IrYgrA51Av0hpk26ZtoSOhGvl6WbTRywoXPEIPiz8jy0uZQuytWdRzoBdt3RzfhCvNGl09lgV1RHgJG6uUIfAraftpiXfrYS9Y+eHHDJjwsz0Swqo8wGSoP57mQWhaaRNd6ZDsMe9erbhR4iLbEyBgd5+VaSTf5gJO3e5biseGccWmxVlQAfrJ8D+tzcMCdsHnK/GDBdds0SL3YSkT/R+IGpZwo0F5yGhpZchgjZs6M2P/PBfnCRzaJKlNefSYgBZezwqK0chznYfNZgMBfkNdj0PvHQiVirogjRCnbpyf1XNY/0i6A4lpjd1MVFRTv29wpUEySioeP/4AFcS/umoExPCsJRfM6P72XLuF7o5mu4W8RBMN/YrjJlS55jv1zc3oZwduXehOe9d7KgD3FOPz7yqRqsXKASAAuTo/E577Cj1jy1ujx8YbfG9TfuPcHPQWLSFHcsgqYkZv3UPmrc1BS6Rs1waRDtdXXQ/78hdoD60WQ/odz8t5JMdG/UsOt7gHLkXCRw7CqmRP6jB5/aGogua9WmuNjupLRj1XxFXjcwE6e9cBA8MCIROqlmonHxwJppqNBxJQOnxuhGD0xRLfBtgteYs92gsetb3mpHnL7VnSgMzBy2demSTp6N68DgGMVpsb7iUcZHoY7l2NT9w6J2ZOaDPVhkwHBxtOijJ6L76NWR5iM7oN0zQEEBgABCcAgAwAHCwEAASQG8QcBIs3/pFByu/gMc5Xrpij3j2npoLfcyeieutTNcvpAIg0WHKoBAAzAHAMACAoB6rFMgwAABQERIQBjAGsAYwBjAC0AYgBhAGMAawB1AHAALgB0AHgAdAAAAAAA', 'base64');

// ---- compat7z.py Builder, ported: write a COLDCARD-style backup.7z ----
function var64(n) {
    if (n < 127) return Buffer.from([n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = 0xc0; b.writeUInt16LE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = 0xf0; b.writeUInt32LE(n, 1); return b;
}
const crc = (b) => crc32(new Uint8Array(b));
const utf16 = (s) => { const u = Buffer.from(s, 'utf8'); const o = Buffer.alloc(u.length * 2); u.forEach((c, i) => { o[i * 2] = c; }); return o; };
function keyOf(password, salt, pow) {
    const h = createHash('sha256'), pw = utf16(password);
    for (let i = 0; i < 2 ** pow; i++) { const c = Buffer.alloc(8); c.writeBigUInt64LE(BigInt(i)); h.update(salt); h.update(pw); h.update(c); }
    return h.digest();
}
function makeColdcard7z(text, password, { pow = 13, inner = 'zoo427.txt' } = {}) {
    const raw = Buffer.from(text, 'utf8');
    const salt = randomBytes(16), iv = randomBytes(16);
    const padded = Buffer.concat([raw, Buffer.alloc((16 - (raw.length % 16)) % 16)]);
    const c = createCipheriv('aes-256-cbc', keyOf(password, salt, pow), iv); c.setAutoPadding(false);
    const body = Buffer.concat([c.update(padded), c.final()]);
    const props = Buffer.concat([Buffer.from([0xc0 | pow, 0xff]), salt, iv]);
    const name = utf16(inner + '\u0000');
    const crcB = Buffer.alloc(4); crcB.writeUInt32LE(crc(raw));
    const sh = Buffer.concat([
        Buffer.from([0x01, 0x04, 0x06, 0x00, 0x01, 0x09]), var64(body.length), Buffer.from([0x00]),
        Buffer.from([0x07, 0x0b, 0x01, 0x00, 0x01, 0x24, 0x06, 0xf1, 0x07, 0x01]), var64(props.length), props,
        Buffer.from([0x01, 0x00, 0x0c]), var64(raw.length), Buffer.from([0x00]),
        Buffer.from([0x08, 0x0a, 0x01]), crcB, Buffer.from([0x00]), Buffer.from([0x00]),
        Buffer.from([0x05, 0x01, 0x11]), var64(name.length + 1), Buffer.from([0x00]), name,
        Buffer.from([0x00, 0x00]),
    ]);
    const sect = Buffer.alloc(20); sect.writeBigUInt64LE(BigInt(body.length), 0); sect.writeBigUInt64LE(BigInt(sh.length), 8); sect.writeUInt32LE(crc(sh), 16);
    const fh = Buffer.alloc(12); Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x03]).copy(fh); fh.writeUInt32LE(crc(sect), 8);
    return new Uint8Array(Buffer.concat([fh, sect, body, sh]));
}

// The backup text, as render_backup_contents() writes it.
function backupText(fields) {
    return '# Coldcard backup file! DO NOT CHANGE.\n\n# Private key details: Bitcoin\n' +
        Object.entries(fields).map(([k, v]) => k + ' = ' + JSON.stringify(v)).join('\n') + '\n\n# EOF\n';
}
const entropyHex = (m) => Buffer.from(bip39.mnemonicToEntropy(m, wordlist)).toString('hex');
const fpOf = (m) => HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(m)).fingerprint.toString(16).padStart(8, '0').toUpperCase();
const xfpInt = (hex) => Buffer.from(hex, 'hex').readUInt32LE(0);   // COLDCARD's str2xfp
function walletFields(m, extra = {}) {
    const root = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(m));
    const marker = (0x80 | ({ 12: 0, 18: 1, 24: 2 }[m.split(' ').length])).toString(16);
    return { mnemonic: m, chain: 'BTC', xprv: root.privateExtendedKey, xpub: root.publicExtendedKey,
             raw_secret: (marker + entropyHex(m)).replace(/0+$/, ''), fw_date: '2026-10-01', fw_version: '6.4.0X', ...extra };
}

console.log('\n1. COLDCARD\'s own sample backups');
{
    const docsPw = 'spice until comfort zoo divide album erode yard inmate change quantum skate';
    const tipPw = 'tip index famous embark tobacco rice attitude interest mask random amazing initial';
    const a = parseColdcard7z(new Uint8Array(SAMPLE_DOCS));
    ck('docs/backup.7z: header read without the password (ckcc-backup.txt, 559 bytes, 2^13 rounds)', a.name === 'ckcc-backup.txt' && a.unpackedSize === 559 && a.roundsPow === 13);
    const o = await openColdcardBackup(new Uint8Array(SAMPLE_DOCS), docsPw);
    const s = summarizeBackup(parseBackupText(o.text));
    ck('opens with the published password and gives the documented 24 words',
        s.mnemonic === 'index abuse oil swift wolf clarify broom auto student media ribbon blossom hundred brief tomato abandon copy design angle memory narrow urge bulk resemble' && s.problems.length === 0, JSON.stringify(s.problems));
    ck('its raw_secret agrees with the words', s.problems.length === 0);
    const t = summarizeBackup(parseBackupText((await openColdcardBackup(new Uint8Array(SAMPLE_TIP), tipPw)).text));
    ck('the testing sample opens too: 24 words, xprv and recorded fingerprint agree', t.words === 24 && t.problems.length === 0 && t.notesForUser.length === 0 && t.fingerprint === fpOf(t.mnemonic), JSON.stringify([t.problems, t.notesForUser]));
    ck('a wrong word is refused', /Wrong password/.test(await rejects(openColdcardBackup(new Uint8Array(SAMPLE_DOCS), docsPw.replace('spice', 'spicy')))));
    ck('words in capitals are a different password (the screen lower-cases them)', /Wrong password/.test(await rejects(openColdcardBackup(new Uint8Array(SAMPLE_DOCS), docsPw.toUpperCase()))));
    ck('an empty password is refused', /Enter the backup password/.test(await rejects(openColdcardBackup(new Uint8Array(SAMPLE_DOCS), ' '))));
}

console.log('\n2. Backups built in COLDCARD\'s layout');
const M1 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const M2 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const M3 = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const PW12 = 'zoo wrist cabin oven pepper zebra bless fiction aware lunch hint arrest';
const has7z = ['/usr/bin/7z', '/usr/bin/7za', '/usr/local/bin/7z', '/opt/homebrew/bin/7z', '/usr/local/bin/7zz', '/opt/homebrew/bin/7zz'].find(existsSync);
{
    const text = backupText(walletFields(M1));
    for (const pow of [13, 16, 19]) {
        const f = makeColdcard7z(text, PW12, { pow });
        const s = summarizeBackup(parseBackupText((await openColdcardBackup(f, PW12)).text));
        ck(`2^${pow} rounds: opens, words and fingerprint 73C5DA0A`, s.mnemonic === M1 && s.fingerprint === '73C5DA0A' && !s.problems.length, JSON.stringify(s.problems));
    }
    const qpw = 'My Coldcard Q password, typed on its keyboard! 2026';
    const fq = makeColdcard7z(text, qpw);
    ck('a COLDCARD Q typed password works exactly as typed', (await openColdcardBackup(fq, qpw)).text === text);
    ck('…and not in lower case', /Wrong password/.test(await rejects(openColdcardBackup(fq, qpw.toLowerCase()))));
    ck('derived key matches node:crypto', Buffer.from(deriveKey(PW12, new Uint8Array(16).fill(7), 13)).equals(keyOf(PW12, Buffer.alloc(16, 7), 13)));
    ck('clear-text backup.txt (COLDCARD\'s no-password option) is read too', summarizeBackup(parseBackupText((await openColdcardBackup(new TextEncoder().encode(text), '')).text)).mnemonic === M1);
    if (has7z) {
        const dir = mkdtempSync(join(tmpdir(), 'ccbk-'));
        try {
            writeFileSync(join(dir, 'backup.7z'), makeColdcard7z(text, PW12, { inner: 'zoo427.txt' }));
            const out = execFileSync(has7z, ['x', '-y', '-o' + dir, '-p' + PW12, join(dir, 'backup.7z')], { encoding: 'utf8' });
            ck('the standard 7z tool opens a backup built here, with the same text', /Everything is Ok/.test(out) && readFileSync(join(dir, 'zoo427.txt'), 'utf8') === text);
            const cc = join(dir, 'cc.7z'); writeFileSync(cc, SAMPLE_DOCS);
            ck('…and COLDCARD\'s own sample (sanity check of the tool)', /Everything is Ok/.test(execFileSync(has7z, ['x', '-y', '-o' + join(dir, 'cc'), '-pspice until comfort zoo divide album erode yard inmate change quantum skate', cc], { encoding: 'utf8' })));
            // A normal 7z made by the tool (compressed, header encrypted) is not a COLDCARD backup.
            writeFileSync(join(dir, 'other.txt'), 'hello');
            execFileSync(has7z, ['a', '-y', '-p' + PW12, '-mhe=on', join(dir, 'other.7z'), join(dir, 'other.txt')], { encoding: 'utf8' });
            const msg = await rejects(openColdcardBackup(new Uint8Array(readFileSync(join(dir, 'other.7z'))), PW12));
            ck('an ordinary 7z archive is refused before decrypting', /wasn’t made by a COLDCARD/.test(msg || ''), msg);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    } else {
        console.log('  [SKIP] 7z tool not installed: cross-check with the standard 7z tool skipped');
    }
}

console.log('\n3. Damaged and foreign files');
{
    const f = makeColdcard7z(backupText(walletFields(M1)), PW12);
    ck('a cut-off file is refused', /incomplete|damaged/.test(await rejects(openColdcardBackup(f.slice(0, f.length - 10), PW12))));
    const t1 = f.slice(); t1[f.length - 20] ^= 1;
    ck('a changed header is refused', /damaged/.test(await rejects(openColdcardBackup(t1, PW12))));
    const t2 = f.slice(); t2[40] ^= 1;
    ck('a changed encrypted body fails the CRC', /Wrong password, or the file is damaged/.test(await rejects(openColdcardBackup(t2, PW12))));
    ck('a text file that isn\'t a backup is refused', /isn’t a COLDCARD backup/.test(await rejects(openColdcardBackup(new TextEncoder().encode('hello'), ''))));
    ck('an empty file is refused', /empty/.test(await rejects(openColdcardBackup(new Uint8Array(0), PW12))));
    const big = new Uint8Array(300 * 1024); big.set(f.subarray(0, 32));
    ck('a huge file is refused', /too large/.test(await rejects(openColdcardBackup(big, PW12))));
    const p20 = f.slice(); const hdrAt = f.length - Number(Buffer.from(f.subarray(20, 28)).readBigUInt64LE());
    const propsAt = Buffer.from(p20).indexOf(Buffer.from([0x06, 0xf1, 0x07, 0x01]), hdrAt) + 5;
    p20[propsAt] = 0xc0 | 30;
    // fix the header CRCs so only the rounds are wrong
    const sh = p20.subarray(hdrAt); Buffer.from(p20.buffer).writeUInt32LE(crc(sh), 28);
    Buffer.from(p20.buffer).writeUInt32LE(crc(p20.subarray(12, 32)), 8);
    ck('a file asking for 2^30 rounds of key stretching is refused', /too much key stretching/.test(await rejects(openColdcardBackup(p20, PW12))));
}

console.log('\n4. What the backup holds');
{
    const s = summarizeBackup(parseBackupText(backupText(walletFields(M2, { 'setting.notes': [{ title: 'a' }, { title: 'b' }], 'setting.seeds': [['AABBCCDD', '80aa', 'x', 'y']] }))));
    ck('12 words, fingerprint, firmware, notes and Seed Vault counted', s.words === 12 && s.fingerprint === fpOf(M2) && s.firmware === '6.4.0X · 2026-10-01' && s.notes === 2 && s.seedVault === 1 && !s.problems.length, JSON.stringify(s));
    const bad = walletFields(M2); bad.raw_secret = '80' + 'ff'.repeat(16);
    ck('raw_secret that disagrees with the words: refused', summarizeBackup(parseBackupText(backupText(bad))).problems.some((p) => /don’t match the rest/.test(p)));
    const pp = walletFields(M2); pp.xprv = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(M2, 'secret')).privateExtendedKey;
    const ps = summarizeBackup(parseBackupText(backupText(pp)));
    ck('an xprv from a passphrase: a note, not a refusal', !ps.problems.length && ps.notesForUser.some((n) => /passphrase/.test(n)));
    const fieldsNoWords = walletFields(M2); delete fieldsNoWords.mnemonic; fieldsNoWords.raw_secret = '01ab';
    const nw = summarizeBackup(parseBackupText(backupText(fieldsNoWords)));
    ck('a passphrase-wallet backup (xprv only) is recognised', nw.passphraseWallet && !nw.mnemonic && !nw.problems.length);
    const inv = walletFields(M2); inv.mnemonic = M2.replace('yellow', 'abandon');
    ck('invalid words are refused', summarizeBackup(parseBackupText(backupText(inv))).problems.some((p) => /valid BIP-39/.test(p)));
    ck('an old setting.xfp in either byte order is accepted', ['', 'r'].every((r) => {
        const f = walletFields(M1); const hex = r ? '0ADAC573' : '73C5DA0A';
        f['setting.xfp'] = Buffer.from(hex, 'hex').readUInt32LE(0);
        return summarizeBackup(parseBackupText(backupText(f))).problems.length === 0;
    }));
    const wrongXfp = walletFields(M1); wrongXfp['setting.xfp'] = 12345;
    ck('a setting.xfp of another seed is refused', summarizeBackup(parseBackupText(backupText(wrongXfp))).problems.some((p) => /fingerprint/.test(p)));
    ck('xfpToHex is COLDCARD\'s xfp2str (little-endian)', xfpToHex(xfpInt('73C5DA0A')) === '73C5DA0A');
}

console.log('\n5. Multisig wallets → descriptors');
{
    const acct = (m, path) => { const k = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(m)).derive(path.replace(/h/g, "'")); return { xfp: xfpInt(fpOf(m)), xpub: k.publicExtendedKey, fp: fpOf(m) }; };
    const seeds = [M1, M2, M3];
    const P = "m/48h/0h/0h/2h";
    const legs = seeds.map((m) => acct(m, P));
    // Independent first receive address: derive /0/0 from each xpub, sort the
    // keys if sortedmulti, build the script with @scure/btc-signer.
    const firstAddr = (keys, M, kind, sorted = true) => {
        let pubs = keys.map((k) => HDKey.fromExtendedKey(k.xpub).deriveChild(0).deriveChild(0).publicKey);
        if (sorted) pubs = pubs.slice().sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        const ms = btc.p2ms(M, pubs);
        return kind === 'p2wsh' ? btc.p2wsh(ms).address : kind === 'p2sh' ? btc.p2sh(ms).address : btc.p2sh(btc.p2wsh(ms)).address;
    };
    // The app's own descriptor reader isn't loadable here, so check the
    // descriptor's address with a small reader for the forms we write.
    const descAddr = (desc) => {
        const m = desc.match(/^(wsh|sh)\((wsh\()?(sortedmulti|multi)\((\d+),(.*?)\)\)?\)$/);
        const keys = m[5].split(',').map((k) => ({ xpub: k.replace(/^\[[^\]]*\]/, '').replace('/<0;1>/*', '') }));
        return firstAddr(keys, Number(m[4]), m[1] === 'wsh' ? 'p2wsh' : m[2] ? 'p2sh-p2wsh' : 'p2sh', m[3] === 'sortedmulti');
    };
    const rec = (name, M, fmt, extra = {}) => [name, [M, legs.length], legs.map((l) => [l.xfp, l.xpub]), { pp: P, ...(fmt != null ? { ft: fmt } : {}), ...extra }];
    const cases = [
        ['P2WSH 2-of-3', rec('Family', 2, 14), 'p2wsh', 'wsh(sortedmulti('],
        ['P2SH-P2WSH 2-of-3', rec('Nested', 2, 26), 'p2sh-p2wsh', 'sh(wsh(sortedmulti('],
        ['legacy P2SH (no ft: COLDCARD\'s default)', rec('Legacy', 2, null), 'p2sh', 'sh(sortedmulti('],
    ];
    for (const [label, r, kind, prefix] of cases) {
        const w = multisigToDescriptor(r);
        ck(`${label}: descriptor shape`, w.descriptor.startsWith(prefix) && w.M === 2 && w.N === 3 && w.format === kind, w.descriptor.slice(0, 60));
        ck(`  first address matches an independent calculation`, descAddr(w.descriptor) === firstAddr(legs, 2, kind), descAddr(w.descriptor));
        ck(`  key origins are [fingerprint/48'/0'/0'/2']`, w.keys.every((k, i) => k.fingerprint === legs[i].fp && w.descriptor.includes('[' + legs[i].fp.toLowerCase() + "/48'/0'/0'/2']" + legs[i].xpub + '/<0;1>/*')));
    }
    // Per-key paths: keys [xfp, index, xpub] with opts.d.
    const P2 = "m/48h/0h/1h/2h";
    const mixed = [legs[0], acct(M2, P2), legs[2]];
    const r4 = ['Mixed paths', [2, 3], [[mixed[0].xfp, 0, mixed[0].xpub], [mixed[1].xfp, 1, mixed[1].xpub], [mixed[2].xfp, 0, mixed[2].xpub]], { ft: 14, d: [P, P2] }];
    const w4 = multisigToDescriptor(r4);
    ck('per-key paths (opts.d): each key gets its own path', w4.descriptor.includes("/48'/0'/1'/2']") && w4.keys[1].path === "m/48'/0'/1'/2'" && descAddr(w4.descriptor) === firstAddr(mixed, 2, 'p2wsh'));
    const r5 = rec('Unsorted', 2, 14); r5.push(0);
    const w5 = multisigToDescriptor(r5);
    ck('a 5th element 0 (no BIP-67): multi() in the given order', w5.descriptor.startsWith('wsh(multi(') && !w5.sorted && descAddr(w5.descriptor) === firstAddr(legs, 2, 'p2wsh', false));
    // SLIP-132 Zpub keys come out as xpub.
    const b58 = createBase58check(sha256);
    const toZpub = (x) => { const r = b58.decode(x); r.set([0x02, 0xaa, 0x7e, 0xd3], 0); return b58.encode(r); };
    const rz = ['Zpub', [2, 3], legs.map((l) => [l.xfp, toZpub(l.xpub)]), { pp: P, ft: 14 }];
    ck('SLIP-132 Zpub keys are written as xpub', multisigToDescriptor(rz).descriptor === multisigToDescriptor(rec('Zpub', 2, 14)).descriptor);
    ck('toStandardXpub refuses a private key', (() => { try { toStandardXpub(HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(M1)).privateExtendedKey); return false; } catch { return true; } })());
    ck('an unknown address type is refused', (() => { try { multisigToDescriptor(rec('x', 2, 35)); return false; } catch (e) { return /address type/.test(e.message); } })());
    ck('a wrong key count is refused', (() => { try { multisigToDescriptor(['x', [2, 4], legs.map((l) => [l.xfp, l.xpub]), { pp: P }]); return false; } catch { return true; } })());
    // In a whole backup: which key is ours, and broken records are reported.
    const f = walletFields(M2, { 'setting.multisig': [rec('Family', 2, 14), ['Broken', [2, 3], [], {}]] });
    const s = summarizeBackup(parseBackupText(backupText(f)));
    ck('in a backup: the wallet is listed and key 2 is this seed', s.multisig.length === 1 && s.multisig[0].mine === 1 && s.multisig[0].name === 'Family');
    ck('…and a broken record is reported, not hidden', s.multisigErrors.length === 1 && /Broken/.test(s.multisigErrors[0]));
    const end = await openColdcardBackup(makeColdcard7z(backupText(f), PW12), PW12);
    ck('…and the same comes out of an encrypted file', summarizeBackup(parseBackupText(end.text)).multisig[0].descriptor === s.multisig[0].descriptor);
}

console.log('\n6. boot.html wiring');
{
    const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
    const entry = readFileSync(new URL('./boot-entry.js', import.meta.url), 'utf8');
    const fn = (name) => { const a = html.indexOf(name); if (a < 0) return ''; const n = [html.indexOf('\nfunction ', a + 10), html.indexOf('\nasync function ', a + 10)].filter((i) => i > 0); return html.slice(a, Math.min(...n)); };
    ck('boot-entry.js loads the module', entry.includes("import './shared/coldcard-backup.js'"));
    ck('welcome offers a COLDCARD backup card', html.includes('onclick="showColdcardRecoveryPanel()"') && html.includes('<b>COLDCARD backup</b>'));
    ck('the panel has a file picker, 12 word boxes and a Q password field', html.includes('id="ccb-file-input"') && fn('function ccb_reset').includes('count: 12') && html.includes('id="ccb-typed"'));
    ck('the 12 words are joined lower-case with single spaces', fn('function _ccbPassword').includes("words.join(' ').toLowerCase()"));
    const restore = fn('async function ccb_restore');
    ck('restore uses the same seed path as the other restores (and none in a Temporary Session)', restore.includes('_isEphemeralBoot()') && restore.includes('_ephemeralCommitSeed(s.mnemonic)') && restore.includes('SafeKeepOS.restoreMasterSeed(s.mnemonic)'));
    ck('restore stops on a failed disk write', restore.includes("result.diskVerified === false && !_SKB_DEV_MODE") && restore.indexOf('return;') < restore.indexOf('_ccbSaveMultisig'));
    ck('only ticked multisig wallets are saved, through the saved-wallet checks', restore.includes('.ccb-ms-pick') && fn('async function _ccbSaveMultisig').includes('_savedWalletParse(w.descriptor)') && fn('async function _ccbSaveMultisig').includes('_savedWalletsStore(list)'));
    ck('no restore button when the file has problems or no words', fn('function _ccbRenderReview').includes("if (!s.problems.length && !s.passphraseWallet)"));
    ck('Back forgets the file, the password and the words', fn('function ccb_reset').includes('_ccbBytes.fill(0)') && fn('function ccb_reset').includes("_ccbSummary.mnemonic = ''") && fn('function hideColdcardRecoveryPanel').includes('ccb_reset()'));
    const bootjs = readFileSync(new URL('./shared/boot.js', import.meta.url), 'utf8');
    ck('SafeKeepOS.coldcardBackup asks the helper for "backup" and waits up to 11 minutes', /coldcardBackup\(\) \{\s*const r = await _coldcardRequest\(\{ action: 'backup' \}, 11 \* 60 \* 1000\)/.test(bootjs) && bootjs.includes('    coldcardBackup,\n'));
    ck('…and turns the base64 into bytes, dropping the base64', bootjs.includes('r.bytes = _ccFromBase64(r.backup_b64)') && bootjs.includes('delete r.backup_b64'));
    const helper = readFileSync(new URL('../usbbootdrive/safekeep-coldcard.py', import.meta.url), 'utf8');
    ck('the COLDCARD helper has a backup action: authenticity check, start, poll, download, SHA-256', ["'backup': do_backup", 'dev.check_mitm()', 'P.start_backup()', 'P.get_backup_file()', 'download_file(length, sha, file_number=0)', 'hashlib.sha256(backup).digest() != bytes(sha)'].every((x) => helper.includes(x)));
    ck('three ways in: USB, the Courier, a file', html.includes('onclick="ccb_fromUsb()"') && html.includes('onclick="ccb_courierStart()"') && html.includes('id="ccb-file-input"'));
    ck('every way in goes through the same check (_ccbLoadBytes)', ['async function ccb_fromUsb', 'function _ccbCourierOnScan', 'function ccb_fileChosen'].every((n) => fn(n).includes('_ccbLoadBytes(')));
    ck('a Courier-received backup stays in memory (nothing written to the Transfer Drive)', !/vaultTransferDriveHandle|getFileHandle|createWritable/.test(fn('function _ccbCourierOnScan') + fn('function _ccbLoadBytes')));
    ck('Back stops the camera', fn('function ccb_reset').includes('ccb_courierStop()'));
    for (const name of ['function _ccbShowInfo', 'function _ccbLoadBytes', 'async function ccb_fromUsb', 'async function ccb_courierStart', 'function ccb_courierStop', 'function _ccbCourierOnScan',
        'function showColdcardRecoveryPanel', 'function hideColdcardRecoveryPanel', 'function ccb_reset', 'function _ccbStatus', 'function ccb_togglePasswordMode', 'function _ccbPassword', 'function ccb_updateButton', 'function ccb_fileChosen', 'async function ccb_open', 'function _ccbRenderReview', 'async function _ccbSaveMultisig', 'async function ccb_restore']) {
        let ok = true, err = '';
        try { new Function(fn(name).replace(/^async function/, 'return async function').replace(/^function/, 'return function')); } catch (e) { ok = false; err = e.message; }
        ck(`${name.replace(/^(async )?function /, '')} parses`, ok, err);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

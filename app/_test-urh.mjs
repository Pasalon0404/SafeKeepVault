var ARM_URH = (function () {
    // ---- CBOR primitives (major type in high 3 bits) --------
    function head(major, n) {
        var mt = major << 5;
        if (n < 24)       return [mt | n];
        if (n < 0x100)    return [mt | 24, n & 0xff];
        if (n < 0x10000)  return [mt | 25, (n >>> 8) & 0xff, n & 0xff];
        // uint32 max
        return [mt | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    }
    function cUint(n)      { return head(0, n >>> 0); }
    function cBytes(u8)    { return head(2, u8.length).concat(Array.prototype.slice.call(u8)); }
    function cArray(items) {
        var out = head(4, items.length);
        for (var i = 0; i < items.length; i++) out = out.concat(items[i]);
        return out;
    }
    function cMap(entries) {
        // entries: [[keyBytes, valBytes], ...]
        var out = head(5, entries.length);
        for (var i = 0; i < entries.length; i++) {
            out = out.concat(entries[i][0]).concat(entries[i][1]);
        }
        return out;
    }
    function cTag(tagNum, inner) { return head(6, tagNum).concat(inner); }
    function cBool(b)            { return [b ? 0xf5 : 0xf4]; }

    // ---- CRC32 (IEEE 802.3) ---------------------------------
    var CRC_TABLE = (function () {
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(u8) {
        var c = 0xffffffff;
        for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }

    // ---- Bytewords (minimal) --------------------------------
    // Authoritative 256-word, 4-char table from Blockchain Commons.
    // Minimal encoding = first + last char of each word (2 chars/byte).
    var BW =
        'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbeta' +
        'biasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecola' +
        'cookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndraw' +
        'dropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfair' +
        'fernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagame' +
        'geargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawk' +
        'heathelphighhillholyhopehornhutsicedideaidleinchinkyintoiris' +
        'ironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokept' +
        'keyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplion' +
        'listlogoloudloveluaulucklungmainmanymathmazememomenumeowmild' +
        'mintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyx' +
        'openovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquad' +
        'quizraceramprealredorichroadrockroofrubyruinrunsrustsafesaga' +
        'scarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitent' +
        'tiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservast' +
        'veryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebs' +
        'whatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom';
    function bytewordsMinimal(u8) {
        var crc = crc32(u8);
        var n = u8.length;
        var withCrc = new Uint8Array(n + 4);
        withCrc.set(u8, 0);
        withCrc[n    ] = (crc >>> 24) & 0xff;
        withCrc[n + 1] = (crc >>> 16) & 0xff;
        withCrc[n + 2] = (crc >>>  8) & 0xff;
        withCrc[n + 3] =  crc         & 0xff;
        var out = '';
        for (var i = 0; i < withCrc.length; i++) {
            var idx = withCrc[i];
            out += BW[idx * 4] + BW[idx * 4 + 3];
        }
        return out;
    }

    // ---- Path / fingerprint helpers -------------------------
    function parsePath(path) {
        // "m/84'/0'/0'" → [{num:84,h:true},{num:0,h:true},{num:0,h:true}]
        var parts = String(path).replace(/^m\//, '').split('/');
        var res = [];
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (!p) continue;
            var h = /['h]$/.test(p);
            var n = parseInt(p.replace(/['h]$/, ''), 10);
            res.push({ num: n, h: h });
        }
        return res;
    }
    function fpHexToUint(fpHex) {
        // 8-char hex → uint32
        return (parseInt(fpHex, 16) >>> 0);
    }

    // ---- crypto-keypath (tag 304) inner map -----------------
    //   1: [components]     — flat [num, bool, num, bool, ...]
    //   2: source-fingerprint (uint32) — MASTER seed FP per Dave's spec
    //   3: depth (uint8)
    function buildKeypathInner(components, sourceFpUint, depth) {
        var arrItems = [];
        for (var i = 0; i < components.length; i++) {
            arrItems.push(cUint(components[i].num));
            arrItems.push(cBool(!!components[i].h));
        }
        var entries = [
            [cUint(1), cArray(arrItems)]
        ];
        if (typeof sourceFpUint === 'number' && sourceFpUint !== 0) {
            entries.push([cUint(2), cUint(sourceFpUint)]);
        }
        if (typeof depth === 'number') {
            entries.push([cUint(3), cUint(depth)]);
        }
        return cMap(entries);
    }

    // ---- crypto-hdkey (untagged at the top level) -----------
    //   3: key-data         (33 compressed pubkey bytes)
    //   4: chain-code       (32 bytes)
    //   6: origin           (tag 304 → crypto-keypath)
    //   8: parent-fingerprint (uint32)
    function buildCryptoHdkey(hd) {
        var origin = buildKeypathInner(
            hd.pathComponents,
            fpHexToUint(hd.sourceFp),
            hd.depth
        );
        var entries = [
            [cUint(3), cBytes(hd.keyData)],
            [cUint(4), cBytes(hd.chainCode)],
            [cUint(6), cTag(304, origin)],
            [cUint(8), cUint(hd.parentFp >>> 0)]
        ];
        return cMap(entries);
    }

    // ---- Assemble ur:<type>/<bytewords> ---------------------
    function toUR(type, cborArr) {
        var u8 = new Uint8Array(cborArr);
        return 'ur:' + type + '/' + bytewordsMinimal(u8);
    }

    // ---- One-shot: accountNode + meta → ur:crypto-hdkey ----
    // hdNode: @scure/bip32 HDKey-like
    //         { publicKey:Uint8Array(33), chainCode:Uint8Array(32),
    //           parentFingerprint:uint32, depth:int }
    // masterFpHex: 8-char hex string of the master seed fingerprint
    //              (goes into source-fingerprint per BCR-2020-007 §6)
    // basePath:   "m/…" — parsed into components
    function encodeAccountAsHdkeyUR(hdNode, masterFpHex, basePath) {
        if (!hdNode || !hdNode.publicKey || !hdNode.chainCode) {
            throw new Error('BC-UR: HD node is missing publicKey/chainCode.');
        }
        if (hdNode.publicKey.length !== 33) {
            throw new Error('BC-UR: publicKey must be 33 compressed bytes.');
        }
        if (hdNode.chainCode.length !== 32) {
            throw new Error('BC-UR: chainCode must be 32 bytes.');
        }
        var components = parsePath(basePath);
        var cbor = buildCryptoHdkey({
            keyData:        hdNode.publicKey,
            chainCode:      hdNode.chainCode,
            pathComponents: components,
            sourceFp:       masterFpHex,
            depth:          (typeof hdNode.depth === 'number') ? hdNode.depth : components.length,
            parentFp:       (typeof hdNode.parentFingerprint === 'number') ? hdNode.parentFingerprint : 0
        });
        return toUR('crypto-hdkey', cbor);
    }

    return {
        encodeAccountAsHdkeyUR: encodeAccountAsHdkeyUR,
        // Exposed for optional self-test / debugging:
        _crc32:               crc32,
        _bytewordsMinimal:    bytewordsMinimal,
        _buildCryptoHdkey:    buildCryptoHdkey,
        _parsePath:           parsePath
    };
})();

// ===== Round-trip test ======================================
import bcur from '@ngraveio/bc-ur';
import { decodeFirst } from 'cbor';

function hex(s) {
    const u = new Uint8Array(s.length/2);
    for (let i=0;i<u.length;i++) u[i] = parseInt(s.substr(i*2,2),16);
    return u;
}

const hdNode = {
    publicKey:  hex('03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd'),
    chainCode:  hex('7923408dadd3c7b56eed15567707ae5e5dca089de972e07f3b860450e2a3b70e'),
    parentFingerprint: 0x6a6d2cf0,
    depth: 3
};
const masterFpHex = '73c5da0a';
const basePath    = "m/84'/0'/0'";

const ur = ARM_URH.encodeAccountAsHdkeyUR(hdNode, masterFpHex, basePath);
console.log('UR:', ur);

const parsed = bcur.UR.fromString(ur);
console.log('Parsed UR type:', parsed.type);
console.log('CBOR hex:', parsed.cbor.toString('hex'));

const decoded = await new Promise((res, rej) =>
    decodeFirst(parsed.cbor, (err, val) => err ? rej(err) : res(val))
);

function hexOf(v) {
    if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
    if (Buffer.isBuffer(v)) return v.toString('hex');
    return v;
}
const getKey = (mp, k) => (mp instanceof Map) ? mp.get(k) : mp[k];

function assertEq(actual, expected, msg) {
    const a = hexOf(actual);
    if (String(a) !== String(expected)) {
        console.error('FAIL', msg, 'got:', a, 'expected:', expected); process.exit(1);
    } else console.log('OK  ', msg);
}

assertEq(getKey(decoded, 3), '03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd', 'key-data (3)');
assertEq(getKey(decoded, 4), '7923408dadd3c7b56eed15567707ae5e5dca089de972e07f3b860450e2a3b70e', 'chain-code (4)');
assertEq(getKey(decoded, 8), 0x6a6d2cf0, 'parent-fingerprint (8)');

const origin = getKey(decoded, 6);
if (!origin || !('tag' in origin) || origin.tag !== 304) {
    console.error('FAIL origin is not tag 304:', origin); process.exit(1);
}
console.log('OK   origin tag = 304');

const kp = origin.value;
const components = getKey(kp, 1);
const sfp = getKey(kp, 2);
const depth = getKey(kp, 3);
console.log('components:', components, 'source-fp hex:', (typeof sfp==='number'?sfp.toString(16):sfp), 'depth:', depth);
assertEq(JSON.stringify(components), JSON.stringify([84, true, 0, true, 0, true]), 'components [84,t,0,t,0,t]');
assertEq(sfp, 0x73c5da0a, 'source-fingerprint (2) = 0x73c5da0a');
assertEq(depth, 3, 'depth (3) = 3');

console.log('\nAll assertions passed.');

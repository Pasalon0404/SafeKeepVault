import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as btc from '@scure/btc-signer'; import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
/**
 * test-bip322-vectors.mjs — BIP-322 message signing through the real auth_sign /
 * auth_verify against the official v1.0.0 vectors (incl. every rejection case),
 * independent Taproot verification, bit-flip tamper sweep, and LOW_S enforcement.
 * Run: node test-bip322-vectors.mjs
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'boot.html'), 'utf8');
process.env.BOOT = join(__dirname, 'boot.html');
// Extract a named top-level function from boot.html (brace matching, string/comment aware).
function extract(name) {
  const re = new RegExp('(^|\\n)([ \\t]*)(async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(SRC); if (!m) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', m.index + m[0].length - 1);
  // skip param list
  let p = m.index + m[0].length - 1, depth = 0;
  for (; p < SRC.length; p++) { const c = SRC[p]; if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) break; } }
  i = SRC.indexOf('{', p);
  depth = 0; let j = i, str = null;
  for (; j < SRC.length; j++) {
    const c = SRC[j], n = SRC[j + 1];
    if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
    if (c === '/' && n === '/') { j = SRC.indexOf('\n', j); continue; }
    if (c === '/' && n === '*') { j = SRC.indexOf('*/', j) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(m.index, j + 1);
}
function lineOf(name) { const i = SRC.search(new RegExp('function\\s+' + name + '\\s*\\(')); return SRC.slice(0, i).split('\n').length; }

// Permissive fake DOM: any element id returns a persistent stub; enough for tool functions.
function makeDom(values = {}) {
  const els = {};
  const mk = (id) => ({ id, value: values[id] ?? '', textContent: '', innerHTML: '', className: '', style: {}, dataset: {}, disabled: false, checked: false,
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } }, children: [],
    appendChild(c){ this.children.push(c); return c; }, setAttribute(){}, removeAttribute(){}, getAttribute(){ return null; }, addEventListener(){},
    querySelector(){ return mk('q'); }, querySelectorAll(){ return []; }, getContext(){ return null; }, focus(){}, remove(){} });
  const document = { getElementById: (id) => (els[id] ||= mk(id)), createElement: () => mk('new'), querySelector: () => mk('q'), querySelectorAll: () => [], body: mk('body') };
  return { document, els };
}

// Official vectors: bitcoin/bips bip-0322/basic-test-vectors.json (spec v1.0.0+)
const BIP322_VECTORS = {"tx_hashes": [{"message": "", "address": "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", "message_hash": "c90c269c4f8fcbe6880f72a721ddfbf1914268a794cbb21cfafee13770ae19f1", "to_spend_tx_hash": "c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7", "to_sign_tx_hash": "1e9654e951a5ba44c8604c4de6c67fd78a27e81dcadcfe1edf638ba3aaebaed6"}, {"message": "Hello World", "address": "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", "message_hash": "f0eb03b1a75ac6d9847f55c624a99169b5dccba2a31f5b23bea77ba270de0a7a", "to_spend_tx_hash": "b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b", "to_sign_tx_hash": "88737ae86f2077145f93cc4b153ae9a1cb8d56afa511988c149c5c8c9d93bddf"}, {"message": "UTF-8 support: öäüéàè 测试文本 😄", "address": "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", "message_hash": "43936b237ea38c7794eb5d755e0d220b6db92ebfc5c8f482759d22b1286376d7", "to_spend_tx_hash": "c8f4f525fe8afb1bc09b44175bd2096f079c98425e8a1be676b712add1fb62f0", "to_sign_tx_hash": "8f488e06b89eafd019ec528109eafaf7f1d1811fd617aa1eeb9658f1c1be6586"}], "simple": [{"message": "", "private_keys": ["L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k"], "address": "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", "type": "p2wpkh", "bip322_signatures": ["smpAkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=", "smpAkgwRQIhAPkJ1Q4oYS0htvyuSFHLxRQpFAY56b70UvE7Dxazen0ZAiAtZfFz1S6T6I23MWI2lK/pcNTWncuyL8UL+oMdydVgzAEhAsfxIAMZZEKUPYWI4BruhAQjzFT8FSFSajuFwrDL1Yhy"]}, {"message": "Hello World", "private_keys": ["L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k"], "address": "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", "type": "p2wpkh", "bip322_signatures": ["smpAkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=", "smpAkgwRQIhAOzyynlqt93lOKJr+wmmxIens//zPzl9tqIOua93wO6MAiBi5n5EyAcPScOjf1lAqIUIQtr3zKNeavYabHyR8eGhowEhAsfxIAMZZEKUPYWI4BruhAQjzFT8FSFSajuFwrDL1Yhy"]}, {"message": "This will be a p2wsh 3-of-3 multisig BIP 322 signed message", "private_keys": [], "address": "bc1qp0ahvfh83088w49k405szqgg4f3pptr7p2g06tdxfjcd40z4lh4q95lsz9", "type": "p2wsh-multisig-3of3", "bip322_signatures": ["smpBQBHMEQCIFX9aaqPJWq2Ff2kpen5bFDTid+ehgUOpHV0LfjncXy4AiA3GNicF7aKPzdpa9PCpmaYQs3pHd+qbvvhXdxOCKCAMAFIMEUCIQD/ELXg6CNYyUQijCg96JtgvgjZb9dsl1Ctof4QAeyTcQIgVM/1AAblFl/DCt6A1gJg+T/i2qU5SQD09+chFJzolRwBSDBFAiEAlqRfSFyWNVQhvaCnmeV5tyneiCWMTcFbuujoD/pFa3wCIGnZjfQb8NolSYq9asV+ZeBSkCGHJcqnaV4JYS5MYPEGAWlTIQJ1aLEfEi/4p7wcV+XHZCBVvGGJZ7L3v+jhH+mZA8lN0yECCovfec+kIdllXpKCgA8RX/HZ2x5yHOtCSKP8/sf6pnwhAwxSng6kCgCXXSAmJOOZFdr3vdK3HzGqCFloOHgc5fM6U64="]}, {"message": "No prefix fallback", "private_keys": ["KyrSGCFPhqZMjCe5fNTYddiLMp4tMj4gLKuJ26TsB2rvr1VJGPbt"], "address": "bc1pss0zhytly75awhm6x2hhvd5lnzv3vssgrf9axfheq8ldyzn88ges79fler", "type": "p2tr", "bip322_signatures": ["AUCJYOwOjxYAvatTAGYaVlNXBVyFuc4MwNQkOuK2tl8xhfKDONd0NjfYyNSYcRqeCp8hsAnCEPHAVEkO9h6vbQ/R"]}], "error": [{"description": "invalid base64 encoding", "message": "", "address": "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", "signature": "not-valid-base64!!!"}, {"description": "empty signature", "message": "", "address": "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", "signature": ""}, {"description": "wrong message for valid simple p2wpkh signature", "message": "Wrong message that was not signed", "address": "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", "signature": "smpAkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI="}, {"description": "wrong address for valid simple p2wpkh signature", "message": "", "address": "bc1qp0ahvfh83088w49k405szqgg4f3pptr7p2g06tdxfjcd40z4lh4q95lsz9", "signature": "smpAkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI="}, {"description": "empty witness stack (single zero byte)", "message": "", "address": "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", "signature": "smpAA=="}, {"description": "wrong message for valid p2wsh 3-of-3 multisig signature", "message": "This is not the message that was signed", "address": "bc1qp0ahvfh83088w49k405szqgg4f3pptr7p2g06tdxfjcd40z4lh4q95lsz9", "signature": "smpBQBHMEQCIFX9aaqPJWq2Ff2kpen5bFDTid+ehgUOpHV0LfjncXy4AiA3GNicF7aKPzdpa9PCpmaYQs3pHd+qbvvhXdxOCKCAMAFIMEUCIQD/ELXg6CNYyUQijCg96JtgvgjZb9dsl1Ctof4QAeyTcQIgVM/1AAblFl/DCt6A1gJg+T/i2qU5SQD09+chFJzolRwBSDBFAiEAlqRfSFyWNVQhvaCnmeV5tyneiCWMTcFbuujoD/pFa3wCIGnZjfQb8NolSYq9asV+ZeBSkCGHJcqnaV4JYS5MYPEGAWlTIQJ1aLEfEi/4p7wcV+XHZCBVvGGJZ7L3v+jhH+mZA8lN0yECCovfec+kIdllXpKCgA8RX/HZ2x5yHOtCSKP8/sf6pnwhAwxSng6kCgCXXSAmJOOZFdr3vdK3HzGqCFloOHgc5fM6U64="}, {"description": "invalid signature prefix", "message": "", "address": "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", "signature": "fooAA=="}, {"description": "incorrect prefix type (ful)", "message": "incorrect prefix", "address": "bc1pyrgrm6cu6n54jrvkdjd9rvyd3xfyu84s2623awu2srn6mxhscwpsm5644w", "signature": "fulAUDZwFXUp+adN+/UZj5dVrGAbB3zKs1Vcalz5fCF9srxS63eSWNGvH1NYbrBkPt1BJDUyWUz9zgUxfc63/QheT6M"}]};
  import vm from 'node:vm';
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + n + (x !== undefined && !c ? '  -> ' + x : '')); };
const hex = u => Buffer.from(u).toString('hex');
const FNS = ['auth_taggedHash','auth_sha256d','auth_reverseBytes','auth_buildBip322PrevHash','auth_sign','auth_encodeWitness','auth_compactSizeLen','auth_writeCompactSize','auth_base64Encode','auth_base64Decode','auth_parsePath','auth_validatePath','auth_verify'];
function mkctx(vals, extra = {}) { const { document, els } = makeDom(vals); let status = '';
  const ctx = vm.createContext({ window: { BtcMath: { btcSigner: btc, secp256k1, schnorr }, SeedSession: { get: () => ({ mnemonic: 'session-present' }) } }, document, crypto: globalThis.crypto, TextEncoder, Uint8Array, BigInt, Number, String, Array, Math, Error,
    atob, btoa, console, showStatus: (m, t) => { status = t + ': ' + m; }, auth_saveState(){}, _authDerivedKey: null, _authDerivedAddress: '', _authLastSignature: '', ...extra });
  vm.runInContext(FNS.map(extract).join('\n'), ctx); return { ctx, els, status: () => status }; }
const wifKey = (w) => btc.WIF().decode(w);
async function sign(wif, message, path) { const priv = wifKey(wif); const pub = secp256k1.getPublicKey(priv, true);
  const { ctx, status } = mkctx({ 'auth-message': message, 'auth-path-custom': path }, { _authDerivedKey: { privateKey: priv, publicKey: pub }, _authDerivedAddress: 'x' });
  await ctx.auth_sign(); return { sig: ctx._authLastSignature, status: status() }; }
async function verify(address, message, sig) { const { ctx, els } = mkctx({ 'auth-verify-address': address, 'auth-verify-message': message, 'auth-verify-sig': sig });
  await ctx.auth_verify(); const t = els['auth-verify-result'].textContent; return { ok: t.startsWith('✓'), text: t }; }
const V = BIP322_VECTORS;

console.log('--- message hash + to_spend / to_sign txids (official tx_hashes) ---');
{ const { ctx } = mkctx({});
  for (const t of V.tx_hashes) {
    const mh = await ctx.auth_taggedHash('BIP0322-signed-message', new TextEncoder().encode(t.message));
    ck(`message_hash "${t.message.slice(0,18)}"`, hex(mh) === t.message_hash, hex(mh));
    const script = btc.OutScript.encode(btc.Address().decode(t.address));
    const prev = await ctx.auth_buildBip322PrevHash(script, mh, btc);
    ck(`to_spend txid "${t.message.slice(0,18)}"`, hex(ctx.auth_reverseBytes(prev)) === t.to_spend_tx_hash, hex(ctx.auth_reverseBytes(prev)));
  } }

console.log('--- signing (auth_sign) vs official P2WPKH signatures ---');
for (const v of V.simple.filter(x => x.type === 'p2wpkh' && x.message !== '')) {
  const r = await sign(v.private_keys[0], v.message, "m/84'/0'/0'/0/0");
  ck(`sign "${v.message}" == an official signature`, v.bip322_signatures.includes(r.sig), r.sig + ' | ' + r.status);
}
console.log('--- Taproot signing (auth_sign) checked by an INDEPENDENT BIP-341 verifier ---');
{ const v = V.simple.find(x => x.type === 'p2tr'); const priv = wifKey(v.private_keys[0]); const xonly = secp256k1.getPublicKey(priv, true).slice(1);
  const out = btc.p2tr(xonly); ck('BIP-86 keypath address == vector address', out.address === v.address, out.address);
  for (const msg of [v.message, 'Hello World', 'UTF-8 ✓ 测试 😄']) {
    const r = await sign(v.private_keys[0], msg, "m/86'/0'/0'/0/0");
    const b = Buffer.from(r.sig.slice(3), 'base64'); // [count=1][len=64|65][sig]
    const sigBytes = b.slice(2, 2 + b[1]);
    const { ctx } = mkctx({}); const mh = await ctx.auth_taggedHash('BIP0322-signed-message', new TextEncoder().encode(msg));
    const prev = await ctx.auth_buildBip322PrevHash(out.script, mh, btc);
    const tx = new btc.Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
    tx.addInput({ txid: ctx.auth_reverseBytes(prev), index: 0, sequence: 0, witnessUtxo: { script: out.script, amount: 0n } });
    tx.addOutput({ script: new Uint8Array([0x6a]), amount: 0n });
    const hashType = sigBytes.length === 65 ? sigBytes[64] : 0;
    const sighash = tx.preimageWitnessV1(0, [out.script], hashType, [0n]);
    const ok = r.sig.startsWith('smp') && schnorr.verify(sigBytes.slice(0, 64), sighash, out.tweakedPubkey);
    ck(`taproot sig for "${msg}" verifies (independent schnorr/BIP-341)`, ok, r.sig);
    const bad = schnorr.verify(sigBytes.slice(0, 64), tx.preimageWitnessV1(0, [out.script], hashType, [0n]).map((x,i)=>i===0?x^1:x), out.tweakedPubkey);
    if (bad) ck('tampered sighash must fail', false);
  } }
console.log('--- verification (auth_verify) of official valid signatures ---');
for (const v of V.simple) for (const s of v.bip322_signatures) {
  const r = await verify(v.address, v.message, s);
  if (v.type === 'p2wpkh') ck(`verify ${v.type} "${v.message}"`, r.ok, r.text);
  else console.log(`  INFO ${v.type}: ${r.ok ? 'accepted' : 'not supported -> ' + r.text.slice(0, 110)}`);
}
console.log('--- verification MUST reject every official error vector ---');
for (const e of V.error) { const r = await verify(e.address, e.message, e.signature); ck(`reject: ${e.description}`, !r.ok, r.text); }
console.log('--- extra forgery / tamper checks ---');
{ const v = V.simple[1]; const good = v.bip322_signatures[0];
  const raw = Buffer.from(good.slice(3), 'base64'); let rejected = 0, total = 0;
  for (let i = 1; i < raw.length; i++) { const t = Buffer.from(raw); t[i] ^= 0x01; total++; if (!(await verify(v.address, v.message, 'smp' + t.toString('base64'))).ok) rejected++; }
  ck(`every single-bit flip rejected (${rejected}/${total})`, rejected === total);
  ck('unprefixed legacy form still accepted (spec back-compat)', (await verify(v.address, v.message, good.slice(3))).ok);
  // high-S malleation of a valid signature: spec (v1.0.0 required rules) says LOW_S is mandatory
  const len = raw[1]; const der = raw.slice(2, 2 + len - 1); const ht = raw[1 + len];
  const sg = secp256k1.Signature.fromBytes(new Uint8Array(der), 'der'); const hi = new secp256k1.Signature(sg.r, secp256k1.Point.CURVE().n - sg.s);
  const hiDer = hi.toBytes('der'); const pubItem = raw.slice(2 + len);
  const w = Buffer.concat([Buffer.from([2, hiDer.length + 1]), Buffer.from(hiDer), Buffer.from([ht]), pubItem]);
  const hv = await verify(v.address, v.message, 'smp' + w.toString('base64'));
  ck('high-S malleated signature rejected (BIP-322 v1.0.0 LOW_S rule)', !hv.ok, hv.text);
}
console.log(`\nBIP-322: ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);

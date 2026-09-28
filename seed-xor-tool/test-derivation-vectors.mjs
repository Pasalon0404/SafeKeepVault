import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs'; import vm from 'node:vm'; import { randomBytes } from 'node:crypto';
import * as bip39 from '@scure/bip39'; import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32'; import * as btcSigner from '@scure/btc-signer';
/**
 * test-derivation-vectors.mjs — seed/derivation/encoding against official vectors:
 * BIP-39 (Trezor), BIP-32, BIP-44/49/84/86 addresses + xpubs, desc_deriveAddress,
 * sortedmulti (BIP-67), base58check vs @scure/base, SLIP-132 normalization,
 * desc_checksum vs the BIP-380 reference algorithm.
 * Run: node test-derivation-vectors.mjs
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



const grab = (start, end) => { const i = SRC.indexOf(start); return SRC.slice(i, SRC.indexOf(end, i) + end.length); };
const ctx = vm.createContext({ Uint8Array, Uint32Array, Array, Math, Error, BigInt, Number, String });
vm.runInContext([grab('var _sha256K = new Uint32Array([', ']);'), extract('_rr'), extract('_sha256impl'), extract('_sha256sync'),
  "var _B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';",
  extract('_base58encode'), extract('_base58decode'), extract('_base58check'), extract('_base58checkDecode'),
  'var DESC_BIP32_PUBLIC_MAINNET = 0x0488B21E; var DESC_BIP32_PUBLIC_TESTNET = 0x043587CF;',
  grab('var _DESC_MAINNET_VERS = {', '};'), grab('var _DESC_TESTNET_VERS = {', '};'),
  extract('_descNormalizeXpub'), extract('desc_checksum'), extract('desc_deriveAddress')].join('\n'), ctx);
let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; if (!c) console.log('  FAIL', n, x || ''); };
const hex = u => Buffer.from(u).toString('hex');
const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// ---- BIP-39 official vector (Trezor, passphrase "TREZOR") ----
ck('bip39 entropy->mnemonic', bip39.entropyToMnemonic(new Uint8Array(16), wordlist) === M);
const seedT = await bip39.mnemonicToSeed(M, 'TREZOR');
ck('bip39 seed TREZOR', hex(seedT) === 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04');
ck('bip32 master xprv', HDKey.fromMasterSeed(seedT).privateExtendedKey === 'xprv9s21ZrQH143K3h3fDYiay8mocZ3afhfULfb5GX8kCBdno77K4HiA15Tg23wpbeF1pLfs1c5SPmYHrEpTuuRhxMwvKDwqdKiGJS9XFKzUsAF');

// ---- Replicate arm_deriveWallet's exact composition, vs official BIP-44/49/84/86 vectors ----
const slip = { '84': { private: 0x04b2430c, public: 0x04b24746 }, '49': { private: 0x049d7878, public: 0x049d7cb2 },
  '44': { private: 0x0488ade4, public: 0x0488b21e }, '86': { private: 0x0488ade4, public: 0x0488b21e } };
const seed = await bip39.mnemonicToSeed(M, '');
function armAddr(pathType, chain, i) {                 // mirrors boot.html L34428-34438
  const hd = HDKey.fromMasterSeed(seed, slip[pathType]); const n = hd.derive(`m/${pathType}'/0'/0'/${chain}/${i}`);
  if (pathType === '84') return btcSigner.p2wpkh(n.publicKey).address;
  if (pathType === '86') return btcSigner.p2tr(n.publicKey.slice(1, 33)).address;
  if (pathType === '49') return btcSigner.p2sh(btcSigner.p2wpkh(n.publicKey)).address;
  return btcSigner.p2pkh(n.publicKey).address;
}
ck('master fingerprint 73c5da0a', HDKey.fromMasterSeed(seed).fingerprint.toString(16).padStart(8,'0') === '73c5da0a');
ck('BIP84 addr 0/0', armAddr('84',0,0) === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', armAddr('84',0,0));
ck('BIP84 addr 0/1', armAddr('84',0,1) === 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', armAddr('84',0,1));
ck('BIP84 change 1/0', armAddr('84',1,0) === 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el', armAddr('84',1,0));
ck('BIP86 addr 0/0', armAddr('86',0,0) === 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', armAddr('86',0,0));
ck('BIP86 addr 0/1', armAddr('86',0,1) === 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh', armAddr('86',0,1));
ck('BIP49 addr 0/0', armAddr('49',0,0) === '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf', armAddr('49',0,0));
ck('BIP44 addr 0/0', armAddr('44',0,0) === '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA', armAddr('44',0,0));
const zpub = HDKey.fromMasterSeed(seed, slip['84']).derive("m/84'/0'/0'").publicExtendedKey;
ck('BIP84 account zpub', zpub === 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs', zpub);
const xpub86 = HDKey.fromMasterSeed(seed, slip['86']).derive("m/86'/0'/0'").publicExtendedKey;
ck('BIP86 account xpub', xpub86 === 'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ', xpub86);

// ---- desc_deriveAddress (the Script/Descriptor tool) vs same vectors ----
const k84 = HDKey.fromMasterSeed(seed).derive("m/84'/0'/0'/0/0").publicKey, k86 = HDKey.fromMasterSeed(seed).derive("m/86'/0'/0'/0/0").publicKey;
ck('desc wpkh', ctx.desc_deriveAddress('wpkh', [k84], 1, btcSigner) === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
ck('desc tr', ctx.desc_deriveAddress('tr', [k86], 1, btcSigner) === 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
// sortedmulti must equal btc-signer's own BIP-67 sort, independent of input order
for (let t = 0; t < 200; t++) { const ks = [0,1,2].map(j => HDKey.fromMasterSeed(randomBytes(32)).publicKey);
  const a = ctx.desc_deriveAddress('wsh-sortedmulti', ks, 2, btcSigner), b = ctx.desc_deriveAddress('wsh-sortedmulti', ks.slice().reverse(), 2, btcSigner);
  const ref = btcSigner.p2wsh(btcSigner.p2ms(2, ks.slice().sort((x,y)=>Buffer.compare(Buffer.from(x),Buffer.from(y))))).address;
  if (!(a === b && a === ref)) { ck('sortedmulti order-independence', false); break; } if (t === 199) ck('sortedmulti x200 (BIP-67)', true); }

// ---- base58check vs @scure/base (independent) ----
const { createBase58check } = await import('@scure/base'); const { sha256 } = await import('@noble/hashes/sha2.js');
const b58c = createBase58check(sha256); let bok = true;
for (let t = 0; t < 3000; t++) { const p = randomBytes(1 + Math.floor(Math.random()*90)); p[0] |= 1; // non-zero lead (real-world)
  const e = ctx._base58check(new Uint8Array(p)); if (e !== b58c.encode(p) || hex(ctx._base58checkDecode(e)) !== hex(p)) { bok = false; console.log('b58 mismatch', hex(p)); break; } }
ck('base58check x3000 == @scure/base', bok);
let zbad = 0; for (let t = 0; t < 500; t++) { const p = randomBytes(40); p[0]=0; p[1]=0; if (ctx._base58check(new Uint8Array(p)) !== b58c.encode(p)) zbad++; }
ck('base58check leading-zero payloads', zbad === 0, zbad + ' mismatches');
let tamper = false; try { const e = ctx._base58check(new Uint8Array(randomBytes(78))); ctx._base58checkDecode(e.slice(0,-1) + (e.at(-1)==='z'?'y':'z')); } catch { tamper = true; }
ck('base58check rejects corrupted checksum', tamper);

// ---- _descNormalizeXpub: zpub -> xpub keeps identical key material ----
const norm = ctx._descNormalizeXpub(zpub); const stdX = HDKey.fromMasterSeed(seed).derive("m/84'/0'/0'").publicExtendedKey;
ck('zpub -> xpub normalization', norm === stdX, norm);
ck('xpub passes through unchanged', ctx._descNormalizeXpub(stdX) === stdX);
const zprv = HDKey.fromMasterSeed(seed, slip['84']).derive("m/84'/0'/0'").privateExtendedKey;
ck('zprv NOT converted (no priv->pub mangling)', ctx._descNormalizeXpub(zprv) === zprv);

// ---- desc_checksum vs independent port of BIP-380 Python reference ----
const IC = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ", CC = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const G = [0xf5dee51989n,0xa9fdca3312n,0x1bab10e32dn,0x3706b1677an,0x644d626ffdn];
function refSum(s){ const sym=[]; let g=[]; for (const c of s){ const v=IC.indexOf(c); if(v<0) return ''; sym.push(v&31); g.push(v>>5); if(g.length===3){sym.push(g[0]*9+g[1]*3+g[2]); g=[];} }
  if(g.length===1) sym.push(g[0]); else if(g.length===2) sym.push(g[0]*3+g[1]); sym.push(0,0,0,0,0,0,0,0);
  let chk=1n; for (const v of sym){ const top=chk>>35n; chk=((chk&0x7ffffffffn)<<5n)^BigInt(v); for(let i=0;i<5;i++) if((top>>BigInt(i))&1n) chk^=G[i]; } chk^=1n;
  let r=''; for(let i=0;i<8;i++) r+=CC[Number((chk>>BigInt(5*(7-i)))&31n)]; return r; }
ck('BIP-380 vector raw(deadbeef)#89f8spxm', ctx.desc_checksum('raw(deadbeef)') === '89f8spxm', ctx.desc_checksum('raw(deadbeef)'));
ck('BIP-380 vector sh(multi(...xpub...))#tjg09x5t', ctx.desc_checksum("sh(multi(2,[00000000/111'/222]xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL,xpub68NZiKmJWnxxS6aaHmn81bvJeTESw724CRDs6HbuccFQN9Ku14VQrADWgqbhhTHBaohPX4CjNLf9fq9MYo6oDaPPLPxSb7gwQN3ih19Zm4Y/0))") === 'tjg09x5t');
let dok = true; for (let t=0;t<5000;t++){ const len=1+Math.floor(Math.random()*120); let s=''; for(let i=0;i<len;i++) s+=IC[Math.floor(Math.random()*(IC.length-1))];
  if (ctx.desc_checksum(s)!==refSum(s)) { dok=false; console.log('checksum mismatch', JSON.stringify(s)); break; } }
ck('desc_checksum x5000 == BIP-380 reference', dok);
ck('desc_checksum rejects invalid char', ctx.desc_checksum('wpkh(é)') === '');
console.log(`\nDERIVATION/ENCODING: ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);

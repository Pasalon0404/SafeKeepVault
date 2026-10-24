import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateMnemonics, combineMnemonics, Share } from 'shamir-mnemonic-ts';
import * as bip39 from '@scure/bip39'; import { wordlist } from '@scure/bip39/wordlists/english.js'; import { HDKey } from '@scure/bip32';
import { randomBytes } from 'node:crypto';
/**
 * test-slip39-vectors.mjs — SLIP-39 via shamir-mnemonic-ts (the library the app bundles):
 * official Trezor vectors, in-app round trips 2-of-2..5-of-16, under-threshold rejection.
 * Also DOCUMENTS the design fact behind the UI warning: shares encode BIP-39 entropy, so a
 * Trezor restoring them opens a DIFFERENT wallet (fingerprints printed below). Then the
 * tool's own split, final check and "check shares I already have" (with and without a
 * share passphrase), run against the real library.
 * Run: node test-slip39-vectors.mjs
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

let pass = 0, fail = 0; const ck = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + n + (x !== undefined ? '  -> ' + x : '')); };
const hex = u => Buffer.from(u).toString('hex'); const fp = k => k.fingerprint.toString(16).padStart(8, '0');
// ---- Library vs official Trezor SLIP-39 vectors (vectors.json #1 and #4) ----
const v1 = await combineMnemonics(['duckling enlarge academic academic agency result length solution fridge kidney coal piece deal husband erode duke ajar critical decision keyboard'], 'TREZOR');
ck('official vector #1 (1-of-1, 128-bit)', hex(v1) === 'bb54aac4b89dc868ba37d9cc21b2cece', hex(v1));
const v4 = await combineMnemonics(['shadow pistol academic always adequate wildlife fancy gross oasis cylinder mustang wrist rescue view short owner flip making coding armed',
  'shadow pistol academic acid actress prayer class unknown daughter sweater depict flip twice unkind craft early superior advocate guest smoking'], 'TREZOR');
ck('official vector #4 (2-of-3, 128-bit)', hex(v4) === 'b43ceb7e57a0ea8766221624d01b0864', hex(v4));

// ---- ALL 45 official Trezor SLIP-39 vectors (github.com/trezor/python-shamir-mnemonic vectors.json), incl. every must-reject case ----
const OFFICIAL = [["1. Valid mnemonic without sharing (128 bits)", ["duckling enlarge academic academic agency result length solution fridge kidney coal piece deal husband erode duke ajar critical decision keyboard"], "bb54aac4b89dc868ba37d9cc21b2cece", "xprv9s21ZrQH143K4QViKpwKCpS2zVbz8GrZgpEchMDg6KME9HZtjfL7iThE9w5muQA4YPHKN1u5VM1w8D4pvnjxa2BmpGMfXr7hnRrRHZ93awZ"], ["2. Mnemonic with invalid checksum (128 bits)", ["duckling enlarge academic academic agency result length solution fridge kidney coal piece deal husband erode duke ajar critical decision kidney"], "", ""], ["3. Mnemonic with invalid padding (128 bits)", ["duckling enlarge academic academic email result length solution fridge kidney coal piece deal husband erode duke ajar music cargo fitness"], "", ""], ["4. Basic sharing 2-of-3 (128 bits)", ["shadow pistol academic always adequate wildlife fancy gross oasis cylinder mustang wrist rescue view short owner flip making coding armed", "shadow pistol academic acid actress prayer class unknown daughter sweater depict flip twice unkind craft early superior advocate guest smoking"], "b43ceb7e57a0ea8766221624d01b0864", "xprv9s21ZrQH143K2nNuAbfWPHBtfiSCS14XQgb3otW4pX655q58EEZeC8zmjEUwucBu9dPnxdpbZLCn57yx45RBkwJHnwHFjZK4XPJ8SyeYjYg"], ["5. Basic sharing 2-of-3 (128 bits)", ["shadow pistol academic always adequate wildlife fancy gross oasis cylinder mustang wrist rescue view short owner flip making coding armed"], "", ""], ["6. Mnemonics with different identifiers (128 bits)", ["adequate smoking academic acid debut wine petition glen cluster slow rhyme slow simple epidemic rumor junk tracks treat olympic tolerate", "adequate stay academic agency agency formal party ting frequent learn upstairs remember smear leaf damage anatomy ladle market hush corner"], "", ""], ["7. Mnemonics with different iteration exponents (128 bits)", ["peasant leaves academic acid desert exact olympic math alive axle trial tackle drug deny decent smear dominant desert bucket remind", "peasant leader academic agency cultural blessing percent network envelope medal junk primary human pumps jacket fragment payroll ticket evoke voice"], "", ""], ["8. Mnemonics with mismatching group thresholds (128 bits)", ["liberty category beard echo animal fawn temple briefing math username various wolf aviation fancy visual holy thunder yelp helpful payment", "liberty category beard email beyond should fancy romp founder easel pink holy hairy romp loyalty material victim owner toxic custody", "liberty category academic easy being hazard crush diminish oral lizard reaction cluster force dilemma deploy force club veteran expect photo"], "", ""], ["9. Mnemonics with mismatching group counts (128 bits)", ["average senior academic leaf broken teacher expect surface hour capture obesity desire negative dynamic dominant pistol mineral mailman iris aide", "average senior academic agency curious pants blimp spew clothes slice script dress wrap firm shaft regular slavery negative theater roster"], "", ""], ["10. Mnemonics with greater group threshold than group counts (128 bits)", ["music husband acrobat acid artist finance center either graduate swimming object bike medical clothes station aspect spider maiden bulb welcome", "music husband acrobat agency advance hunting bike corner density careful material civil evil tactics remind hawk discuss hobo voice rainbow", "music husband beard academic black tricycle clock mayor estimate level photo episode exclude ecology papa source amazing salt verify divorce"], "", ""], ["11. Mnemonics with duplicate member indices (128 bits)", ["device stay academic always dive coal antenna adult black exceed stadium herald advance soldier busy dryer daughter evaluate minister laser", "device stay academic always dwarf afraid robin gravity crunch adjust soul branch walnut coastal dream costume scholar mortgage mountain pumps"], "", ""], ["12. Mnemonics with mismatching member thresholds (128 bits)", ["hour painting academic academic device formal evoke guitar random modern justice filter withdraw trouble identify mailman insect general cover oven", "hour painting academic agency artist again daisy capital beaver fiber much enjoy suitable symbolic identify photo editor romp float echo"], "", ""], ["13. Mnemonics giving an invalid digest (128 bits)", ["guilt walnut academic acid deliver remove equip listen vampire tactics nylon rhythm failure husband fatigue alive blind enemy teaspoon rebound", "guilt walnut academic agency brave hamster hobo declare herd taste alpha slim criminal mild arcade formal romp branch pink ambition"], "", ""], ["14. Insufficient number of groups (128 bits, case 1)", ["eraser senior beard romp adorn nuclear spill corner cradle style ancient family general leader ambition exchange unusual garlic promise voice"], "", ""], ["15. Insufficient number of groups (128 bits, case 2)", ["eraser senior decision scared cargo theory device idea deliver modify curly include pancake both news skin realize vitamins away join", "eraser senior decision roster beard treat identify grumpy salt index fake aviation theater cubic bike cause research dragon emphasis counter"], "", ""], ["16. Threshold number of groups, but insufficient number of members in one group (128 bits)", ["eraser senior decision shadow artist work morning estate greatest pipeline plan ting petition forget hormone flexible general goat admit surface", "eraser senior beard romp adorn nuclear spill corner cradle style ancient family general leader ambition exchange unusual garlic promise voice"], "", ""], ["17. Threshold number of groups and members in each group (128 bits, case 1)", ["eraser senior decision roster beard treat identify grumpy salt index fake aviation theater cubic bike cause research dragon emphasis counter", "eraser senior ceramic snake clay various huge numb argue hesitate auction category timber browser greatest hanger petition script leaf pickup", "eraser senior ceramic shaft dynamic become junior wrist silver peasant force math alto coal amazing segment yelp velvet image paces", "eraser senior ceramic round column hawk trust auction smug shame alive greatest sheriff living perfect corner chest sled fumes adequate", "eraser senior decision smug corner ruin rescue cubic angel tackle skin skunk program roster trash rumor slush angel flea amazing"], "7c3397a292a5941682d7a4ae2d898d11", "xprv9s21ZrQH143K3dzDLfeY3cMp23u5vDeFYftu5RPYZPucKc99mNEddU4w99GxdgUGcSfMpVDxhnR1XpJzZNXRN1m6xNgnzFS5MwMP6QyBRKV"], ["18. Threshold number of groups and members in each group (128 bits, case 2)", ["eraser senior decision smug corner ruin rescue cubic angel tackle skin skunk program roster trash rumor slush angel flea amazing", "eraser senior beard romp adorn nuclear spill corner cradle style ancient family general leader ambition exchange unusual garlic promise voice", "eraser senior decision scared cargo theory device idea deliver modify curly include pancake both news skin realize vitamins away join"], "7c3397a292a5941682d7a4ae2d898d11", "xprv9s21ZrQH143K3dzDLfeY3cMp23u5vDeFYftu5RPYZPucKc99mNEddU4w99GxdgUGcSfMpVDxhnR1XpJzZNXRN1m6xNgnzFS5MwMP6QyBRKV"], ["19. Threshold number of groups and members in each group (128 bits, case 3)", ["eraser senior beard romp adorn nuclear spill corner cradle style ancient family general leader ambition exchange unusual garlic promise voice", "eraser senior acrobat romp bishop medical gesture pumps secret alive ultimate quarter priest subject class dictate spew material endless market"], "7c3397a292a5941682d7a4ae2d898d11", "xprv9s21ZrQH143K3dzDLfeY3cMp23u5vDeFYftu5RPYZPucKc99mNEddU4w99GxdgUGcSfMpVDxhnR1XpJzZNXRN1m6xNgnzFS5MwMP6QyBRKV"], ["20. Valid mnemonic without sharing (256 bits)", ["theory painting academic academic armed sweater year military elder discuss acne wildlife boring employer fused large satoshi bundle carbon diagnose anatomy hamster leaves tracks paces beyond phantom capital marvel lips brave detect luck"], "989baf9dcaad5b10ca33dfd8cc75e42477025dce88ae83e75a230086a0e00e92", "xprv9s21ZrQH143K41mrxxMT2FpiheQ9MFNmWVK4tvX2s28KLZAhuXWskJCKVRQprq9TnjzzzEYePpt764csiCxTt22xwGPiRmUjYUUdjaut8RM"], ["21. Mnemonic with invalid checksum (256 bits)", ["theory painting academic academic armed sweater year military elder discuss acne wildlife boring employer fused large satoshi bundle carbon diagnose anatomy hamster leaves tracks paces beyond phantom capital marvel lips brave detect lunar"], "", ""], ["22. Mnemonic with invalid padding (256 bits)", ["theory painting academic academic campus sweater year military elder discuss acne wildlife boring employer fused large satoshi bundle carbon diagnose anatomy hamster leaves tracks paces beyond phantom capital marvel lips facility obtain sister"], "", ""], ["23. Basic sharing 2-of-3 (256 bits)", ["humidity disease academic always aluminum jewelry energy woman receiver strategy amuse duckling lying evidence network walnut tactics forget hairy rebound impulse brother survive clothes stadium mailman rival ocean reward venture always armed unwrap", "humidity disease academic agency actress jacket gross physics cylinder solution fake mortgage benefit public busy prepare sharp friar change work slow purchase ruler again tricycle involve viral wireless mixture anatomy desert cargo upgrade"], "c938b319067687e990e05e0da0ecce1278f75ff58d9853f19dcaeed5de104aae", "xprv9s21ZrQH143K3a4GRMgK8WnawupkwkP6gyHxRsXnMsYPTPH21fWwNcAytijtfyftqNfiaY8LgQVdBQvHZ9FBvtwdjC7LCYxjYruJFuLzyMQ"], ["24. Basic sharing 2-of-3 (256 bits)", ["humidity disease academic always aluminum jewelry energy woman receiver strategy amuse duckling lying evidence network walnut tactics forget hairy rebound impulse brother survive clothes stadium mailman rival ocean reward venture always armed unwrap"], "", ""], ["25. Mnemonics with different identifiers (256 bits)", ["smear husband academic acid deadline scene venture distance dive overall parking bracelet elevator justice echo burning oven chest duke nylon", "smear isolate academic agency alpha mandate decorate burden recover guard exercise fatal force syndrome fumes thank guest drift dramatic mule"], "", ""], ["26. Mnemonics with different iteration exponents (256 bits)", ["finger trash academic acid average priority dish revenue academic hospital spirit western ocean fact calcium syndrome greatest plan losing dictate", "finger traffic academic agency building lilac deny paces subject threaten diploma eclipse window unknown health slim piece dragon focus smirk"], "", ""], ["27. Mnemonics with mismatching group thresholds (256 bits)", ["flavor pink beard echo depart forbid retreat become frost helpful juice unwrap reunion credit math burning spine black capital lair", "flavor pink beard email diet teaspoon freshman identify document rebound cricket prune headset loyalty smell emission skin often square rebound", "flavor pink academic easy credit cage raisin crazy closet lobe mobile become drink human tactics valuable hand capture sympathy finger"], "", ""], ["28. Mnemonics with mismatching group counts (256 bits)", ["column flea academic leaf debut extra surface slow timber husky lawsuit game behavior husky swimming already paper episode tricycle scroll", "column flea academic agency blessing garbage party software stadium verify silent umbrella therapy decorate chemical erode dramatic eclipse replace apart"], "", ""], ["29. Mnemonics with greater group threshold than group counts (256 bits)", ["smirk pink acrobat acid auction wireless impulse spine sprinkle fortune clogs elbow guest hush loyalty crush dictate tracks airport talent", "smirk pink acrobat agency dwarf emperor ajar organize legs slice harvest plastic dynamic style mobile float bulb health coding credit", "smirk pink beard academic alto strategy carve shame language rapids ruin smart location spray training acquire eraser endorse submit peaceful"], "", ""], ["30. Mnemonics with duplicate member indices (256 bits)", ["fishing recover academic always device craft trend snapshot gums skin downtown watch device sniff hour clock public maximum garlic born", "fishing recover academic always aircraft view software cradle fangs amazing package plastic evaluate intend penalty epidemic anatomy quarter cage apart"], "", ""], ["31. Mnemonics with mismatching member thresholds (256 bits)", ["evoke garden academic academic answer wolf scandal modern warmth station devote emerald market physics surface formal amazing aquatic gesture medical", "evoke garden academic agency deal revenue knit reunion decrease magazine flexible company goat repair alarm military facility clogs aide mandate"], "", ""], ["32. Mnemonics giving an invalid digest (256 bits)", ["river deal academic acid average forbid pistol peanut custody bike class aunt hairy merit valid flexible learn ajar very easel", "river deal academic agency camera amuse lungs numb isolate display smear piece traffic worthy year patrol crush fact fancy emission"], "", ""], ["33. Insufficient number of groups (256 bits, case 1)", ["wildlife deal beard romp alcohol space mild usual clothes union nuclear testify course research heat listen task location thank hospital slice smell failure fawn helpful priest ambition average recover lecture process dough stadium"], "", ""], ["34. Insufficient number of groups (256 bits, case 2)", ["wildlife deal decision scared acne fatal snake paces obtain election dryer dominant romp tactics railroad marvel trust helpful flip peanut theory theater photo luck install entrance taxi step oven network dictate intimate listen", "wildlife deal decision smug ancestor genuine move huge cubic strategy smell game costume extend swimming false desire fake traffic vegan senior twice timber submit leader payroll fraction apart exact forward pulse tidy install"], "", ""], ["35. Threshold number of groups, but insufficient number of members in one group (256 bits)", ["wildlife deal decision shadow analysis adjust bulb skunk muscle mandate obesity total guitar coal gravity carve slim jacket ruin rebuild ancestor numerous hour mortgage require herd maiden public ceiling pecan pickup shadow club", "wildlife deal beard romp alcohol space mild usual clothes union nuclear testify course research heat listen task location thank hospital slice smell failure fawn helpful priest ambition average recover lecture process dough stadium"], "", ""], ["36. Threshold number of groups and members in each group (256 bits, case 1)", ["wildlife deal ceramic round aluminum pitch goat racism employer miracle percent math decision episode dramatic editor lily prospect program scene rebuild display sympathy have single mustang junction relate often chemical society wits estate", "wildlife deal decision scared acne fatal snake paces obtain election dryer dominant romp tactics railroad marvel trust helpful flip peanut theory theater photo luck install entrance taxi step oven network dictate intimate listen", "wildlife deal ceramic scatter argue equip vampire together ruin reject literary rival distance aquatic agency teammate rebound false argue miracle stay again blessing peaceful unknown cover beard acid island language debris industry idle", "wildlife deal ceramic snake agree voter main lecture axis kitchen physics arcade velvet spine idea scroll promise platform firm sharp patrol divorce ancestor fantasy forbid goat ajar believe swimming cowboy symbolic plastic spelling", "wildlife deal decision shadow analysis adjust bulb skunk muscle mandate obesity total guitar coal gravity carve slim jacket ruin rebuild ancestor numerous hour mortgage require herd maiden public ceiling pecan pickup shadow club"], "5385577c8cfc6c1a8aa0f7f10ecde0a3318493262591e78b8c14c6686167123b", "xprv9s21ZrQH143K2UspC9FRPfQC9NcDB4HPkx1XG9UEtuceYtpcCZ6ypNZWdgfxQ9dAFVeD1F4Zg4roY7nZm2LB7THPD6kaCege3M7EuS8v85c"], ["37. Threshold number of groups and members in each group (256 bits, case 2)", ["wildlife deal decision scared acne fatal snake paces obtain election dryer dominant romp tactics railroad marvel trust helpful flip peanut theory theater photo luck install entrance taxi step oven network dictate intimate listen", "wildlife deal beard romp alcohol space mild usual clothes union nuclear testify course research heat listen task location thank hospital slice smell failure fawn helpful priest ambition average recover lecture process dough stadium", "wildlife deal decision smug ancestor genuine move huge cubic strategy smell game costume extend swimming false desire fake traffic vegan senior twice timber submit leader payroll fraction apart exact forward pulse tidy install"], "5385577c8cfc6c1a8aa0f7f10ecde0a3318493262591e78b8c14c6686167123b", "xprv9s21ZrQH143K2UspC9FRPfQC9NcDB4HPkx1XG9UEtuceYtpcCZ6ypNZWdgfxQ9dAFVeD1F4Zg4roY7nZm2LB7THPD6kaCege3M7EuS8v85c"], ["38. Threshold number of groups and members in each group (256 bits, case 3)", ["wildlife deal beard romp alcohol space mild usual clothes union nuclear testify course research heat listen task location thank hospital slice smell failure fawn helpful priest ambition average recover lecture process dough stadium", "wildlife deal acrobat romp anxiety axis starting require metric flexible geology game drove editor edge screw helpful have huge holy making pitch unknown carve holiday numb glasses survive already tenant adapt goat fangs"], "5385577c8cfc6c1a8aa0f7f10ecde0a3318493262591e78b8c14c6686167123b", "xprv9s21ZrQH143K2UspC9FRPfQC9NcDB4HPkx1XG9UEtuceYtpcCZ6ypNZWdgfxQ9dAFVeD1F4Zg4roY7nZm2LB7THPD6kaCege3M7EuS8v85c"], ["39. Mnemonic with insufficient length", ["junk necklace academic academic acne isolate join hesitate lunar roster dough calcium chemical ladybug amount mobile glasses verify cylinder"], "", ""], ["40. Mnemonic with invalid master secret length", ["fraction necklace academic academic award teammate mouse regular testify coding building member verdict purchase blind camera duration email prepare spirit quarter"], "", ""], ["41. Valid mnemonics which can detect some errors in modular arithmetic", ["herald flea academic cage avoid space trend estate dryer hairy evoke eyebrow improve airline artwork garlic premium duration prevent oven", "herald flea academic client blue skunk class goat luxury deny presence impulse graduate clay join blanket bulge survive dish necklace", "herald flea academic acne advance fused brother frozen broken game ranked ajar already believe check install theory angry exercise adult"], "ad6f2ad8b59bbbaa01369b9006208d9a", "xprv9s21ZrQH143K2R4HJxcG1eUsudvHM753BZ9vaGkpYCoeEhCQx147C5qEcupPHxcXYfdYMwJmsKXrHDhtEwutxTTvFzdDCZVQwHneeQH8ioH"], ["42. Valid extendable mnemonic without sharing (128 bits)", ["testify swimming academic academic column loyalty smear include exotic bedroom exotic wrist lobe cover grief golden smart junior estimate learn"], "1679b4516e0ee5954351d288a838f45e", "xprv9s21ZrQH143K2w6eTpQnB73CU8Qrhg6gN3D66Jr16n5uorwoV7CwxQ5DofRPyok5DyRg4Q3BfHfCgJFk3boNRPPt1vEW1ENj2QckzVLQFXu"], ["43. Extendable basic sharing 2-of-3 (128 bits)", ["enemy favorite academic acid cowboy phrase havoc level response walnut budget painting inside trash adjust froth kitchen learn tidy punish", "enemy favorite academic always academic sniff script carpet romp kind promise scatter center unfair training emphasis evening belong fake enforce"], "48b1a4b80b8c209ad42c33672bdaa428", "xprv9s21ZrQH143K4FS1qQdXYAFVAHiSAnjj21YAKGh2CqUPJ2yQhMmYGT4e5a2tyGLiVsRgTEvajXkxhg92zJ8zmWZas9LguQWz7WZShfJg6RS"], ["44. Valid extendable mnemonic without sharing (256 bits)", ["impulse calcium academic academic alcohol sugar lyrics pajamas column facility finance tension extend space birthday rainbow swimming purple syndrome facility trial warn duration snapshot shadow hormone rhyme public spine counter easy hawk album"], "8340611602fe91af634a5f4608377b5235fa2d757c51d720c0c7656249a3035f", "xprv9s21ZrQH143K2yJ7S8bXMiGqp1fySH8RLeFQKQmqfmmLTRwWmAYkpUcWz6M42oGoFMJRENmvsGQmunWTdizsi8v8fku8gpbVvYSiCYJTF1Y"], ["45. Extendable basic sharing 2-of-3 (256 bits)", ["western apart academic always artist resident briefing sugar woman oven coding club ajar merit pecan answer prisoner artist fraction amount desktop mild false necklace muscle photo wealthy alpha category unwrap spew losing making", "western apart academic acid answer ancient auction flip image penalty oasis beaver multiple thunder problem switch alive heat inherit superior teaspoon explain blanket pencil numb lend punish endless aunt garlic humidity kidney observe"], "8dc652d6d6cd370d8c963141f6d79ba440300f25c467302c1d966bff8f62300d", "xprv9s21ZrQH143K2eFW2zmu3aayWWd6MJZBG7RebW35fiKcoCZ6jFi6U5gzffB9McDdiKTecUtRqJH9GzueCXiQK1LaQXdgthS8DgWfC8Uu3z7"]];
{ let ok = 0, bad = [];
  for (const [desc, mns, secret, xprv] of OFFICIAL) { let got = null; try { got = Buffer.from(await combineMnemonics(mns, 'TREZOR')).toString('hex'); } catch {}
    const good = secret ? (got === secret && HDKey.fromMasterSeed(Buffer.from(secret, 'hex')).privateExtendedKey === xprv) : got === null; good ? ok++ : bad.push(desc); }
  ck(`all ${OFFICIAL.length} official vectors (valid recover exactly, invalid rejected)`, bad.length === 0, bad.join(' | ')); }
// ---- App-equivalent round trip (same call shape as s39_generateShares / s39r_recover) ----
let rt = 0, bad = 0;
for (const len of [16, 32]) for (const [m, n] of [[2,3],[3,5],[4,7],[2,2],[5,16]]) for (let t = 0; t < 8; t++) {
  const mnemonic = bip39.entropyToMnemonic(randomBytes(len), wordlist); const ent = Buffer.from(bip39.mnemonicToEntropy(mnemonic, wordlist));
  const shares = (await generateMnemonics(1, [[m, n]], ent, '', 1))[0];
  const pick = shares.slice().sort(() => Math.random() - 0.5).slice(0, m);
  const back = bip39.entropyToMnemonic(new Uint8Array(await combineMnemonics(pick, '')), wordlist);
  back === mnemonic ? rt++ : bad++;
  let under = false; if (m > 1) { try { await combineMnemonics(pick.slice(0, m - 1), ''); under = true; } catch {} } if (under) bad++;
}
ck(`in-app round trip x${rt} (12/24w, 2-of-2 .. 5-of-16); m-1 shares always rejected`, bad === 0, bad ? bad + ' bad' : undefined);
// ---- Finding 2: what a Trezor (standard SLIP-39) would restore ----
const mnT = bip39.entropyToMnemonic(randomBytes(16), wordlist);
const entT = Buffer.from(bip39.mnemonicToEntropy(mnT, wordlist));
const sharesT = (await generateMnemonics(1, [[2, 3]], entT, '', 1))[0];
const ms = new Uint8Array(await combineMnemonics(sharesT.slice(0, 2), ''));
const walletFp = fp(HDKey.fromMasterSeed(await bip39.mnemonicToSeed(mnT, '')));   // the user's real wallet
const trezorFp = fp(HDKey.fromMasterSeed(ms));                                        // SLIP-39 standard: master secret IS the BIP-32 seed
console.log(`\n  user's real wallet fingerprint : ${walletFp}`);
console.log(`  Trezor restore fingerprint     : ${trezorFp}   ${walletFp === trezorFp ? '(same)' : '<-- DIFFERENT WALLET'}`);
// ---- Recovery shows both readings before anything is saved (Trezor shares → standard wallet) ----
{
  const vm = await import('node:vm');
  const btcSigner = await import('@scure/btc-signer');
  const ctx = vm.createContext({ window: { BtcMath: { bip39, HDKey, btcSigner } }, Uint8Array, Promise });
  vm.runInContext(extract('_s39rReadings'), ctx);
  const v4 = OFFICIAL.find(([d]) => d.startsWith('4. '));
  const secret = new Uint8Array(await combineMnemonics(v4[1], 'TREZOR'));
  const words = bip39.entropyToMnemonic(secret.slice(), wordlist);
  const r = await ctx._s39rReadings(words, secret.slice());
  const fpOf = (k) => (k.fingerprint >>> 0).toString(16).padStart(8, '0').toUpperCase();
  const official = HDKey.fromExtendedKey(v4[3]);          // the official vector's expected master key
  const addrOf = (root) => btcSigner.p2wpkh(root.derive("m/84'/0'/0'/0/0").publicKey).address;
  ck('Trezor/standard reading = the official vector\'s master key (fingerprint + first address)',
    r.standard.fp === fpOf(official) && r.standard.address === addrOf(official), r.standard.fp);
  const skRoot = HDKey.fromMasterSeed(await bip39.mnemonicToSeed(words, ''));
  ck('SafeKeep reading = the 12-word wallet (fingerprint + first address)', r.safekeep.fp === fpOf(skRoot) && r.safekeep.address === addrOf(skRoot), r.safekeep.fp);
  ck('the two readings are different wallets (and both are shown)', r.safekeep.fp !== r.standard.fp);
  const rec = extract('s39r_recover');
  ck('Combine & Recover no longer saves anything or asks confirm(): it only shows the choice',
    !/confirm\(/.test(rec) && !/restoreMasterSeed|_ephemeralCommitSeed/.test(rec) && /_s39rShowChoice\(/.test(rec));
  const restore = extract('s39r_restorePending');
  ck('only "Restore This Wallet" (the SafeKeep reading) writes a seed', /restoreMasterSeed\(mnemonic\)/.test(restore) && /_ephemeralCommitSeed\(mnemonic\)/.test(restore));
  ck('the Trezor reading has no restore button and says nothing is saved', /SafeKeep can&rsquo;t open this wallet yet, so nothing will be saved/.test(extract('_s39rShowChoice')) &&
    (extract('_s39rShowChoice').match(/onclick=/g) || []).length === 1);
}
// ---- The tool's own split and checks (Shamir Backup on the guided flow) ----
{
  const vm = await import('node:vm');
  const toolFns = ['_xorFingerprint', '_s39Combine', 's39_validatePassphrase', 's39_generateShares', '_s39VerifyTyped', '_s39CheckExisting'];
  function toolCtx(mnemonic, { m = 2, n = 3, pp = '', confirm = pp } = {}) {
    const { document } = makeDom({ 's39-passphrase': pp, 's39-passphrase-confirm': confirm });
    const log = { status: '', flow: 0, locked: [], released: [] };
    const ctx = vm.createContext({
      window: { BtcMath: { bip39, wordlist, HDKey }, SLIP39: { generateMnemonics, combineMnemonics }, ShareFlow: {}, SeedSession: { get: () => ({ mnemonic }) } },
      document, Buffer, Uint8Array, console,
      showStatus: (msg, t) => { log.status = t + ':' + msg; },
      s39_state: { threshold: m, totalShares: n, generatedShares: [], locked: false },
      _s39HasWork: false,
      _s39StartFlow: () => { log.flow++; },
      _shardLockEngage: (t) => { log.locked.push(t); }, _shardLockRelease: (t) => { log.released.push(t); },
    });
    vm.runInContext(toolFns.map((f) => extract(f)).join('\n'), ctx);
    return { ctx, log };
  }
  for (const len of [16, 32]) {
    const seed = bip39.entropyToMnemonic(randomBytes(len), wordlist);
    const { ctx, log } = toolCtx(seed);
    await ctx.s39_generateShares();
    const shares = ctx.s39_state.generatedShares;
    const words = len === 16 ? 20 : 33;
    ck(`split (${len === 16 ? 12 : 24}-word seed): 3 shares of ${words} words, flow started, warning on`, shares.length === 3 && shares.every((x) => x.split(' ').length === words) && log.flow === 1 && log.locked[0] === 's39', log.status);
    ck(`split: the shares rebuild the seed (any 2)`, (await ctx._s39Combine([shares[2], shares[0]], '')) === seed);
    ck('split: fingerprint and state kept for the checks', ctx.s39_state.seedMnemonic === seed && /^[0-9a-f]{8}$/.test(ctx.s39_state.fingerprint) && !ctx.s39_state.hasPassphrase);
    let r = await ctx._s39VerifyTyped(shares);
    ck('final check: all typed shares rebuild the seed and release the warning', r.ok && log.released.includes('s39'), JSON.stringify(r));
    { // a valid share from another set in the last place must not pass
      const t2 = toolCtx(seed); await t2.ctx.s39_generateShares();
      const mixed = [shares[0], shares[1], t2.ctx.s39_state.generatedShares[2]];
      const r2 = await ctx._s39VerifyTyped(mixed);
      ck('final check: every share takes part (a foreign last share fails)', !r2.ok, JSON.stringify(r2)); }
    r = await ctx._s39CheckExisting([shares[1], shares[2]]);
    ck('check shares: any 2 rebuild the vault seed', r.ok && /rebuild your vault seed/.test(r.message) && !seed.split(' ').slice(1).some((w, k) => r.message.includes(seed.split(' ')[k] + ' ' + w)), r.message);
    ck('check shares: the words come back separately, labelled as the vault seed', r.words === seed && /your vault seed/.test(r.wordsLabel));
    r = await ctx._s39CheckExisting([shares[1]]);
    ck('check shares: one share is not enough, and the message says how many', !r.ok && /Not enough shares: this set needs 2/.test(r.message), r.message);
    r = await ctx._s39CheckExisting(shares.slice());
    ck('check shares: all 3 of a 2-of-3 set → "enter 2 of them"', !r.ok && /Too many shares.*Enter 2/.test(r.message), r.message);
    const typo = shares[0].split(' '); typo[5] = typo[5] === 'academic' ? 'acid' : 'academic';
    r = await ctx._s39CheckExisting([typo.join(' '), shares[1]]);
    ck('check shares: a wrong word is caught, and no words are offered', !r.ok && /wrong word/.test(r.message) && !r.words, r.message);
    const other = (await generateMnemonics(1, [[2, 3]], Buffer.from(randomBytes(len)), '', 1))[0];
    r = await ctx._s39CheckExisting([shares[0], other[1]]);
    ck('check shares: shares from two different sets are refused', !r.ok, r.message);
    r = await ctx._s39CheckExisting(other.slice(0, 2));
    ck('check shares: another seed\'s shares → a different seed, both fingerprints', !r.ok && /different seed/.test(r.message) && (r.message.match(/[0-9a-f]{8}/g) || []).length === 2, r.message);
    ck('check shares: that seed\'s words are offered, labelled NOT your vault seed', r.words && r.words !== seed && r.words.split(' ').length === len * 3 / 4 && /NOT your vault seed/.test(r.wordsLabel));
  }
  { // with a share passphrase
    const seed = bip39.entropyToMnemonic(randomBytes(16), wordlist);
    const { ctx, log } = toolCtx(seed, { m: 3, n: 5, pp: 'correct horse' });
    await ctx.s39_generateShares();
    const shares = ctx.s39_state.generatedShares;
    ck('passphrase split: 5 shares, 3 needed, passphrase noted but not kept', shares.length === 5 && ctx.s39_state.hasPassphrase && !JSON.stringify(ctx.s39_state).includes('correct horse'));
    let r = await ctx._s39VerifyTyped(shares, 'wrong horse');
    ck('final check: a wrong passphrase says so and keeps the warning', !r.ok && /passphrase is wrong/.test(r.message) && !log.released.length, r.message);
    r = await ctx._s39VerifyTyped(shares, 'correct horse');
    ck('final check: the right passphrase passes', r.ok);
    r = await ctx._s39CheckExisting(shares.slice(1, 4), '');
    ck('check shares: without the passphrase → a different seed, with a hint', !r.ok && /share passphrase/.test(r.message), r.message);
    r = await ctx._s39CheckExisting(shares.slice(1, 4), 'correct horse');
    ck('check shares: with the passphrase they pass', r.ok);
  }
  { // refusals
    const seed = bip39.entropyToMnemonic(randomBytes(16), wordlist);
    let t = toolCtx(seed, { pp: 'abc', confirm: 'abd' }); await t.ctx.s39_generateShares();
    ck('split refuses mismatched passphrases', !t.ctx.s39_state.generatedShares.length && /don\u2019t match/.test(t.log.status), t.log.status);
    t = toolCtx(seed, { pp: 'caf\u00e9', confirm: 'caf\u00e9' }); await t.ctx.s39_generateShares();
    ck('split refuses a non-ASCII passphrase', !t.ctx.s39_state.generatedShares.length && /ASCII/.test(t.log.status));
    t = toolCtx(seed, { m: 1, n: 3 }); await t.ctx.s39_generateShares();
    ck('split refuses a threshold of 1', !t.ctx.s39_state.generatedShares.length && /threshold of 1/.test(t.log.status));
  }
  { // The Dashboard's BIP-39 passphrase is not used as the share passphrase.
    const init = extract('s39_init'), reset = extract('_s39ResetPassphraseFields');
    ck('entering the tool never reads the BIP-39 passphrase into the share passphrase', !/getPassphrase/.test(init + reset) && /pp\.value = ''/.test(reset) && /readOnly = false/.test(reset));
    ck('the share passphrase comes only from the Advanced field', /getElementById\('s39-passphrase'\)\.value/.test(extract('s39_generateShares')) && !/getPassphrase/.test(extract('s39_generateShares')));
    ck('a BIP-39 passphrase only adds a "back it up separately" line to the done screen', /keep a separate backup of that passphrase/.test(extract('_s39StartFlow')));
  }
  ck('the old share cards, Copy and Dry Run are gone', !/s39_copyShare|s39v_testRecovery|s39-shares-container|Backup Verification — Dry Run/.test(SRC));
}

// ---- Welcome screen: Recover Shamir Backup (word boxes, add-time checks, exactly-M) ----
{
  const vm = await import('node:vm');
  const btcSigner = await import('@scure/btc-signer');
  const shareInfo = (m) => { const x = Share.fromMnemonic(m); return { identifier: x.identifier, groupIndex: x.groupIndex, groupThreshold: x.groupThreshold, groupCount: x.groupCount, index: x.index, memberThreshold: x.memberThreshold }; };
  function recCtx() {
    const { document } = makeDom({ 's39r-passphrase': '' });
    let typed = [], status = '';
    const boxes = { getWords: () => typed.slice(), clear() { typed = []; }, focus() {} };
    const ctx = vm.createContext({
      window: { BtcMath: { bip39, wordlist, HDKey, btcSigner }, SLIP39: { combineMnemonics, shareInfo } },
      document, Uint8Array, Buffer, console, showStatus() {}, s39r_showLocalStatus: (m) => { status = m; }, s39r_renderShareList() {},
      _s39rBoxes: boxes, _s39rShares: [], _s39rPending: null,
    });
    vm.runInContext(['_s39rNeeded', 's39r_updateRecoverBtn', 's39r_addShare', 's39r_recover', '_s39rReadings', '_s39rShowChoice', '_s39rClearChoice'].map((f) => extract(f)).join('\n'), ctx);
    return { ctx, type: (m) => { typed = m.split(' '); }, status: () => status, btn: () => ctx.document.getElementById('s39r-recover-btn') };
  }
  const seed = bip39.entropyToMnemonic(randomBytes(32), wordlist);
  const sh = (await generateMnemonics(1, [[2, 3]], Buffer.from(bip39.mnemonicToEntropy(seed, wordlist)), '', 1))[0];
  const skFp = (HDKey.fromMasterSeed(await bip39.mnemonicToSeed(seed, '')).fingerprint >>> 0).toString(16).padStart(8, '0').toUpperCase();
  const r = recCtx();
  r.type(sh[0]); r.ctx.s39r_addShare();
  ck('recover: adding share 1 says the set needs 2', /needs 2 shares: add 1 more/.test(r.status()) && r.btn().disabled, r.status());
  const typo = sh[1].split(' '); typo[7] = typo[7] === 'academic' ? 'acid' : 'academic';
  r.type(typo.join(' ')); r.ctx.s39r_addShare();
  ck('recover: a mistyped share is refused when added', /wrong word/.test(r.status()) && r.ctx._s39rShares.length === 1, r.status());
  const other = (await generateMnemonics(1, [[2, 3]], Buffer.from(randomBytes(32)), '', 1))[0];
  r.type(other[1]); r.ctx.s39r_addShare();
  ck('recover: a share from another set is refused when added', /different set/.test(r.status()) && r.ctx._s39rShares.length === 1, r.status());
  r.type(sh[0]); r.ctx.s39r_addShare();
  ck('recover: the same share twice is refused', /already been added/.test(r.status()));
  r.type(sh[2]); r.ctx.s39r_addShare();
  ck('recover: 2 shares → enough, Combine enabled', /you have enough/.test(r.status()) && !r.btn().disabled, r.status());
  r.type(sh[1]); r.ctx.s39r_addShare();
  ck('recover: a third share can still be added', r.ctx._s39rShares.length === 3);
  await r.ctx.s39r_recover();
  ck('recover: 3 shares of a 2-of-3 set combine (every run agrees) and show the seed\'s fingerprint', r.ctx._s39rPending && r.ctx._s39rPending.mnemonic === seed && r.ctx._s39rPending.safekeepFp === skFp, r.status());
  const t3 = (await generateMnemonics(1, [[3, 5]], Buffer.from(randomBytes(16)), '', 1))[0];
  const few = recCtx(); few.ctx._s39rShares.push(t3[0], t3[1]);
  await few.ctx.s39r_recover();
  ck('recover: too few shares says how many the set needs', /this set needs 3 shares/.test(few.status()), few.status());
  ck('recover panel: no text box, word boxes and a 20/33 choice', !/id="s39r-share-input"/.test(SRC) && /id="s39r-boxes"/.test(SRC) && /s39r_setWordCount\(20\)/.test(SRC));
  ck('XOR restore panel: the shared word boxes', /ShareFlow\.createWordBoxes\(document\.getElementById\('xrr-grid-'/.test(SRC) && !/function xrr_onInput/.test(SRC));
}

console.log(`\nSLIP-39: ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);

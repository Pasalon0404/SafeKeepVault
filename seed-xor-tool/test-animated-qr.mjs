/**
 * test-animated-qr.mjs — dense QR codes can be played as animated BC-UR.
 *
 *  1. Density: short payloads (xpub, descriptor) are not dense; Hardware
 *     Wallet JSON and a 3-of-5 descriptor are; text too big for any QR is.
 *  2. Frames: upper-case UR:BYTES parts, each small enough to scan easily,
 *     that a BC-UR decoder puts back together into exactly the same text.
 *  3. Wiring: Seed Management and Output Descriptor draw through
 *     skqr_render and stop the animation when the QR is hidden.
 *
 * Run: node test-animated-qr.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import QRCode from 'qrcode';
import { URDecoder, UR, UREncoder } from '@ngraveio/bc-ur';
import { Buffer } from 'buffer';
import { qrVersion, isDense, urBytesFrames, DENSE_MIN_VERSION } from './shared/animated-qr.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'boot.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + n + (c ? '' : '  got: ' + x)); };

const XPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const XP = 'xpub6E79FaRWLSJCAgA2jDHRvyrWKwT6aSmR685zptzyYPvmUd44omcxZ1NAzDtbdFBvEADjcVbV4NzTDwQeU6oiSV9KGiMSWhjANZjbfUHkm3Y';
const DESC1 = "wpkh([5436d724/84'/0'/0']xpub6Bner3L3tdQW367NmmMsWKtMfP7hbu4JxdtbSGdWWjSzLkSUEnT7G9h5GFWUXtifeRhHiUXJuek1qeaTJqnXkveWpiHp8rmt53E8HTMshg9/<0;1>/*)#00lx6ere";
const multi = (m, n) => `wsh(sortedmulti(${m},${Array.from({ length: n }, (_, i) =>
    `[${(0x1000000 + i).toString(16).padStart(8, '0')}/48'/0'/0'/2']${XP}/<0;1>/*`).join(',')}))#abcdefgh`;
const JSON1 = JSON.stringify({ chain: 'BTC', xfp: '5436D724', xpub: XP, account: 0,
    bip84: { name: 'p2wpkh', deriv: "m/84'/0'/0'", xpub: XP, _pub: XPUB, xfp: 'A1B2C3D4', first: 'bc1qzmtrqsfuaf6l6kkcsseumq26ukaphfj9skkug6' },
    bip352: { deriv: "m/352'/0'/0'", descriptor: 'sp(' + XP + XP + ')', path: "m/352'/0'/0'", birthday: 840000, name: 'SafeKeep SP' } }, null, 2);

console.log('1. Density');
ck('xpub is not dense', !isDense(QRCode, XPUB));
ck('single-sig descriptor is not dense', !isDense(QRCode, DESC1, 'L'));
ck('2-of-3 descriptor at L is not dense', !isDense(QRCode, multi(2, 3), 'L'), qrVersion(QRCode, multi(2, 3), 'L'));
ck('3-of-5 descriptor at L is dense', isDense(QRCode, multi(3, 5), 'L'), qrVersion(QRCode, multi(3, 5), 'L'));
ck(`Hardware Wallet JSON (${JSON1.length} chars) is dense`, isDense(QRCode, JSON1), qrVersion(QRCode, JSON1));
ck('text too big for any QR code: version Infinity, dense', qrVersion(QRCode, 'x'.repeat(5000)) === Infinity && isDense(QRCode, 'x'.repeat(5000)));
ck('threshold is version 15 (77 squares per side)', DENSE_MIN_VERSION === 15);

console.log('2. Frames');
const libs = { UR, UREncoder, Buffer };
const roundTrip = (frames) => {
    const dec = new URDecoder();
    for (const f of frames) { if (dec.isComplete()) break; dec.receivePart(f); }
    return dec.isSuccess() ? { type: dec.resultUR().type, text: dec.resultUR().decodeCBOR().toString('utf8') } : null;
};
for (const [name, text] of [['Hardware Wallet JSON', JSON1], ['5-of-7 descriptor', multi(5, 7)], ['text too big for one QR', 'é—' + 'x'.repeat(5000)]]) {
    const frames = urBytesFrames(libs, text);
    const back = roundTrip(frames);
    ck(`${name}: ${frames.length} frames decode to exactly the same text`, back && back.type === 'bytes' && back.text === text, back && back.text.slice(0, 40));
    ck(`${name}: frames are upper-case UR:BYTES/i-n`, frames.every((f, i) => f.startsWith(`UR:BYTES/${i + 1}-${frames.length}/`)));
    const worst = Math.max(...frames.map((f) => qrVersion(QRCode, f, 'L')));
    ck(`${name}: every frame is small (version ${worst} ≤ 10)`, worst <= 10, worst);
}
ck('frames still decode when the camera joins mid-loop', (() => {
    const f = urBytesFrames(libs, JSON1); return roundTrip([...f.slice(4), ...f.slice(0, 4)])?.text === JSON1; })());

console.log('3. Wiring');
const fn = (name) => { const i = SRC.search(new RegExp('function ' + name + '\\s*\\(')); return SRC.slice(i, SRC.indexOf('\n}\n', i)); };
ck('Seed Management Show QR draws through skqr_render', /skqr_render\(canvas, payload/.test(fn('arm_toggleXpubQR')));
ck('Seed Management Hide QR stops the animation', /skqr_stop\(/.test(fn('arm_toggleXpubQR')));
ck('a key format change that hides the QR stops the animation', /_armXpubQRVisible = false;\n[^\n]*\n\s*skqr_stop\(/.test(fn('arm_deriveWallet')));
ck('Output Descriptor Show QR draws through skqr_render, Hide stops it',
    /skqr_render\(canvas, desc_state\.currentDescriptor/.test(fn('desc_toggleQR')) && /skqr_stop\(canvas\)/.test(fn('desc_toggleQR')));
ck('Output Descriptor shows the QR box before drawing (a hidden canvas stops the animation)',
    fn('desc_toggleQR').indexOf("wrap.style.display = 'block'") < fn('desc_toggleQR').indexOf('skqr_render('));
ck('animation stops by itself once the QR is off screen', /if \(!canvas\.getClientRects\(\)\.length\) \{ skqr_stop\(canvas\); return; \}/.test(fn('skqr_play')));
ck('frames are drawn at error correction L', /errorCorrectionLevel: 'L'/.test(fn('skqr_play')));
ck('boot-entry exposes window.AnimatedQR', /window\.AnimatedQR = \{/.test(readFileSync(join(HERE, 'boot-entry.js'), 'utf8')));

console.log(`\nANIMATED QR: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

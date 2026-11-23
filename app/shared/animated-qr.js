/**
 * animated-qr.js — measure how dense a QR code is, and turn its text into
 * animated BC-UR frames when it is too dense for a camera to read easily.
 *
 * The animated form is `ur:bytes` (BCR-2020-005/006): the exact text the
 * static QR would hold, split into fountain-coded parts. Wallets that scan
 * animated QR codes (Sparrow, Nunchuk, Keystone, BlueWallet, …) put the
 * parts back together and get the same text. Frames are upper-case so the
 * QR library uses its compact alphanumeric mode.
 *
 * The libraries are passed in (window.QRCode, window.UR, window.UREncoder,
 * window.Buffer in the app; the npm packages in the tests).
 */

// A QR code of version 15 (77 squares per side) or more counts as dense.
// Measured in the app: xpubs, single-sig descriptors, seeds and shares are
// version 6–11; Hardware Wallet JSON is 23–26 and a 3-of-5 descriptor 19–22.
export const DENSE_MIN_VERSION = 15;

// Bytes of text per animated frame. 120 bytes gives frames of about
// version 9 (53 squares per side) at error correction L.
export const FRAGMENT_BYTES = 120;

export const FRAME_MS = 300;

/** The QR version for `text`, or Infinity if it fits no single QR code. */
export function qrVersion(QRCode, text, errorCorrectionLevel = 'M') {
    try {
        return QRCode.create(text, { errorCorrectionLevel }).version;
    } catch (_) {
        return Infinity;
    }
}

export function isDense(QRCode, text, errorCorrectionLevel = 'M') {
    return qrVersion(QRCode, text, errorCorrectionLevel) >= DENSE_MIN_VERSION;
}

/** The animated frames for `text`: upper-case `UR:BYTES/…` strings, one loop. */
export function urBytesFrames({ UR, UREncoder, Buffer }, text, fragmentBytes = FRAGMENT_BYTES) {
    const encoder = new UREncoder(UR.fromBuffer(Buffer.from(String(text), 'utf8')), fragmentBytes);
    const frames = [];
    for (let i = 0; i < encoder.fragmentsLength; i++) frames.push(encoder.nextPart().toUpperCase());
    return frames;
}

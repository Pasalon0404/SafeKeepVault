import * as btc from '@scure/btc-signer';
import * as bip39 from '@scure/bip39';
// Added .js extension to satisfy Vite 8 strict resolution
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import QRCode from 'qrcode';

// The new Optical Air-Gap libraries
import { URDecoder } from "@ngraveio/bc-ur";

// Shared modules
import '../shared/seed-manager.js';
import '../shared/seed-session.js';

// Expose them to the window so your HTML can use them
window.BtcMath = {
    btc,
    bip39,
    wordlist,
    HDKey
};

window.QRCode = QRCode;
window.URDecoder = URDecoder;
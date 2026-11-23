import * as btc from '@scure/btc-signer';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import QRCode from 'qrcode';

// Shared modules (bundled by Vite into this tool's standalone HTML)
import '../shared/seed-manager.js';
import '../shared/seed-selector.js';
import '../shared/seed-session.js';

// Expose them to the window so your HTML can use them
window.BtcMath = {
    btc,
    bip39,
    wordlist,
    HDKey
};

window.QRCode = QRCode;
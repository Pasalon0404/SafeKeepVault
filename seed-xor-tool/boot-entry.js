/**
 * SafeKeepBitcoin — Boot Entry Point (Vite-bundled)
 *
 * This is the JS entry point for boot.html. Vite bundles the shared
 * modules (seed-session, boot) into this file so the boot page works
 * as a single self-contained HTML file on the USB drive.
 */

// Buffer polyfill — vite-plugin-node-polyfills doesn't auto-inject into global scope
import { Buffer } from 'buffer';
window.Buffer = Buffer;

// Crypto libraries — Vite bundles these from node_modules
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import * as btcSigner from '@scure/btc-signer';

// QR code generation and scanning
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { URDecoder } from '@ngraveio/bc-ur';

// CBOR decoder — transitive dependency of @ngraveio/bc-ur, used to decode
// crypto-output payloads from UR QR codes into output descriptor strings.
import CBOR from 'cbor-sync';

// SLIP-39: Shamir's Secret Sharing for mnemonic backup
import { generateMnemonics, combineMnemonics } from 'shamir-mnemonic-ts';

// Miniscript: policy compilation for advanced custody (wsh(miniscript(...)))
// @bitcoinerlab/miniscript compiles policies → witness scripts
// Uses WASM internally — Vite must be configured to inline the .wasm asset.
// If the WASM build fails, Miniscript features gracefully degrade (see boot.html).
let Miniscript = null;
try {
  const ms = await import('@bitcoinerlab/miniscript');
  Miniscript = { compilePolicy: ms.compilePolicy, compileMiniscript: ms.compileMiniscript };
} catch (e) {
  console.warn('Miniscript library not available — advanced policy features disabled.', e.message);
}

// Expose to window so boot.js and inline scripts can use them
window.BtcMath = { bip39, wordlist, HDKey, btcSigner };
window.SLIP39 = { generateMnemonics, combineMnemonics };
window.Miniscript = Miniscript;
window.QRCode = QRCode;
window.jsQR = jsQR;
window.URDecoder = URDecoder;
window.CBOR = CBOR;

// Import shared modules — Vite will bundle these
import './shared/seed-session.js';
import './shared/boot.js';

// Run the boot sequence once the DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const result = await window.SafeKeepOS.boot();
    // Hand off to the inline script in boot.html
    if (typeof window.onBootComplete === 'function') {
      window.onBootComplete(result);
    }
  } catch (err) {
    console.error('SafeKeepOS boot failed:', err);
    // Show loading screen error
    const spinner = document.querySelector('.boot-spinner');
    if (spinner) spinner.style.display = 'none';
    const text = document.querySelector('.boot-spinner-text');
    if (text) {
      text.textContent = `Boot error: ${err.message}`;
      text.style.color = 'var(--skb-danger)';
    }
  }
});

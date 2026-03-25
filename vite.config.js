import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';

export default defineConfig({
  base: './', // <-- THIS IS THE MAGIC LINE FOR OFFLINE USAGE
  plugins: [
    nodePolyfills(),
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        architecture: resolve(__dirname, 'architecture/index.html'),
        bip85: resolve(__dirname, 'bip85/index.html'),
        descriptor: resolve(__dirname, 'descriptor/index.html'),
        dice: resolve(__dirname, 'dice/index.html'),
        entropyTool: resolve(__dirname, 'entropy-tool/index.html'),
        guideCypherpunk: resolve(__dirname, 'guide-cypherpunk/index.html'),
        guideRecovery: resolve(__dirname, 'guide-recovery/index.html'),
        guideThreats: resolve(__dirname, 'guide-threats/index.html'),
        guideXorVsMultisig: resolve(__dirname, 'guide-xor-vs-multisig/index.html'),
        passphrase: resolve(__dirname, 'passphrase/index.html'),
        secureNote: resolve(__dirname, 'secure-note/index.html'),
        seedxor: resolve(__dirname, 'seedxor/index.html'),
        seedqr: resolve(__dirname, 'seedqr/index.html'),
        signer: resolve(__dirname, 'signer/index.html'),
        qrtransfer: resolve(__dirname, 'qr-transfer/index.html')


      }
    }
  }
});
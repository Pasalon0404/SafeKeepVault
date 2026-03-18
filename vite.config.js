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
        bip85: resolve(__dirname, 'bip85folder/index.html'),
        signer: resolve(__dirname, 'safekeep-signer/index.html'),
        app: resolve(__dirname, 'app.html'),
        architecture: resolve(__dirname, 'architecture.html'),
        cssprint: resolve(__dirname, 'cssprint.html'),
        cypherpunk: resolve(__dirname, 'cypherpunk.html'),
        diceToSeed: resolve(__dirname, 'dice-to-seed.html'),
        newsigner: resolve(__dirname, 'newsigner.html'),
        passphrase: resolve(__dirname, 'passphrase.html'),
        recovery: resolve(__dirname, 'recovery101.html'),
        threats: resolve(__dirname, 'threats.html'),
        xor: resolve(__dirname, 'xor-vs-multisig.html')
      }
    }
  }
});
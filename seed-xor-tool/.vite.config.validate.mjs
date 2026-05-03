const defineConfig = (c) => c;
const nodePolyfills = () => ({ name: "stub-polyfills" });
const viteSingleFile = () => ({ name: "stub-singlefile" });
import { resolve } from 'path';

// ---------------------------------------------------------------
// SafeKeepVault — Vite configuration
// ---------------------------------------------------------------
// Production builds are driven by build-offline.mjs (runs `vite build`
// programmatically, inlines boot.html into a single self-contained
// file for the USB kiosk). That script bypasses this config entirely
// via `configFile: false`.
//
// This file therefore exists to serve the DEV SERVER (`npm run dev`),
// which is what developers use to iterate on boot.html from a Mac via
// the Live Server dev-mode wrapper baked into boot.html itself.
//
// The legacy landing page (index.html) and the four guide-* pages
// were removed during the OS pivot. They used to appear in
// rollupOptions.input below, but every entry that no longer resolves
// to a real file causes Vite to crash at startup with:
//   "failed to resolve rollupOptions.input value: .../index.html"
// The input list is now pruned to files that actually exist.
//
// `base: './'` keeps generated URLs relative — essential for the
// file:// kiosk origin where the compiled boot.html is served.
//
// `appType: 'mpa'` tells the dev server to treat this repo as a
// multi-page app. Without this, Vite defaults to 'spa' and rewrites
// every 404 to /index.html, which no longer exists; requests for
// /boot.html work anyway, but bare `/` 404s cleanly instead of
// triggering the SPA fallback spinner.
//
// `server.open: '/boot.html'` makes `npm run dev` launch the dev
// build into the default browser pointing directly at the app,
// saving the developer a manual URL paste.
// ---------------------------------------------------------------

export default defineConfig({
  base: './', // Required for file:// kiosk bundles; harmless for dev server
  appType: 'mpa',
  server: {
    open: '/boot.html',
    // Port is left default (5173). If you want a specific port for
    // consistency with external docs, uncomment:
    // port: 5173,
  },
  plugins: [
    nodePolyfills(),
    viteSingleFile(),
  ],
  build: {
    // Disable module preload entirely — the polyfill injects fetch() calls and
    // crossorigin attributes that break on file:// protocol (USB boot drive).
    // All our JS is inlined anyway, so preloading gains nothing.
    modulePreload: false,
    rollupOptions: {
      input: {
        // PRIMARY ENTRY — boot.html is the entire shipped product.
        // build-offline.mjs rebuilds this as a monolithic single-file
        // HTML for the USB kiosk; the dev server uses it directly.
        boot: resolve(__dirname, 'boot.html'),

        // Secondary standalone tool pages — these still exist on
        // disk and are occasionally opened directly for isolated
        // tool demos. They are NOT part of the shipped kiosk build
        // (build-offline.mjs only compiles boot.html), but keeping
        // them in the dev input list lets developers load them at
        // http://localhost:5173/<path>/ during iteration.
        //
        // If any of these are deleted in future, remove the
        // matching line here or the dev server will refuse to start.
        architecture: resolve(__dirname, 'architecture/index.html'),
        bip85:        resolve(__dirname, 'bip85/index.html'),
        descriptor:   resolve(__dirname, 'descriptor/index.html'),
        dice:         resolve(__dirname, 'dice/index.html'),
        entropyTool:  resolve(__dirname, 'entropy-tool/index.html'),
        passphrase:   resolve(__dirname, 'passphrase/index.html'),
        secureNote:   resolve(__dirname, 'secure-note/index.html'),
        seedxor:      resolve(__dirname, 'seedxor/index.html'),
        seedqr:       resolve(__dirname, 'seedqr/index.html'),
        signer:       resolve(__dirname, 'signer/index.html'),
        qrtransfer:   resolve(__dirname, 'qr-transfer/index.html'),
      }
    }
  }
});

import { build } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The exact list of every page in your newly organized suite
const pages = [
    'index.html',
    'architecture/index.html',
    'bip85/index.html',
    'descriptor/index.html',
    'dice/index.html',
    'guide-cypherpunk/index.html',
    'guide-recovery/index.html',
    'guide-threats/index.html',
    'guide-xor-vs-multisig/index.html',
    'passphrase/index.html',
    'secure-note/index.html',
    'seedxor/index.html',
    'signer/index.html'
];

async function buildOfflineSuite() {
    for (let i = 0; i < pages.length; i++) {
        console.log(`\n🔨 Building standalone file: ${pages[i]}`);
        
        // We run a mini Vite build for each individual file
        await build({
            configFile: false, // Bypass standard config
            root: __dirname,
            base: './', // Ensures relative links work offline
            plugins: [nodePolyfills(), viteSingleFile()],
            build: {
                emptyOutDir: i === 0, // Only wipe the dist folder on the first run
                outDir: 'dist',
                rollupOptions: {
                    input: resolve(__dirname, pages[i]),
                }
            }
        });
    }
    console.log('\n✅ All tools successfully compiled into standalone offline HTML files!');
}

buildOfflineSuite();
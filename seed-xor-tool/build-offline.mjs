import { build } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// SafeKeep OS ships a single self-contained entry point.
// boot.html is the entire app — Vite inlines all scripts, styles,
// and assets via viteSingleFile(). The legacy per-tool pages and
// index.html landing page were removed during the OS pivot.
const pages = [
    'boot.html'
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
                // Kill the modulepreload polyfill and crossorigin attributes —
                // they inject fetch() calls that break on file:// (USB boot drive)
                modulePreload: false,
                rollupOptions: {
                    input: resolve(__dirname, pages[i]),
                }
            }
        });
    }
    console.log('\n✅ All tools successfully compiled into standalone offline HTML files!');

    // ------------------------------------------------------------------
    // DEV MODE STRIP — belt-and-suspenders hardening
    // ------------------------------------------------------------------
    // The _SKB_DevModeWrapper IIFE in boot.html short-circuits on
    // anything other than http(s)://localhost, so in theory it is
    // already inert on the USB drive (which loads over file://). This
    // step physically excises the wrapper from the shipped payload
    // anyway so that:
    //   • a compromised kiosk spoofing /etc/hosts can't activate it,
    //   • static auditors don't see the mock SafeKeepOS in prod bytes,
    //   • the attack surface drops to zero instead of "zero-under-
    //     a-hostname-check".
    //
    // We strip:
    //   1. The <!-- DEV_MODE — LIVE SERVER WRAPPER … --> HTML comment
    //   2. The adjacent <script>(function _SKB_DevModeWrapper() {…}());</script>
    //
    // MUST run before the integrity manifest is computed so the
    // attestation hash reflects the bytes Chromium will actually load.
    // ------------------------------------------------------------------
    const BOOT_HTML_PATH = join(resolve(__dirname, 'dist'), 'boot.html');
    if (existsSync(BOOT_HTML_PATH)) {
        const original = readFileSync(BOOT_HTML_PATH, 'utf8');

        // Comment block: the HTML comment whose body contains the exact
        // header phrase "DEV_MODE — LIVE SERVER WRAPPER". The negative
        // lookahead `(?:(?!-->)[\s\S])*?` guarantees we cannot cross an
        // intervening "-->", which would otherwise let an earlier,
        // unrelated <!--…--> pair anchor the opener — since the literal
        // token DEV_MODE also appears inside the circuit-breaker reads
        // of window._SKB_DEV_MODE. The lookahead forces the <!-- we
        // match to be the direct opener of the comment that really
        // holds the dev-wrapper banner.
        const COMMENT_RE =
            /<!--(?:(?!-->)[\s\S])*?DEV_MODE(?:(?!-->)[\s\S])*?LIVE SERVER WRAPPER(?:(?!-->)[\s\S])*?-->\s*/;

        // Script block: a <script> that contains the _SKB_DevModeWrapper
        // IIFE. The `\s*\(function\s+_SKB_DevModeWrapper` anchor is
        // unique in the bundle — it appears in exactly one <script>
        // open tag — so a simple non-greedy span to </script> is safe.
        const SCRIPT_RE =
            /<script\b[^>]*>\s*\(function\s+_SKB_DevModeWrapper\b[\s\S]*?<\/script>\s*/;

        const commentHit = COMMENT_RE.test(original);
        const scriptHit  = SCRIPT_RE.test(original);

        if (!scriptHit) {
            console.error('[DEV-STRIP] ✗ _SKB_DevModeWrapper block NOT FOUND in dist/boot.html');
            console.error('[DEV-STRIP]   Refusing to ship a build whose dev-mode posture is unknown.');
            process.exit(1);
        }

        let stripped = original.replace(COMMENT_RE, '');
        stripped = stripped.replace(SCRIPT_RE, '');

        // Post-strip paranoia — confirm no trace of the wrapper survives.
        if (/_SKB_DevModeWrapper|_SKB_DEV_URL_MODE/.test(stripped)) {
            console.error('[DEV-STRIP] ✗ residual dev-mode identifiers still present after strip.');
            process.exit(1);
        }

        writeFileSync(BOOT_HTML_PATH, stripped, { encoding: 'utf8' });

        const bytesSaved = original.length - stripped.length;
        console.log(
            `\n🧹 Dev Mode wrapper stripped from production build. ` +
            `(comment: ${commentHit ? 'removed' : 'absent'}, ` +
            `script: removed, saved ${bytesSaved} bytes)`
        );
    } else {
        console.error('[DEV-STRIP] ✗ dist/boot.html missing — Vite build did not produce expected output.');
        process.exit(1);
    }

    // ------------------------------------------------------------------
    // INTEGRITY MANIFEST — Item 5 (First-Boot Attestation)
    // ------------------------------------------------------------------
    // Generates dist/manifest.json containing SHA-256 hashes of every
    // file our boot flow actually cares about. safekeep-boot.sh reads
    // this manifest at early boot, re-computes the live hash of each
    // listed file, and writes the comparison result to a tmpfs bridge
    // at /run/safekeep-integrity.json. The front-end then fetches that
    // bridge file and renders a pass/fail attestation badge.
    //
    // Keeping the manifest bundled with dist/ means every build — dev,
    // CI, or hand-compiled on the Linux ZBook — automatically produces
    // a fresh integrity baseline. Future feature work cannot silently
    // break the attestation because the manifest regenerates in lock-
    // step with the files it hashes.
    //
    // Hashed files are listed below. boot.html is the primary gate
    // (it's what Chromium loads). If other files become security-
    // critical (e.g. a preload script), add them to the ATTESTED list.
    // ------------------------------------------------------------------
    const ATTESTED = ['boot.html'];
    const distDir = resolve(__dirname, 'dist');
    const manifest = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        algorithm: 'sha256',
        files: {}
    };

    for (const rel of ATTESTED) {
        const abs = join(distDir, rel);
        if (!existsSync(abs)) {
            console.error(`[MANIFEST] ✗ missing attested file: ${rel}`);
            process.exit(1);
        }
        const bytes = readFileSync(abs);
        const hash = createHash('sha256').update(bytes).digest('hex');
        manifest.files[rel] = { sha256: hash, bytes: bytes.length };
        console.log(`[MANIFEST] ${rel}  sha256=${hash.slice(0, 12)}…  ${bytes.length} bytes`);
    }

    const manifestPath = join(distDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8' });
    console.log(`\n🔒 Integrity manifest written to ${manifestPath}`);
}

buildOfflineSuite();
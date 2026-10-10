import { build } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `npm run build:demo` (--demo) builds the public online demo
// (demo.safekeepbitcoin.com) into dist-demo/ instead of the release
// boot.html in dist/. See DEMO BUILD below and shared/demo-mode.js.
const DEMO = process.argv.includes('--demo');
const OUT_DIR = DEMO ? 'dist-demo' : 'dist';

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
                outDir: OUT_DIR,
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
    const BOOT_HTML_PATH = join(resolve(__dirname, OUT_DIR), 'boot.html');
    if (DEMO) {
        // The demo runs the dev mock (in-memory vault, Transfer Drive,
        // Coldcard/Trezor simulators), so the wrapper stays in.
        if (!existsSync(BOOT_HTML_PATH) || !/_SKB_DevModeWrapper/.test(readFileSync(BOOT_HTML_PATH, 'utf8'))) {
            console.error('[DEMO] ✗ dev-mode wrapper missing from dist-demo/boot.html.');
            process.exit(1);
        }
    } else if (existsSync(BOOT_HTML_PATH)) {
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
        // The release must never carry the online-demo switch.
        if (DEMO_FLAG_RE.test(stripped)) {
            console.error('[DEV-STRIP] ✗ the online-demo flag (window.SKV_DEMO = true) is in the release build.');
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
    // ------------------------------------------------------------------
    // VERSION STAMP — automatic, nothing to edit per build
    // ------------------------------------------------------------------
    // Release number: seed-xor-tool/VERSION (bump it by hand for a release).
    // Build number:   the git commit count (goes up by one with every commit).
    // Commit:         short git hash, so any stick traces to one exact commit.
    // "+ local changes" marks a build made from uncommitted app source,
    // "+ shallow clone" one whose commit count (build number) is incomplete.
    // Fills every element marked data-skv-version (welcome screen, dashboard
    // footer). Runs BEFORE the integrity manifest so the hash covers it.
    const stamp = versionStamp() + (DEMO ? ' \u00b7 demo' : '');
    {
        const html = readFileSync(BOOT_HTML_PATH, 'utf8');
        const SKV_RE = /(<[^>]*\bdata-skv-version\b[^>]*>)[^<]*(<)/g;
        const hits = (html.match(SKV_RE) || []).length;
        if (hits < 2) {
            console.error(`[VERSION] ✗ expected the version spots in dist/boot.html, found ${hits}.`);
            process.exit(1);
        }
        const esc = stamp.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        writeFileSync(BOOT_HTML_PATH, html.replace(SKV_RE, (m, open, close) => open + esc + close), { encoding: 'utf8' });
        console.log(`\n🏷  Version: ${stamp}`);
    }

    if (DEMO) {
        finishDemo(BOOT_HTML_PATH);
        return;
    }

    const ATTESTED = ['boot.html'];
    const distDir = resolve(__dirname, 'dist');
    const manifest = {
        schemaVersion: 1,
        version: stamp,
        // Commit time, not build time, so rebuilding a commit reproduces
        // the manifest byte-for-byte too (see VERIFYING.md).
        generatedAt: commitTime(),
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

// ----------------------------------------------------------------------
// DEMO BUILD — the public online demo (demo.safekeepbitcoin.com)
// ----------------------------------------------------------------------
// Adds to the top of <head>:
//   - a Content-Security-Policy that forbids every network connection
//     (connect-src 'none'), so the page can't send anything anywhere;
//   - window.SKV_DEMO = true, which switches on the demo safeguards
//     (shared/demo-mode.js) and the in-memory dev mock;
// and writes dist-demo/index.html, the file the demo site serves.
// The release build never gets these (and refuses to ship the flag).
const DEMO_FLAG_RE = /window\.SKV_DEMO\s*=\s*true/;
const DEMO_CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob: mediastream:",
    "connect-src 'none'",
    "worker-src blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

function finishDemo(bootHtmlPath) {
    const html = readFileSync(bootHtmlPath, 'utf8');
    const HEAD_RE = /<head>/i;
    if (!HEAD_RE.test(html)) {
        console.error('[DEMO] ✗ no <head> in dist-demo/boot.html.');
        process.exit(1);
    }
    const inject =
        '<head>\n    <meta http-equiv="Content-Security-Policy" content="' + DEMO_CSP + '">\n' +
        '    <meta name="description" content="SafeKeepVault online demo. Runs in your browser with public demo seeds only. Not for real bitcoin.">\n' +
        '    <script>window.SKV_DEMO = true;</script>';
    const out = html.replace(HEAD_RE, inject);
    const dir = dirname(bootHtmlPath);
    writeFileSync(join(dir, 'index.html'), out, { encoding: 'utf8' });
    // boot.html has no demo flag: served online it would run without the
    // safeguards, so it must not be published next to index.html.
    unlinkSync(bootHtmlPath);
    // public/CNAME names the main site; the demo has its own domain.
    writeFileSync(join(dir, 'CNAME'), 'demo.safekeepbitcoin.com\n', { encoding: 'utf8' });
    console.log('\n🧪 Demo build written to ' + join(dir, 'index.html'));
}

function commitTime() {
    try {
        return execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (_) {
        return new Date().toISOString();
    }
}

function versionStamp() {
    let release = '0.0';
    try { release = readFileSync(resolve(__dirname, 'VERSION'), 'utf8').trim() || release; } catch (_) {}
    const git = (...args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        const count = git('rev-list', '--count', 'HEAD');
        // Fixed length: plain --short follows the builder's core.abbrev,
        // which would make the stamp (and the file's hash) machine-dependent.
        const hash = git('rev-parse', '--short=7', 'HEAD');
        const date = git('log', '-1', '--format=%cs');
        // Uncommitted changes to tracked app source (built output in dist/ ignored).
        const dirty = git('status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude)dist') !== '';
        // A shallow clone counts only part of the history, so its build
        // number is wrong and the file can't match a release. Say so.
        const shallow = git('rev-parse', '--is-shallow-repository') === 'true';
        if (shallow) console.warn('[VERSION] ⚠ shallow git clone: the build number is wrong. Run `git fetch --unshallow`.');
        return `v${release} · build ${count} · ${hash} · ${date}` + (dirty ? ' + local changes' : '') + (shallow ? ' + shallow clone' : '');
    } catch (_) {
        return `v${release} · build unknown`;
    }
}

buildOfflineSuite();
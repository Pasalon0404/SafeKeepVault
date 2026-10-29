/**
 * demo-mode.js — the public online demo (demo.safekeepbitcoin.com).
 *
 * The demo build (`npm run build:demo`) is the real app with these
 * safeguards switched on. It is active only when the demo page's <head>
 * sets window.SKV_DEMO = true AND the page is served over http(s). It is
 * never active from the USB stick (file:), and the release build never
 * sets the flag (build-offline.mjs refuses to ship one that does).
 *
 * Safeguards:
 *   - Only the public demo seeds work. Turning seed words into a key or
 *     entropy (bip39.mnemonicToSeed / mnemonicToSeedSync /
 *     mnemonicToEntropy) and making a seed the active session seed both
 *     refuse anything else. Every tool derives keys this way, and no tool
 *     accepts a private key directly, so a real seed is useless here.
 *   - A freshly generated seed is never shown: replaceGenerated() swaps it
 *     for the public demo seed of the same length.
 *   - A banner that can't be closed, explaining that this is a preview of
 *     the offline vault with public demo seeds (and, on phones and tablets,
 *     that the vault runs on a laptop or desktop), and a watermark on every
 *     printout.
 *
 * The demo seeds are the all-zero-entropy BIP-39 mnemonics, the most
 * widely published test vectors there are. Anything they control can be
 * taken by anyone.
 */

const ZERO_LAST_WORD = { 12: 'about', 15: 'address', 18: 'agent', 21: 'admit', 24: 'art' };

export const DEMO_SEEDS = Object.freeze(Object.fromEntries(
    Object.entries(ZERO_LAST_WORD).map(([n, last]) => [n, Array(Number(n) - 1).fill('abandon').concat(last).join(' ')])
));

export const REFUSAL_MESSAGE =
    'SafeKeep demo: only the public demo seeds work here, so those words were not used. ' +
    'On the offline vault, your own seed works. As a rule, never type real seed words into a website.';

export function isDemoActive(win = (typeof window !== 'undefined' ? window : undefined)) {
    try {
        return !!win && win.SKV_DEMO === true && /^https?:$/.test(win.location.protocol);
    } catch (_) {
        return false;
    }
}

export function normalizeMnemonic(m) {
    return String(m == null ? '' : m).normalize('NFKD').toLowerCase().trim().split(/\s+/).join(' ');
}

const DEMO_SET = new Set(Object.values(DEMO_SEEDS));

export function isDemoSeed(m) {
    return DEMO_SET.has(normalizeMnemonic(m));
}

/** The public demo seed with the same word count (24 words if the count is unusual). */
export function replaceGenerated(m, notify = noticeGenerated) {
    const n = normalizeMnemonic(m).split(' ').filter(Boolean).length;
    notify();
    return DEMO_SEEDS[n] || DEMO_SEEDS[24];
}

/** Wraps @scure/bip39 so only the demo seeds can become keys or entropy. */
export function wrapBip39(real, onRefuse = noticeRefused) {
    const guard = (m) => {
        if (!isDemoSeed(m)) {
            onRefuse();
            throw new Error(REFUSAL_MESSAGE);
        }
    };
    return Object.freeze({
        ...real,
        mnemonicToSeed: async (m, passphrase) => { guard(m); return real.mnemonicToSeed(m, passphrase); },
        mnemonicToSeedSync: (m, passphrase) => { guard(m); return real.mnemonicToSeedSync(m, passphrase); },
        mnemonicToEntropy: (m, wordlist) => { guard(m); return real.mnemonicToEntropy(m, wordlist); },
    });
}

// ---------------------------------------------------------------------------
//  On-screen parts (demo only)
// ---------------------------------------------------------------------------

const REAL_VAULT_URL = 'https://safekeepbitcoin.com/download.html';

function toast(text) {
    try {
        let el = document.getElementById('skv-demo-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'skv-demo-toast';
            el.setAttribute('role', 'alert');
            el.style.cssText =
                'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
                'max-width:min(560px,92vw);background:#111;color:#fff;border:2px solid #f7931a;' +
                'border-radius:8px;padding:12px 16px;font:600 14px/1.45 system-ui,-apple-system,sans-serif;' +
                'box-shadow:0 8px 28px rgba(0,0,0,.5);';
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.style.display = 'block';
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { el.style.display = 'none'; }, 7000);
    } catch (_) { /* cosmetic */ }
}

export function noticeRefused() {
    toast(REFUSAL_MESSAGE + ' The demo seeds are under \u201cShow the demo seeds\u201d at the bottom.');
}

export function noticeGenerated() {
    toast('SafeKeep demo: on the offline vault, your new seed words appear here. ' +
          'In the demo, a public demo seed is used instead.');
}

export function installDemoUi() {
    const css = document.createElement('style');
    css.id = 'skv-demo-style';
    css.textContent =
        '#skv-demo-banner{position:fixed;left:0;right:0;bottom:0;z-index:2147483646;' +
        'background:#141414;color:#f0f0f0;font:500 13px/1.45 system-ui,-apple-system,sans-serif;' +
        'border-top:2px solid #f7931a;padding:8px 14px;text-align:center;box-shadow:0 -2px 10px rgba(0,0,0,.4)}' +
        '#skv-demo-banner .skv-demo-tag{display:inline-block;background:#f7931a;color:#111;font-weight:800;' +
        'letter-spacing:.06em;font-size:11px;padding:1px 7px;border-radius:4px;margin-right:6px;vertical-align:1px}' +
        '#skv-demo-banner a{color:#f7931a;text-decoration:underline;font-weight:600;white-space:nowrap}' +
        '@media (max-width:600px){#skv-demo-banner{font-size:12px;padding:6px 10px}}' +
        // The app is laid out for laptop screens; on a phone a few rows are a
        // little wider than the screen, which pushed this fixed banner partly
        // off-screen. Keep the demo page to the screen's width.
        '@media (max-width:600px){html,body{overflow-x:hidden;max-width:100vw}}' +
        '#skv-demo-banner .skv-demo-note{display:block;font-size:12px;color:#a8a8a8;margin-top:2px}' +
        '#skv-demo-banner details{display:inline}#skv-demo-banner summary{display:inline;cursor:pointer;text-decoration:underline;color:#f7931a;font-weight:600;white-space:nowrap}' +
        '#skv-demo-banner .skv-seeds{display:block;margin-top:6px;font:12px/1.5 ui-monospace,Menlo,monospace;text-align:left;' +
        'max-width:900px;margin-left:auto;margin-right:auto;user-select:all}' +
        // Shown only on phones and tablets: the vault itself boots on a
        // laptop or desktop, so say so to visitors who open the demo there.
        '#skv-demo-banner .skv-demo-mobile{display:none}' +
        '@media (max-width:860px),(pointer:coarse){#skv-demo-banner .skv-demo-mobile{display:block;font-size:12px;' +
        'font-weight:700;color:#f7931a;margin-top:2px}}' +
        // Both links on one line of their own, under the longer message.
        '#skv-demo-banner .skv-demo-links{display:block;margin-top:2px}' +
        // Room below the page for the banner, so it doesn't cover the last
        // rows (it's taller on a phone, with the extra line).
        'body{padding-bottom:110px !important}' +
        '@media (max-width:860px),(pointer:coarse){body{padding-bottom:200px !important}}' +
        '@media print{#skv-demo-banner,#skv-demo-toast{display:none !important}' +
        'body::after{content:"SAFEKEEP DEMO \\2014  NOT A REAL BACKUP \\2014  PUBLIC DEMO SEED";position:fixed;' +
        'top:45%;left:-10%;right:-10%;text-align:center;transform:rotate(-30deg);font:900 40pt/1 sans-serif;' +
        'color:rgba(200,0,0,.35);z-index:2147483647;pointer-events:none;' +
        '-webkit-print-color-adjust:exact;print-color-adjust:exact}}';
    document.head.appendChild(css);

    const banner = document.createElement('div');
    banner.id = 'skv-demo-banner';
    banner.setAttribute('role', 'note');
    banner.innerHTML =
        '<span class="skv-demo-tag">DEMO</span>' +
        'A preview of the SafeKeepVault tools, not a working vault: only the public demo seeds work here. ' +
        'To use the tools with your own keys, run the vault offline from a USB stick on a laptop or desktop computer. ' +
        // The vault link comes first: Chrome lays out <details> as a block,
        // so anything after it wrapped onto a line of its own.
        '<span class="skv-demo-links"><a href="' + REAL_VAULT_URL + '" target="_blank" rel="noopener">Get the offline vault</a> &middot; ' +
        '<details><summary>Show the demo seeds</summary><span class="skv-seeds"></span></details></span>' +
        '<span class="skv-demo-note">Demo wallets are public: never send real bitcoin to them.</span>' +
        '<span class="skv-demo-mobile">On a phone? SafeKeepVault doesn\u2019t run on phones or tablets. ' +
        'This preview is easier to explore on a computer.</span>';
    const seeds = banner.querySelector('.skv-seeds');
    for (const n of Object.keys(DEMO_SEEDS)) {
        const line = document.createElement('div');
        line.textContent = n + ' words: ' + DEMO_SEEDS[n];
        seeds.appendChild(line);
    }
    document.body.appendChild(banner);

    document.title = 'DEMO · ' + document.title;
}

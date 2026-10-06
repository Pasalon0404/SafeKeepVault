/**
 * residue-audit.mjs — memory residue audit (developer harness, Linux only)
 *
 * Drives the release build (dist/boot.html) through a Temporary session with
 * a PUBLIC test seed, reads the memory of every Chromium process at fixed
 * checkpoints, and searches it for that seed's secrets. The report says, per
 * checkpoint and per secret, how many copies were found and in which process.
 *
 *   npm run build && npm run residue-audit [-- --gc] [-- --browser /path/to/chromium]
 *
 * NEVER FUND THE FIXTURE WALLET. Its mnemonic and passphrase are public.
 *
 * Checkpoints
 *   before-input  app booted, nothing entered     (must be clean: control)
 *   after-load    Temporary seed loaded           (mnemonic must be found: control)
 *   after-lock    the app's Lock action has run
 *   after-close   the app tab is closed; the browser stays up on a blank tab
 *
 * Validity: every browser process must be readable at every checkpoint, the
 * before-input capture must be clean, and the after-load capture must contain
 * the mnemonic. Otherwise the run is INVALID (exit 2): zero hits from a scan
 * that could not see the secret prove nothing. A valid run exits 0 whatever
 * it finds; the report is the result.
 *
 * Memory is read from /proc/<pid>/mem, so no capture tool is needed, but the
 * harness must be allowed to ptrace the browser: run as the same user with
 * kernel.yama.ptrace_scope <= 1 (the harness is the browser's ancestor), or as
 * root. Chromium's sandbox can make renderers unreadable; pass --no-sandbox
 * only if the report then shows unreadable processes, and note it.
 *
 * Limits: zero hits is not proof of erasure. Only readable, writable or
 * anonymous mappings are scanned; swap, the GPU, the kernel, the clipboard
 * and other encodings are not. Typing the fixture through the DevTools
 * protocol leaves copies in the browser process's input buffers, so hits
 * there may be the harness's own. Compare runs made with the same settings.
 *
 * Inspired by EntropyLab's residue audit (docs/Residue_Audit.md).
 */

import { pbkdf2Sync } from 'node:crypto';
import { readFileSync, readdirSync, openSync, readSync, closeSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Fixture: the published BIP-39 vector for entropy 0x80 × 16, plus a public
// passphrase. Both are test data; the derived wallet must never hold funds.
// ---------------------------------------------------------------------------
export const FIXTURE = Object.freeze({
    mnemonic: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
    passphrase: 'SafeKeep residue audit - PUBLIC TEST ONLY',
});

export const CHECKPOINTS = ['before-input', 'after-load', 'after-lock', 'after-close'];

/**
 * The secrets to search for, each in the representations it is likely to take
 * in a browser: UTF-8 / Latin-1 and UTF-16LE text for strings, raw bytes for
 * key material. The seed comes from node:crypto PBKDF2 (not the app), the keys
 * from @scure/bip32 and @scure/btc-signer.
 */
export async function buildNeedles(fixture = FIXTURE) {
    const { HDKey } = await import('@scure/bip32');
    const { WIF } = await import('@scure/btc-signer');
    const seed = pbkdf2Sync(fixture.mnemonic.normalize('NFKD'), ('mnemonic' + fixture.passphrase).normalize('NFKD'), 2048, 64, 'sha512');
    const root = HDKey.fromMasterSeed(new Uint8Array(seed));
    const first = root.derive("m/84'/0'/0'/0/0");
    const text = (name, s) => [
        { secret: name, encoding: 'utf8', bytes: Buffer.from(s, 'utf8') },
        { secret: name, encoding: 'utf16le', bytes: Buffer.from(s, 'utf16le') },
    ];
    return [
        ...text('mnemonic', fixture.mnemonic),
        ...text('passphrase', fixture.passphrase),
        { secret: 'bip39-seed', encoding: 'raw', bytes: Buffer.from(seed) },
        ...text('bip39-seed', seed.toString('hex')),
        ...text('master-xprv', root.privateExtendedKey),
        { secret: 'master-private-key', encoding: 'raw', bytes: Buffer.from(root.privateKey) },
        { secret: 'first-key (m/84\'/0\'/0\'/0/0)', encoding: 'raw', bytes: Buffer.from(first.privateKey) },
        ...text('first-key (m/84\'/0\'/0\'/0/0)', WIF().encode(first.privateKey)),
    ];
}

/**
 * Count every needle in a sequence of chunks. Chunks are searched with an
 * overlap of (longest needle - 1) bytes so a match split across two chunks is
 * found exactly once. `chunks` yields Buffers in address order; a `null`
 * yields a gap (unreadable bytes), which resets the overlap.
 */
export function countInChunks(chunks, needles) {
    const counts = needles.map(() => 0);
    const keep = Math.max(...needles.map((n) => n.bytes.length)) - 1;
    let tail = Buffer.alloc(0);
    for (const chunk of chunks) {
        if (chunk === null) { tail = Buffer.alloc(0); continue; }
        const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk;
        needles.forEach((n, k) => {
            // A match must end inside the new chunk, or it was counted already.
            for (let i = buf.indexOf(n.bytes); i !== -1; i = buf.indexOf(n.bytes, i + 1)) {
                if (i + n.bytes.length > tail.length) counts[k]++;
            }
        });
        tail = buf.subarray(Math.max(0, buf.length - keep));
    }
    return counts;
}

// ---------------------------------------------------------------------------
// Linux process memory
// ---------------------------------------------------------------------------
const procStat = (pid) => {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return { ppid: Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]) };
};

/** The browser root (cmdline names our profile dir, no --type) and all its descendants. */
export function browserProcessTree(profileDir) {
    const all = [];
    for (const d of readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
            // Chromium rewrites argv into one space-separated string, so match
            // on the joined command line rather than on NUL-separated args.
            const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ');
            all.push({ pid: Number(d), ppid: procStat(d).ppid, cmd });
        } catch (_) { /* exited */ }
    }
    const roots = all.filter((p) => p.cmd.includes(`--user-data-dir=${profileDir} `) && !/--type=/.test(p.cmd));
    if (roots.length !== 1) throw new Error(`Expected one browser root process, found ${roots.length}.`);
    const tree = [roots[0]];
    for (let i = 0; i < tree.length; i++) for (const p of all) if (p.ppid === tree[i].pid) tree.push(p);
    return tree.map((p) => ({
        pid: p.pid,
        type: (p.cmd.match(/--type=([\w-]+)/) || [, 'browser'])[1],
    }));
}

function* processChunks(pid, stats, chunkSize = 4 << 20) {
    const maps = readFileSync(`/proc/${pid}/maps`, 'utf8').trim().split('\n');
    const fd = openSync(`/proc/${pid}/mem`, 'r');
    const buf = Buffer.alloc(chunkSize);
    try {
        for (const line of maps) {
            const [range, perms, , , , path = ''] = line.trim().split(/\s+/);
            // Heap-like memory only: readable and (writable or anonymous).
            if (perms[0] !== 'r' || path === '[vvar]' || path === '[vsyscall]') continue;
            if (perms[1] !== 'w' && path && !path.startsWith('[')) continue;
            const [start, end] = range.split('-').map((h) => BigInt('0x' + h));
            for (let a = start; a < end; a += BigInt(chunkSize)) {
                const len = Number(end - a < BigInt(chunkSize) ? end - a : BigInt(chunkSize));
                let n = 0;
                try { n = readSync(fd, buf, 0, len, a); } catch (_) { n = 0; }
                if (n <= 0) { stats.unreadable += len; yield null; continue; }
                stats.read += n;
                yield Buffer.from(buf.subarray(0, n));
            }
        }
    } finally {
        closeSync(fd);
    }
}

export function scanProcess(pid, needles) {
    const stats = { read: 0, unreadable: 0 };
    const counts = countInChunks(processChunks(pid, stats), needles);
    return { counts, ...stats };
}

// ---------------------------------------------------------------------------
// Verdict and report
// ---------------------------------------------------------------------------

/**
 * Decide validity from the per-checkpoint scans. `scans[cp]` is a list of
 * { pid, type, counts, read, error } and `needles` the needle list.
 */
export function evaluate(scans, needles) {
    const reasons = [];
    for (const cp of CHECKPOINTS) {
        const s = scans[cp];
        if (!s) { reasons.push(`${cp}: checkpoint missing`); continue; }
        if (!s.length) reasons.push(`${cp}: no browser process scanned`);
        for (const p of s) if (p.error || !(p.read > 0)) reasons.push(`${cp}: pid ${p.pid} (${p.type}) unreadable${p.error ? ': ' + p.error : ''}`);
    }
    const total = (cp, secret) => (scans[cp] || []).reduce((sum, p) => sum + needles.reduce((t, n, k) => t + (n.secret === secret ? (p.counts?.[k] || 0) : 0), 0), 0);
    const secrets = [...new Set(needles.map((n) => n.secret))];
    for (const secret of secrets) if (total('before-input', secret)) reasons.push(`before-input: ${secret} found before any input (contaminated)`);
    if (scans['after-load'] && !total('after-load', 'mnemonic')) reasons.push('after-load: positive control failed, mnemonic not found');
    // A secret never seen before Lock cannot show that Lock erased it.
    const calibrated = Object.fromEntries(secrets.map((s) => [s, total('after-load', s) > 0]));
    const table = Object.fromEntries(secrets.map((s) => [s, Object.fromEntries(CHECKPOINTS.map((cp) => [cp, total(cp, s)]))]));
    return { valid: reasons.length === 0, reasons, calibrated, table };
}

export function renderMarkdown(meta, result, scans, needles) {
    const L = [];
    L.push('# SafeKeep memory residue report', '');
    L.push(`- Date: ${meta.date}`, `- Browser: ${meta.browser}`, `- Build: ${meta.build}`, `- Options: ${meta.options}`);
    L.push(`- Result: **${result.valid ? 'VALID' : 'INVALID'}**`, '');
    if (!result.valid) { L.push('## Why the run is invalid', ''); for (const r of result.reasons) L.push(`- ${r}`); L.push(''); }
    L.push('## Copies found (all processes)', '');
    L.push(`| Secret | ${CHECKPOINTS.join(' | ')} | Calibrated |`, `|---|${CHECKPOINTS.map(() => '---:').join('|')}|---|`);
    for (const [secret, row] of Object.entries(result.table)) {
        L.push(`| ${secret} | ${CHECKPOINTS.map((cp) => row[cp]).join(' | ')} | ${result.calibrated[secret] ? 'yes' : '**NOT CALIBRATED**'} |`);
    }
    L.push('', '"NOT CALIBRATED": the secret was never found after loading, so a later zero says nothing about erasure.', '');
    L.push('## Per process', '');
    for (const cp of CHECKPOINTS) {
        L.push(`### ${cp}`, '', '| PID | Type | MB read | Hits (secret/encoding) |', '|---:|---|---:|---|');
        for (const p of scans[cp] || []) {
            const hits = (p.counts || []).map((c, k) => (c ? `${needles[k].secret}/${needles[k].encoding}: ${c}` : '')).filter(Boolean).join('; ');
            L.push(`| ${p.pid} | ${p.type} | ${(p.read / 1e6).toFixed(0)} | ${p.error ? 'ERROR: ' + p.error : hits || '—'} |`);
        }
        L.push('');
    }
    L.push('## Limits', '', 'Zero hits is not proof of erasure. Only heap-like mappings were scanned, in the encodings listed. Input typed through the DevTools protocol can leave copies in the browser process that the app never held. Swap, GPU memory, the kernel and the clipboard are not covered.', '');
    return L.join('\n');
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
async function main(argv) {
    if (process.platform !== 'linux') { console.error('residue-audit: Linux only (reads /proc/<pid>/mem).'); process.exit(2); }
    const here = dirname(fileURLToPath(import.meta.url));
    const app = join(here, 'dist', 'boot.html');
    if (!existsSync(app)) { console.error('residue-audit: dist/boot.html not found. Run `npm run build` first.'); process.exit(2); }
    const gc = argv.includes('--gc');
    const noSandbox = argv.includes('--no-sandbox');
    const bi = argv.indexOf('--browser');
    const executablePath = bi >= 0 ? argv[bi + 1] : (process.env.CHROMIUM_BINARY || undefined);

    const needles = await buildNeedles();
    const html = readFileSync(app);
    for (const n of needles) if (html.includes(n.bytes)) { console.error(`residue-audit: the build itself contains ${n.secret}; refusing.`); process.exit(2); }

    let chromium;
    try { ({ chromium } = await import('playwright-core')); } catch (_) {
        console.error('residue-audit: playwright-core is not installed. Run `npm install`.'); process.exit(2);
    }

    const outDir = join(here, 'out', 'residue');
    mkdirSync(outDir, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), 'skv-residue-'));
    const scans = {};
    let ctx;
    const capture = async (cp, page) => {
        if (gc && page) { try { const s = await page.context().newCDPSession(page); await s.send('HeapProfiler.collectGarbage'); await s.detach(); } catch (_) {} }
        await new Promise((r) => setTimeout(r, 3000));
        const tree = browserProcessTree(profile);
        scans[cp] = tree.map(({ pid, type }) => {
            try { return { pid, type, ...scanProcess(pid, needles) }; } catch (e) { return { pid, type, read: 0, error: e.code || e.message }; }
        });
        const hits = scans[cp].reduce((t, p) => t + (p.counts || []).reduce((a, b) => a + b, 0), 0);
        console.log(`[${cp}] scanned ${scans[cp].length} processes, ${hits} hits`);
    };

    try {
        ctx = await chromium.launchPersistentContext(profile, {
            executablePath, headless: !argv.includes('--headed'),
            args: noSandbox ? ['--no-sandbox'] : [],
        });
        const keeper = ctx.pages()[0] || await ctx.newPage(); // keeps the browser alive after the app tab closes
        await keeper.goto('about:blank');
        const page = await ctx.newPage();
        await page.goto(pathToFileURL(app).href);
        await page.waitForFunction(() => document.documentElement.dataset.selfTestsFailed === '0', null, { timeout: 60000 });
        await page.waitForTimeout(3000);

        await capture('before-input', page);
        if (evaluate({ 'before-input': scans['before-input'] }, needles).reasons.some((r) => r.startsWith('before-input'))) {
            throw new Error('before-input capture is contaminated or incomplete; no fixture data entered.');
        }

        // Temporary session: open the lock overlay, choose Temporary Seed, 12 words.
        await page.evaluate(() => { vaultLock(); vaultShowTempSeed(); vtmp_setWordCount(12); });
        const words = FIXTURE.mnemonic.split(' ');
        for (let i = 0; i < words.length; i++) {
            await page.locator(`#vtmp-word-${i}`).click();
            await page.keyboard.insertText(words[i]);   // native input events, no literal in page JS
            await page.keyboard.press('Tab');
        }
        await page.locator('#vtmp-passphrase').click();
        await page.keyboard.insertText(FIXTURE.passphrase);
        await page.locator('#vtmp-load-btn').click({ timeout: 10000 });
        await page.waitForFunction(() => document.getElementById('dash-identity-label')?.textContent === 'Temporary Seed Active', null, { timeout: 30000 });
        await capture('after-load', page);

        await page.evaluate(() => vaultLock());
        await page.waitForFunction(() => !(window.SeedSession && window.SeedSession.get()), null, { timeout: 30000 });
        await capture('after-lock', page);

        await page.close();
        await capture('after-close', keeper);
    } catch (e) {
        console.error('residue-audit: run aborted:', e.message);
    } finally {
        const result = evaluate(scans, needles);
        let build = 'unknown';
        try { build = (readFileSync(app, 'utf8').match(/v\d+\.\d+ · build \d+ · [0-9a-f]+[^<"]*/) || ['unknown'])[0]; } catch (_) {}
        const meta = {
            date: new Date().toISOString(),
            browser: ctx ? `${ctx.browser()?.version?.() || 'chromium'} (${executablePath || 'Playwright default'})` : 'not started',
            build, options: [gc && '--gc', noSandbox && '--no-sandbox'].filter(Boolean).join(' ') || 'none',
        };
        writeFileSync(join(outDir, 'residue-report.json'), JSON.stringify({
            meta, ...result,
            needles: needles.map((n) => ({ secret: n.secret, encoding: n.encoding, length: n.bytes.length })),
            scans,
        }, null, 2));
        writeFileSync(join(outDir, 'residue-report.md'), renderMarkdown(meta, result, scans, needles));
        try { await ctx?.close(); } catch (_) {}
        rmSync(profile, { recursive: true, force: true });
        console.log(`\n${result.valid ? 'VALID' : 'INVALID'} run. Report: ${join('out', 'residue', 'residue-report.md')}`);
        if (!result.valid) for (const r of result.reasons) console.log('  - ' + r);
        console.table(result.table);
        process.exit(result.valid ? 0 : 2);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main(process.argv.slice(2));
}

/**
 * test-session-exits.mjs — no dead ends from the welcome screen
 *
 * Every path the welcome screen offers (most often reached in a Temporary
 * Session, after Lock → Boot Temporary Session) must have a visible way
 * back. Two traps were found by hand (the Entropy Generator's setup screen,
 * and the "write down your words" screen after a seed is made); an audit
 * of all nine paths in the dev build found two more (Encrypted backup and
 * Sign with Hardware Wallet, whose only exit led to a seedless Dashboard).
 * This checks the wiring for each so none comes back:
 *
 *   Type my recovery words, Seed XOR, Shamir, COLDCARD → a Back button
 *   Create a new wallet → Back to Welcome (setup wizard)
 *   … a seed is made → Leave Without Keeping This Seed (Temporary Session)
 *   Encrypted backup (.7z), Sign with Hardware Wallet → the sidebar link
 *     reads "Back to Welcome" when no seed is loaded and goes there
 *   Temporary Session banner names Lock as the way back, not "power off".
 *
 * Run:  node test-session-exits.mjs
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => { (cond ? pass++ : fail++); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${(extra && !cond) ? '  → ' + extra : ''}`); };
const html = readFileSync(new URL('./boot.html', import.meta.url), 'utf8');
const fn = (name) => { const a = html.indexOf(name); if (a < 0) return ''; const n = [html.indexOf('\nfunction ', a + 10), html.indexOf('\nasync function ', a + 10)].filter((i) => i > 0); return html.slice(a, Math.min(...n)); };

console.log('\n1. Welcome panels have Back');
for (const [panel, hide] of [['restore-panel', 'hideRestorePanel()'], ['xor-recovery-panel', 'hideXorRecoveryPanel()'], ['shamir-recovery-panel', 'hideShamirRecoveryPanel()'], ['coldcard-recovery-panel', 'hideColdcardRecoveryPanel()']]) {
    const a = html.indexOf(`<div id="${panel}"`);
    const seg = html.slice(a, a + 40000);
    ck(`${panel} has a button calling ${hide}`, a > 0 && seg.includes(`onclick="${hide}"`));
}

console.log('\n2. Create a new wallet');
ck('setup wizard has Back to Welcome (eob_cancel)', html.includes('id="eob-back-btn" onclick="eob_cancel()"') && /body\.onboarding-forge \.eob-back-btn \{ display: inline-flex; \}/.test(html));
ck('eob_cancel returns to the welcome screen in setup', fn('function eob_cancel').includes("showState('state-welcome')"));
ck('after a seed is made, a Temporary Session can leave without keeping it', html.includes('id="backup-ephemeral-exit"') && fn('function transitionToBackup').includes('_bExit.hidden = !_isEphemeralBoot()') && fn('function backup_exitConfirm').includes('vaultLock();'));

console.log('\n3. Tool screens reached without a seed');
ck('the sidebar status box goes through sidebar_goHome (not straight to the Dashboard)', html.includes('id="sidebar-seed-status"') && /id="sidebar-seed-status"[^>]*onclick="sidebar_goHome\(\)"/.test(html));
const home = fn('function sidebar_goHome');
ck('with a seed: Dashboard; without: the welcome screen', home.includes("if (_sidebarHasSeed()) { showState('state-dashboard'); return; }") && home.includes('welcome_returnNoSeed()'));
ck('Sign with Hardware Wallet uses its own way back (wipes PSBT state)', home.includes('_psbtHwMode') && home.includes('psbtBackToDashboard()'));
ck('the encrypted-backup Courier camera is stopped', home.includes('rlq_courierStop()'));
ck('the link\'s label follows the seed state', fn('function _globalSeedStatusUpdate').includes("hasSeed ? '\\u2190 Dashboard' : '\\u2190 Back to Welcome'"));
const ret = fn('function welcome_returnNoSeed');
ck('back on the welcome screen a Temporary Session keeps its heading, Unlock my vault instead and the hardware-wallet button', ret.includes('transitionToWelcome()') && ret.includes("heading.textContent = 'Temporary Session'") && ret.includes("'welcome-vault-btn'") && ret.includes("getElementById('welcome-hw-btn')"));

console.log('\n4. Wording');
ck('no "power off, and reboot normally" advice left (Lock is the way back)', !/power off,? and reboot normally/.test(html));
ck('the Temporary Session banner names Lock', html.includes('To keep a seed, write down its words, then Lock'));

for (const name of ['function _sidebarHasSeed', 'function sidebar_goHome', 'function welcome_returnNoSeed', 'function backup_exitAsk', 'function backup_exitCancel', 'function backup_exitConfirm']) {
    let ok = true, err = '';
    try { new Function(fn(name).replace(/^function/, 'return function')); } catch (e) { ok = false; err = e.message; }
    ck(`${name.replace(/^function /, '')} parses`, ok, err);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

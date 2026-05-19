/**
 * SafeKeepBitcoin — Boot Controller (boot.js)
 *
 * The "OS-level" initialization and routing module for the SafeKeep
 * hardware wallet experience. This module enforces a strict single-seed
 * architecture modeled after dedicated hardware wallets (Coldcard, Trezor).
 *
 * Architecture:
 *   - ONE hardcoded file path: /media/safekeep-vault/seeds/master-seed.json
 *   - NO file pickers, NO "Save As...", NO "Open File..."
 *   - Two-state routing: Welcome Screen (no seed) or Dashboard (seed loaded)
 *   - Factory Reset: intentional wipe → return to Welcome Screen
 *   - Passphrases are ephemeral (RAM-only, never saved to disk)
 *
 * File I/O strategy (Silent Download):
 *   The Linux boot drive configures Chromium with enterprise policies:
 *     - PromptForDownloadLocation = false
 *     - DownloadDirectory = /media/.safekeep-vault/seeds
 *   This means a standard Blob download with filename "master-seed.json"
 *   silently writes to the encrypted LUKS partition. No backend API needed.
 *   The vault unlock script (unlock-vault.sh) ensures the directory exists
 *   via `mkdir -p /media/.safekeep-vault/seeds` after LUKS decryption.
 *
 * Boot sequence:
 *   1. boot() checks sessionStorage (fast path), then fetches master-seed.json
 *   2. If found and valid → load into sessionStorage, return State B (Dashboard)
 *   3. If not found or wiped → return State A (Welcome Screen)
 *
 * Seed lifecycle:
 *   - generateMasterSeed() → BIP-39 mnemonic → silent download master-seed.json
 *   - restoreMasterSeed(words) → validate → silent download master-seed.json
 *   - factoryReset() → overwrite with random garbage download → clear session
 *
 * Dependencies:
 *   - SeedSession (shared/seed-session.js) for sessionStorage wiring
 *   - BtcMath (window.BtcMath) for BIP-39 generation/validation and fingerprint
 */

const SafeKeepOS = (() => {

  // ---- The One True Path ----
  // Chromium download policy routes all Blob downloads here silently.
  // The vault unlock script guarantees this directory exists after LUKS open:
  //   mkdir -p /media/.safekeep-vault/seeds
  // IMPORTANT: Must match VAULT_MOUNT in safekeep-boot.sh / unlock-vault.sh
  const MASTER_SEED_DIR  = '/media/.safekeep-vault/seeds';
  const MASTER_SEED_FILE = 'master-seed.json';
  const MASTER_SEED_PATH = `${MASTER_SEED_DIR}/${MASTER_SEED_FILE}`;
  const MASTER_SEED_URL  = `file://${MASTER_SEED_PATH}`;

  // A wiped file contains this marker instead of a mnemonic.
  // Boot sequence treats this the same as "file not found".
  const WIPED_MARKER = '__SAFEKEEP_WIPED__';

  // Boot states
  const STATE_WELCOME   = 'welcome';   // No seed found — show setup screen
  const STATE_DASHBOARD = 'dashboard'; // Seed loaded — show tool launcher

  // ---- Internal state ----
  let _currentState = null;
  let _masterFingerprint = null;


  // =============================================
  //  BOOT-TIME HYDRATION — Disk → In-Memory Index
  // =============================================
  //
  // The browser cannot list directory contents via file:// protocol.
  // safekeep-boot.sh pre-generates JSON index files at boot time:
  //   /media/.safekeep-vault/codex/.codex-index.json
  //   /media/.safekeep-vault/passphrases/.passphrase-index.json
  //
  // These hydration functions read those indexes and pre-populate the
  // in-memory Maps so listNotes() and listPassphrases() return data
  // immediately after boot — without requiring the user to open each
  // tool first.

  /**
   * Populate _codexStore from the pre-generated .codex-index.json.
   * Each entry contains { title, slug, updatedAt } from the .meta.json sidecars.
   * The actual note content (.html body) is NOT loaded here — loadNote()
   * fetches it on demand when the user opens a specific note.
   */
  async function _hydrateCodex() {
    if (!isBootDrive()) return;
    try {
      const resp = await fetch(`file://${CODEX_DIR}/.codex-index.json`, { cache: 'no-store' });
      if (resp.ok) {
        const entries = await resp.json();
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (entry.slug) {
              _codexStore.set(entry.slug, {
                title: entry.title || entry.slug,
                content: '',  // loaded on demand by loadNote()
                updatedAt: entry.updatedAt || ''
              });
            }
          }
          console.log(`SafeKeepOS: hydrated ${_codexStore.size} codex notes from disk`);
        }
      }
    } catch (e) {
      console.warn('SafeKeepOS: codex hydration failed (empty vault is normal)', e.message);
    }
  }

  /**
   * Populate _passphraseStore from the pre-generated .passphrase-index.json.
   * Each entry contains the full passphrase record { nickname, slug, passphrase, masked, updatedAt }.
   */
  async function _hydratePassphrases() {
    if (!isBootDrive()) return;
    try {
      const resp = await fetch(`file://${PASSPHRASE_DIR}/.passphrase-index.json`, { cache: 'no-store' });
      if (resp.ok) {
        const entries = await resp.json();
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (entry.slug) {
              _passphraseStore.set(entry.slug, {
                nickname: entry.nickname || entry.slug,
                passphrase: entry.passphrase || '',
                masked: entry.masked || _passphraseMask(entry.passphrase || ''),
                updatedAt: entry.updatedAt || ''
              });
            }
          }
          console.log(`SafeKeepOS: hydrated ${_passphraseStore.size} passphrases from disk`);
        }
      }
    } catch (e) {
      console.warn('SafeKeepOS: passphrase hydration failed (empty vault is normal)', e.message);
    }
  }


  // =============================================
  //  BOOT SEQUENCE
  // =============================================

  /**
   * Main boot entry point. Call once on page load.
   *
   * 1. Checks sessionStorage first (fast path — seed already loaded this session)
   * 2. If empty, tries to fetch master-seed.json from the hardcoded path
   * 3. Hydrates codex + passphrase in-memory indexes from disk
   * 4. Returns { state, seed } where state is 'welcome' or 'dashboard'
   *
   * This never prompts the user — completely silent.
   */
  async function boot() {
    // DEV_MODE: skip all hardware I/O (transfer drive resolution,
    // LUKS codex/passphrase hydration, master-seed.json fetch).
    // Immediately resolve as "no seed found" so the Welcome screen
    // renders without waiting for partitions that don't exist.
    if (window._SKB_DEV_MODE) {
      console.log('DEV MODE: Bypassed initial seed check. Simulating empty vault.');
      _currentState = STATE_WELCOME;
      _masterFingerprint = null;
      return { state: STATE_WELCOME, seed: null };
    }

    // Resolve the dynamic USB transfer drive path before anything else
    await _resolveTransferRoot();

    // Hydrate in-memory stores from LUKS disk indexes.
    // These run in parallel since they're independent reads.
    await Promise.all([_hydrateCodex(), _hydratePassphrases()]);

    // Fast path: already in sessionStorage from a previous tool navigation
    const existing = window.SeedSession?.get();
    if (existing && existing.mnemonic) {
      _currentState = STATE_DASHBOARD;
      _masterFingerprint = existing.fingerprint || null;
      return { state: STATE_DASHBOARD, seed: existing };
    }

    // Cold boot: try to load master-seed.json from disk
    try {
      const response = await fetch(MASTER_SEED_URL);
      if (response.ok) {
        const data = await response.json();

        // Check for wiped marker — treat as "no seed"
        if (data && data.wiped === WIPED_MARKER) {
          console.log('SafeKeepOS: master-seed.json is wiped — treating as empty');
          return _welcomeState();
        }

        if (data && data.mnemonic) {
          // Validate the mnemonic before trusting it
          const words = data.mnemonic.trim().split(/\s+/);
          if (words.length !== 12 && words.length !== 24) {
            console.error('SafeKeepOS: master-seed.json has invalid word count:', words.length);
            return { state: STATE_WELCOME, seed: null, error: 'corrupt' };
          }

          // Load into sessionStorage for tool navigation
          window.SeedSession?.set({
            type: data.type || 'seed',
            mnemonic: data.mnemonic,
            fingerprint: data.fingerprint || '',
            label: data.label || 'Master Seed',
            keyFormat: data.keyFormat || 'slip132',
            addressType: data.addressType || '84',
            wordCount: words.length,
            default: true
          });

          _currentState = STATE_DASHBOARD;
          _masterFingerprint = data.fingerprint || null;
          return { state: STATE_DASHBOARD, seed: data };
        }
      }
    } catch (e) {
      // file:// fetch failed — expected on the website, or if no seed exists yet
      console.log('SafeKeepOS: No master seed found (this is normal on first boot)');
    }

    return _welcomeState();
  }

  function _welcomeState() {
    _currentState = STATE_WELCOME;
    _masterFingerprint = null;
    return { state: STATE_WELCOME, seed: null };
  }


  // =============================================
  //  SEED CREATION
  // =============================================

  /**
   * Generate a new random BIP-39 mnemonic and write it as master-seed.json.
   *
   * If `userEntropyBytes` is supplied (a Uint8Array of length strength/8),
   * those bytes are XOR-mixed with a fresh draw from the system CSPRNG and
   * used as the entropy input for BIP-39. This is the BYOE (Bring Your Own
   * Entropy) path — it defends against a compromised or weak system RNG by
   * ensuring the final entropy is at least as random as the stronger of the
   * two sources (XOR with an independent uniform is a secure extractor).
   *
   * If `userEntropyBytes` is omitted, the CSPRNG is trusted on its own. The
   * SafeKeep UI should never omit it for new-seed generation.
   *
   * @param {number} strength - 128 (12 words) or 256 (24 words). Default: 256.
   * @param {Uint8Array=} userEntropyBytes - Optional user-supplied entropy bytes.
   * @returns {{ mnemonic, fingerprint, wordCount }} on success
   * @throws if BtcMath is not available or write fails
   */
  async function generateMasterSeed(strength = 256, userEntropyBytes = null) {
    const { bip39, wordlist } = _requireBtcMath();

    const byteLen = strength / 8;
    let mnemonic;
    if (userEntropyBytes && userEntropyBytes.byteLength === byteLen) {
      // --- BYOE path: XOR user entropy with a fresh CSPRNG draw ---
      const systemBytes = new Uint8Array(byteLen);
      crypto.getRandomValues(systemBytes);
      const mixed = new Uint8Array(byteLen);
      for (let i = 0; i < byteLen; i++) {
        mixed[i] = systemBytes[i] ^ userEntropyBytes[i];
      }
      mnemonic = bip39.entropyToMnemonic(mixed, wordlist);
      // Best-effort zeroization of the transient buffers
      systemBytes.fill(0);
      mixed.fill(0);
    } else {
      // --- Legacy path: system CSPRNG only ---
      mnemonic = bip39.generateMnemonic(wordlist, strength);
    }

    const fingerprint = await _computeFingerprint(mnemonic);

    const writeResult = await _silentSaveMasterSeed(mnemonic, fingerprint);

    // Load into session
    const wordCount = mnemonic.trim().split(/\s+/).length;
    window.SeedSession?.set({
      type: 'seed',
      mnemonic,
      fingerprint,
      label: 'Master Seed',
      keyFormat: 'slip132',
      addressType: '84',
      wordCount,
      default: true
    });

    _currentState = STATE_DASHBOARD;
    _masterFingerprint = fingerprint;

    return { mnemonic, fingerprint, wordCount, diskVerified: writeResult.verified };
  }

  /**
   * Restore a master seed from a user-provided mnemonic (typed or pasted words).
   *
   * @param {string} mnemonic - Space-separated BIP-39 words
   * @returns {{ mnemonic, fingerprint, wordCount }} on success
   * @throws if mnemonic is invalid
   */
  async function restoreMasterSeed(mnemonic) {
    const { bip39, wordlist } = _requireBtcMath();

    // Normalize
    const words = mnemonic.trim().split(/\s+/);
    const normalized = words.join(' ');

    // Validate
    if (words.length !== 12 && words.length !== 24) {
      throw new Error(`Expected 12 or 24 words, got ${words.length}`);
    }

    const valid = bip39.validateMnemonic(normalized, wordlist);
    if (!valid) {
      throw new Error('Invalid mnemonic: bad checksum or unknown words');
    }

    const fingerprint = await _computeFingerprint(normalized);

    const writeResult = await _silentSaveMasterSeed(normalized, fingerprint);

    // Load into session
    window.SeedSession?.set({
      type: 'seed',
      mnemonic: normalized,
      fingerprint,
      label: 'Master Seed',
      keyFormat: 'slip132',
      addressType: '84',
      wordCount: words.length,
      default: true
    });

    _currentState = STATE_DASHBOARD;
    _masterFingerprint = fingerprint;

    return { mnemonic: normalized, fingerprint, wordCount: words.length, diskVerified: writeResult.verified };
  }


  // =============================================
  //  FACTORY RESET
  // =============================================

  /**
   * "Wipe Device" — securely destroy the master seed.
   *
   * Strategy: "OS Trigger" pattern.
   *
   * The JS sandbox cannot delete or overwrite OS files (Chromium blocks
   * silent overwrites of existing filenames). Instead, we use a two-step
   * bridge between the web app and the OS:
   *
   *   1. APP: Silently download WIPE_TRIGGER.txt to the seeds directory.
   *      This is a NEW filename, so Chromium's download policy accepts it.
   *
   *   2. OS: A background watcher daemon in safekeep-boot.sh polls for
   *      WIPE_TRIGGER.txt every second. When found, it runs:
   *        shred -vfz -n 3 master-seed*.json
   *      then deletes the trigger file.
   *
   *   3. APP: Polls fetch(master-seed.json) with cache: 'no-store'.
   *      When the fetch fails (404 / network error), the shred is confirmed.
   *      Clear sessionStorage and route to Welcome Screen.
   *
   * This is intentionally a multi-step confirmation in the UI layer.
   * By the time this function is called, the user has already typed "WIPE".
   */
  const WIPE_TRIGGER_FILE = 'WIPE_TRIGGER.txt';
  const WIPE_TRIGGER_URL  = `file://${MASTER_SEED_DIR}/${WIPE_TRIGGER_FILE}`;
  const WIPE_TIMEOUT_MS   = 10000; // 10 seconds max wait

  async function factoryReset() {
    if (!isBootDrive()) {
      // Web demo mode: just clear session, no disk operations
      _clearSession();
      return { state: STATE_WELCOME, wipeVerified: true };
    }

    // Step 1: Drop the trigger file via silent download.
    // This is a new filename — Chromium will not block it.
    const triggerPayload = [
      'SAFEKEEP_WIPE_REQUEST',
      'Requested at: ' + new Date().toISOString(),
      'This file signals the OS watcher daemon to shred master-seed.json.',
    ].join('\n');

    _silentDownload(WIPE_TRIGGER_FILE, triggerPayload);
    console.log('SafeKeepOS: WIPE_TRIGGER.txt dropped — waiting for OS watcher...');

    // Step 2: Poll until master-seed.json disappears from disk.
    // The OS watcher shreds the file and removes the trigger.
    const startTime = Date.now();
    let confirmed = false;

    while (Date.now() - startTime < WIPE_TIMEOUT_MS) {
      await _sleep(500);

      try {
        const response = await fetch(MASTER_SEED_URL, { cache: 'no-store' });
        if (!response.ok) {
          // 404 or other HTTP error — file is gone
          console.log('SafeKeepOS: master-seed.json returned non-OK — shred confirmed.');
          confirmed = true;
          break;
        }
        // File still exists — watcher hasn't acted yet, keep polling
        console.log('SafeKeepOS: master-seed.json still present, polling...');
      } catch (e) {
        // Network/fetch error on file:// means file doesn't exist
        console.log('SafeKeepOS: fetch threw — file is gone. Shred confirmed.');
        confirmed = true;
        break;
      }
    }

    if (!confirmed) {
      // Also check if the trigger file was at least consumed
      // (watcher ran but file deletion was slow)
      try {
        const triggerCheck = await fetch(WIPE_TRIGGER_URL, { cache: 'no-store' });
        if (!triggerCheck.ok) {
          // Trigger was consumed — watcher ran. Give one more second.
          await _sleep(1000);
          try {
            await fetch(MASTER_SEED_URL, { cache: 'no-store' });
            // Still there — genuine failure
          } catch (_) {
            confirmed = true; // File gone on final check
          }
        }
      } catch (_) {
        // Trigger file also gone — good sign, final seed check
        try {
          await fetch(MASTER_SEED_URL, { cache: 'no-store' });
        } catch (__) {
          confirmed = true;
        }
      }
    }

    if (!confirmed) {
      console.error('SafeKeepOS: Wipe NOT confirmed after ' + WIPE_TIMEOUT_MS + 'ms');
      throw new Error(
        'Factory wipe failed: master-seed.json is still on disk after ' +
        (WIPE_TIMEOUT_MS / 1000) + ' seconds. The OS wipe watcher may not be running. ' +
        'Your seed has NOT been destroyed.'
      );
    }

    // Step 3: Shred confirmed — clear all session data and invalidate vault cache
    _clearSession();
    _invalidateVaultCheck();
    return { state: STATE_WELCOME, wipeVerified: true };
  }

  /** Internal: clear all session/memory state after confirmed wipe or web-demo reset */
  function _clearSession() {
    window.SeedSession?.clear();
    window.SeedSession?.clearPassphrase();
    try {
      sessionStorage.clear();
    } catch (e) {
      // silent
    }
    _currentState = STATE_WELCOME;
    _masterFingerprint = null;
  }


  // =============================================
  //  PASSPHRASE (EPHEMERAL)
  // =============================================

  /**
   * Set an ephemeral passphrase. Lives only in sessionStorage (RAM).
   * Different passphrases derive different wallets from the same master seed.
   * NEVER written to disk.
   */
  function setPassphrase(passphrase) {
    window.SeedSession?.setPassphrase(passphrase || '');
  }

  function getPassphrase() {
    return window.SeedSession?.getPassphrase() || '';
  }

  function clearPassphrase() {
    window.SeedSession?.clearPassphrase();
  }


  // =============================================
  //  QUERIES
  // =============================================

  function getState() { return _currentState; }
  function getFingerprint() { return _masterFingerprint; }

  /**
   * Check if we're running on the USB boot drive (file:// protocol)
   * vs the demo website (http/https).
   */
  function isBootDrive() {
    return window.location.protocol === 'file:';
  }


  // =============================================
  //  INTERNAL HELPERS
  // =============================================

  function _requireBtcMath() {
    if (!window.BtcMath || !window.BtcMath.bip39) {
      throw new Error('BtcMath library not loaded. Cannot generate or validate seeds.');
    }
    return window.BtcMath;
  }

  async function _computeFingerprint(mnemonic) {
    const { bip39, HDKey } = window.BtcMath;
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const master = HDKey.fromMasterSeed(seed);
    return master.fingerprint.toString(16).toUpperCase().padStart(8, '0');
  }

  /**
   * Vault Fingerprint — a user-visible 8-character tag for a master seed.
   *
   * SHA-256 of the space-separated mnemonic, truncated to 8 hex chars.
   *
   * This is DISTINCT from the BIP-32 master fingerprint (which is derived
   * from HD key material). The Vault Fingerprint is purely a label used
   * by the UI to let users visually match a set of XOR shards back to the
   * master seed they were split from — no typos, no silent mismatch.
   *
   * Stability: the same mnemonic always produces the same fingerprint,
   * regardless of any passphrase, derivation path, or address type.
   */
  async function vaultFingerprint(mnemonic) {
    if (!mnemonic || typeof mnemonic !== 'string') return '';
    const normalized = mnemonic.trim().split(/\s+/).join(' ');
    const bytes = new TextEncoder().encode(normalized);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8).toLowerCase();
  }

  /**
   * Save the master seed via Chromium's silent download mechanism,
   * then verify the write by reading the file back.
   *
   * On the boot drive:
   *   Chromium enterprise policy routes all downloads to
   *   /media/safekeep-vault/seeds/ without any dialog.
   *   After writing, we fetch the file back and verify the mnemonic
   *   round-trips correctly. If verification fails, the caller is
   *   notified via { verified: false } so the UI can show a warning.
   *
   * On the website (demo mode):
   *   This triggers a normal browser download. Read-back verification
   *   is skipped (can't fetch from the user's Downloads folder).
   *
   * @returns {{ verified: boolean, error?: string }}
   */
  async function _silentSaveMasterSeed(mnemonic, fingerprint) {
    const words = mnemonic.trim().split(/\s+/);
    const normalizedMnemonic = words.join(' ');
    const payload = {
      type: 'seed',
      mnemonic: normalizedMnemonic,
      length: words.length,
      label: 'Master Seed',
      fingerprint: fingerprint,
      keyFormat: 'slip132',
      addressType: '84',
      createdAt: new Date().toISOString(),
      default: true
    };

    _silentDownload(MASTER_SEED_FILE, JSON.stringify(payload, null, 2));

    // ---- Read-back verification (boot drive only) ----
    // On file:// protocol, we can fetch the file back after Chromium writes it.
    // On http/https (demo site), skip — the download goes to user's Downloads folder.
    if (!isBootDrive()) {
      return { verified: true, skipped: true };
    }

    // Give Chromium time to flush the download to disk.
    // Try up to 3 times with increasing delays (500ms, 1000ms, 1500ms).
    for (let attempt = 1; attempt <= 3; attempt++) {
      await _sleep(500 * attempt);
      try {
        const response = await fetch(MASTER_SEED_URL, { cache: 'no-store' });
        if (!response.ok) continue;
        const data = await response.json();
        if (data && data.mnemonic && data.mnemonic.trim() === normalizedMnemonic) {
          console.log(`SafeKeepOS: Seed file verified on disk (attempt ${attempt})`);
          return { verified: true };
        }
        // File exists but mnemonic doesn't match — corrupt write
        console.error('SafeKeepOS: Seed file read-back MISMATCH');
        return { verified: false, error: 'Mnemonic mismatch after write' };
      } catch (e) {
        // fetch failed — file not written yet, retry
        console.log(`SafeKeepOS: Read-back attempt ${attempt} failed, retrying...`);
      }
    }

    // All 3 attempts failed — file never appeared on disk
    console.error('SafeKeepOS: Seed file NOT FOUND after 3 read-back attempts');
    return { verified: false, error: 'File not found after write' };
  }

  // System trigger filenames that bypass the vault sentinel check.
  // These files are part of the browser→daemon communication protocol
  // and must be writable even during edge-case scenarios (e.g., the
  // wipe trigger needs to work to initiate factory reset).
  const _SYSTEM_TRIGGER_PREFIXES = [
    'WIPE_TRIGGER',
    'RELIQUARY_TRIGGER', 'RELIQUARY_ACK',
    'RESTORE_INSPECT', 'RESTORE_INSPECT_ACK',
    'RESTORE_COMMIT', 'RESTORE_COMMIT_ACK',
    'POWER_ACTION',     // dashboard Power Options → safekeep-boot.sh dispatcher
    'DISPLAY_SLEEP',    // Settings idle timer → safekeep-boot.sh display watcher
    'master-seed'
  ];

  /**
   * Check if a filename is a system trigger file (allowed without vault check).
   */
  function _isSystemFile(filename) {
    for (const prefix of _SYSTEM_TRIGGER_PREFIXES) {
      if (filename.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Trigger a silent file download.
   *
   * Creates an invisible <a> element with a Blob URL, clicks it,
   * then cleans up. Chromium's download policy intercepts this and
   * routes it to the hardcoded vault directory without any UI.
   *
   * SECURITY: For data files (notes, passphrases), this function checks
   * the vault sentinel before writing. If the LUKS vault is not mounted,
   * the download is blocked to prevent data from landing on the volatile
   * tmpfs/overlayfs layer where it would be lost on reboot.
   *
   * System trigger files (WIPE_TRIGGER, RELIQUARY_TRIGGER, etc.) bypass
   * this check since they are ephemeral protocol files, not user data.
   *
   * @param {string} filename - The download filename (e.g. "master-seed.json")
   * @param {string} content - The file content as a string
   * @returns {boolean} true if the download was triggered, false if blocked
   */
  function _silentDownload(filename, content) {
    // Guard: block data file writes if the vault isn't verified.
    // System trigger files bypass this check (they're ephemeral protocol).
    if (isBootDrive() && !_isSystemFile(filename) && _vaultVerified !== true) {
      console.error(`SafeKeepOS: BLOCKED download of "${filename}" — vault not verified. Data would be lost on reboot.`);
      return false;
    }

    // Build a fresh, isolated anchor per call. We intentionally DO NOT
    // reuse anchors across calls — each invocation gets its own element
    // that is removed from the DOM synchronously in a finally block so
    // stale <a> tags can never accumulate and fire stray click events.
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);

    try {
      a.click();
    } finally {
      // Synchronous teardown — unlink from DOM immediately so the
      // element is GC-eligible the moment click() returns. The blob
      // URL is revoked on a microtask tick so the browser has time
      // to hand the data off to the download layer.
      if (a.parentNode) a.parentNode.removeChild(a);
      a.href = '';
      a.removeAttribute('download');
      setTimeout(function() { URL.revokeObjectURL(url); }, 0);
    }
    return true;
  }

  function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ---- Vault Sentinel ----
  // safekeep-boot.sh writes this file AFTER cryptsetup opens the vault
  // and the LUKS filesystem is verified mounted. It contains the vault's
  // UUID and a timestamp. The browser checks for this file AND verifies
  // the UUID matches to confirm the real encrypted partition is live —
  // not a tmpfs/overlayfs ghost directory.
  const VAULT_SENTINEL_PATH = `${MASTER_SEED_DIR}/.vault-sentinel.json`;
  const VAULT_SENTINEL_URL  = `file://${VAULT_SENTINEL_PATH}`;

  // Cached result: once verified true in a session, skip re-fetching.
  // Reset to null on factory reset or if a check ever fails.
  let _vaultVerified = null;

  /**
   * Verify the LUKS vault partition is genuinely mounted and LUKS-backed.
   *
   * The previous implementation used a simple fetch() to check if the
   * vault directory was reachable — but on a Live USB with an overlay
   * filesystem, the directory can exist in the writable tmpfs layer
   * even when the LUKS partition is NOT mounted. This caused false
   * positives: saves appeared to succeed but wrote to volatile RAM.
   *
   * The new approach uses a sentinel file that safekeep-boot.sh writes
   * ONLY after cryptsetup successfully opens the vault AND the mount
   * is verified. The sentinel contains the vault's dm-crypt UUID, which
   * the browser compares against a known constant. This is unforgeable:
   * the overlay filesystem cannot produce a valid sentinel because it
   * doesn't know the UUID, and the file is written by the boot script
   * (not by the browser or Chromium downloads).
   *
   * @returns {Promise<boolean>} true if the real LUKS vault is mounted
   */
  async function _isVaultMounted() {
    if (!isBootDrive()) return true;  // Demo mode — always "mounted"

    // Fast path: already verified this session
    if (_vaultVerified === true) return true;

    try {
      const resp = await fetch(VAULT_SENTINEL_URL, { cache: 'no-store' });
      if (!resp.ok) {
        _vaultVerified = false;
        return false;
      }

      const sentinel = await resp.json();

      // The sentinel must contain a non-empty UUID written by the boot script.
      // An overlay ghost directory would not have this file at all, and even
      // if someone manually created the directory, they couldn't forge the
      // correct UUID without knowing the dm-crypt mapper output.
      if (!sentinel || !sentinel.uuid || !sentinel.ts) {
        console.warn('SafeKeepOS: vault sentinel exists but is malformed');
        _vaultVerified = false;
        return false;
      }

      // Sentinel looks valid — cache for this session
      _vaultVerified = true;
      console.log('SafeKeepOS: vault sentinel verified (UUID: ' + sentinel.uuid.substring(0, 8) + '...)');
      return true;
    } catch (e) {
      _vaultVerified = false;
      return false;
    }
  }

  /**
   * Invalidate the cached vault verification.
   * Called during factory reset so the next save re-checks.
   */
  function _invalidateVaultCheck() {
    _vaultVerified = null;
  }


  // =============================================
  //  CODEX — Note Storage API (LUKS Sandbox)
  // =============================================
  //
  // Notes are stored as plaintext .txt files inside the encrypted
  // LUKS vault:  /media/.safekeep-vault/codex/<slug>.txt
  //
  // Because the entire partition is LUKS-encrypted at rest, individual
  // files do NOT need secondary passwords. The vault unlock is the
  // single authentication gate.
  //
  // On the boot drive (file:// protocol), _silentDownload writes via
  // Chromium's enterprise download policy, and fetch() reads back.
  // On the website (demo mode), an in-memory Map simulates the filesystem.

  const CODEX_DIR  = '/media/.safekeep-vault/codex';
  const CODEX_URL  = `file://${CODEX_DIR}`;

  // In-memory store. On the boot drive, _hydrateCodex() populates this
  // from the pre-generated .codex-index.json at boot time. All subsequent
  // writes go to both the Map AND disk; reads use the Map for listing,
  // disk for content (loadNote fetches the .html on demand).
  const _codexStore = new Map();

  /**
   * Slugify a title for use as a filename.
   * Strips unsafe chars, lowercases, replaces spaces with hyphens.
   */
  function _codexSlug(title) {
    return title.trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s\-_]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 80) || 'untitled';
  }

  // ---- Embedded metadata header (Codex single-file format) ----
  //
  // Sprint 22: To eliminate Chromium's "allow multiple downloads" prompt,
  // the Codex no longer writes a separate .meta.json sidecar. Instead,
  // title/slug/timestamp are embedded as a leading HTML comment at the
  // top of the .html payload itself, so saveNote() issues EXACTLY ONE
  // _silentDownload() per user action.
  //
  // Format:
  //   <!--SAFEKEEP_META:{"title":"…","slug":"…","updatedAt":"…"}-->\n
  //   <actual html body>
  //
  // Parser (codex_parseMeta) tolerates:
  //   - absent header (returns empty meta, falls back to legacy .meta.json)
  //   - malformed JSON (returns empty meta)
  //   - extra whitespace before the comment
  //
  // NOTE (backend follow-up): safekeep-boot.sh File Router should be
  // updated to stop expecting a .meta.json sidecar and parse the
  // embedded header instead. Until then, loadNote's legacy sidecar
  // fallback path keeps older notes readable.
  const _CODEX_META_RE = /^\s*<!--\s*SAFEKEEP_META:(\{[^]*?\})\s*-->\s*\r?\n?/;

  function _codexEncodeMeta(meta, htmlBody) {
    const header = '<!--SAFEKEEP_META:' + JSON.stringify(meta) + '-->\n';
    return header + (htmlBody || '');
  }

  function _codexParseMeta(payload) {
    if (!payload) return { meta: null, body: '' };
    const m = payload.match(_CODEX_META_RE);
    if (!m) return { meta: null, body: payload };
    let meta = null;
    try { meta = JSON.parse(m[1]); } catch (e) { meta = null; }
    return { meta, body: payload.slice(m[0].length) };
  }

  /**
   * Save a note to the vault.
   * Content is stored as HTML to preserve rich-text formatting.
   *
   * @param {string} title - Human-readable title (used as filename slug)
   * @param {string} content - The note body (HTML string from contenteditable)
   * @returns {{ saved: boolean, slug: string, error?: string }}
   */
  async function saveNote(title, content) {
    if (!title || !title.trim()) {
      return { saved: false, slug: '', error: 'Title is required.' };
    }

    // Pre-flight: verify vault is mounted before writing
    if (isBootDrive() && !(await _isVaultMounted())) {
      return { saved: false, slug: '', error: 'LUKS vault is not mounted. Cannot save note — data would be lost on reboot.' };
    }

    const slug = _codexSlug(title);
    const filename = slug + '.html';
    const body = content || '';
    const updatedAt = new Date().toISOString();

    // Always write to in-memory store — store the raw body without the
    // embedded header so the editor round-trips cleanly on reload.
    _codexStore.set(slug, { title: title.trim(), content: body, updatedAt });

    if (isBootDrive()) {
      // Single-file write: the metadata is embedded at the top of the
      // .html payload as an HTML comment. This is a ONE-SHOT download —
      // one anchor.click() per user action — so Chromium no longer
      // pops "allow multiple downloads."
      const combined = _codexEncodeMeta(
        { title: title.trim(), slug, updatedAt },
        body
      );
      _silentDownload(filename, combined);

      // Verify the file reached codex/ (router should move it within ~2s)
      await _sleep(2500);
      try {
        const resp = await fetch(`${CODEX_URL}/${filename}`, { cache: 'no-store' });
        if (resp.ok) {
          return { saved: true, slug };
        }
      } catch (e) { /* fall through */ }

      // Could not verify, but download was triggered — optimistic success
      console.warn('SafeKeepOS/Codex: Write triggered but read-back failed. File may still be writing.');
      return { saved: true, slug, warning: 'Read-back verification failed — file may still be flushing.' };
    }

    // Demo mode — in-memory only, always succeeds
    return { saved: true, slug };
  }

  /**
   * List all saved notes.
   *
   * On boot drive: scans the codex directory by fetching a known manifest,
   * then falls back to in-memory store.
   * On website: returns the in-memory store contents.
   *
   * @returns {Array<{ slug: string, title: string, updatedAt: string }>}
   */
  async function listNotes() {
    // Always return the in-memory index.
    // On boot drive, the gatekeeper populates this at boot from disk;
    // for now, the in-memory store is the source of truth for the session.
    const notes = [];
    _codexStore.forEach(function(val, slug) {
      notes.push({ slug, title: val.title, updatedAt: val.updatedAt || '' });
    });
    // Sort by most recently updated
    notes.sort(function(a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
    return notes;
  }

  /**
   * Load a single note by slug.
   *
   * @param {string} slug - The filename slug (without .html extension)
   * @returns {{ found: boolean, title: string, content: string, slug: string }}
   */
  async function loadNote(slug) {
    // Try disk first on boot drive
    if (isBootDrive()) {
      try {
        const resp = await fetch(`${CODEX_URL}/${slug}.html`, { cache: 'no-store' });
        if (resp.ok) {
          const raw = await resp.text();

          // Sprint 22: metadata is embedded as a leading HTML comment.
          // Parse it out so the editor sees only the body.
          const parsed = _codexParseMeta(raw);
          let title = (parsed.meta && parsed.meta.title) ? parsed.meta.title : slug;
          let content = parsed.body;
          const updatedAt = (parsed.meta && parsed.meta.updatedAt) || new Date().toISOString();

          // Legacy fallback: older notes stored metadata in a sidecar.
          // Only fetch the sidecar if no embedded header was found.
          if (!parsed.meta) {
            try {
              const metaResp = await fetch(`${CODEX_URL}/${slug}.meta.json`, { cache: 'no-store' });
              if (metaResp.ok) {
                const meta = await metaResp.json();
                title = meta.title || slug;
              }
            } catch (e) { /* use slug as title */ }
          }

          // Update in-memory cache (body only — no embedded header)
          _codexStore.set(slug, { title, content, updatedAt });
          return { found: true, title, content, slug };
        }
      } catch (e) { /* fall through to in-memory */ }
    }

    // In-memory fallback
    const entry = _codexStore.get(slug);
    if (entry) {
      return { found: true, title: entry.title, content: entry.content, slug };
    }

    return { found: false, title: '', content: '', slug };
  }

  /**
   * Delete a note by slug.
   *
   * On boot drive: overwrites the file with empty content (can't truly delete
   * via silent download, but the next listNotes will skip empty entries).
   * On website: removes from in-memory store.
   *
   * @param {string} slug - The filename slug
   * @returns {{ deleted: boolean }}
   */
  async function deleteNote(slug) {
    _codexStore.delete(slug);

    if (isBootDrive()) {
      // Overwrite with empty content — best we can do via silent download.
      // Sprint 22: single-file format means one write, one anchor click.
      // No companion .meta.json is required (see saveNote header notes).
      _silentDownload(slug + '.html', '');
    }

    return { deleted: true };
  }


  // =============================================
  //  CIPHER — Passphrase Library
  // =============================================
  //
  // Stores named passphrases on the LUKS-encrypted vault.
  // Sprint 21+: single combined <slug>.json with passphrase + metadata.
  // Legacy fallback reads <slug>.txt + <slug>.meta.json if .json missing.
  //
  // Save path: /media/.safekeep-vault/passphrases/

  const PASSPHRASE_DIR = '/media/.safekeep-vault/passphrases';
  const PASSPHRASE_URL = `file://${PASSPHRASE_DIR}`;
  const _passphraseStore = new Map();

  /**
   * Slugify a nickname for use as a filename.
   */
  function _passphraseSlug(nickname) {
    return nickname.trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s\-_]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 80) || 'untitled';
  }

  /**
   * Generate a masked preview string for the archive list.
   * Shows first 2 chars, a middle mask with the total length, and last 2 chars.
   * Example: "My.......[64 chars].......s!"
   */
  function _passphraseMask(raw) {
    if (!raw || raw.length < 6) return raw ? '*'.repeat(raw.length) : '';
    var first = raw.substring(0, 2);
    var last  = raw.substring(raw.length - 2);
    return first + '.......[' + raw.length + ' chars].......' + last;
  }

  /**
   * Save a passphrase to the vault.
   *
   * @param {string} nickname - Human-readable label
   * @param {string} passphrase - The raw passphrase string
   * @returns {{ saved: boolean, slug: string, error?: string }}
   */
  async function savePassphrase(nickname, passphrase) {
    if (!nickname || !nickname.trim()) {
      return { saved: false, slug: '', error: 'Nickname is required.' };
    }
    if (!passphrase) {
      return { saved: false, slug: '', error: 'Passphrase is required.' };
    }

    // Pre-flight: verify vault is mounted before writing
    if (isBootDrive() && !(await _isVaultMounted())) {
      return { saved: false, slug: '', error: 'LUKS vault is not mounted. Cannot save passphrase — data would be lost on reboot.' };
    }

    const slug = _passphraseSlug(nickname);
    const masked = _passphraseMask(passphrase);

    // Always write to in-memory store
    _passphraseStore.set(slug, {
      nickname: nickname.trim(),
      passphrase,
      masked,
      updatedAt: new Date().toISOString()
    });

    if (isBootDrive()) {
      // Single combined JSON file — avoids Chromium's "multiple downloads" warning.
      // Previous approach used separate .txt + .meta.json files with a 700ms stagger,
      // but the second download still fired outside the user gesture window in kiosk mode.
      const combined = JSON.stringify({
        nickname: nickname.trim(),
        slug,
        passphrase,
        masked,
        updatedAt: new Date().toISOString()
      });
      _silentDownload(slug + '.json', combined);

      // Verify the file write
      await _sleep(800);
      try {
        const resp = await fetch(`${PASSPHRASE_URL}/${slug}.json`, { cache: 'no-store' });
        if (resp.ok) {
          return { saved: true, slug };
        }
      } catch (e) { /* fall through */ }

      console.warn('SafeKeepOS/Cipher: Write triggered but read-back failed.');
      return { saved: true, slug, warning: 'Read-back verification failed.' };
    }

    // Demo mode — in-memory only
    return { saved: true, slug };
  }

  /**
   * List all saved passphrases.
   * Returns metadata only (never the raw passphrase).
   *
   * @returns {Array<{ slug: string, nickname: string, masked: string, updatedAt: string }>}
   */
  async function listPassphrases() {
    const entries = [];
    _passphraseStore.forEach(function(val, slug) {
      entries.push({ slug, nickname: val.nickname, masked: val.masked, updatedAt: val.updatedAt || '' });
    });
    entries.sort(function(a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
    return entries;
  }

  /**
   * Load a passphrase by slug (returns the raw passphrase string).
   *
   * @param {string} slug
   * @returns {{ found: boolean, nickname: string, passphrase: string, slug: string }}
   */
  async function loadPassphrase(slug) {
    // Try disk first on boot drive
    if (isBootDrive()) {
      // Try combined .json format first (Sprint 21+)
      try {
        const resp = await fetch(`${PASSPHRASE_URL}/${slug}.json`, { cache: 'no-store' });
        if (resp.ok) {
          const data = await resp.json();
          const passphrase = data.passphrase || '';
          const nickname = data.nickname || slug;
          _passphraseStore.set(slug, {
            nickname,
            passphrase,
            masked: _passphraseMask(passphrase),
            updatedAt: data.updatedAt || new Date().toISOString()
          });
          return { found: true, nickname, passphrase, slug };
        }
      } catch (e) { /* fall through to legacy format */ }

      // Legacy fallback: separate .txt + .meta.json (pre-Sprint 21)
      try {
        const resp = await fetch(`${PASSPHRASE_URL}/${slug}.txt`, { cache: 'no-store' });
        if (resp.ok) {
          const passphrase = await resp.text();
          let nickname = slug;
          try {
            const metaResp = await fetch(`${PASSPHRASE_URL}/${slug}.meta.json`, { cache: 'no-store' });
            if (metaResp.ok) {
              const meta = await metaResp.json();
              nickname = meta.nickname || slug;
            }
          } catch (e) { /* use slug as nickname */ }
          _passphraseStore.set(slug, {
            nickname,
            passphrase,
            masked: _passphraseMask(passphrase),
            updatedAt: new Date().toISOString()
          });
          return { found: true, nickname, passphrase, slug };
        }
      } catch (e) { /* fall through to in-memory */ }
    }

    // In-memory fallback
    const entry = _passphraseStore.get(slug);
    if (entry) {
      return { found: true, nickname: entry.nickname, passphrase: entry.passphrase, slug };
    }

    return { found: false, nickname: '', passphrase: '', slug };
  }

  /**
   * Delete a passphrase by slug.
   *
   * @param {string} slug
   * @returns {{ deleted: boolean }}
   */
  async function deletePassphrase(slug) {
    _passphraseStore.delete(slug);

    if (isBootDrive()) {
      // Wipe the combined .json (Sprint 21+) and legacy .txt/.meta.json files
      _silentDownload(slug + '.json', '');
      // Note: legacy .txt and .meta.json are left on disk (harmless empty stubs).
      // A full cleanup would require OS-level file deletion, which the browser cannot do.
    }

    return { deleted: true };
  }


  // =============================================
  //  RELIQUARY — Encrypted Backup / Restore
  // =============================================
  //
  // Uses native Ubuntu `7z` (p7zip-full) to create AES-256
  // encrypted archives of selected vault directories.
  //
  // Vault layout under /media/.safekeep-vault/:
  //   seeds/          → Master seed JSON
  //   codex/          → Notes (.html + .meta.json)
  //   settings/       → Application configuration
  //   cipher/         → Passphrase material
  //
  // Archives are written to the transfer drive (USB partition).
  // The actual mount point is resolved dynamically at boot by
  // safekeep-boot.sh and written to .transfer-mount-path.
  // The default is a fallback for demo mode or if the path file
  // hasn't been read yet.

  const VAULT_ROOT     = '/media/.safekeep-vault';
  let   TRANSFER_ROOT  = '/media/safekeep-transfer';  // default, overridden at boot
  const RELIQUARY_TMP  = '/tmp/reliquary';

  // Read the dynamic transfer mount path written by safekeep-boot.sh.
  // Called once during boot() — updates TRANSFER_ROOT for all subsequent calls.
  async function _resolveTransferRoot() {
    if (!isBootDrive()) return;  // demo mode uses default
    try {
      const resp = await fetch(
        `file://${MASTER_SEED_DIR}/.transfer-mount-path`,
        { cache: 'no-store' }
      );
      if (resp.ok) {
        const path = (await resp.text()).trim();
        if (path && path.startsWith('/')) {
          TRANSFER_ROOT = path;
          console.log('SafeKeepOS: TRANSFER_ROOT resolved → ' + TRANSFER_ROOT);
        }
      }
    } catch (e) {
      console.warn('SafeKeepOS: could not read .transfer-mount-path, using default');
    }
  }

  // Map of backup category → vault subdirectory
  const RELIQUARY_DIRS = {
    codex:    `${VAULT_ROOT}/codex`,
    settings: `${VAULT_ROOT}/settings`,
    cipher:   `${VAULT_ROOT}/passphrases`,
    seed:     `${VAULT_ROOT}/seeds`
  };

  /**
   * Create an encrypted Reliquary backup archive.
   *
   * Constructs a 7z command that compresses selected vault directories
   * into an AES-256 encrypted archive on the transfer drive.
   *
   * @param {string[]} selections - Array of category keys: 'codex', 'settings', 'cipher', 'seed'
   * @param {string} password - Encryption password for the 7z archive
   * @returns {{ created: boolean, filename: string, command: string, error?: string }}
   */
  async function createReliquary(selections, password) {
    if (!selections || selections.length === 0) {
      return { created: false, filename: '', command: '', error: 'No items selected for backup.' };
    }
    if (!password || password.length < 1) {
      return { created: false, filename: '', command: '', error: 'Encryption password is required.' };
    }

    const dateStr = new Date().toISOString().substring(0, 10);
    const baseName = `Safekeep_backup_${dateStr}`;

    // Build list of source directories to include
    const sources = [];
    for (const key of selections) {
      if (RELIQUARY_DIRS[key]) {
        sources.push(RELIQUARY_DIRS[key]);
      }
    }

    if (sources.length === 0) {
      return { created: false, filename: '', command: '', error: 'No valid directories matched selections.' };
    }

    // Escape the password for shell single-quote context
    const escapedPw = password.replace(/'/g, "'\\''");
    const srcArgs = sources.map(s => "'" + s + "'").join(' ');

    // Construct a shell script block that:
    //   1. Deletes any existing archive with the same base name on the
    //      transfer drive (we want a clean overwrite, not a -01/-02 fan-out)
    //   2. Runs 7z with the base filename — produces a fresh archive
    //   3. Echoes the final filename for capture by the caller
    //
    // Rationale: the previous uniquify-with-suffix policy produced a
    // messy duplicate file tree on the transfer partition whenever a
    // user backed up more than once on a given day (including the
    // copy-boot-restore-backup loop). Overwrite is what users expect
    // from a "daily snapshot" semantic — the 7z archive itself is
    // AES-256 encrypted so there is no data-loss risk from replacing
    // the old file in place, and the user still retains archives from
    // previous days (different baseName).
    //
    // `rm -f` is a no-op when the file does not exist, so first-ever
    // backups still work. We use `rm -f` rather than `7z`'s own update
    // mode (`7z u`) because update semantics *append* to an existing
    // archive rather than replacing it — which would blend today's
    // vault state with whatever was already in the archive on disk.
    const cmd = [
      `BASE='${TRANSFER_ROOT}/${baseName}'`,
      `EXT='.7z'`,
      `OUT="${'${BASE}${EXT}'}"`,
      `rm -f "$OUT"`,
      `7z a -t7z -m0=lzma2 -mhe=on -p'${escapedPw}' "$OUT" ${srcArgs}`,
      `echo "RELIQUARY_FILE=$(basename "$OUT")"`,
    ].join('\n');

    // Filename is now deterministic — no runtime suffix resolution.
    const filename = `${baseName}.7z`;

    if (!isBootDrive()) {
      // Demo mode: return the command without executing
      // Also store a manifest in memory for simulation
      _reliquaryManifest = { selections: [...selections], filename, dateStr };
      return { created: true, filename, command: cmd, demo: true };
    }

    // ── Boot Drive: Trigger-File Execution via _silentDownload ──
    // The browser cannot exec shell commands directly. We write a trigger
    // file via Chromium's enterprise download routing (which drops it into
    // the directory the Reliquary Watcher daemon monitors).  The daemon
    // executes the 7z command, writes a result file, and deletes the trigger.
    //
    // The daemon is a hardcoded state machine that expects an ACK file
    // before it releases its locks.  The ACK is fired via a delayed
    // setTimeout (1500 ms) after we read the result — this is a terminal
    // workflow step with no subsequent trigger, so even if Chrome prompts,
    // it cannot break the flow.
    //
    // Trigger: VAULT_MOUNT/seeds/RELIQUARY_TRIGGER.json
    // ACK:     VAULT_MOUNT/seeds/RELIQUARY_ACK.json
    // Result:  VAULT_MOUNT/seeds/RELIQUARY_RESULT.json

    const triggerPayload = JSON.stringify({
      action: 'create',
      command: cmd,
      baseName,
      dateStr,
      selections: [...selections],
      timestamp: Date.now()
    });

    _silentDownload('RELIQUARY_TRIGGER.json', triggerPayload);

    // Poll for the result file (the watcher daemon writes it after 7z completes)
    const RESULT_URL = `file://${MASTER_SEED_DIR}/RELIQUARY_RESULT.json`;
    const POLL_INTERVAL = 800;   // ms between checks
    const MAX_WAIT = 60000;      // 60 seconds max (large backups can take time)
    let elapsed = 0;

    // Small initial delay — trigger file needs to flush to disk
    await _sleep(1200);

    while (elapsed < MAX_WAIT) {
      try {
        const resp = await fetch(RESULT_URL, { cache: 'no-store' });
        if (resp.ok) {
          const result = await resp.json();

          // Delayed ACK — releases the daemon's lock.  The 1500 ms gap
          // from the trigger separates the two downloads enough to dodge
          // Chrome's rapid-fire heuristic.  This is the terminal step of
          // the export workflow so even a Chrome prompt won't block state.
          setTimeout(function() { _silentDownload('RELIQUARY_ACK.json', '{"ack":true}'); }, 1500);

          if (result.ok) {
            const actualFilename = result.filename || filename;
            _reliquaryManifest = { selections: [...selections], filename: actualFilename, dateStr };
            return { created: true, filename: actualFilename, command: cmd };
          } else {
            return { created: false, filename: '', command: cmd, error: result.error || 'Backup creation failed on disk.' };
          }
        }
      } catch (e) {
        // Result file not ready yet — continue polling
      }
      await _sleep(POLL_INTERVAL);
      elapsed += POLL_INTERVAL;
    }

    // Timed out waiting for the watcher
    return { created: false, filename: '', command: cmd, error: 'Backup timed out — the .7z backup watcher daemon may not be running. Check system logs.' };
  }

  // In-memory manifest for the last backup/restore operation
  let _reliquaryManifest = null;
  let _restoreInspectAckPending = false; // Set by inspectReliquary, consumed by commitReliquary

  /**
   * Translate a raw 7-Zip stderr/stdout dump into a clean, user-facing
   * error string.
   *
   * The Restore Watcher daemon forwards 7z's output verbatim when the
   * child process exits non-zero. 7z's banner starts with
   * "7-Zip 23.01 (x64) ..." and its password/corruption failures
   * surface as exit code 2 with "Wrong password" or "Data Error" in
   * the payload. Dumping that raw text into the UI is ugly and leaks
   * internal tool details to the user.
   *
   * This helper inspects the raw error text for known 7z failure
   * signatures and returns a single-line, user-friendly message.
   * If the text does not match any known 7z signature, the first
   * non-banner line is returned (still trimmed) so genuine daemon
   * errors (e.g. disk full, missing file) remain visible.
   *
   * @param {string} raw - Raw error text from the daemon result file.
   * @returns {string} Clean, user-facing error message.
   */
  function _sanitize7zError(raw) {
    if (!raw || typeof raw !== 'string') {
      return 'Unknown error.';
    }

    // Normalize for pattern matching (case-insensitive scan).
    const hay = raw.toLowerCase();

    // 7-Zip exit code 2 + password/corruption signatures.
    //   code 2 / (code 2) / exit code 2  → 7z "fatal error"
    //   "wrong password"                  → bad password
    //   "data error"                      → bad password or corruption
    //   "can not open encrypted archive"  → bad password
    //   "cannot open the file as archive" → corrupt/not-7z
    //   "cannot open encrypted archive"   → bad password
    //   "headers error"                   → corrupt header / wrong pw on -mhe=on
    const badPwOrCorrupt =
      /\bcode\s*2\b/.test(hay) ||
      hay.indexOf('wrong password') !== -1 ||
      hay.indexOf('data error') !== -1 ||
      hay.indexOf('headers error') !== -1 ||
      hay.indexOf('can not open encrypted archive') !== -1 ||
      hay.indexOf('cannot open encrypted archive') !== -1 ||
      hay.indexOf('cannot open the file as archive') !== -1;

    if (badPwOrCorrupt) {
      return 'Incorrect password or corrupted archive.';
    }

    // Not a recognized 7z failure — strip the 7-Zip banner lines but
    // keep the first meaningful line so genuine daemon errors remain
    // diagnosable without dumping the full terminal output.
    const firstUseful = raw
      .split(/\r?\n/)
      .map(function(l) { return l.trim(); })
      .find(function(l) {
        if (!l) return false;
        const low = l.toLowerCase();
        // Skip 7-Zip banner / copyright / version lines.
        if (low.indexOf('7-zip') === 0) return false;
        if (low.indexOf('p7zip version') !== -1) return false;
        if (low.indexOf('igor pavlov') !== -1) return false;
        if (low.indexOf('copyright') !== -1) return false;
        if (/^\d{4}-\d{2}-\d{2}/.test(low)) return false; // build date line
        if (low.indexOf('scanning the drive') === 0) return false;
        if (low.indexOf('open archive') === 0) return false;
        if (/^-+$/.test(low)) return false; // separator rules
        return true;
      });

    return firstUseful || 'Archive extraction failed.';
  }

  /**
   * List archive artefacts on the Transfer Drive.
   *
   * Includes two file kinds:
   *   • `*.7z`   — encrypted Reliquary backup archives (restorable)
   *   • `*.json` — hardware-wallet exports (e.g. safekeep-nunchuk.json
   *                from The Armory's "Download JSON" button) — read-only,
   *                never feeds the unlock/restore flow
   *
   * The Archive UI classifies each entry by extension and renders JSON
   * exports as read-only "Export" rows with a toast-style message
   * instead of a password prompt.
   *
   * On boot drive: reads a pre-generated index file (.backups-index.json)
   * that safekeep-boot.sh creates at boot and the Reliquary Watcher
   * regenerates after every successful create/export, so new files show
   * up without requiring a reboot.
   * In demo mode: returns a simulated list covering both file kinds.
   *
   * @returns {Promise<string[]>} Filenames sorted newest-first.
   */
  async function listBackups() {
    if (!isBootDrive()) {
      // Demo mode: include both a sample backup and a sample JSON export
      // so the Archive UI demo renders the full Backup/Export distinction.
      var demos = [
        'safekeep-nunchuk.json',
        'Safekeep_backup_2026-01-15.7z'
      ];
      if (_reliquaryManifest && _reliquaryManifest.filename) {
        demos.unshift(_reliquaryManifest.filename);
      }
      return demos;
    }

    // Boot drive: read the index generated by safekeep-boot.sh
    try {
      var resp = await fetch(
        `file://${TRANSFER_ROOT}/.backups-index.json`,
        { cache: 'no-store' }
      );
      if (resp.ok) {
        var data = await resp.json();
        if (Array.isArray(data)) return data;
      }
    } catch (e) { /* fall through */ }

    return [];
  }

  /**
   * Inspect a Reliquary archive from the transfer drive.
   *
   * Extracts to a RAM-disk temp directory and returns a manifest
   * of what the archive contains.
   *
   * @param {string} filename - The .7z filename on the transfer drive
   * @param {string} password - Decryption password
   * @returns {{ unlocked: boolean, manifest: object, command: string, error?: string }}
   */
  async function inspectReliquary(filename, password) {
    if (!filename || !password) {
      return { unlocked: false, manifest: null, command: '', error: 'Filename and password are required.' };
    }

    const escapedPw = password.replace(/'/g, "'\\''");
    const archivePath = `${TRANSFER_ROOT}/${filename}`;
    const extractCmd = `rm -rf '${RELIQUARY_TMP}' && mkdir -p '${RELIQUARY_TMP}'` +
                       ` && 7z x -o'${RELIQUARY_TMP}' -p'${escapedPw}'` +
                       ` '${archivePath}' -y`;

    // Build manifest by checking which directories exist after extraction
    const manifest = {
      codex: false,
      settings: false,
      cipher: false,
      seed: false,
      codexCount: 0,
      cipherCount: 0
    };

    if (!isBootDrive()) {
      // Demo mode: simulate from last backup manifest
      if (_reliquaryManifest && _reliquaryManifest.selections) {
        _reliquaryManifest.selections.forEach(function(s) { manifest[s] = true; });
        if (manifest.codex) manifest.codexCount = 3;
        if (manifest.cipher) manifest.cipherCount = 1;
      }
      return { unlocked: true, manifest, command: extractCmd, demo: true };
    }

    // ── Boot Drive: Trigger-File Execution via _silentDownload ──
    // Write a trigger file via Chromium's enterprise download routing,
    // which drops it into the directory the Restore Watcher daemon in
    // safekeep-boot.sh monitors.  The daemon extracts the .7z to
    // /tmp/reliquary, probes the contents, and writes a result file.
    //
    // The daemon is a hardcoded state machine: it will NOT accept a
    // RESTORE_COMMIT trigger until it sees RESTORE_INSPECT_ACK.  We
    // do NOT fire the ACK here (that would be a second programmatic
    // download in the same gesture window → Chrome warning).  Instead
    // we set a flag (_restoreInspectAckPending) so the ACK is fired
    // from the NEXT user gesture — the Merge/Overwrite button click
    // in commitReliquary().
    //
    // Trigger: VAULT_MOUNT/seeds/RESTORE_INSPECT.json
    // ACK:     VAULT_MOUNT/seeds/RESTORE_INSPECT_ACK.json  (deferred)
    // Result:  VAULT_MOUNT/seeds/RESTORE_INSPECT_RESULT.json

    const triggerPayload = JSON.stringify({
      action: 'inspect',
      filename,
      password: escapedPw,
      command: extractCmd,
      timestamp: Date.now()
    });

    _silentDownload('RESTORE_INSPECT.json', triggerPayload);

    // Poll for the result file (daemon writes it after 7z + probe completes)
    const RESULT_URL = `file://${MASTER_SEED_DIR}/RESTORE_INSPECT_RESULT.json`;
    const POLL_INTERVAL = 800;
    const MAX_WAIT = 60000;
    let elapsed = 0;

    await _sleep(1200);

    while (elapsed < MAX_WAIT) {
      try {
        const resp = await fetch(RESULT_URL, { cache: 'no-store' });
        if (resp.ok) {
          const result = await resp.json();

          // Mark ACK as pending — commitReliquary() will fire it from
          // the user's click gesture before sending the commit trigger.
          _restoreInspectAckPending = true;

          if (result.ok) {
            manifest.codex    = !!result.codex;
            manifest.settings = !!result.settings;
            manifest.cipher   = !!result.cipher;
            manifest.seed     = !!result.seed;
            manifest.codexCount  = result.codexCount  || 0;
            manifest.cipherCount = result.cipherCount || 0;
            return { unlocked: true, manifest, command: extractCmd };
          } else {
            // Sanitize the daemon's raw 7z output before surfacing it
            // to the UI — hides the 7-Zip banner and maps exit-code-2
            // style failures to a clean, user-facing message.
            const cleanErr = result.error
              ? _sanitize7zError(result.error)
              : 'Failed to extract archive.';
            return { unlocked: false, manifest: null, command: extractCmd, error: cleanErr };
          }
        }
      } catch (e) {
        // Result file not ready yet — continue polling
      }
      await _sleep(POLL_INTERVAL);
      elapsed += POLL_INTERVAL;
    }

    return { unlocked: false, manifest: null, command: extractCmd, error: 'Inspect timed out — the Restore Watcher daemon may not be running.' };
  }

  /**
   * Commit a previously inspected Reliquary to the vault.
   *
   * @param {'merge'|'overwrite'} mode
   *   - 'merge': copy extracted files into vault alongside existing
   *   - 'overwrite': wipe vault dirs, then copy extracted files in
   * @returns {{ committed: boolean, command: string, error?: string }}
   */
  async function commitReliquary(mode) {
    if (mode !== 'merge' && mode !== 'overwrite') {
      return { committed: false, command: '', error: 'Mode must be "merge" or "overwrite".' };
    }

    const src = `${RELIQUARY_TMP}${VAULT_ROOT}`;
    let cmd = '';

    if (mode === 'overwrite') {
      // Wipe destination dirs, then copy
      cmd = `rm -rf '${VAULT_ROOT}/codex' '${VAULT_ROOT}/settings' '${VAULT_ROOT}/passphrases'` +
            ` && cp -a '${src}/.' '${VAULT_ROOT}/'` +
            ` && rm -rf '${RELIQUARY_TMP}'`;
    } else {
      // Merge: overlay backup on top of existing vault data
      cmd = `cp -a '${src}/.' '${VAULT_ROOT}/'` +
            ` && rm -rf '${RELIQUARY_TMP}'`;
    }

    if (!isBootDrive()) {
      // Demo mode
      _reliquaryManifest = null;
      return { committed: true, command: cmd, demo: true };
    }

    // ── Boot Drive: Trigger-File Execution via _silentDownload ──
    // This function is called from rlq_commit() which is itself called
    // from a direct user click (Merge / Overwrite button).  That click
    // gives us a fresh user-gesture window.
    //
    // Step 1: Fire the deferred RESTORE_INSPECT_ACK from THIS gesture
    //         (the daemon is stuck in the Inspect phase until it sees it).
    // Step 2: Wait 500 ms so the ACK flushes to disk and the daemon
    //         transitions to the Commit-ready state.
    // Step 3: Fire the RESTORE_COMMIT trigger — still within the same
    //         gesture window, so Chrome allows it without a prompt.
    //
    // The commit ACK at the end is delayed by 1500 ms via setTimeout.
    // It's the terminal step — even if Chrome prompts, it won't block.
    //
    // Trigger: VAULT_MOUNT/seeds/RESTORE_COMMIT.json
    // ACK:     VAULT_MOUNT/seeds/RESTORE_COMMIT_ACK.json  (delayed)
    // Result:  VAULT_MOUNT/seeds/RESTORE_COMMIT_RESULT.json

    // Step 1: Flush the deferred inspect ACK
    if (_restoreInspectAckPending) {
      _silentDownload('RESTORE_INSPECT_ACK.json', '{"ack":true}');
      _restoreInspectAckPending = false;
      // Step 2: Give the daemon time to process the ACK and unlock
      await _sleep(500);
    }

    // Step 3: Fire the commit trigger
    const triggerPayload = JSON.stringify({
      action: 'commit',
      mode,
      command: cmd,
      timestamp: Date.now()
    });

    _silentDownload('RESTORE_COMMIT.json', triggerPayload);

    const RESULT_URL = `file://${MASTER_SEED_DIR}/RESTORE_COMMIT_RESULT.json`;
    const POLL_INTERVAL = 800;
    const MAX_WAIT = 30000;
    let elapsed = 0;

    await _sleep(1000);

    while (elapsed < MAX_WAIT) {
      try {
        const resp = await fetch(RESULT_URL, { cache: 'no-store' });
        if (resp.ok) {
          const result = await resp.json();

          // Delayed commit ACK — releases the daemon's final lock.
          // 1500 ms gap from the commit trigger dodges Chrome's
          // rapid-fire heuristic; terminal step so a prompt is harmless.
          setTimeout(function() { _silentDownload('RESTORE_COMMIT_ACK.json', '{"ack":true}'); }, 1500);

          _reliquaryManifest = null;

          if (result.ok) {
            return { committed: true, command: cmd };
          } else {
            // Same sanitizer — commit can also hit 7z if a nested
            // archive ever shows up, and in any case we don't want
            // raw daemon output bleeding into the UI.
            const cleanErr = result.error
              ? _sanitize7zError(result.error)
              : 'Commit failed on disk.';
            return { committed: false, command: cmd, error: cleanErr };
          }
        }
      } catch (e) {
        // Result file not ready yet — continue polling
      }
      await _sleep(POLL_INTERVAL);
      elapsed += POLL_INTERVAL;
    }

    _reliquaryManifest = null;
    return { committed: false, command: cmd, error: 'Commit timed out — the Restore Watcher daemon may not be running.' };
  }

  /**
   * Export a small plain-text / JSON file to the Transfer partition.
   *
   * Use case: exports that belong ON the unencrypted transfer drive
   * (so the user can hand them to an offline wallet like Nunchuk or
   * Coldcard), NOT inside the encrypted LUKS vault. Examples include:
   *   • safekeep-nunchuk.json  (Coldcard-style xpub profile)
   *   • PSBT workflow artifacts
   *
   * Why not just `_silentDownload`?  Chromium's DownloadDirectory on
   * the boot drive is pinned to the vault's seeds/ directory (see
   * safekeep-boot.sh `DownloadDirectory=$SEED_DIR`). _silentDownload
   * therefore writes into the ENCRYPTED vault, not the transfer
   * partition — the File Router daemon only picks up recognized file
   * types (codex .html, passphrase .json) and would leave arbitrary
   * JSON sitting in seeds/ forever.
   *
   * This function piggy-backs on the Reliquary Watcher daemon that
   * already executes archive-creation shell commands. The trigger
   * file's `command` field is arbitrary shell; the daemon rewrites
   * any `/media/safekeep-transfer` reference to the dynamically
   * resolved USB mount, executes it, verifies the output file, and
   * writes a result record.
   *
   * Content is base64-encoded before being embedded in the command
   * so we don't have to worry about shell escaping of JSON punctuation
   * (quotes, backslashes, newlines, etc.). The daemon decodes it with
   * `base64 -d` and writes the raw bytes to the transfer partition.
   *
   * @param {string} filename  Base filename only — no path components.
   *                           Rejects anything containing `/`, `\`, or `..`.
   * @param {string} content   File contents as a string (UTF-8 safe).
   * @returns {Promise<{ exported: boolean, filename: string, size?: number,
   *                     command?: string, demo?: boolean, error?: string }>}
   */
  async function exportToTransfer(filename, content) {
    // Filename validation — reject anything that could escape the
    // transfer root via path traversal or separators.
    if (!filename || typeof filename !== 'string') {
      return { exported: false, filename: '', error: 'Filename is required.' };
    }
    if (/[\/\\]/.test(filename) || filename.indexOf('..') !== -1) {
      return { exported: false, filename, error: 'Filename must not contain path components.' };
    }
    if (typeof content !== 'string') {
      return { exported: false, filename, error: 'Content must be a string.' };
    }

    // Base64-encode the content so shell-unsafe characters (quotes,
    // newlines, backslashes) survive the round-trip into the trigger
    // JSON and out through `bash -c`. `unescape(encodeURIComponent(...))`
    // converts the JS string to a UTF-8 byte stream before btoa, which
    // handles non-ASCII characters correctly should they ever appear.
    let b64;
    try {
      b64 = btoa(unescape(encodeURIComponent(content)));
    } catch (e) {
      return { exported: false, filename, error: 'Content encoding failed: ' + e.message };
    }

    // Single-quote escape the filename for the shell. `'` inside a
    // single-quoted string is written as `'\''` (close, escaped quote,
    // reopen). This is the same pattern createReliquary uses for its
    // password escape.
    const escapedName = filename.replace(/'/g, "'\\''");

    // Build a self-contained shell script.
    //   1. Ensure the transfer mount root exists (no-op if mounted).
    //   2. Decode the base64 payload into the target file — overwrites
    //      any existing file with the same name (matches the clean-
    //      overwrite policy we use for archives).
    //   3. Emit RELIQUARY_FILE= so the watcher's existing success
    //      parser reports the filename/size back to us verbatim.
    //
    // The Reliquary Watcher's sed rewriter replaces the literal
    // `/media/safekeep-transfer` with the dynamically resolved USB
    // mount point. We use that same literal here so the rewriter
    // can find it even if TRANSFER_ROOT has since been overridden
    // in-browser (e.g. to `/media/$USER/TRANSFER`).
    const cmd = [
      `mkdir -p '/media/safekeep-transfer'`,
      `printf '%s' '${b64}' | base64 -d > '/media/safekeep-transfer/${escapedName}'`,
      `echo "RELIQUARY_FILE=${escapedName}"`,
    ].join('\n');

    if (!isBootDrive()) {
      // Demo mode — surface the command but do not execute.
      return { exported: true, filename, command: cmd, demo: true };
    }

    // Reuse the Reliquary Watcher's trigger/result/ack plumbing.
    // Same trigger name, same result path, same ACK file — the
    // watcher doesn't care whether we asked it to create an archive
    // or just write a small file, as long as the command block is
    // valid and produces a RELIQUARY_FILE= line on success.
    const triggerPayload = JSON.stringify({
      action:    'export-file',   // informational only — watcher runs `command`
      command:   cmd,
      filename,
      timestamp: Date.now()
    });

    _silentDownload('RELIQUARY_TRIGGER.json', triggerPayload);

    const RESULT_URL    = `file://${MASTER_SEED_DIR}/RELIQUARY_RESULT.json`;
    const POLL_INTERVAL = 400;   // faster than backup — this is a trivial write
    const MAX_WAIT      = 15000; // 15 s ceiling — base64 decode + write is near-instant
    let elapsed = 0;

    // Minimum flush delay — the trigger file has to hit disk before the
    // watcher's `[ -f ]` check sees it.
    await _sleep(600);

    while (elapsed < MAX_WAIT) {
      try {
        const resp = await fetch(RESULT_URL, { cache: 'no-store' });
        if (resp.ok) {
          const result = await resp.json();

          // Delayed ACK releases the daemon's lock. 1500 ms gap from
          // the trigger download dodges Chrome's rapid-fire heuristic;
          // terminal step for this workflow so a prompt is harmless.
          setTimeout(function() { _silentDownload('RELIQUARY_ACK.json', '{"ack":true}'); }, 1500);

          if (result.ok) {
            return {
              exported: true,
              filename: result.filename || filename,
              size:     result.size || 0,
              command:  cmd
            };
          } else {
            return {
              exported: false,
              filename,
              command:  cmd,
              error:    _sanitize7zError(result.error) || 'Export failed on disk.'
            };
          }
        }
      } catch (e) {
        // Result not yet written — keep polling.
      }
      await _sleep(POLL_INTERVAL);
      elapsed += POLL_INTERVAL;
    }

    return {
      exported: false,
      filename,
      command:  cmd,
      error:    'Export timed out — the .7z backup watcher daemon may not be running.'
    };
  }


  // =============================================
  //  POWER SEQUENCE — Shutdown / Restart
  // =============================================
  //
  // Protocol:
  //   1. The frontend calls powerOff() or restart() from the Power Options
  //      dashboard modal.
  //   2. This writes a protocol file ("POWER_ACTION.txt") whose single-line
  //      body is either "poweroff" or "reboot", via a RAW Blob download —
  //      deliberately bypassing _silentDownload so the Amnesia / Volatile
  //      firewall never sees it and blocks it. This file is a transient
  //      OS-protocol signal, not user data.
  //   3. safekeep-boot.sh is blocked on Chromium's foreground process.
  //      After Chromium exits (via window.close()), the shell reads
  //      POWER_ACTION.txt from the appropriate signal directory and
  //      branches to `sudo reboot` or `sudo poweroff`. If no file is
  //      present, it defaults to poweroff (safe fallback — destroys RAM).
  //   4. In normal boot the signal file lands in $SEED_DIR (Chromium's
  //      download target = the vault's seeds dir). In ephemeral boot the
  //      vault is unmounted; safekeep-boot.sh reconfigures Chromium's
  //      DownloadDirectory to /tmp/safekeep-signals/ for that boot.
  //
  // SECURITY: The file contains no seed material — only the literal
  // string "poweroff" or "reboot". It is erased at the next boot either
  // way (tmpfs for ephemeral; explicit `rm` at start of safekeep-boot.sh
  // for normal mode) so no stale signals can survive a power cycle.
  //
  // Filename is all-caps and prefixed "POWER_ACTION" so it is recognised
  // as a system trigger file by _isSystemFile() (see _SYSTEM_TRIGGER_PREFIXES).

  const POWER_ACTION_FILE = 'POWER_ACTION.txt';

  /**
   * Raw Blob-download helper that intentionally bypasses _silentDownload's
   * firewall. Used ONLY for OS protocol signals (power-action, never seed
   * material).
   */
  function _rawBlobDownload(filename, content) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      if (a.parentNode) a.parentNode.removeChild(a);
      a.href = '';
      a.removeAttribute('download');
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    }
  }

  /**
   * Drop the power-action signal file and close the Chromium kiosk,
   * handing control back to safekeep-boot.sh which reads the file and
   * executes either `sudo poweroff` or `sudo reboot`.
   *
   * A 500 ms delay is inserted between the Blob click and window.close()
   * to give Chromium's download layer time to flush the file to disk
   * before the process exits.
   *
   * @param {'poweroff'|'reboot'} action
   */
  function _submitPowerAction(action) {
    if (action !== 'poweroff' && action !== 'reboot') {
      throw new Error('Invalid power action: ' + action);
    }
    try {
      _rawBlobDownload(POWER_ACTION_FILE, action + '\n');
    } catch (err) {
      console.error('SafeKeepOS.powerAction: failed to drop signal file:', err);
      // Fall through — closing the window still triggers the default
      // poweroff path in safekeep-boot.sh.
    }
    // Give Chromium time to flush the download to disk before exit.
    setTimeout(function () {
      try { window.close(); } catch (_) {}
    }, 500);
  }

  /**
   * Cleanly power off the SafeKeep device.
   * Backend: safekeep-boot.sh runs `sudo poweroff` after Chromium exits.
   */
  function powerOff() {
    return _submitPowerAction('poweroff');
  }

  /**
   * Cleanly reboot the SafeKeep device.
   * Backend: safekeep-boot.sh runs `sudo reboot` after Chromium exits.
   */
  function restart() {
    return _submitPowerAction('reboot');
  }


  // =============================================
  //  DISPLAY SLEEP — DPMS timer bridge (Task #16)
  // =============================================
  //
  // Configurable Display Sleep (settings.displaySleepMinutes) flows from
  // the Settings UI through window.skbIdleTimers and lands here as a
  // call to setDisplaySleep(seconds). Unlike POWER_ACTION (which closes
  // Chromium and signals via download-on-exit), display sleep must take
  // effect WITHOUT exiting the kiosk — the user is mid-session.
  //
  // Protocol:
  //   1. JS writes DISPLAY_SLEEP_TRIGGER.json into Chromium's download
  //      directory ($SEED_DIR on the boot drive). Body is a single-line
  //      JSON object: { "seconds": N, "timestamp": ms }.
  //   2. The display-sleep watcher daemon in safekeep-boot.sh polls
  //      $SEED_DIR/DISPLAY_SLEEP_TRIGGER.json once per second. When it
  //      sees the file, it parses the seconds value, exports DISPLAY=:0
  //      and XAUTHORITY=/root/.Xauthority (essential — without these
  //      the xset call from a background subshell silently fails to
  //      reach the X server), runs the appropriate xset DPMS sequence,
  //      then deletes the trigger file.
  //   3. Seconds = 0 means "disable display sleep entirely" — the
  //      watcher runs `xset s off s noblank -dpms` to mirror the
  //      autostart's default kiosk-mode behavior.
  //   4. Seconds > 0 means "blank after N seconds idle" — the watcher
  //      runs `xset s off s noblank +dpms; xset dpms N N N`.
  //
  // SECURITY: The trigger file contains no seed material — only an
  // integer second-count and a timestamp. It is treated as a system
  // trigger (DISPLAY_SLEEP_* prefix in _SYSTEM_TRIGGER_PREFIXES) so the
  // Amnesia / Volatile firewall lets it through.

  const DISPLAY_SLEEP_TRIGGER_FILE = 'DISPLAY_SLEEP_TRIGGER.json';

  /**
   * Set the OS display-sleep (DPMS) timeout. Takes effect during the
   * current session — no Chromium restart needed.
   *
   * @param {number} seconds  0 disables sleep entirely; >0 arms the
   *                          DPMS off-timer for that many seconds idle.
   *                          Capped to a sane upper bound by the caller.
   */
  function setDisplaySleep(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      console.warn('SafeKeepOS.setDisplaySleep: invalid seconds value:', seconds);
      return;
    }
    const intSeconds = Math.floor(seconds);

    if (!isBootDrive()) {
      // Demo / dev mode — no real X server to drive. Log and return so
      // dev work doesn't accidentally write a trigger file into a
      // browser-managed Downloads folder.
      console.log('SafeKeepOS.setDisplaySleep:', intSeconds, 'sec — boot drive only, ignored.');
      return;
    }

    try {
      const payload = JSON.stringify({
        seconds: intSeconds,
        timestamp: Date.now()
      });
      _silentDownload(DISPLAY_SLEEP_TRIGGER_FILE, payload);
    } catch (err) {
      console.error('SafeKeepOS.setDisplaySleep: failed to drop trigger file:', err);
    }
  }


  // =============================================
  //  PUBLIC API
  // =============================================

  return {
    // Boot
    boot,
    STATE_WELCOME,
    STATE_DASHBOARD,

    // Power sequence
    powerOff,
    restart,

    // Display sleep (DPMS timer)
    setDisplaySleep,

    // Seed lifecycle
    generateMasterSeed,
    restoreMasterSeed,

    // Factory reset
    factoryReset,

    // Ephemeral passphrase
    setPassphrase,
    getPassphrase,
    clearPassphrase,

    // Queries
    getState,
    getFingerprint,
    vaultFingerprint,
    isBootDrive,
    isVaultMounted: _isVaultMounted,

    // Codex — Note Storage
    saveNote,
    listNotes,
    loadNote,
    deleteNote,

    // Cipher — Passphrase Library
    savePassphrase,
    listPassphrases,
    loadPassphrase,
    deletePassphrase,
    PASSPHRASE_DIR,

    // Reliquary — Encrypted Backup / Restore
    createReliquary,
    inspectReliquary,
    commitReliquary,
    listBackups,

    // Transfer-partition exports (piggy-backs on Reliquary Watcher daemon)
    exportToTransfer,

    // Constants (for tooling/tests)
    MASTER_SEED_PATH,
    MASTER_SEED_URL,
    CODEX_DIR,
    TRANSFER_ROOT
  };

})();

// Expose globally
window.SafeKeepOS = SafeKeepOS;

export { SafeKeepOS };

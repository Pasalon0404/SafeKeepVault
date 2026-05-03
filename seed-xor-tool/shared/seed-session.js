/**
 * SafeKeepBitcoin — Seed Session (RAM-only wiring between tools)
 *
 * Manages the "active seed" across tool navigation using sessionStorage.
 * sessionStorage is RAM-only — it vanishes when the browser closes and
 * never touches the disk. In our Chromium --incognito boot drive
 * environment, this is the perfect security boundary.
 *
 * Flow:
 *   1. User unlocks LUKS vault → startup script optionally writes
 *      /media/safekeep-vault/active-seed.json (default seed)
 *   2. First tool loads → SeedSession.init() checks sessionStorage,
 *      then falls back to fetching the vault file
 *   3. User generates/loads a seed in any tool → SeedSession.set()
 *      writes it to sessionStorage
 *   4. User navigates to another tool → SeedSession.init() finds it
 *      in sessionStorage instantly, no file picker needed
 *   5. Browser closes / "Power Off (Clear RAM)" → sessionStorage gone,
 *      zero trace on disk
 *
 * Data stored in sessionStorage (JSON):
 *   { type, mnemonic, fingerprint, label, passphrase,
 *     keyFormat, addressType, wordCount, default }
 *
 * Usage in any tool:
 *   import { SeedSession } from '../shared/seed-session.js';
 *
 *   // On page load
 *   const seed = await SeedSession.init();
 *   if (seed) {
 *     // Auto-load this seed into the tool's UI
 *   }
 *
 *   // When user generates or loads a new seed
 *   SeedSession.set({ mnemonic, fingerprint, label, ... });
 *
 *   // When user clears
 *   SeedSession.clear();
 */

const SeedSession = (() => {

  const STORAGE_KEY = 'safekeep_active_seed';
  const PASSPHRASE_KEY = 'safekeep_active_passphrase';

  // Path to vault-based default seed (only exists on boot drive after unlock)
  const VAULT_DEFAULT_PATH = '/media/safekeep-vault/active-seed.json';

  let _onChangeCallbacks = [];


  // ---- Get / Set / Clear the active seed ----

  /**
   * Store the active seed in sessionStorage (RAM only).
   * Call this whenever a seed is generated, loaded from file, or
   * received from another tool.
   */
  function set(seedData) {
    if (!seedData || !seedData.mnemonic) return;

    const payload = {
      type: seedData.type || 'seed',
      mnemonic: seedData.mnemonic,
      fingerprint: seedData.fingerprint || '',
      label: seedData.label || '',
      passphrase: seedData.passphrase || '',
      keyFormat: seedData.keyFormat || 'slip132',
      addressType: seedData.addressType || '84',
      wordCount: seedData.wordCount || seedData.mnemonic.trim().split(/\s+/).length,
      default: seedData.default || false
    };

    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('SeedSession: sessionStorage write failed', e);
    }

    _notifyChange(payload);
  }

  /**
   * Retrieve the active seed from sessionStorage.
   * Returns the seed object or null if none is active.
   */
  function get() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('SeedSession: sessionStorage read failed', e);
      return null;
    }
  }

  /**
   * Clear the active seed from sessionStorage.
   */
  function clear() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.warn('SeedSession: sessionStorage clear failed', e);
    }
    _notifyChange(null);
  }


  // ---- Passphrase (independent of seed) ----

  /**
   * Store the active passphrase separately.
   * Allows passphrase to be set/changed independently of the seed.
   */
  function setPassphrase(passphrase) {
    try {
      if (passphrase) {
        sessionStorage.setItem(PASSPHRASE_KEY, passphrase);
      } else {
        sessionStorage.removeItem(PASSPHRASE_KEY);
      }
    } catch (e) {
      console.warn('SeedSession: passphrase write failed', e);
    }
  }

  function getPassphrase() {
    try {
      return sessionStorage.getItem(PASSPHRASE_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function clearPassphrase() {
    try {
      sessionStorage.removeItem(PASSPHRASE_KEY);
    } catch (e) {
      // silent
    }
  }


  // ---- Init: check sessionStorage, then try vault fallback ----

  /**
   * Initialize the session. Call on page load.
   *
   * 1. Checks sessionStorage for an existing active seed
   * 2. If empty, tries to fetch the default seed from the vault
   *    (only works on the boot drive after LUKS unlock)
   * 3. Returns the seed object, or null if nothing is available
   *
   * This never prompts the user — it's completely silent.
   */
  async function init() {
    // Check sessionStorage first (fast path)
    const existing = get();
    if (existing) return existing;

    // Try vault fallback (boot drive only — will 404 on the website)
    try {
      const response = await fetch(VAULT_DEFAULT_PATH);
      if (response.ok) {
        const data = await response.json();
        if (data && data.mnemonic) {
          // Store in sessionStorage so subsequent tool loads are instant
          set(data);

          // Also store passphrase separately if present
          if (data.passphrase) {
            setPassphrase(data.passphrase);
          }

          return data;
        }
      }
    } catch (e) {
      // Expected to fail on the website — that's fine, silent fail
    }

    return null;
  }


  // ---- Change notification ----
  // Tools can subscribe to be notified when the active seed changes.
  // This handles the case where multiple tools are open in tabs.

  function onChange(callback) {
    _onChangeCallbacks.push(callback);
    return () => {
      _onChangeCallbacks = _onChangeCallbacks.filter(cb => cb !== callback);
    };
  }

  function _notifyChange(seedData) {
    _onChangeCallbacks.forEach(cb => {
      try { cb(seedData); } catch (e) {
        console.error('SeedSession onChange error:', e);
      }
    });
  }


  // ---- Listen for cross-tab sessionStorage changes ----
  // If the user has two tools open in different tabs, this keeps
  // them in sync when one tab updates the active seed.

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) {
        const newData = e.newValue ? JSON.parse(e.newValue) : null;
        _notifyChange(newData);
      }
    });
  }


  // ---- Public API ----
  return {
    init,
    set,
    get,
    clear,
    setPassphrase,
    getPassphrase,
    clearPassphrase,
    onChange
  };

})();

// Expose globally
window.SeedSession = SeedSession;

export { SeedSession };

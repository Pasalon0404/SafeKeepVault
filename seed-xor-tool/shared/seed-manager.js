/**
 * SafeKeepBitcoin — Seed Manager
 *
 * Manages seed and passphrase storage using browser-native file save/open dialogs.
 *
 * JSON file format (self-describing, used for wiring between tools):
 *   { "type": "seed", "mnemonic": "...", "length": 24,
 *     "keyFormat": "slip132", "addressType": "84",
 *     "label": "Main Wallet", "fingerprint": "A1B2C3D4" }
 *
 *   { "type": "passphrase", "passphrase": "...", "label": "Strong PP" }
 *
 *   { "type": "seed+passphrase", "mnemonic": "...", "passphrase": "...",
 *     "length": 24, "keyFormat": "slip132", "addressType": "84",
 *     "label": "Main Wallet", "fingerprint": "A1B2C3D4" }
 *
 * Legacy .txt format is still supported for loading (line 1 = words, line 2 = passphrase).
 * Filenames: "Label (FINGERPRINT).json" or "seed-FINGERPRINT.json"
 */

const SeedManager = (() => {

  let _onChangeCallbacks = [];

  // ---- Directory hints for file pickers ----
  // These provide starting directory suggestions. On the USB boot drive,
  // the vault will have /seeds/ and /passphrases/ subdirectories.
  // In the browser, startIn is a hint — the OS may override it.
  const SEED_DIR_HINT = 'documents';       // fallback for browser
  const PASSPHRASE_DIR_HINT = 'documents'; // fallback for browser

  // Custom directory handle (set by boot drive init or user choice)
  let _seedDirHandle = null;
  let _passphraseDirHandle = null;

  function setSeedDirectory(dirHandle) { _seedDirHandle = dirHandle; }
  function setPassphraseDirectory(dirHandle) { _passphraseDirHandle = dirHandle; }

  // ---- Fingerprint computation ----

  /**
   * Compute the master fingerprint from a mnemonic.
   * Requires window.BtcMath (bip39, HDKey) to be available.
   * Returns 8-char uppercase hex string (e.g. "3F8A21D7").
   */
  async function computeFingerprint(mnemonic) {
    const { bip39, wordlist, HDKey } = window.BtcMath;
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const master = HDKey.fromMasterSeed(seed);
    const fp = master.fingerprint;
    return fp.toString(16).toUpperCase().padStart(8, '0');
  }


  // ---- Save seed ----

  /**
   * Save a seed to a user-chosen location via Save As dialog.
   * @param {string} mnemonic - Space-separated BIP-39 words
   * @param {object} meta - Optional metadata { label, passphrase, keyFormat, addressType, source }
   * @returns {{ fingerprint: string }} or null if cancelled
   */
  async function saveSeed(mnemonic, meta = {}) {
    const words = mnemonic.trim().split(/\s+/);
    const fingerprint = await computeFingerprint(mnemonic);

    const label = (meta.label || '').trim();
    const suggestedName = label
      ? `${label} (${fingerprint}).json`
      : `seed-${fingerprint}.json`;

    const passphrase = (meta.passphrase || '').trim();
    const fileType = passphrase ? 'seed+passphrase' : 'seed';

    const payload = {
      type: fileType,
      mnemonic: words.join(' '),
      length: words.length,
      label: label,
      fingerprint: fingerprint,
      keyFormat: meta.keyFormat || 'slip132',
      addressType: meta.addressType || '84',
      source: meta.source || '',
      default: meta.default || false
    };

    if (passphrase) {
      payload.passphrase = passphrase;
    }

    // If this seed was derived from a parent (e.g. BIP-85), record provenance
    if (meta.parentFingerprint) {
      payload.parentFingerprint = meta.parentFingerprint;
    }

    const fileContent = JSON.stringify(payload, null, 2);

    try {
      const pickerOpts = {
        suggestedName: suggestedName,
        types: [{
          description: 'SafeKeep Seed',
          accept: { 'application/json': ['.json'] }
        }]
      };
      if (_seedDirHandle) {
        pickerOpts.startIn = _seedDirHandle;
      } else {
        pickerOpts.startIn = SEED_DIR_HINT;
      }
      const fileHandle = await window.showSaveFilePicker(pickerOpts);

      const writable = await fileHandle.createWritable();
      await writable.write(fileContent);
      await writable.close();

      _notifyChange();
      return { fingerprint };

    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
  }


  // ---- Save passphrase independently ----

  /**
   * Save a passphrase to its own file.
   * @param {string} passphrase
   * @param {object} meta - Optional { label }
   * @returns {boolean} true if saved, false if cancelled
   */
  async function savePassphrase(passphrase, meta = {}) {
    const label = (meta.label || '').trim();
    const suggestedName = label
      ? `${label} (passphrase).json`
      : `passphrase.json`;

    const payload = {
      type: 'passphrase',
      passphrase: passphrase,
      label: label
    };

    const fileContent = JSON.stringify(payload, null, 2);

    try {
      const pickerOpts = {
        suggestedName: suggestedName,
        types: [{
          description: 'SafeKeep Passphrase',
          accept: { 'application/json': ['.json'] }
        }]
      };
      if (_passphraseDirHandle) {
        pickerOpts.startIn = _passphraseDirHandle;
      } else {
        pickerOpts.startIn = PASSPHRASE_DIR_HINT;
      }
      const fileHandle = await window.showSaveFilePicker(pickerOpts);

      const writable = await fileHandle.createWritable();
      await writable.write(fileContent);
      await writable.close();

      _notifyChange();
      return true;

    } catch (e) {
      if (e.name === 'AbortError') return false;
      throw e;
    }
  }


  // ---- Load seed ----

  /**
   * Open a seed file via the system Open dialog.
   * Supports both .json (new) and .txt (legacy) formats.
   * @returns {{ type, mnemonic, fingerprint, wordCount, label, passphrase, keyFormat, addressType }} or null
   */
  async function loadSeed() {
    try {
      const openOpts = {
        types: [{
          description: 'SafeKeep Seed',
          accept: {
            'application/json': ['.json'],
            'text/plain': ['.txt']
          }
        }],
        multiple: false
      };
      if (_seedDirHandle) {
        openOpts.startIn = _seedDirHandle;
      } else {
        openOpts.startIn = SEED_DIR_HINT;
      }
      const [fileHandle] = await window.showOpenFilePicker(openOpts);

      const file = await fileHandle.getFile();
      const rawText = (await file.text()).trim();

      // Try JSON first
      if (rawText.startsWith('{')) {
        return _parseJsonSeed(rawText, file.name);
      }

      // Fall back to legacy .txt format
      return await _parseLegacyTxt(rawText, file.name);

    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
  }


  // ---- Load passphrase independently ----

  /**
   * Open a passphrase file via the system Open dialog.
   * @returns {{ passphrase, label }} or null
   */
  async function loadPassphrase() {
    try {
      const openOpts = {
        types: [{
          description: 'SafeKeep Passphrase',
          accept: {
            'application/json': ['.json'],
            'text/plain': ['.txt']
          }
        }],
        multiple: false
      };
      if (_passphraseDirHandle) {
        openOpts.startIn = _passphraseDirHandle;
      } else {
        openOpts.startIn = PASSPHRASE_DIR_HINT;
      }
      const [fileHandle] = await window.showOpenFilePicker(openOpts);

      const file = await fileHandle.getFile();
      const rawText = (await file.text()).trim();

      if (rawText.startsWith('{')) {
        const data = JSON.parse(rawText);
        // Accept passphrase from any type that has one
        if (data.passphrase) {
          return { passphrase: data.passphrase, label: data.label || '' };
        }
        throw new Error('File does not contain a passphrase');
      }

      // Legacy .txt — line 2 is passphrase
      const lines = rawText.split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length > 1 && lines[1]) {
        return { passphrase: lines[1], label: '' };
      }
      // If single line and it doesn't look like a mnemonic, treat as passphrase
      if (lines.length === 1) {
        const words = lines[0].split(/\s+/);
        if (words.length !== 12 && words.length !== 24) {
          return { passphrase: lines[0], label: '' };
        }
      }
      throw new Error('No passphrase found in file');

    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
  }


  // ---- Internal parsers ----

  function _parseJsonSeed(rawText, fileName) {
    const data = JSON.parse(rawText);

    if (data.type === 'passphrase') {
      throw new Error('This file contains only a passphrase, not a seed. Use "Load Passphrase" instead.');
    }

    if (!data.mnemonic) {
      throw new Error('JSON file does not contain a mnemonic');
    }

    const words = data.mnemonic.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      throw new Error(`Expected 12 or 24 words, got ${words.length}`);
    }

    return {
      type: data.type || 'seed',
      mnemonic: words.join(' '),
      fingerprint: data.fingerprint || null,
      wordCount: words.length,
      label: data.label || '',
      passphrase: data.passphrase || '',
      keyFormat: data.keyFormat || 'slip132',
      addressType: data.addressType || '84',
      default: data.default || false
    };
  }

  async function _parseLegacyTxt(rawText, fileName) {
    const lines = rawText.split('\n').map(l => l.trim()).filter(l => l);
    const mnemonic = lines[0];
    const passphrase = lines.length > 1 ? lines[1] : '';

    const words = mnemonic.split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      throw new Error(`Expected 12 or 24 words, got ${words.length}`);
    }

    const fingerprint = await computeFingerprint(mnemonic);

    // Extract friendly label from filename pattern "Label (FINGERPRINT).txt"
    let label = '';
    const labelMatch = fileName.match(/^(.+?)\s*\([0-9A-Fa-f]{8}\)\.(txt|json)$/);
    if (labelMatch) {
      label = labelMatch[1].trim();
    }

    return {
      type: passphrase ? 'seed+passphrase' : 'seed',
      mnemonic,
      fingerprint,
      wordCount: words.length,
      label,
      passphrase,
      keyFormat: 'slip132',
      addressType: '84'
    };
  }


  // ---- Quick save via Blob download (fallback, no dialog permission needed) ----

  async function downloadSeed(mnemonic, meta = {}) {
    const words = mnemonic.trim().split(/\s+/);
    const fingerprint = await computeFingerprint(mnemonic);

    const label = (meta.label || '').trim();
    const fileName = label
      ? `${label} (${fingerprint}).json`
      : `seed-${fingerprint}.json`;

    const passphrase = (meta.passphrase || '').trim();
    const fileType = passphrase ? 'seed+passphrase' : 'seed';

    const payload = {
      type: fileType,
      mnemonic: words.join(' '),
      length: words.length,
      label: label,
      fingerprint: fingerprint,
      keyFormat: meta.keyFormat || 'slip132',
      addressType: meta.addressType || '84',
      source: meta.source || '',
      default: meta.default || false
    };

    if (passphrase) {
      payload.passphrase = passphrase;
    }

    const fileContent = JSON.stringify(payload, null, 2);
    const blob = new Blob([fileContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);

    _notifyChange();
    return { fingerprint };
  }


  // ---- Validation ----

  function validateMnemonic(mnemonic) {
    try {
      const { bip39, wordlist } = window.BtcMath;
      const valid = bip39.validateMnemonic(mnemonic, wordlist);
      if (!valid) return { valid: false, error: 'Invalid checksum or unknown words' };
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }


  // ---- Feature detection ----

  function hasFileSystemAccess() {
    return typeof window.showSaveFilePicker === 'function';
  }


  // ---- Change notification ----

  function onChange(callback) {
    _onChangeCallbacks.push(callback);
    return () => {
      _onChangeCallbacks = _onChangeCallbacks.filter(cb => cb !== callback);
    };
  }

  function _notifyChange() {
    _onChangeCallbacks.forEach(cb => {
      try { cb(); } catch (e) { console.error('SeedManager onChange error:', e); }
    });
  }


  // ---- Public API ----
  return {
    computeFingerprint,
    saveSeed,
    savePassphrase,
    loadSeed,
    loadPassphrase,
    downloadSeed,
    validateMnemonic,
    hasFileSystemAccess,
    onChange,
    setSeedDirectory,
    setPassphraseDirectory
  };
})();

// Expose globally
window.SeedManager = SeedManager;

export { SeedManager };

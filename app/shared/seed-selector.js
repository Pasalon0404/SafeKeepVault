/**
 * SafeKeepBitcoin — Seed Selector Component
 *
 * A drop-in UI component that provides unified seed management
 * across all tools. Renders into a container element and provides
 * callbacks when the active seed changes.
 *
 * Uses showSaveFilePicker / showOpenFilePicker (via SeedManager)
 * rather than a directory-based approach, for broad macOS/Windows/Linux
 * compatibility.
 *
 * Usage:
 *   import { SeedSelector } from '../shared/seed-selector.js';
 *
 *   const selector = new SeedSelector({
 *     container: document.getElementById('seed-selector'),
 *     onSeedLoaded: (seed) => { ... },
 *     onSeedCleared: () => { ... },
 *     showSaveButton: true,
 *     getPassphrase: () => document.getElementById('passphrase-input').value,
 *     getConfig: () => ({ keyFormat: '...', addressType: '...' })
 *   });
 */

class SeedSelector {
  constructor(options = {}) {
    this.container = options.container;
    this.onSeedLoaded = options.onSeedLoaded || (() => {});
    this.onSeedCleared = options.onSeedCleared || (() => {});
    this.showSaveButton = options.showSaveButton !== false;
    this.getPassphrase = options.getPassphrase || (() => '');
    this.getConfig = options.getConfig || (() => ({}));

    this._mnemonic = null;
    this._fingerprint = null;
    this._label = null;
    this._meta = null;

    if (this.container) {
      this._render();
    }
  }

  // ---- Public API ----

  async setActiveSeed(mnemonic, fingerprint = null, meta = {}, { silent = false } = {}) {
    this._mnemonic = mnemonic;
    if (!fingerprint && window.SeedManager) {
      fingerprint = await window.SeedManager.computeFingerprint(mnemonic);
    }
    this._fingerprint = fingerprint;
    this._label = meta.label || '';
    this._meta = meta;
    this._renderLoaded();
    if (!silent) {
      this.onSeedLoaded({ mnemonic, fingerprint, ...meta });
    }
  }

  getActiveSeed() {
    if (!this._mnemonic) return null;
    return {
      mnemonic: this._mnemonic,
      fingerprint: this._fingerprint,
      label: this._label,
      ...(this._meta || {})
    };
  }

  clearSeed() {
    this._mnemonic = null;
    this._fingerprint = null;
    this._label = null;
    this._meta = null;
    this._renderEmpty();
    this.onSeedCleared();
  }

  async saveCurrent(label = '') {
    if (!this._mnemonic) return;
    if (!window.SeedManager) return;

    const config = this.getConfig();
    const result = await window.SeedManager.saveSeed(this._mnemonic, {
      label: label || this._label,
      passphrase: this.getPassphrase(),
      keyFormat: config.keyFormat || 'slip132',
      addressType: config.addressType || '84',
      source: 'entropy-tool'
    });

    if (result) {
      this._fingerprint = result.fingerprint;
      if (label) this._label = label;
      this._renderLoaded();
    }
  }


  // ---- Internal rendering ----

  _render() {
    this.container.innerHTML = '';
    this.container.className = 'skb-seed-selector';
    this._renderEmpty();
  }

  _renderEmpty() {
    this.container.innerHTML = `
      <div class="skb-seed-selector-left">
        <div class="skb-seed-icon-box">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div class="skb-seed-info">
          <div class="skb-seed-label">Active Seed</div>
          <div class="skb-seed-empty-text">No seed loaded</div>
        </div>
      </div>
      <div class="skb-seed-selector-actions">
        <button class="skb-btn-secondary skb-seed-load-btn">Load from File</button>
      </div>
    `;

    this.container.querySelector('.skb-seed-load-btn')
      .addEventListener('click', () => this._loadFromFile());
  }

  _renderLoaded() {
    const words = this._mnemonic ? this._mnemonic.trim().split(/\s+/).length : '?';
    const hasLabel = this._label && this._label.trim().length > 0;

    this.container.innerHTML = `
      <div class="skb-seed-selector-left">
        <div class="skb-seed-icon-box skb-seed-icon-box--active">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 5-5 5 5 0 0 1 5 5v4"/>
          </svg>
        </div>
        <div class="skb-seed-info">
          <div class="skb-seed-label">Active Seed</div>
          ${hasLabel
            ? `<div class="skb-seed-friendly-name">${this._label}</div>
               <div class="skb-seed-meta-text">${this._fingerprint || '--------'} · ${words} words</div>`
            : `<div class="skb-seed-fingerprint">${this._fingerprint || '--------'}</div>
               <div class="skb-seed-meta-text">${words} words · unsaved</div>`
          }
        </div>
      </div>
      <div class="skb-seed-selector-actions">
        ${this.showSaveButton && this._mnemonic ? `<button class="skb-btn-sm skb-seed-save-btn">${hasLabel ? 'Save As' : 'Save'}</button>` : ''}
        <button class="skb-btn-secondary skb-seed-load-btn">Load</button>
        <button class="skb-btn-sm skb-seed-clear-btn">Clear</button>
      </div>
    `;

    this.container.querySelector('.skb-seed-load-btn')
      .addEventListener('click', () => this._loadFromFile());

    const clearBtn = this.container.querySelector('.skb-seed-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', () => this.clearSeed());

    const saveBtn = this.container.querySelector('.skb-seed-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', () => this._showSaveModal());
  }


  // ---- Load seed from file ----

  async _loadFromFile() {
    if (!window.SeedManager) {
      console.error('SeedManager not available');
      return;
    }
    try {
      const result = await window.SeedManager.loadSeed();
      if (result) {
        await this.setActiveSeed(result.mnemonic, result.fingerprint, {
          wordCount: result.wordCount,
          label: result.label || '',
          passphrase: result.passphrase || '',
          keyFormat: result.keyFormat || 'slip132',
          addressType: result.addressType || '84'
        });
      }
    } catch (e) {
      console.error('Failed to load seed:', e);
      this._showError(`Could not load seed: ${e.message}`);
    }
  }


  // ---- Save modal ----
  // Uses a custom inline modal instead of prompt() so that the
  // "Save to Disk" button click is a fresh user gesture — required
  // by browsers for showSaveFilePicker to open reliably.

  _showSaveModal() {
    if (!this._mnemonic || !window.SeedManager) return;

    // Capture passphrase and config now while inputs are accessible
    const capturedPassphrase = this.getPassphrase();
    const capturedConfig = this.getConfig();

    // Remove any existing modal
    const existing = document.getElementById('skb-save-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'skb-save-modal';
    overlay.className = 'skb-save-modal-overlay';
    overlay.innerHTML = `
      <div class="skb-save-modal">
        <div class="skb-save-modal-title">Save Seed</div>
        <label class="skb-save-modal-label">
          Give this seed a friendly name
        </label>
        <input type="text" class="skb-save-modal-input" id="skb-save-name-input"
               placeholder='e.g. Main Wallet'
               value="${(this._label || '').replace(/"/g, '&quot;')}"
               autocomplete="off" spellcheck="false">
        <div class="skb-save-modal-hint">
          The fingerprint (${this._fingerprint || '--------'}) will be appended automatically.
        </div>
        <label class="skb-save-modal-default" style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 0.85rem; color: var(--skb-text-muted, #999); cursor: pointer;">
          <input type="checkbox" id="skb-save-default-checkbox">
          Set as default seed
        </label>
        <div class="skb-save-modal-actions">
          <button class="skb-btn-secondary skb-save-modal-cancel">Cancel</button>
          <button class="skb-btn-primary skb-save-modal-confirm">Save to Disk</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector('#skb-save-name-input');
    const confirmBtn = overlay.querySelector('.skb-save-modal-confirm');
    const cancelBtn = overlay.querySelector('.skb-save-modal-cancel');

    // Focus the input and select existing text
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);

    // Allow Enter key to trigger save
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmBtn.click();
      }
      if (e.key === 'Escape') {
        overlay.remove();
      }
    });

    // Cancel
    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // SAVE — this click event IS the user gesture that showSaveFilePicker needs
    const defaultCheckbox = overlay.querySelector('#skb-save-default-checkbox');
    confirmBtn.addEventListener('click', async () => {
      const label = nameInput.value.trim();
      const isDefault = defaultCheckbox.checked;
      this._label = label;

      // Close modal immediately so the OS save dialog isn't behind it
      overlay.remove();

      try {
        if (window.SeedManager.hasFileSystemAccess()) {
          const result = await window.SeedManager.saveSeed(this._mnemonic, {
            label: label,
            passphrase: capturedPassphrase,
            keyFormat: capturedConfig.keyFormat || 'slip132',
            addressType: capturedConfig.addressType || '84',
            source: 'entropy-tool',
            default: isDefault
          });

          if (result) {
            this._fingerprint = result.fingerprint;
            this._renderLoaded();
          }
        } else {
          await window.SeedManager.downloadSeed(this._mnemonic, {
            label: label,
            passphrase: capturedPassphrase,
            keyFormat: capturedConfig.keyFormat || 'slip132',
            addressType: capturedConfig.addressType || '84',
            source: 'entropy-tool',
            default: isDefault
          });
          this._renderLoaded();
        }
      } catch (e) {
        console.error('Save failed:', e);
        this._showError(`Save failed: ${e.message}`);
      }
    });
  }


  // ---- Error display ----

  _showError(message) {
    const existing = document.querySelector('.skb-seed-error-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'skb-seed-error-toast';
    toast.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: var(--skb-danger); color: white; padding: 10px 20px;
      border-radius: var(--skb-radius-md); font-size: 0.85rem;
      z-index: 10000; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }
}

// CSS (injected once)
(() => {
  if (document.getElementById('skb-seed-selector-styles')) return;
  const style = document.createElement('style');
  style.id = 'skb-seed-selector-styles';
  style.textContent = `
    .skb-seed-selector {
      background: var(--skb-bg-secondary);
      border: 1px solid var(--skb-border);
      border-radius: var(--skb-radius-lg);
      padding: 14px 18px;
      margin-bottom: 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      box-shadow: var(--skb-shadow);
      transition: background var(--skb-transition), border var(--skb-transition);
    }
    .skb-seed-selector-left {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
      min-width: 0;
    }
    .skb-seed-icon-box {
      width: 40px; height: 40px;
      background: var(--skb-bg-tertiary);
      border: 1px solid var(--skb-border);
      border-radius: var(--skb-radius-md);
      display: flex; align-items: center; justify-content: center;
      color: var(--skb-text-dim);
      flex-shrink: 0;
      transition: all var(--skb-transition);
    }
    .skb-seed-icon-box--active {
      background: var(--skb-primary-muted);
      border-color: rgba(247, 147, 26, 0.2);
      color: var(--skb-primary);
    }
    .skb-seed-info { min-width: 0; }
    .skb-seed-label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--skb-text-muted);
      font-weight: 600;
    }
    .skb-seed-friendly-name {
      font-size: 0.95rem;
      color: var(--skb-text);
      font-weight: 600;
    }
    .skb-seed-fingerprint {
      font-family: var(--skb-mono);
      font-size: 0.95rem;
      color: var(--skb-primary);
      font-weight: 600;
    }
    .skb-seed-meta-text {
      font-size: 0.78rem;
      color: var(--skb-text-dim);
    }
    .skb-seed-empty-text {
      color: var(--skb-text-dim);
      font-size: 0.88rem;
    }
    .skb-seed-selector-actions {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }

    /* Save modal */
    .skb-save-modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      backdrop-filter: blur(2px);
    }
    .skb-save-modal {
      background: var(--skb-bg-secondary, #1a1a2e);
      border: 1px solid var(--skb-border, #333);
      border-radius: var(--skb-radius-lg, 12px);
      padding: 24px;
      width: 90%;
      max-width: 420px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    .skb-save-modal-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--skb-text, #eee);
      margin-bottom: 16px;
    }
    .skb-save-modal-label {
      display: block;
      font-size: 0.82rem;
      color: var(--skb-text-muted, #999);
      margin-bottom: 8px;
      font-weight: 600;
    }
    .skb-save-modal-input {
      width: 100%;
      padding: 10px 12px;
      font-size: 0.95rem;
      border: 1px solid var(--skb-border, #333);
      border-radius: var(--skb-radius-md, 8px);
      background: var(--skb-bg-tertiary, #0f0f23);
      color: var(--skb-text, #eee);
      outline: none;
      box-sizing: border-box;
      transition: border-color 0.2s;
    }
    .skb-save-modal-input:focus {
      border-color: var(--skb-primary, #f7931a);
    }
    .skb-save-modal-hint {
      font-size: 0.78rem;
      color: var(--skb-text-dim, #666);
      margin-top: 8px;
      margin-bottom: 20px;
    }
    .skb-save-modal-actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }
    .skb-save-modal-actions .skb-btn-primary,
    .skb-save-modal-actions .skb-btn-secondary {
      width: auto;
      padding: 10px 20px;
      font-size: 0.88rem;
    }

    @media (max-width: 640px) {
      .skb-seed-selector { flex-direction: column; align-items: stretch; }
      .skb-seed-selector-actions { justify-content: flex-end; }
    }
  `;
  document.head.appendChild(style);
})();


window.SeedSelector = SeedSelector;
export { SeedSelector };

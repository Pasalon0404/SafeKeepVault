/**
 * lifehash-icons.js — LifeHash icons beside master fingerprints
 *
 * A LifeHash (https://lifehash.info, version2) is a deterministic picture of a
 * hash, so two wallets can be told apart at a glance. Following Sparrow
 * Wallet's convention, the icon is the LifeHash of the RAW 4 fingerprint
 * bytes (not the hex string), so SafeKeep shows the same picture Sparrow
 * shows for the same keystore.
 *
 * Usage: mark the element that displays a fingerprint with
 *   data-lifehash="<size in px>"            icon inserted before the element
 *   data-lifehash-place="parent-right"      icon floated right as the parent's first child
 * The icon is a sibling, never a child, because the app rewrites these
 * elements' textContent. A MutationObserver redraws it whenever the text
 * changes and hides it when the text holds no 8-hex-digit fingerprint.
 *
 * Rendering uses the canonical `lifehash` package (MIT, Andreas Gassmann; a
 * port of Blockchain Commons' BSD-2-Clause-Patent C++ reference).
 * Inspired by EntropyLab's fingerprint LifeHashes.
 */

import { LifeHash } from 'lifehash';

/** First standalone 8-hex-digit token in `text`, lower-cased, or null. */
export function fingerprintFromText(text) {
    const m = String(text || '').match(/(?:^|[^0-9a-f])([0-9a-f]{8})(?![0-9a-f])/i);
    return m ? m[1].toLowerCase() : null;
}

/** 32×32 RGB LifeHash of the raw fingerprint bytes: { width, height, colors }. */
export function lifeHashImage(fingerprintHex) {
    const hex = String(fingerprintHex).toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(hex)) throw new Error('fingerprint must be 8 hex digits');
    const bytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
    return LifeHash.makeFrom(bytes);
}

const _cache = new Map();

/** Draw the LifeHash into `canvas` (sized to the image; CSS scales it). */
export function drawLifeHash(canvas, fingerprintHex) {
    let img = _cache.get(fingerprintHex);
    if (!img) { img = lifeHashImage(fingerprintHex); _cache.set(fingerprintHex, img); }
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    const data = ctx.createImageData(img.width, img.height);
    for (let p = 0, q = 0; p < img.width * img.height; p++, q += 3) {
        data.data[p * 4] = img.colors[q];
        data.data[p * 4 + 1] = img.colors[q + 1];
        data.data[p * 4 + 2] = img.colors[q + 2];
        data.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
}

/** Attach a live LifeHash icon to a fingerprint element. Returns the canvas. */
export function attachLifeHash(el) {
    if (el._lifehashCanvas) return el._lifehashCanvas;
    const size = parseInt(el.dataset.lifehash, 10) || 32;
    const canvas = document.createElement('canvas');
    canvas.className = 'skb-lifehash';
    canvas.setAttribute('role', 'img');
    canvas.style.cssText = `width:${size}px;height:${size}px;image-rendering:pixelated;flex:0 0 auto;vertical-align:middle;`;
    if (el.dataset.lifehashPlace === 'parent-right') {
        canvas.style.float = 'right';
        canvas.style.marginLeft = '0.5rem';
        el.parentNode.insertBefore(canvas, el.parentNode.firstChild);
    } else {
        el.parentNode.insertBefore(canvas, el);
    }
    el._lifehashCanvas = canvas;

    let shown; // undefined, so the first update always runs (and hides an empty icon)
    const update = () => {
        const fp = fingerprintFromText(el.textContent);
        if (fp === shown) return;
        shown = fp;
        if (!fp) { canvas.hidden = true; canvas.removeAttribute('aria-label'); canvas.title = ''; return; }
        try {
            drawLifeHash(canvas, fp);
            const label = `LifeHash of fingerprint ${fp.toUpperCase()}. Sparrow Wallet shows the same picture for this wallet.`;
            canvas.setAttribute('aria-label', label);
            canvas.title = label;
            canvas.hidden = false;
        } catch (e) {
            console.warn('[LifeHash] render failed:', e.message);
            canvas.hidden = true;
        }
    };
    new MutationObserver(update).observe(el, { childList: true, characterData: true, subtree: true });
    update();
    return canvas;
}

export function attachAllLifeHashes(root = document) {
    root.querySelectorAll('[data-lifehash]').forEach(attachLifeHash);
}

if (typeof window !== 'undefined') {
    window.SKLifeHash = { fingerprintFromText, lifeHashImage, drawLifeHash, attachLifeHash, attachAllLifeHashes };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => attachAllLifeHashes());
    else attachAllLifeHashes();
}

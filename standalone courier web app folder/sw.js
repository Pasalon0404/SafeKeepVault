/**
 * SafeKeepVault Courier — Service Worker
 * Cache strategy: cache-first for the app shell, network-first for everything else.
 * Bump CACHE_NAME whenever you deploy changes to the app shell files.
 */

'use strict';

const CACHE_NAME = 'skv-courier-v1';

/** Core app shell — these files are pre-cached on install. */
const APP_SHELL = [
  './courier-tool.html',
  './style.css',
  './newfavicon.png',
  './manifest.json',
  './vendor/qrcode.min.js',
  './vendor/html5-qrcode.min.js',
];

// ─── INSTALL ─────────────────────────────────────────────────────────────────
// Pre-cache the app shell so the PWA loads instantly and offline.
self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()) // activate immediately without waiting for old SW to die
  );
});

// ─── ACTIVATE ────────────────────────────────────────────────────────────────
// Remove any stale caches left by previous versions of this service worker.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim()) // take control of all open tabs immediately
  );
});

// ─── FETCH ───────────────────────────────────────────────────────────────────
// Cache-first for GET requests; graceful offline fallback for navigation.
self.addEventListener('fetch', event => {
  // Only intercept GET requests; let everything else pass through untouched.
  if (event.request.method !== 'GET') return;

  // Ignore non-http(s) requests (e.g. chrome-extension://).
  const url = new URL(event.request.url);
  if (!url.protocol.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      // ── Cache hit: serve immediately ──────────────────────────────────────
      if (cached) return cached;

      // ── Cache miss: fetch from network ───────────────────────────────────
      return fetch(event.request)
        .then(response => {
          // Only cache successful, same-origin responses.
          if (
            !response ||
            response.status !== 200 ||
            response.type !== 'basic'
          ) {
            return response;
          }

          // Clone: one copy for the cache, one to hand to the browser.
          const responseToCache = response.clone();
          caches
            .open(CACHE_NAME)
            .then(cache => cache.put(event.request, responseToCache));

          return response;
        })
        .catch(() => {
          // ── Offline fallback ─────────────────────────────────────────────
          // If it's a page navigation, serve the cached app shell.
          if (event.request.mode === 'navigate') {
            return caches.match('./courier-tool.html');
          }
          // For sub-resources (images, scripts), fail silently.
        });
    })
  );
});

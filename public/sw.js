// public/sw.js
// ── Fixi.ge Service Worker ───────────────────────────────
// Handles:
//   1. push  — shows a notification
//   2. notificationclick — opens the right page on tap
//   3. Basic offline cache (optional, non-blocking)

const CACHE_NAME = 'fixi-v2';
const OFFLINE_ASSETS = ['/', '/assets/icon.png'];

// ── Install: pre-cache key assets ─────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(OFFLINE_ASSETS).catch(() => {})  // non-fatal
    )
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ─────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Push: show notification ────────────────────────────────────
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() || {}; } catch (_) {}

  const title   = data.title  || 'Fixi.ge';
  const body    = data.body   || '';
  // ✅ Always use the brand logo so notifications carry our identity
  const icon    = data.icon   || '/assets/icon.png';
  const badge   = data.badge  || '/assets/icon.png';
  const tag     = data.tag    || 'default';
  const url     = data.url    || '/';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag,
      data: { url },
      vibrate: [200, 100, 200],
      requireInteraction: false,
    })
  );
});

// ── Notification click: open / focus the right page ───────────
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || '/';

  e.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        // If the app is already open, focus it and navigate
        for (const client of clients) {
          if (client.url.includes(self.location.origin)) {
            client.focus();
            client.postMessage({ type: 'PUSH_NAVIGATE', url: targetUrl });
            return;
          }
        }
        // Otherwise open a new window
        return self.clients.openWindow(targetUrl);
      })
  );
});

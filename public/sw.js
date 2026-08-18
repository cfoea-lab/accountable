/* Accountable service worker — offline shell + sensible caching.
   Static app shell: stale-while-revalidate (updates flow through on next load).
   API calls: network-first with cached fallback, so the dashboard still shows
   the last-known data when offline. Photos: cache-first (they're immutable). */
'use strict';
const VERSION = 'accountable-v4';
const SHELL = ['/', '/app.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Push notifications (nudges)
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(data.title || 'Accountable', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return clients.openWindow((e.notification.data && e.notification.data.url) || '/');
    })
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // writes always go to the network

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Photos: cache-first (filenames are unique and never change)
  if (url.pathname.startsWith('/uploads/')) {
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // API: network-first, fall back to last cached response when offline
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req);
          return hit || new Response(JSON.stringify({ error: 'Offline' }), {
            status: 503, headers: { 'Content-Type': 'application/json' },
          });
        })
    );
    return;
  }

  // App shell & static: stale-while-revalidate
  e.respondWith(
    caches.open(VERSION).then(async (c) => {
      const cached = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
      const refresh = fetch(req)
        .then((res) => { if (res.ok) c.put(req, res.clone()); return res; })
        .catch(() => null);
      return cached || refresh.then((res) => res || c.match('/'));
    })
  );
});

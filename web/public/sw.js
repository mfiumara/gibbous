// Gibbous service worker: push notifications only (no offline cache; Gibbous needs the live server anyway).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let n = { title: 'Gibbous', body: '' };
  try { n = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(n.title, { body: n.body, tag: n.tag, data: { url: n.url || '/' }, icon: '/icon-192.png', badge: '/favicon-64.png' }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = all[0];
    if (c) { await c.focus(); c.postMessage({ url }); return; }
    await self.clients.openWindow(url);
  })());
});

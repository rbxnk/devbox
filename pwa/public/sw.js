// Installable, and the place push notifications arrive. No offline cache:
// the app is useless without the box, and a stale shell would only hide updates.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let note = { title: 'herdr', body: '', url: '/', tag: 'herdr' };
  try { note = { ...note, ...e.data.json() }; } catch {}
  // One notification per terminal: a newer one replaces the older.
  e.waitUntil(self.registration.showNotification(note.title, { body: note.body, tag: note.tag, data: { url: note.url }, icon: '/icon.svg' }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url ?? '/', self.location.origin).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // The app is already open: take it to that terminal instead of opening a second copy.
    if (open[0]) { await open[0].focus(); open[0].postMessage({ go: url }); } else await self.clients.openWindow(url);
  })());
});

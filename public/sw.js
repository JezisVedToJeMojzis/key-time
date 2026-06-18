// Service worker: receives push events and shows the "It's key time!" notification.
const APP_URL = './?keytime=1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: "It's key time! 🔑", body: 'Open to start the next timer.' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* keep defaults */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon.svg',
      badge: './icons/icon.svg',
      tag: 'key-time',
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: { url: APP_URL },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || APP_URL;

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clients) {
        if ('focus' in client) {
          await client.focus();
          // Navigate the existing tab to where this notification points
          // (key-time banner, friend request, invite, …).
          if ('navigate' in client) {
            try { await client.navigate(url); } catch { /* cross-context */ }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});

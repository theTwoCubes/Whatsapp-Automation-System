// Runs outside the page so it can receive push events after the tab is
// closed. Per the client's spec, clicking the notification just dismisses it,
// it does not try to focus the console.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* opaque payload */ }
  const title = data.title || 'A lead needs a person';
  const options = {
    body: data.body || '',
    tag: data.tag || 'handoff',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    renotify: true,
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
});

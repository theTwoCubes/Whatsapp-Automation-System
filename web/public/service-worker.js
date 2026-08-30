// Runs outside the page so it can receive push events after the tab is
// closed. Per the client's spec, clicking the notification just dismisses it,
// it does not try to focus the console.

const VERSION = 'sw-2026-08-30-2';

self.addEventListener('install', (event) => {
  console.log('[SW]', VERSION, 'installing');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW]', VERSION, 'activated');
  event.waitUntil(self.clients.claim());
});

// Handle SKIP_WAITING message for update flow (§2.5)
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
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
    // Store conversationId so a future deep-link can use it (§2.6)
    data: { conversationId: data.conversationId || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
});

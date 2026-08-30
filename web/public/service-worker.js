// Runs outside the page so it can receive push events after the tab is
// closed. Per the client's spec, clicking the notification just dismisses it,
// it does not try to focus the console.

const VERSION = 'sw-2026-08-30-3';

// Which chat the console/app is currently viewing. Kept in memory so we can
// suppress duplicate pings for a chat the agent is already reading. Reset
// whenever the SW is terminated by the browser, which is fine — a dormant SW
// means the tab was closed, so notifications should fire again.
let viewingConversationId = null;

self.addEventListener('install', (event) => {
  console.log('[SW]', VERSION, 'installing');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW]', VERSION, 'activated');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (msg.type === 'VIEWING_CONVERSATION') {
    // id is either a number (currently open) or null (not on any chat)
    viewingConversationId = msg.id != null ? String(msg.id) : null;
  }
});

// True when at least one window client is focused. If nothing is focused,
// the user has clearly moved away from the tab, so the notification should
// fire even if viewingConversationId still points at that chat.
async function anyClientFocused() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  return clients.some((c) => c.focused);
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { /* opaque payload */ }

    // Suppression: if the agent is actively looking at this exact chat on
    // this device right now, don't nag them with an OS notification.
    const cid = data.conversationId != null ? String(data.conversationId) : null;
    if (cid && cid === viewingConversationId && await anyClientFocused()) {
      return;
    }

    const title = data.title || 'A lead needs a person';
    const options = {
      body: data.body || '',
      tag: data.tag || 'handoff',
      icon: '/Icon192.png',
      badge: '/Icon192.png',
      renotify: true,
      requireInteraction: false,
      data: { conversationId: data.conversationId || null },
    };
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
});

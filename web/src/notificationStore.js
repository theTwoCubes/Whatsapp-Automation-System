// One shared source for the in-app notification inbox. Both bell instances
// (mobile top bar and desktop sidebar) subscribe here, so there is a single
// 30s poll and a single fetch instead of one per bell drifting out of sync.

import { api } from './api.js';

let state = { items: [], unread: 0, loading: false };
const listeners = new Set();
let interval = null;

function emit() {
  for (const l of listeners) l(state);
}

export async function refresh() {
  state = { ...state, loading: true };
  emit();
  try {
    const { notifications, unread } = await api.notifications();
    state = { items: notifications || [], unread: unread || 0, loading: false };
  } catch {
    state = { ...state, loading: false };
  }
  emit();
}

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  // First subscriber starts the shared poll and does an immediate fetch.
  if (listeners.size === 1) {
    refresh();
    interval = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 30000);
    document.addEventListener('visibilitychange', onVisible);
  } else {
    listener(state);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(interval);
      interval = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

function onVisible() {
  if (document.visibilityState === 'visible') refresh();
}

export async function markRead(id) {
  const was = state.items.find((n) => n.id === id);
  state = {
    ...state,
    items: state.items.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)),
    // Only decrement if it was actually unread - otherwise a double-tap, or
    // another tab/poll marking it read first, undercounts the badge until
    // the next poll reconciles it.
    unread: was && !was.read_at ? Math.max(0, state.unread - 1) : state.unread,
  };
  emit();
  try { await api.markNotificationRead(id); } catch { /* will reconcile on next poll */ }
}

export async function markAll() {
  const now = new Date().toISOString();
  state = {
    ...state,
    items: state.items.map((n) => (n.read_at ? n : { ...n, read_at: now })),
    unread: 0,
  };
  emit();
  try { await api.markAllNotificationsRead(); } catch { /* will reconcile on next poll */ }
}

export async function deleteOne(id) {
  const was = state.items.find((n) => n.id === id);
  state = {
    ...state,
    items: state.items.filter((n) => n.id !== id),
    unread: was && !was.read_at ? Math.max(0, state.unread - 1) : state.unread,
  };
  emit();
  try { await api.deleteNotification(id); } catch { /* reconcile on next poll */ }
}

export async function deleteAll() {
  state = { ...state, items: [], unread: 0 };
  emit();
  try { await api.deleteAllNotifications(); } catch { /* reconcile on next poll */ }
}

export async function toggleSave(id) {
  state = {
    ...state,
    items: state.items.map((n) =>
      n.id === id ? { ...n, saved_at: n.saved_at ? null : new Date().toISOString() } : n,
    ),
  };
  emit();
  try { await api.toggleSaveNotification(id); } catch { /* reconcile on next poll */ }
}

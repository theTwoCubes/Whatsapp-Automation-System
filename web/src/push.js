// Browser side of the push notification setup. Registers the service worker,
// asks the user for permission (once), subscribes to the Push API using our
// VAPID key, and hands the subscription to the backend so it can push later.
//
// Runs happily inside a normal browser tab and inside the Capacitor Android
// wrapper. Inside Capacitor the WebView cannot receive Push API events, so
// this file also exposes registerNativePush which the wrapper wires to FCM.

import { api } from './api.js';

export const isCapacitor = () =>
  typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

let registration = null;

export async function ensureServiceWorker(onUpdateReady) {
  if (registration) return registration;
  if (!('serviceWorker' in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register('/service-worker.js');
    // If a new SW is waiting, prompt to update
    const checkWaiting = (reg) => {
      if (reg.waiting) onUpdateReady?.();
    };
    checkWaiting(registration);
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      newWorker?.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          onUpdateReady?.();
        }
      });
    });
    return registration;
  } catch {
    return null;
  }
}

// Are we in a state where the browser can subscribe?
export function pushAvailable() {
  if (isCapacitor()) return true;
  return typeof window !== 'undefined'
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && Notification.permission !== 'denied';
}

// True after we successfully subscribed at least once this session.
let subscribed = false;
export function isSubscribed() { return subscribed; }

export async function enablePush() {
  if (isCapacitor()) {
    return enableNativePush();
  }
  if (!('Notification' in window)) return { ok: false, reason: 'unsupported' };
  const perm = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission;
  if (perm !== 'granted') return { ok: false, reason: perm };

  const reg = await ensureServiceWorker();
  if (!reg) return { ok: false, reason: 'no-sw' };

  const { key } = await api.getVapidKey();
  if (!key) return { ok: false, reason: 'server-not-configured' };

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  await api.pushSubscribe({
    subscription: sub.toJSON(),
    meta: { platform: 'web' },
  });
  subscribed = true;
  return { ok: true };
}

// Silently registers/refreshes FCM token on Capacitor launch.
// Only runs when permission is already granted (no user prompt).
// The initial permission prompt is triggered in App.jsx on first launch.
export async function autoRegisterIfNative() {
  if (!isCapacitor()) return;
  try {
    const mod = await import(/* @vite-ignore */ '@capacitor/push-notifications').catch(() => null);
    if (!mod?.PushNotifications) return;
    const { PushNotifications } = mod;
    const status = await PushNotifications.checkPermissions();
    if (status.receive === 'granted') {
      await _doNativeRegistration(PushNotifications);
    }
  } catch { /* ignore */ }
}

// Rewritten native push: adds listeners BEFORE calling register() so we
// never miss a token that arrives synchronously on Android 13+.
async function enableNativePush() {
  try {
    const mod = await import(/* @vite-ignore */ '@capacitor/push-notifications').catch(() => null);
    if (!mod?.PushNotifications) return { ok: false, reason: 'plugin-missing' };
    const { PushNotifications } = mod;

    // Check current state first
    let perm = await PushNotifications.checkPermissions();

    // Only prompt if not determined yet
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions();
    }

    if (perm.receive !== 'granted') {
      return { ok: false, reason: perm.receive };
    }

    return _doNativeRegistration(PushNotifications);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Registers and waits for token. Adds listeners BEFORE calling .register()
// so the token is never missed if Android delivers it synchronously.
function _doNativeRegistration(PushNotifications) {
  return new Promise((resolve) => {
    // Remove any stale listeners first to avoid duplicates
    PushNotifications.removeAllListeners().catch(() => {});

    // Add success listener
    PushNotifications.addListener('registration', async (token) => {
      try {
        await api.pushSubscribe({
          subscription: { transport: 'fcm', token: token.value },
          meta: { platform: 'android' },
        });
        subscribed = true;
        resolve({ ok: true });
      } catch (err) {
        resolve({ ok: false, reason: err.message });
      }
    });

    // Add error listener
    PushNotifications.addListener('registrationError', (err) => {
      resolve({ ok: false, reason: err?.error || 'registration-error' });
    });

    // NOW call register — listeners are already wired
    PushNotifications.register().catch((err) => {
      resolve({ ok: false, reason: err?.message || 'register-failed' });
    });
  });
}

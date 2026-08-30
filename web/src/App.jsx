import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, clearToken, getToken, getAgentEmail } from './api.js';
import { BrandContext } from './brand.js';
import { ToastProvider, useToast } from './components/ui/Toast.jsx';
import Sidebar, { PushPill } from './components/layout/Sidebar.jsx';
import Login from './views/Login.jsx';
import Console from './Console.jsx';
import Admin from './Admin.jsx';
import { Menu } from 'lucide-react';
import {
  ensureServiceWorker, enablePush, pushAvailable,
  autoRegisterIfNative, isCapacitor,
} from './push.js';

import Modal from './components/ui/Modal.jsx';

  // Color helpers 
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}
function darken(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const d = (v) => Math.max(0, Math.round(v * (1 - amount)));
  return `rgb(${d(r)}, ${d(g)}, ${d(b)})`;
}
function hexWithAlpha(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

  // Push state persistence 
const PUSH_STATE_KEY = 'wa_push_state';

function resolveInitialPushState() {
  const stored = localStorage.getItem(PUSH_STATE_KEY);
  if (typeof Notification === 'undefined') return stored || 'dismissed';
  const perm = Notification.permission;
  if (perm === 'granted') return 'granted';
  if (perm === 'denied') return 'denied';
  return stored || 'default';
}
function savePushState(state) {
  localStorage.setItem(PUSH_STATE_KEY, state);
}

  // Root 
export default function App() {
  const [authed, setAuthed]  = useState(Boolean(getToken()));
  const [view, setView]      = useState('conversations');
  const [brand, setBrand]    = useState({
    name: 'Console',
    watermark: '',
    supportEmail: '',
    accentColor: '#00a884',
  });
  const [conversations, setConversations]   = useState([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [pushState, setPushState]           = useState(() => resolveInitialPushState());
  const [deniedModalOpen, setDeniedModalOpen] = useState(false);
  // Track whether a thread is open on mobile (hides top bar)
  const [threadOpen, setThreadOpen]         = useState(false);
  // For back-button: reference current view/thread so the listener always sees latest state
  const viewRef       = useRef(view);
  const threadOpenRef = useRef(threadOpen);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { threadOpenRef.current = threadOpen; }, [threadOpen]);

  // Load branding
  useEffect(() => {
    api.branding().then((b) => {
      if (!b) return;
      setBrand(b);
      if (b.accentColor) {
        const hex = b.accentColor;
        document.documentElement.style.setProperty('--accent', hex);
        document.documentElement.style.setProperty('--accent-hover', hex);
        document.documentElement.style.setProperty('--accent-text', darken(hex, 0.2));
        document.documentElement.style.setProperty('--accent-dim', hexWithAlpha(hex, 0.08));
      }
    });
  }, []);

  // Load conversation list for badge count
  useEffect(() => {
    if (!authed) return;
    api.conversations()
      .then((d) => setConversations(d.conversations || []))
      .catch(() => {});
  }, [authed]);

  // SW registration + push state sync + live OS permission listener
  useEffect(() => {
    if (!authed) return;

    ensureServiceWorker(() => {
      window.dispatchEvent(new CustomEvent('sw-update-ready'));
    });

    setPushState(resolveInitialPushState());

    // Silently re-register FCM token on every Capacitor launch
    autoRegisterIfNative();

    // Hardware back button support for Android —
    // uses React state (not history) so it works correctly in a SPA:
    //   - thread open → close thread
    //   - on an admin sub-view → go back to conversations
    //   - already on conversations → exit app
    let backListener = null;
    if (isCapacitor()) {
      // @vite-ignore is required — these paths must NOT be transformed by Rollup.
      // The Capacitor WebView runtime resolves @capacitor/* imports natively.
      import(/* @vite-ignore */ '@capacitor/app').then(({ App: CapApp }) => {
        CapApp.addListener('backButton', ({ canGoBack }) => {
          if (viewRef.current !== 'conversations') {
            setView('conversations');
          } else if (canGoBack) {
            window.history.back();
          } else {
            CapApp.exitApp();
          }
        }).then((listener) => { backListener = listener; });
      }).catch(() => {});

      // Request push permissions immediately on every Capacitor launch.
      // On first launch this shows the Android system permission dialog.
      // On subsequent launches it silently refreshes the FCM token if already granted.
      import(/* @vite-ignore */ '@capacitor/push-notifications')
        .then(({ PushNotifications }) => {
          PushNotifications.requestPermissions()
            .then((status) => {
              if (status.receive === 'granted') {
                autoRegisterIfNative();
              }
            })
            .catch(() => {});
        })
        .catch(() => {});
    }

    // Live OS permission change (browser only)
    let permStatus = null;
    try {
      navigator.permissions?.query({ name: 'notifications' }).then((ps) => {
        permStatus = ps;
        ps.onchange = () => {
          const next = ps.state === 'granted' ? 'granted'
            : ps.state === 'denied' ? 'denied' : 'default';
          savePushState(next);
          setPushState(next);
        };
      }).catch(() => {});
    } catch { /* unsupported */ }
    return () => { 
      if (permStatus) permStatus.onchange = null; 
      if (backListener) backListener.then(l => l.remove());
    };
  }, [authed]);


  const dismissBanner = () => {
    savePushState('dismissed');
    setPushState('dismissed');
  };

  const pendingCount = useMemo(
    () => conversations.filter((c) => c.state === 'pending').length,
    [conversations],
  );

  const logout = () => {
    clearToken();
    setAuthed(false);
    setView('conversations');
  };

  if (!authed) {
    return (
      <BrandContext.Provider value={brand}>
        <ToastProvider>
          <Login onLogin={() => setAuthed(true)} />
        </ToastProvider>
      </BrandContext.Provider>
    );
  }

  const adminViews = ['dashboard', 'knowledge', 'followups', 'setup', 'team'];
  const isAdmin    = adminViews.includes(view);
  // Show banner only on web (not Capacitor), and only when on conversations view
  const showBanner = !isCapacitor() && pushState === 'default' && pushAvailable() && !threadOpen;

  return (
    <BrandContext.Provider value={brand}>
      <ToastProvider>
        <AppInner
          brand={brand}
          view={view}
          setView={setView}
          mobileMenuOpen={mobileMenuOpen}
          setMobileMenuOpen={setMobileMenuOpen}
          pushState={pushState}
          setPushState={setPushState}
          showBanner={showBanner}
          dismissBanner={dismissBanner}
          deniedModalOpen={deniedModalOpen}
          setDeniedModalOpen={setDeniedModalOpen}
          pendingCount={pendingCount}
          setConversations={setConversations}
          logout={logout}
          isAdmin={isAdmin}
          threadOpen={threadOpen}
          setThreadOpen={setThreadOpen}
        />
      </ToastProvider>
    </BrandContext.Provider>
  );
}

  // AppInner: inside ToastProvider so useToast works 
function AppInner({
  brand, view, setView, mobileMenuOpen, setMobileMenuOpen,
  pushState, showBanner, dismissBanner,
  deniedModalOpen, setDeniedModalOpen,
  pendingCount, setConversations, logout, isAdmin,
  threadOpen, setThreadOpen, setPushState
}) {
  const toast = useToast();

  const turnOnPush = async () => {
    const res = await enablePush();
    let next;
    if (res.ok) {
      next = 'granted';
    } else if (res.reason === 'denied') {
      next = 'denied';
    } else if (res.reason === 'default') {
      // The user closed the browser prompt with the ✕ instead of
      // Allow/Block. Treat as "dismissed" so the banner does not keep
      // re-appearing on every reload.
      next = 'dismissed';
    } else {
      next = 'default';
      toast.error(`Push registration failed: ${res.reason || 'Unknown error'}`);
    }
    savePushState(next);
    setPushState?.(next);
  };

  // SW update toast
  useEffect(() => {
    const handler = () => {
      toast.info('A new version is ready.', 0, {
        label: 'Reload',
        onClick: () => {
          navigator.serviceWorker?.controller?.postMessage({ type: 'SKIP_WAITING' });
          setTimeout(() => location.reload(), 300);
        },
      });
    };
    window.addEventListener('sw-update-ready', handler);
    return () => window.removeEventListener('sw-update-ready', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePushTest = async () => {
    try {
      let status = await api.pushStatus();
      if (!status?.vapidConfigured && !isCapacitor()) {
        toast.error('Notifications not configured on the server.');
        return;
      }
      if (!status?.myEndpoints?.length) {
        // The backend has lost our subscription (e.g. server restart or dev wipe).
        // Try to re-register silently instead of failing.
        const re = await enablePush();
        if (!re.ok) {
          toast.warning('No subscription found. Try turning notifications on again.');
          return;
        }
        // Re-fetch status after silent registration
        status = await api.pushStatus();
      }
      const res = await api.pushTest();
      if (res?.sent > 0) {
        toast.success(`Test sent to ${res.sent} device${res.sent !== 1 ? 's' : ''}`);
      } else {
        toast.warning('Server sent 0 notifications. Check device settings.');
      }
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="flex h-full overflow-hidden bg-white relative w-full">
      <Sidebar
        view={view}
        onNavigate={(v) => { setView(v); setMobileMenuOpen(false); }}
        onLogout={logout}
        pendingCount={pendingCount}
        agentEmail={getAgentEmail()}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        pushState={pushState}
        onPushTest={handlePushTest}
        onEnablePush={turnOnPush}
        onPushDeniedInfo={() => setDeniedModalOpen(true)}
      />

      <main className="flex-1 flex flex-col min-h-0 overflow-hidden bg-surface-page w-full relative">

        {/* Mobile Top Bar — hidden when a thread is open (thread header replaces it) */}
        {!threadOpen && (
          <div
            className="md:hidden flex items-center gap-2 flex-shrink-0 z-20 border-b border-gray-200 bg-white"
            style={{
              height: 'calc(56px + env(safe-area-inset-top))',
              paddingTop: 'env(safe-area-inset-top)',
              paddingLeft: '16px',
              paddingRight: '12px',
            }}
          >
            <div className="font-bold text-lg text-gray-900 truncate flex-1 tracking-tight">{brand.name || 'Console'}</div>
            <PushPill
              pushState={pushState}
              onTest={handlePushTest}
              onEnablePush={turnOnPush}
              onDeniedInfo={() => setDeniedModalOpen(true)}
              compact
            />
            <button
              className="p-2 -mr-1 text-gray-600 hover:text-gray-900 transition-colors"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={24} />
            </button>
          </div>
        )}

        {/* Notification banner — only on web, only when list is visible */}
        {showBanner && (
          <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-900 flex-shrink-0">
            <span className="flex-1 min-w-0 text-xs truncate">
              Get notified when a lead needs help
            </span>
            <button
              onClick={turnOnPush}
              className="h-7 px-3 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold flex-shrink-0 transition-colors"
            >
              Turn on
            </button>
            <button
              onClick={dismissBanner}
              className="text-amber-700 text-lg leading-none px-1 flex-shrink-0"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
          {view === 'conversations' && (
            <Console
              onConversationsChange={setConversations}
              onThreadOpen={setThreadOpen}
            />
          )}
          {isAdmin && (
            <Admin
              activeTab={view}
              onNavigate={(v) => { setView(v); setMobileMenuOpen(false); }}
            />
          )}
        </div>
      </main>

      {deniedModalOpen && (
        <Modal
          title="Notifications blocked"
          body="You blocked notifications for this site. To re-enable, open your browser site settings for this URL, allow notifications, then refresh."
          confirmLabel="Got it"
          cancelLabel=""
          onConfirm={() => setDeniedModalOpen(false)}
          onClose={() => setDeniedModalOpen(false)}
        />
      )}
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { api, clearToken, getToken, getAgentEmail } from './api.js';
import { BrandContext } from './brand.js';
import { ToastProvider, useToast } from './components/ui/Toast.jsx';
import Sidebar from './components/layout/Sidebar.jsx';
import Login from './views/Login.jsx';
import Console from './Console.jsx';
import Admin from './Admin.jsx';
import { Menu, Bell } from 'lucide-react';
import { ensureServiceWorker, enablePush, pushAvailable } from './push.js';
import Modal from './components/ui/Modal.jsx';

// Color helpers for white-label brand theming
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

// Persist push state across sessions in localStorage (§2.1)
const PUSH_STATE_KEY = 'wa_push_state';

function resolveInitialPushState() {
  const stored = localStorage.getItem(PUSH_STATE_KEY);
  if (typeof Notification === 'undefined') return stored || 'dismissed';
  const perm = Notification.permission; // 'granted' | 'denied' | 'default'
  // If OS says granted/denied, trust that over stored value
  if (perm === 'granted') return 'granted';
  if (perm === 'denied') return 'denied';
  // Otherwise respect stored dismissed state
  return stored || 'default';
}

function savePushState(state) {
  localStorage.setItem(PUSH_STATE_KEY, state);
}

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [view, setView] = useState('conversations');
  const [brand, setBrand] = useState({
    name: 'Console',
    watermark: '',
    supportEmail: '',
    accentColor: '#00a884',
  });
  const [conversations, setConversations] = useState([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [pushState, setPushState] = useState(() => resolveInitialPushState());
  const [deniedModalOpen, setDeniedModalOpen] = useState(false);

  // Load branding on mount
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

  // Keep conversation list so sidebar can show the pending count
  useEffect(() => {
    if (!authed) return;
    api.conversations()
      .then((d) => setConversations(d.conversations || []))
      .catch(() => {});
  }, [authed]);

  // Register SW on sign-in and sync push state (§2.1)
  useEffect(() => {
    if (!authed) return;
    ensureServiceWorker(() => {
      // A new service worker is waiting. We can't call useToast here (outside
      // the provider tree) so we fire a custom event that AppInner listens to.
      window.dispatchEvent(new CustomEvent('sw-update-ready'));
    });
    // Sync with current permission (handles case where user changed OS settings)
    setPushState(resolveInitialPushState());

    // Live permission change listener (§2.1)
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
    } catch { /* browser doesn't support */ }
    return () => { if (permStatus) permStatus.onchange = null; };
  }, [authed]);

  const turnOnPush = async () => {
    const res = await enablePush();
    let next;
    if (res.ok) {
      next = 'granted';
    } else if (res.reason === 'denied') {
      next = 'denied';
    } else {
      next = 'default';
    }
    savePushState(next);
    setPushState(next);
  };

  const dismissBanner = () => {
    savePushState('dismissed');
    setPushState('dismissed');
  };

  // Push test — calls backend, shows toast via outer ToastProvider
  // Wired inside the ToastProvider tree so we use a wrapper
  const [pushTestResult, setPushTestResult] = useState(null);

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

  // Admin views
  const adminViews = ['dashboard', 'knowledge', 'followups', 'setup', 'team'];
  const isAdmin = adminViews.includes(view);

  const showBanner = pushState === 'default' && pushAvailable();

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
          showBanner={showBanner}
          turnOnPush={turnOnPush}
          dismissBanner={dismissBanner}
          deniedModalOpen={deniedModalOpen}
          setDeniedModalOpen={setDeniedModalOpen}
          pendingCount={pendingCount}
          conversations={conversations}
          setConversations={setConversations}
          logout={logout}
          isAdmin={isAdmin}
        />
      </ToastProvider>
    </BrandContext.Provider>
  );
}

// Inner component so useToast works inside the provider tree
function AppInner({
  brand, view, setView, mobileMenuOpen, setMobileMenuOpen,
  pushState, showBanner, turnOnPush, dismissBanner,
  deniedModalOpen, setDeniedModalOpen,
  pendingCount, setConversations, logout, isAdmin,
}) {
  const toast = useToast();

  // Listen for SW update signal from App root
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
      const status = await api.pushStatus();
      if (!status?.vapidConfigured) {
        toast.error('Notifications not configured on the server. Run node scripts/generate-vapid.js >> .env and restart.');
        return;
      }
      if (!status?.myEndpoints?.length) {
        toast.warning('No subscription found for this device. Try turning notifications on again.');
        return;
      }
      const res = await api.pushTest();
      if (res?.sent > 0) {
        toast.success(`Test sent to ${res.sent} device${res.sent !== 1 ? 's' : ''}`);
      } else {
        toast.warning('Server sent 0 notifications. Check your device settings.');
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
        {/* Mobile Top Bar — share bottom border with banner when banner visible (§2.3) */}
        <div
          className={`md:hidden flex items-center justify-between px-4 h-14 bg-white flex-shrink-0 z-20 shadow-sm relative
            ${showBanner ? '' : 'border-b border-gray-200'}`}
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div className="font-bold text-lg text-gray-900 truncate">{brand.name || 'Console'}</div>
          <button 
            className="p-2 -mr-2 text-gray-600 hover:text-gray-900 transition-colors"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={24} />
          </button>
        </div>

        {/* Push banner — simplified on mobile (§2.3) */}
        {showBanner && (
          <div className="flex items-center gap-2 md:gap-3 px-4 md:px-5 py-2 md:py-2.5 bg-amber-50 border-b border-amber-200 text-sm text-amber-900 flex-shrink-0">
            <Bell size={14} className="flex-shrink-0" />
            <span className="flex-1 min-w-0 text-xs md:text-sm truncate md:whitespace-normal">
              <span className="md:hidden">Get alerted when a lead needs a person</span>
              <span className="hidden md:inline">Get alerted when a lead needs a person, even with this tab closed.</span>
            </span>
            <button
              onClick={turnOnPush}
              className="h-7 md:h-8 px-2.5 md:px-3 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold flex-shrink-0 transition-colors"
            >
              Turn on
            </button>
            {/* Not now hidden on mobile per §2.3 spec — use X instead */}
            <button
              onClick={dismissBanner}
              className="text-amber-700 hover:text-amber-900 text-xs px-1 md:px-2 flex-shrink-0"
              aria-label="Dismiss"
            >
              <span className="md:hidden">&times;</span>
              <span className="hidden md:inline">Not now</span>
            </button>
          </div>
        )}

        <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
          {view === 'conversations' && (
            <Console onConversationsChange={setConversations} />
          )}
          {isAdmin && (
            <Admin activeTab={view} onNavigate={(v) => { setView(v); setMobileMenuOpen(false); }} />
          )}
        </div>
      </main>

      {/* Denied modal (§2.2) */}
      {deniedModalOpen && (
        <Modal
          title="Notifications blocked"
          body="You blocked notifications for this site. To re-enable, open your browser's site settings for this URL and allow notifications, then refresh the page."
          confirmLabel="Got it"
          cancelLabel=""
          onConfirm={() => setDeniedModalOpen(false)}
          onClose={() => setDeniedModalOpen(false)}
        />
      )}
    </div>
  );
}

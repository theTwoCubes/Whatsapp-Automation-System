import React, { useEffect, useMemo, useState } from 'react';
import { api, clearToken, getToken, getAgentEmail } from './api.js';
import { BrandContext } from './brand.js';
import { ToastProvider } from './components/ui/Toast.jsx';
import Sidebar from './components/layout/Sidebar.jsx';
import Login from './views/Login.jsx';
import Console from './Console.jsx';
import Admin from './Admin.jsx';
import { Menu, Bell } from 'lucide-react';
import { ensureServiceWorker, enablePush, pushAvailable } from './push.js';

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
  const [pushState, setPushState] = useState('unknown');

  // Load branding on mount
  useEffect(() => {
    api.branding().then((b) => {
      if (!b) return;
      setBrand(b);
      if (b.accentColor) {
        const hex = b.accentColor;
        document.documentElement.style.setProperty('--accent', hex);
        document.documentElement.style.setProperty('--accent-hover', hex);
        // Compute a darker variant for text-on-light-bg (multiply by ~0.75)
        document.documentElement.style.setProperty('--accent-text', darken(hex, 0.2));
        // Compute a very light tint for hover/active backgrounds
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

  // Register the service worker as soon as the agent signs in. It powers the
  // background notification path, and the browser will not accept a Push API
  // subscribe until it is active.
  useEffect(() => {
    if (!authed) return;
    ensureServiceWorker();
    if (typeof Notification !== 'undefined') {
      setPushState(Notification.permission); // 'granted' | 'denied' | 'default'
    }
  }, [authed]);

  const turnOnPush = async () => {
    const res = await enablePush();
    setPushState(res.ok ? 'granted' : (res.reason === 'denied' ? 'denied' : 'default'));
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

  // Admin views
  const adminViews = ['dashboard', 'knowledge', 'followups', 'setup', 'team'];
  const isAdmin = adminViews.includes(view);

  return (
    <BrandContext.Provider value={brand}>
      <ToastProvider>
        <div className="flex h-full overflow-hidden bg-white relative w-full">
          <Sidebar
            view={view}
            onNavigate={(v) => { setView(v); setMobileMenuOpen(false); }}
            onLogout={logout}
            pendingCount={pendingCount}
            agentEmail={getAgentEmail()}
            mobileOpen={mobileMenuOpen}
            onCloseMobile={() => setMobileMenuOpen(false)}
          />
          <main className="flex-1 flex flex-col min-h-0 overflow-hidden bg-surface-page w-full relative">
            {/* Mobile Top Bar */}
            <div className="md:hidden flex items-center justify-between px-4 h-14 bg-white border-b border-gray-200 flex-shrink-0 z-20 shadow-sm relative">
              <div className="font-bold text-lg text-gray-900 truncate">{brand.name || 'Console'}</div>
              <button 
                className="p-2 -mr-2 text-gray-600 hover:text-gray-900 transition-colors"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Open menu"
              >
                <Menu size={24} />
              </button>
            </div>
            
            {pushState === 'default' && pushAvailable() && (
              <div className="flex items-center gap-3 px-4 md:px-5 py-2.5 bg-amber-50 border-b border-amber-200 text-sm text-amber-900 flex-shrink-0">
                <Bell size={16} className="flex-shrink-0" />
                <span className="flex-1 min-w-0">
                  Get alerted when a lead needs a person, even with this tab closed.
                </span>
                <button
                  onClick={turnOnPush}
                  className="h-8 px-3 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold flex-shrink-0 transition-colors"
                >
                  Turn on
                </button>
                <button
                  onClick={() => setPushState('dismissed')}
                  className="text-amber-700 hover:text-amber-900 text-xs px-2 flex-shrink-0"
                >
                  Not now
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
        </div>
      </ToastProvider>
    </BrandContext.Provider>
  );
}

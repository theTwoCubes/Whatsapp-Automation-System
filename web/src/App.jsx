import React, { useEffect, useMemo, useState } from 'react';
import { api, clearToken, getToken, getAgentEmail } from './api.js';
import { BrandContext } from './brand.js';
import { ToastProvider } from './components/ui/Toast.jsx';
import Sidebar from './components/layout/Sidebar.jsx';
import Login from './views/Login.jsx';
import Console from './Console.jsx';
import Admin from './Admin.jsx';

// ─── Color helpers for white-label brand theming ───────────────
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
        <div className="flex h-full overflow-hidden bg-white">
          <Sidebar
            view={view}
            onNavigate={setView}
            onLogout={logout}
            pendingCount={pendingCount}
            agentEmail={getAgentEmail()}
          />
          <main className="flex-1 flex flex-col min-h-0 overflow-hidden bg-surface-page">
            {view === 'conversations' && (
              <Console onConversationsChange={setConversations} />
            )}
            {isAdmin && (
              <Admin activeTab={view} onNavigate={setView} />
            )}
          </main>
        </div>
      </ToastProvider>
    </BrandContext.Provider>
  );
}

import React, { useEffect, useState } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';
import { BrandContext } from './brand.js';
import Console from './Console.jsx';
import Admin from './Admin.jsx';

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [view, setView] = useState('chats');
  const [brand, setBrand] = useState({ name: 'Console', watermark: '', supportEmail: '', accentColor: '#00a884' });

  useEffect(() => {
    api.branding().then((b) => {
      if (!b) return;
      setBrand(b);
      if (b.accentColor) {
        document.documentElement.style.setProperty('--green', b.accentColor);
        document.documentElement.style.setProperty('--green-dark', b.accentColor);
      }
    });
  }, []);

  const logout = () => {
    clearToken();
    setAuthed(false);
    setView('chats');
  };

  let screen;
  if (!authed) screen = <Login brand={brand} onLogin={() => setAuthed(true)} />;
  else if (view === 'admin') screen = <Admin onBack={() => setView('chats')} onLogout={logout} />;
  else screen = <Console onOpenAdmin={() => setView('admin')} onLogout={logout} />;

  return <BrandContext.Provider value={brand}>{screen}</BrandContext.Provider>;
}

function Login({ onLogin, brand }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { token } = await api.login(email, password);
      setToken(token);
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="brand">
          <div className="dot">{(brand?.name || 'C').slice(0, 2)}</div>
          <h1>{brand?.name || 'Console'}</h1>
          <p className="sub">Sign in to manage your WhatsApp chats</p>
        </div>
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}

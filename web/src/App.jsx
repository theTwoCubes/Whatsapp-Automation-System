import React, { useState } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';
import Console from './Console.jsx';

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return (
    <Console
      onLogout={() => {
        clearToken();
        setAuthed(false);
      }}
    />
  );
}

function Login({ onLogin }) {
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
          <div className="dot">tC</div>
          <h1>theTwoCubes Console</h1>
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

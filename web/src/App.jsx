import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';

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

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const { token } = await api.login(email, password);
      setToken(token);
      onLogin();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form className="login" onSubmit={submit}>
      <h1>WhatsApp Console</h1>
      <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">Sign in</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Console({ onLogout }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [thread, setThread] = useState(null);
  const [templates, setTemplates] = useState([]);
  const selectedRef = useRef(null);

  const loadList = useCallback(async () => {
    try {
      const { conversations } = await api.conversations();
      setConversations(conversations);
    } catch (err) {
      if (err.message === 'unauthorized') onLogout();
    }
  }, [onLogout]);

  const loadThread = useCallback(async (id) => {
    if (!id) return;
    try {
      setThread(await api.conversation(id));
    } catch {
      // ignore, a refresh will retry
    }
  }, []);

  useEffect(() => {
    loadList();
    api.templates().then((d) => setTemplates(d.templates)).catch(() => {});
  }, [loadList]);

  useEffect(() => {
    selectedRef.current = selected;
    loadThread(selected);
  }, [selected, loadThread]);

  // Live updates. Any event refreshes the list and the open thread.
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/stream?token=${getToken()}`);
    ws.onmessage = () => {
      loadList();
      if (selectedRef.current) loadThread(selectedRef.current);
    };
    return () => ws.close();
  }, [loadList, loadThread]);

  return (
    <div className="app">
      <aside className="list">
        <header>
          <span>Chats</span>
          <button className="link" onClick={onLogout}>
            Sign out
          </button>
        </header>
        {conversations.map((c) => (
          <button
            key={c.id}
            className={`row ${selected === c.id ? 'active' : ''}`}
            onClick={() => setSelected(c.id)}
          >
            <div className="row-top">
              <strong>{c.name || c.wa_id}</strong>
              <span className={`tag ${c.state}`}>{c.state}</span>
            </div>
            <div className="row-sub">{c.last_message || 'No messages yet'}</div>
            {c.campaign && <div className="row-campaign">from: {c.campaign}</div>}
          </button>
        ))}
      </aside>

      <main className="thread">
        {thread ? (
          <Thread thread={thread} templates={templates} onChanged={() => loadThread(selected)} />
        ) : (
          <div className="empty">Select a chat</div>
        )}
      </main>
    </div>
  );
}

function Thread({ thread, templates, onChanged }) {
  const { conversation, messages } = thread;
  const [text, setText] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [error, setError] = useState('');

  const act = async (fn) => {
    setError('');
    try {
      await fn();
      setText('');
      await onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      <header className="thread-head">
        <div>
          <strong>{conversation.name || conversation.wa_id}</strong>
          <span className={`tag ${conversation.state}`}>{conversation.state}</span>
        </div>
        {conversation.state === 'bot' ? (
          <button onClick={() => act(() => api.takeover(conversation.id))}>Take over</button>
        ) : (
          <button onClick={() => act(() => api.handback(conversation.id))}>Give back to bot</button>
        )}
      </header>

      <div className="messages">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.direction}`}>
            <div>{m.body}</div>
            {m.direction === 'outbound' && m.status && <span className="status">{m.status}</span>}
          </div>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="composer">
        <input
          placeholder="Type a reply"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && text.trim() && act(() => api.send(conversation.id, text.trim()))}
        />
        <button disabled={!text.trim()} onClick={() => act(() => api.send(conversation.id, text.trim()))}>
          Send
        </button>
        {templates.length > 0 && (
          <div className="template-row">
            <select value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
              <option value="">Send a template</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              disabled={!templateName}
              onClick={() => act(() => api.sendTemplate(conversation.id, templateName))}
            >
              Send template
            </button>
          </div>
        )}
      </div>
    </>
  );
}

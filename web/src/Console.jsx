import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken } from './api.js';
import { initials, avatarColor, shortTime, groupByDay, templateParamCount } from './lib.js';

export default function Console({ onLogout }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [thread, setThread] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [query, setQuery] = useState('');
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
      // a later refresh will retry
    }
  }, []);

  const syncTemplates = useCallback(async () => {
    const d = await api.syncTemplates();
    setTemplates(d.templates || []);
  }, []);

  useEffect(() => {
    loadList();
    api.templates().then((d) => setTemplates(d.templates)).catch(() => {});
  }, [loadList]);

  useEffect(() => {
    selectedRef.current = selected;
    loadThread(selected);
  }, [selected, loadThread]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/stream?token=${getToken()}`);
    ws.onmessage = () => {
      loadList();
      if (selectedRef.current) loadThread(selectedRef.current);
    };
    return () => ws.close();
  }, [loadList, loadThread]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) => (c.name || '').toLowerCase().includes(q) || (c.wa_id || '').includes(q),
    );
  }, [conversations, query]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="side-head">
          <div className="me">
            <div className="avatar sm" style={{ background: 'var(--green)' }}>
              tC
            </div>
            <span>Console</span>
          </div>
          <button className="icon-btn" onClick={onLogout}>
            Sign out
          </button>
        </div>
        <div className="search">
          <input placeholder="Search name or number" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="chat-list">
          {filtered.length === 0 && <div className="empty-list">No chats yet</div>}
          {filtered.map((c) => (
            <button
              key={c.id}
              className={`chat-row ${String(selected) === String(c.id) ? 'active' : ''}`}
              onClick={() => setSelected(c.id)}
            >
              <div className="avatar" style={{ background: avatarColor(c.wa_id) }}>
                {initials(c.name, c.wa_id)}
              </div>
              <div className="chat-main">
                <div className="chat-top">
                  <span className="name">{c.name || c.wa_id}</span>
                  <span className="time">{shortTime(c.last_at)}</span>
                </div>
                <div className="chat-bottom">
                  <span className="preview">{c.last_message || 'No messages yet'}</span>
                  <span className={`pill ${c.state}`}>{c.state}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="chat">
        {thread ? (
          <Chat
            thread={thread}
            templates={templates}
            onSync={syncTemplates}
            onChanged={() => loadThread(selected)}
          />
        ) : (
          <div className="empty-chat">
            <div className="big">💬</div>
            <p>Select a chat to start</p>
          </div>
        )}
      </main>
    </div>
  );
}

function Ticks({ status }) {
  if (!status) return null;
  const read = status === 'read';
  const single = status === 'sent';
  return <span className={`ticks ${read ? 'read' : ''}`}>{single ? '✓' : '✓✓'}</span>;
}

function Chat({ thread, templates, onSync, onChanged }) {
  const { conversation, messages } = thread;
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, conversation.id]);

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

  const groups = groupByDay(messages);
  const isHuman = conversation.state === 'human';
  const windowOpen = conversation.window_open;

  return (
    <>
      <div className="chat-head">
        <div className="avatar sm" style={{ background: avatarColor(conversation.wa_id) }}>
          {initials(conversation.name, conversation.wa_id)}
        </div>
        <div className="who">
          <div className="name">{conversation.name || conversation.wa_id}</div>
          <div className="sub">
            {conversation.wa_id}
            {isHuman && conversation.assignee ? ` · with ${conversation.assignee}` : ` · handled by bot`}
          </div>
        </div>
        <span className={`window ${windowOpen ? 'open' : 'closed'}`}>
          {windowOpen ? '24h window open' : 'window closed'}
        </span>
        {isHuman ? (
          <button className="btn ghost" onClick={() => act(() => api.handback(conversation.id))}>
            Give back to bot
          </button>
        ) : (
          <button className="btn" onClick={() => act(() => api.takeover(conversation.id))}>
            Take over
          </button>
        )}
      </div>

      <div className="messages">
        {groups.map((g) => (
          <React.Fragment key={g.label}>
            <div className="day">{g.label}</div>
            {g.items.map((m) => (
              <div key={m.id} className={`bubble ${m.direction}`}>
                {m.body}
                <span className="meta">
                  {shortTime(m.created_at)}
                  {m.direction === 'outbound' && <Ticks status={m.status} />}
                </span>
              </div>
            ))}
          </React.Fragment>
        ))}
        <div ref={endRef} />
      </div>

      {error && <p className="error" style={{ padding: '4px 16px' }}>{error}</p>}

      <div className="composer">
        {windowOpen ? (
          <div className="row">
            <input
              className="msg"
              placeholder="Type a message"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && text.trim() && act(() => api.send(conversation.id, text.trim()))}
            />
            <button
              className="send"
              disabled={!text.trim()}
              onClick={() => act(() => api.send(conversation.id, text.trim()))}
              title="Send"
            >
              ➤
            </button>
          </div>
        ) : (
          <p className="locked">
            This chat is outside the 24 hour window, so free messages are not allowed. You can send an approved
            template below.
          </p>
        )}
        <TemplatePanel
          conversationId={conversation.id}
          templates={templates}
          onSync={onSync}
          onSent={onChanged}
        />
      </div>

      <div className="watermark">
        Made by theTwoCubes · <a href="mailto:build@thetwocubes.com">build@thetwocubes.com</a>
      </div>
    </>
  );
}

function TemplatePanel({ conversationId, templates, onSync, onSent }) {
  const [name, setName] = useState('');
  const [params, setParams] = useState([]);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);

  const selected = templates.find((t) => t.name === name);
  const count = templateParamCount(selected?.body);

  useEffect(() => {
    setParams(Array(count).fill(''));
  }, [name, count]);

  const send = async () => {
    setError('');
    try {
      await api.sendTemplate(conversationId, name, params);
      setName('');
      await onSent();
    } catch (err) {
      setError(err.message);
    }
  };

  const sync = async () => {
    setSyncing(true);
    setError('');
    try {
      await onSync();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const preview = selected?.body
    ? selected.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] || `{{${n}}}`)
    : '';

  return (
    <div className="template-panel">
      <div className="template-bar">
        <select value={name} onChange={(e) => setName(e.target.value)}>
          <option value="">Send an approved template...</option>
          {templates.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <button className="btn ghost" onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing...' : 'Sync'}
        </button>
      </div>

      {count > 0 &&
        Array.from({ length: count }).map((_, i) => (
          <input
            key={i}
            className="param"
            placeholder={`Value for {{${i + 1}}}`}
            value={params[i] || ''}
            onChange={(e) => {
              const next = [...params];
              next[i] = e.target.value;
              setParams(next);
            }}
          />
        ))}

      {preview && <div className="template-preview">{preview}</div>}

      {name && (
        <button className="btn" onClick={send}>
          Send template
        </button>
      )}

      {templates.length === 0 && (
        <p className="locked">No approved templates yet. Click Sync to pull them from Meta.</p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

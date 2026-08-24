import React, { useEffect, useState } from 'react';
import { api } from './api.js';

const tabs = [
  ['overview', 'Overview'],
  ['profile', 'Business profile'],
  ['knowledge', 'Knowledge base'],
  ['templates', 'Templates'],
  ['agents', 'Agents'],
  ['settings', 'Settings'],
  ['audit', 'Audit log'],
];

export default function Admin({ onBack, onLogout }) {
  const [tab, setTab] = useState('overview');

  return (
    <div className="admin">
      <div className="admin-top">
        <button className="btn ghost" onClick={onBack}>
          Back to chats
        </button>
        <strong>Admin</strong>
        <button className="icon-btn" onClick={onLogout}>
          Sign out
        </button>
      </div>
      <div className="admin-body">
        <nav className="admin-nav">
          {tabs.map(([key, label]) => (
            <button key={key} className={`admin-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="admin-panel">
          {tab === 'overview' && <Overview />}
          {tab === 'profile' && <Profile />}
          {tab === 'knowledge' && <Knowledge />}
          {tab === 'templates' && <Templates />}
          {tab === 'agents' && <Agents />}
          {tab === 'settings' && <Settings />}
          {tab === 'audit' && <AuditLog />}
        </div>
      </div>
      <div className="watermark">
        Made by theTwoCubes · <a href="mailto:build@thetwocubes.com">build@thetwocubes.com</a>
      </div>
    </div>
  );
}

function useAsync(loader, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const reload = () => {
    loader()
      .then(setData)
      .catch((e) => setError(e.message));
  };
  useEffect(reload, deps);
  return [data, error, reload];
}

function Overview() {
  const [data, error] = useAsync(() => api.overview());
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  const o = data.overview;
  const cards = [
    ['Leads', o.leads],
    ['Campaigns', o.campaigns],
    ['With the bot', o.bot_chats],
    ['With a human', o.human_chats],
    ['Messages in', o.inbound],
    ['Messages out', o.outbound],
  ];
  return (
    <div className="stat-grid">
      {cards.map(([label, value]) => (
        <div key={label} className="stat">
          <div className="stat-num">{value}</div>
          <div className="stat-label">{label}</div>
        </div>
      ))}
    </div>
  );
}

function Profile() {
  const [data, error, reload] = useAsync(() => api.getProfile());
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (data?.profile) {
      const p = data.profile;
      setForm({
        about: p.about || '',
        description: p.description || '',
        email: p.email || '',
        address: p.address || '',
        vertical: p.vertical || '',
        websites: (p.websites || []).join(', '),
      });
    }
  }, [data]);

  const save = async () => {
    setMsg('');
    try {
      const body = { ...form, websites: form.websites ? form.websites.split(',').map((s) => s.trim()).filter(Boolean) : [] };
      await api.saveProfile(body);
      setMsg('Saved');
      reload();
    } catch (e) {
      setMsg(e.message);
    }
  };

  if (error) return <p className="error">{error}</p>;
  return (
    <div className="form">
      <p className="muted">This is your WhatsApp business profile, shown to customers. Changes go straight to Meta.</p>
      <Field label="About" value={form.about} onChange={(v) => setForm({ ...form, about: v })} />
      <Field label="Description" value={form.description} textarea onChange={(v) => setForm({ ...form, description: v })} />
      <Field label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
      <Field label="Address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} />
      <Field label="Websites (comma separated)" value={form.websites} onChange={(v) => setForm({ ...form, websites: v })} />
      <div className="form-actions">
        <button className="btn" onClick={save}>Save profile</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
  );
}

function Knowledge() {
  const [data, error, reload] = useAsync(() => api.knowledge());
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [msg, setMsg] = useState('');

  const add = async () => {
    setMsg('');
    try {
      await api.addKnowledge(title, content);
      setTitle('');
      setContent('');
      reload();
    } catch (e) {
      setMsg(e.message);
    }
  };
  const remove = async (id) => {
    await api.deleteKnowledge(id);
    reload();
  };

  if (error) return <p className="error">{error}</p>;
  return (
    <div className="form">
      <p className="muted">Facts the bot answers from. Keep them short and specific.</p>
      {(data?.knowledge || []).map((k) => (
        <div key={k.id} className="list-row">
          <div>
            <strong>{k.title}</strong>
            <div className="muted">{k.content}</div>
          </div>
          <button className="btn ghost danger" onClick={() => remove(k.id)}>Delete</button>
        </div>
      ))}
      <div className="add-box">
        <input placeholder="Title, e.g. Pricing" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea placeholder="Content" value={content} onChange={(e) => setContent(e.target.value)} />
        <button className="btn" onClick={add} disabled={!title.trim() || !content.trim()}>Add entry</button>
        {msg && <span className="error">{msg}</span>}
      </div>
    </div>
  );
}

function Templates() {
  const [data, error, reload] = useAsync(() => api.templates());
  const [msg, setMsg] = useState('');

  const sync = async () => {
    setMsg('Syncing...');
    try {
      const d = await api.syncTemplates();
      setMsg(`Synced ${d.synced} templates`);
      reload();
    } catch (e) {
      setMsg(e.message);
    }
  };
  if (error) return <p className="error">{error}</p>;
  return (
    <div className="form">
      <div className="form-actions">
        <button className="btn" onClick={sync}>Sync from Meta</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      <p className="muted">Approved templates you can send outside the 24 hour window.</p>
      {(data?.templates || []).map((t) => (
        <div key={t.name} className="list-row">
          <div>
            <strong>{t.name}</strong> <span className="tag bot">{t.category || 'template'}</span>
            <div className="muted">{t.body}</div>
          </div>
        </div>
      ))}
      {(data?.templates || []).length === 0 && <p className="muted">No approved templates yet.</p>}
    </div>
  );
}

function Agents() {
  const [data, error, reload] = useAsync(() => api.agents());
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const add = async () => {
    setMsg('');
    try {
      await api.addAgent(email, name, password);
      setEmail('');
      setName('');
      setPassword('');
      reload();
    } catch (e) {
      setMsg(e.message);
    }
  };
  const remove = async (id) => {
    try {
      await api.deleteAgent(id);
      reload();
    } catch (e) {
      setMsg(e.message);
    }
  };
  if (error) return <p className="error">{error}</p>;
  return (
    <div className="form">
      <p className="muted">People who can sign into this console.</p>
      {(data?.agents || []).map((a) => (
        <div key={a.id} className="list-row">
          <div>
            <strong>{a.name || a.email}</strong>
            <div className="muted">{a.email}</div>
          </div>
          <button className="btn ghost danger" onClick={() => remove(a.id)}>Remove</button>
        </div>
      ))}
      <div className="add-box">
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn" onClick={add} disabled={!email.trim() || password.length < 6}>Add agent</button>
        {msg && <span className="error">{msg}</span>}
      </div>
    </div>
  );
}

function Settings() {
  const [data, error, reload] = useAsync(() => api.getSettings());
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (data?.settings) setForm(data.settings);
  }, [data]);
  const save = async () => {
    setMsg('');
    try {
      await api.saveSettings(form);
      setMsg('Saved');
      reload();
    } catch (e) {
      setMsg(e.message);
    }
  };
  if (error) return <p className="error">{error}</p>;
  return (
    <div className="form">
      <p className="muted">How the bot talks and behaves. Changes apply within a few seconds.</p>
      <Field label="Business name" value={form.business_name} onChange={(v) => setForm({ ...form, business_name: v })} />
      <Field label="About the business" value={form.business_about} textarea onChange={(v) => setForm({ ...form, business_about: v })} />
      <Field label="Tone" value={form.business_tone} onChange={(v) => setForm({ ...form, business_tone: v })} />
      <Field label="Fallback message" value={form.fallback_message} textarea onChange={(v) => setForm({ ...form, fallback_message: v })} />
      <Field label="Handoff message" value={form.handoff_message} textarea onChange={(v) => setForm({ ...form, handoff_message: v })} />
      <Field label="Drip steps (template:days, comma separated)" value={form.drip_steps} onChange={(v) => setForm({ ...form, drip_steps: v })} />
      <Field label="Auto resume after (minutes, 0 to disable)" value={form.resume_minutes} onChange={(v) => setForm({ ...form, resume_minutes: v })} />
      <div className="form-actions">
        <button className="btn" onClick={save}>Save settings</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
  );
}

function AuditLog() {
  const [data, error] = useAsync(() => api.audit());
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  return (
    <div className="form">
      <p className="muted">Recent actions taken in the console.</p>
      {data.audit.map((a) => (
        <div key={a.id} className="list-row">
          <div>
            <strong>{a.action}</strong> {a.target ? <span className="muted">{a.target}</span> : null}
            <div className="muted">
              {a.actor || 'system'} · {new Date(a.created_at).toLocaleString()}
              {a.detail ? ` · ${a.detail}` : ''}
            </div>
          </div>
        </div>
      ))}
      {data.audit.length === 0 && <p className="muted">Nothing yet.</p>}
    </div>
  );
}

function Field({ label, value, onChange, textarea }) {
  return (
    <label className="field">
      <span>{label}</span>
      {textarea ? (
        <textarea value={value || ''} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input value={value || ''} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

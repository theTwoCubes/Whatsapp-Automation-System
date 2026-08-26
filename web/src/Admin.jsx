import React, { useContext, useEffect, useState } from 'react';
import { api } from './api.js';
import { BrandContext } from './brand.js';

const tabs = [
  ['overview', 'Overview'],
  ['campaigns', 'Campaigns'],
  ['profile', 'Business profile'],
  ['knowledge', 'Knowledge base'],
  ['media', 'Media'],
  ['templates', 'Templates'],
  ['agents', 'Agents'],
  ['settings', 'Settings'],
  ['branding', 'Branding'],
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
          {tab === 'campaigns' && <Campaigns />}
          {tab === 'profile' && <Profile />}
          {tab === 'knowledge' && <Knowledge />}
          {tab === 'media' && <Media />}
          {tab === 'templates' && <Templates />}
          {tab === 'agents' && <Agents />}
          {tab === 'settings' && <Settings />}
          {tab === 'branding' && <Branding />}
          {tab === 'audit' && <AuditLog />}
        </div>
      </div>
      <AdminWatermark />
    </div>
  );
}

function AdminWatermark() {
  const brand = useContext(BrandContext);
  if (!brand?.watermark) return null;
  return (
    <div className="watermark">
      {brand.watermark}
      {brand.supportEmail ? (
        <>
          {' · '}
          <a href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>
        </>
      ) : null}
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

function Campaigns() {
  const [data, error, reload] = useAsync(() => api.campaigns());
  const [topics, setTopics] = useState([]);

  useEffect(() => {
    api.topics().then((d) => setTopics(d.topics || [])).catch(() => {});
  }, []);

  const link = async (campaignId, topicId) => {
    await api.linkCampaignTopic(campaignId, topicId || null);
    reload();
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;

  const rows = data.campaigns || [];
  const organic = data.organic || {};

  return (
    <div className="form">
      <p className="muted">
        Every lead is tracked back to the ad that brought them in, or marked organic if there was none. Link a
        campaign to a Topic so its leads get answers weighted toward that service.
      </p>

      {rows.map((c) => (
        <div key={c.id} className="list-row">
          <div>
            <strong>{c.headline || c.source_type || `Campaign ${c.id}`}</strong>
            <div className="muted" style={{ fontSize: 11 }}>
              {c.source_type || 'click to whatsapp ad'} · created {new Date(c.created_at).toLocaleDateString()}
            </div>
            <div className="muted">
              {c.leads} lead{c.leads === '1' ? '' : 's'} · {c.bot_chats} with the bot · {c.human_chats} with a human ·{' '}
              {c.inbound} in / {c.outbound} out
            </div>
          </div>
          <select value={c.topic_id || ''} onChange={(e) => link(c.id, e.target.value ? Number(e.target.value) : null)}>
            <option value="">No topic linked</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      ))}
      {rows.length === 0 && <p className="muted">No ad campaigns tracked yet.</p>}

      <div className="list-row">
        <div>
          <strong>Organic</strong>
          <div className="muted" style={{ fontSize: 11 }}>leads with no ad referral</div>
          <div className="muted">
            {organic.leads || 0} lead{organic.leads === '1' ? '' : 's'} · {organic.bot_chats || 0} with the bot ·{' '}
            {organic.human_chats || 0} with a human · {organic.inbound || 0} in / {organic.outbound || 0} out
          </div>
        </div>
      </div>
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
  // Tiered knowledge editor. Base tab shows the shared brain, plus one tab per
  // Topic. Each pane supports adding a single fact, pasting raw text to be
  // split into atomic deduped facts, and listing what is stored.
  const [topics, setTopics] = useState([]);
  const [scope, setScope] = useState('base');
  const [topicId, setTopicId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [addTopicOpen, setAddTopicOpen] = useState(false);

  useEffect(() => {
    api.topics().then((d) => setTopics(d.topics)).catch(() => {});
  }, [reloadKey]);

  const openBase = () => {
    setScope('base');
    setTopicId(null);
  };
  const openTopic = (t) => {
    setScope('topic');
    setTopicId(t.id);
  };

  return (
    <div>
      <p className="muted">
        The base knowledge is the shared brain that every conversation can draw from. Each Topic is a service
        or campaign specific pack. The bot pulls the most relevant facts for every incoming message.
      </p>

      <div className="topic-tabs">
        <button className={`topic-tab ${scope === 'base' ? 'active' : ''}`} onClick={openBase}>
          Base
        </button>
        {topics.map((t) => (
          <button
            key={t.id}
            className={`topic-tab ${scope === 'topic' && String(topicId) === String(t.id) ? 'active' : ''}`}
            onClick={() => openTopic(t)}
          >
            {t.name} <span className="count">{t.knowledge_count}</span>
          </button>
        ))}
        <button className="topic-tab add" onClick={() => setAddTopicOpen(true)}>
          + Add topic
        </button>
      </div>

      {addTopicOpen && (
        <AddTopic
          onCancel={() => setAddTopicOpen(false)}
          onCreated={(t) => {
            setAddTopicOpen(false);
            setReloadKey((k) => k + 1);
            openTopic(t);
          }}
        />
      )}

      <KnowledgePane
        key={`${scope}-${topicId ?? 'base'}-${reloadKey}`}
        scope={scope}
        topicId={topicId}
        onChange={() => setReloadKey((k) => k + 1)}
      />
    </div>
  );
}

function AddTopic({ onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [msg, setMsg] = useState('');
  const submit = async () => {
    setMsg('');
    try {
      const res = await api.addTopic(name.trim(), slug.trim() || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'), description.trim());
      onCreated(res.topic);
    } catch (e) {
      setMsg(e.message);
    }
  };
  return (
    <div className="add-box">
      <strong>Create a topic</strong>
      <input placeholder="Name, e.g. Logo Design" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="Slug (auto if blank)" value={slug} onChange={(e) => setSlug(e.target.value)} />
      <input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="form-actions">
        <button className="btn" onClick={submit} disabled={!name.trim()}>Create</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        {msg && <span className="error">{msg}</span>}
      </div>
    </div>
  );
}

function KnowledgePane({ scope, topicId, onChange }) {
  const [data, error, reload] = useAsync(() => api.knowledge(scope, topicId), [scope, topicId]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [raw, setRaw] = useState('');
  const [msg, setMsg] = useState('');

  const add = async () => {
    setMsg('');
    try {
      const res = await api.addKnowledge(title, content, scope, topicId);
      setMsg(res.added ? 'Added.' : `Already known (matches unit ${res.duplicateOf}).`);
      if (res.added) {
        setTitle('');
        setContent('');
      }
      reload();
      onChange?.();
    } catch (e) {
      setMsg(e.message);
    }
  };
  const remove = async (id) => {
    await api.deleteKnowledge(id);
    reload();
    onChange?.();
  };
  const ingest = async () => {
    setMsg('Processing...');
    try {
      const res = await api.ingestKnowledge(raw, scope, topicId);
      setMsg(`Added ${res.added}, skipped ${res.skipped} duplicates.`);
      setRaw('');
      reload();
      onChange?.();
    } catch (e) {
      setMsg(e.message);
    }
  };

  if (error) return <p className="error">{error}</p>;
  const rows = data?.knowledge || [];

  return (
    <div className="form">
      <div className="muted">{rows.length} facts stored in this scope.</div>
      {rows.map((k) => (
        <div key={k.id} className="list-row">
          <div>
            <strong>{k.title}</strong>
            <div className="muted">{k.content}</div>
            <div className="muted" style={{ fontSize: 11 }}>source: {k.source}</div>
          </div>
          <button className="btn ghost danger" onClick={() => remove(k.id)}>Delete</button>
        </div>
      ))}

      <div className="add-box">
        <strong>Add a single fact</strong>
        <input placeholder="Title, e.g. Pricing" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea placeholder="Content" value={content} onChange={(e) => setContent(e.target.value)} />
        <button className="btn" onClick={add} disabled={!title.trim() || !content.trim()}>Add fact</button>
      </div>

      <div className="add-box">
        <strong>Or paste an FAQ or block of text</strong>
        <p className="muted">We split it into atomic facts and skip anything that duplicates what is already stored.</p>
        <textarea placeholder="Paste Q: A: pairs or paragraphs" value={raw} onChange={(e) => setRaw(e.target.value)} rows={10} />
        <button className="btn" onClick={ingest} disabled={!raw.trim()}>Process and add</button>
      </div>

      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

function Media() {
  // Segregated by topic, same shell as Knowledge, so both the bot and a human
  // taking over can find the right file by service instead of one big pile.
  const [topics, setTopics] = useState([]);
  const [topicId, setTopicId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api.topics().then((d) => setTopics(d.topics)).catch(() => {});
  }, [reloadKey]);

  return (
    <div>
      <p className="muted">
        Upload files under a topic with a short description of what they show. The bot uses the description to
        find the right file for what a lead is asking about, and a human taking over can browse the same library.
      </p>

      <div className="topic-tabs">
        <button className={`topic-tab ${topicId === null ? 'active' : ''}`} onClick={() => setTopicId(null)}>
          All
        </button>
        {topics.map((t) => (
          <button
            key={t.id}
            className={`topic-tab ${String(topicId) === String(t.id) ? 'active' : ''}`}
            onClick={() => setTopicId(t.id)}
          >
            {t.name}
          </button>
        ))}
      </div>

      <MediaPane topics={topics} topicId={topicId} reloadKey={reloadKey} onChange={() => setReloadKey((k) => k + 1)} />
    </div>
  );
}

function MediaPane({ topics, topicId, reloadKey, onChange }) {
  const [data, error, reload] = useAsync(() => api.media(topicId), [topicId, reloadKey]);
  const [file, setFile] = useState(null);
  const [uploadTopicId, setUploadTopicId] = useState('');
  const [description, setDescription] = useState('');
  const [msg, setMsg] = useState('');

  const upload = async () => {
    if (!file) return;
    setMsg('Uploading...');
    try {
      await api.uploadMedia(file, uploadTopicId ? Number(uploadTopicId) : null, description.trim());
      setMsg('Uploaded.');
      setFile(null);
      setDescription('');
      reload();
      onChange?.();
    } catch (e) {
      setMsg(e.message);
    }
  };
  const remove = async (id) => {
    await api.deleteMedia(id);
    reload();
    onChange?.();
  };

  if (error) return <p className="error">{error}</p>;
  const rows = data?.media || [];

  return (
    <div className="form">
      <div className="muted">{rows.length} file{rows.length === 1 ? '' : 's'} in this view.</div>
      {rows.map((m) => (
        <div key={m.id} className="list-row">
          <div>
            <strong>{m.filename}</strong> <span className="tag bot">{m.kind}</span>
            {m.description && <div className="muted">{m.description}</div>}
            <div className="muted" style={{ fontSize: 11 }}>
              {topics.find((t) => t.id === m.topic_id)?.name || 'no topic'}
            </div>
          </div>
          <button className="btn ghost danger" onClick={() => remove(m.id)}>Delete</button>
        </div>
      ))}

      <div className="add-box">
        <strong>Upload a file</strong>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <select value={uploadTopicId} onChange={(e) => setUploadTopicId(e.target.value)}>
          <option value="">No topic</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <textarea
          placeholder="Description, e.g. Pricing sheet for logo design packages"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button className="btn" onClick={upload} disabled={!file}>Upload</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
  );
}

function Templates() {
  const [data, error, reload] = useAsync(() => api.templates());
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('UTILITY');
  const [body, setBody] = useState('');
  const [createMsg, setCreateMsg] = useState('');

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
  const create = async () => {
    setCreateMsg('');
    try {
      await api.createTemplate(name.trim(), category, body.trim());
      setCreateMsg('Submitted to Meta for approval. It will appear here once approved.');
      setName('');
      setBody('');
    } catch (e) {
      setCreateMsg(e.message);
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

      <div className="add-box">
        <strong>Create a template</strong>
        <p className="muted">Use {'{{1}}'}, {'{{2}}'} for values you fill in when sending. Meta must approve it first.</p>
        <input placeholder="Name, lowercase and underscores e.g. welcome_offer" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="UTILITY">Utility</option>
          <option value="MARKETING">Marketing</option>
        </select>
        <textarea placeholder="Body text, e.g. Hi {{1}}, thanks for reaching out to us." value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="btn" onClick={create} disabled={!name.trim() || !body.trim()}>Submit for approval</button>
        {createMsg && <span className="muted">{createMsg}</span>}
      </div>
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
      <Field label="Attachment received message" value={form.attachment_message} textarea onChange={(v) => setForm({ ...form, attachment_message: v })} />
      <Field label="Drip steps (template:days, comma separated)" value={form.drip_steps} onChange={(v) => setForm({ ...form, drip_steps: v })} />
      <Field label="Auto resume after (minutes, 0 to disable)" value={form.resume_minutes} onChange={(v) => setForm({ ...form, resume_minutes: v })} />
      <div className="form-actions">
        <button className="btn" onClick={save}>Save settings</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
  );
}

function Branding() {
  const [data, error] = useAsync(() => api.getSettings());
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (data?.settings) setForm(data.settings);
  }, [data]);
  const save = async () => {
    setMsg('');
    try {
      await api.saveSettings({
        brand_name: form.brand_name,
        brand_watermark: form.brand_watermark,
        support_email: form.support_email,
        accent_color: form.accent_color,
      });
      setMsg('Saved. Reload the page to apply the colour.');
    } catch (e) {
      setMsg(e.message);
    }
  };
  if (error) return <p className="error">{error}</p>;
  return (
    <div className="form">
      <p className="muted">White label the console for this client. Reload after saving to apply the accent colour.</p>
      <Field label="Brand name" value={form.brand_name} onChange={(v) => setForm({ ...form, brand_name: v })} />
      <Field label="Watermark" value={form.brand_watermark} onChange={(v) => setForm({ ...form, brand_watermark: v })} />
      <Field label="Support email" value={form.support_email} onChange={(v) => setForm({ ...form, support_email: v })} />
      <Field label="Accent colour (hex)" value={form.accent_color} onChange={(v) => setForm({ ...form, accent_color: v })} />
      <div className="form-actions">
        <button className="btn" onClick={save}>Save branding</button>
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

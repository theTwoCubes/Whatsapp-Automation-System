import React, { useContext, useEffect, useState } from 'react';
import { api } from './api.js';
import { BrandContext } from './brand.js';

const tabs = [
  ['overview', 'Overview'],
  ['campaigns', 'Campaigns'],
  ['profile', 'Business profile'],
  ['faqs', 'FAQs'],
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
          {tab === 'faqs' && <Faqs />}
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
    ['Waiting for a human', o.pending_chats],
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
              {c.leads} lead{c.leads === '1' ? '' : 's'} · {c.bot_chats} with the bot · {c.pending_chats} pending ·{' '}
              {c.human_chats} with a human · {c.inbound} in / {c.outbound} out
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
            {organic.pending_chats || 0} pending · {organic.human_chats || 0} with a human · {organic.inbound || 0} in
            / {organic.outbound || 0} out
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

function Faqs() {
  // The bot is given whole packs verbatim, so this list is literally what it
  // knows. Order matters, since that is the order it reads them in.
  const [packs, setPacks] = useState([]);
  const [pack, setPack] = useState('base');
  const [reloadKey, setReloadKey] = useState(0);
  const [addTopicOpen, setAddTopicOpen] = useState(false);
  const [learnMsg, setLearnMsg] = useState('');
  const [learning, setLearning] = useState(false);
  const [search, setSearch] = useState('');
  const [simulatorOpen, setSimulatorOpen] = useState(false);

  const reloadPacks = () => {
    api.packs().then((d) => setPacks(d.packs || [])).catch(() => {});
  };
  useEffect(reloadPacks, [reloadKey]);

  const runLearning = async () => {
    setLearning(true);
    setLearnMsg('');
    try {
      const res = await api.runRefinement();
      const gaps = res.gaps?.proposed || 0;
      const contras = res.contradictions?.proposed || 0;
      const parts = [];
      if (gaps) parts.push(`${gaps} gap${gaps === 1 ? '' : 's'} to fill`);
      if (contras) parts.push(`${contras} contradiction${contras === 1 ? '' : 's'}`);
      setLearnMsg(parts.length ? `Found ${parts.join(' and ')}, waiting for review below.` : 'Nothing new to flag this time.');
      setReloadKey((k) => k + 1);
    } catch (e) {
      setLearnMsg(e.message);
    } finally {
      setLearning(false);
    }
  };

  const doExport = async () => {
    const data = await api.exportFaqs();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `faqs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <p className="muted">
        Every answer the bot can give is written here. The base pack goes into every conversation, and a service
        pack goes in when the lead came through that campaign. The whole pack is handed over as written, nothing is
        summarised or picked out, so if an answer is wrong here it is wrong in the chat. Anything the answers do not
        cover goes to a person instead of being guessed at.
      </p>
      <p className="muted">
        Every week we also look for gaps (questions the bot could not answer and passed to you) and contradictions
        (pairs of answers here that disagree). Anything found lands as a proposal below, nothing goes live until
        you approve it.{' '}
        <button className="btn ghost" onClick={runLearning} disabled={learning}>
          {learning ? 'Looking...' : 'Look for gaps and contradictions'}
        </button>{' '}
        <button className="btn ghost" onClick={() => setSimulatorOpen((v) => !v)}>
          {simulatorOpen ? 'Close simulator' : 'Test a question'}
        </button>{' '}
        <button className="btn ghost" onClick={doExport}>Export</button>
        {learnMsg && <span className="muted"> {learnMsg}</span>}
      </p>

      <Proposals reloadKey={reloadKey} onChange={() => setReloadKey((k) => k + 1)} />

      {simulatorOpen && <Simulator packs={packs} />}

      <div className="search">
        <input
          placeholder="Search across every pack"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {search.trim() ? (
        <FaqSearchResults query={search.trim()} onChange={() => setReloadKey((k) => k + 1)} />
      ) : (
        <>
          <div className="topic-tabs">
            {packs.map((p) => (
              <button
                key={p.slug}
                className={`topic-tab ${String(pack) === String(p.topic_id ?? 'base') ? 'active' : ''}`}
                onClick={() => setPack(p.topic_id ?? 'base')}
              >
                {p.name} <span className="count">{p.faq_count}</span>
              </button>
            ))}
            <button className="topic-tab add" onClick={() => setAddTopicOpen(true)}>
              + Add pack
            </button>
          </div>

          {addTopicOpen && (
            <AddTopic
              onCancel={() => setAddTopicOpen(false)}
              onCreated={(t) => {
                setAddTopicOpen(false);
                setReloadKey((k) => k + 1);
                setPack(t.id);
              }}
            />
          )}

          <FaqPane
            key={`${pack}-${reloadKey}`}
            pack={pack}
            onChange={() => setReloadKey((k) => k + 1)}
          />
        </>
      )}
    </div>
  );
}

function FaqSearchResults({ query, onChange }) {
  const [data, error, reload] = useAsync(() => api.searchFaqs(query), [query]);
  const [msg, setMsg] = useState('');

  const remove = async (id) => {
    await api.deleteFaq(id);
    reload();
    onChange?.();
  };
  const toggle = async (id, active) => {
    await api.updateFaq(id, { active });
    reload();
    onChange?.();
  };

  if (error) return <p className="error">{error}</p>;
  const rows = data?.faqs || [];

  return (
    <div className="form">
      <div className="muted">
        {rows.length === 0
          ? 'No answer matches that.'
          : `${rows.length} match${rows.length === 1 ? '' : 'es'} across every pack.`}
      </div>
      {rows.map((f) => (
        <div key={f.id} className="list-row">
          <div>
            <strong>{f.question}</strong>{' '}
            <span className="tag">{f.topic_name || 'Base'}</span>
            {f.verbatim && <span className="tag human">word for word</span>}
            {!f.active && <span className="tag human">inactive</span>}
            <div className="muted">{f.answer}</div>
          </div>
          <div className="form-actions">
            {f.active ? (
              <button className="btn ghost" onClick={() => toggle(f.id, false)}>Deactivate</button>
            ) : (
              <button className="btn" onClick={() => toggle(f.id, true)}>Activate</button>
            )}
            <button className="btn ghost danger" onClick={() => remove(f.id)}>Delete</button>
          </div>
        </div>
      ))}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

function Proposals({ reloadKey, onChange }) {
  // Gap and contradiction proposals from the weekly refinement pass. Gaps
  // become new FAQs on approve, contradictions just get dismissed once the
  // client has fixed the underlying pair in the FAQ tab below.
  const [data, error, reload] = useAsync(() => api.proposals('open'), [reloadKey]);
  const proposals = data?.proposals || [];

  const refresh = () => {
    reload();
    onChange?.();
  };

  if (error) return <p className="error">{error}</p>;
  if (proposals.length === 0) return null;

  const gaps = proposals.filter((p) => p.kind === 'gap');
  const contras = proposals.filter((p) => p.kind === 'contradiction');

  return (
    <div className="proposals">
      {gaps.length > 0 && (
        <div className="add-box">
          <strong>Questions the bot could not answer</strong>
          <p className="muted">
            Each of these came up in a real chat and the bot passed it to a person. Approve the draft (edit it
            first if you want), or dismiss it if it is not worth writing down.
          </p>
          {gaps.map((p) => (
            <GapProposal key={p.id} proposal={p} onChanged={refresh} />
          ))}
        </div>
      )}
      {contras.length > 0 && (
        <div className="add-box">
          <strong>Answers here that seem to disagree</strong>
          <p className="muted">
            Two live answers in the same pack said different things about the same fact. Fix or delete one of
            them in the FAQ list, then dismiss the flag.
          </p>
          {contras.map((p) => (
            <ContradictionProposal key={p.id} proposal={p} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

function GapProposal({ proposal, onChanged }) {
  const [question, setQuestion] = useState(proposal.question || '');
  const [answer, setAnswer] = useState(proposal.answer || '');
  const [msg, setMsg] = useState('');

  const approve = async () => {
    setMsg('');
    try {
      await api.approveProposal(proposal.id, { question: question.trim(), answer: answer.trim() });
      onChanged();
    } catch (e) {
      setMsg(e.message);
    }
  };
  const dismiss = async () => {
    await api.dismissProposal(proposal.id);
    onChanged();
  };

  return (
    <div className="proposal">
      <div className="muted" style={{ fontSize: 12 }}>
        {proposal.topic_name || 'Base'}
        {proposal.reason ? ` · ${proposal.reason}` : ''}
        {proposal.sample_conversation_ids?.length > 0
          ? ` · seen in ${proposal.sample_conversation_ids.length} chat${proposal.sample_conversation_ids.length === 1 ? '' : 's'}`
          : ''}
      </div>
      <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="The question a customer would ask" />
      <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="The answer, in the words you want it said" rows={3} />
      <div className="form-actions">
        <button className="btn" onClick={approve} disabled={!question.trim() || !answer.trim()}>Approve and add</button>
        <button className="btn ghost" onClick={dismiss}>Dismiss</button>
        {msg && <span className="error">{msg}</span>}
      </div>
    </div>
  );
}

function ContradictionProposal({ proposal, onChanged }) {
  const dismiss = async () => {
    await api.dismissProposal(proposal.id);
    onChanged();
  };
  return (
    <div className="proposal">
      <div className="muted" style={{ fontSize: 12 }}>
        {proposal.topic_name || 'Base'} · {proposal.reason}
      </div>
      <div className="contra-pair">
        <div>
          <div className="muted" style={{ fontSize: 11 }}>Answer #{proposal.faq_id_a}</div>
          <strong>{proposal.faq_a_question}</strong>
          <div className="muted">{proposal.faq_a_answer}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11 }}>Answer #{proposal.faq_id_b}</div>
          <strong>{proposal.faq_b_question}</strong>
          <div className="muted">{proposal.faq_b_answer}</div>
        </div>
      </div>
      <div className="form-actions">
        <button className="btn ghost" onClick={dismiss}>Dismiss (I have fixed it)</button>
      </div>
    </div>
  );
}

function Simulator({ packs }) {
  // Dry runs the reply pipeline against a message the client types, without
  // touching any conversation or sending anything. Shows what the model would
  // be given and, if the ai is configured, what it would answer.
  const [text, setText] = useState('');
  const [topicId, setTopicId] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [contextOpen, setContextOpen] = useState(false);

  const run = async () => {
    setBusy(true);
    setErr('');
    setResult(null);
    try {
      const r = await api.simulate({ text: text.trim(), topicId: topicId ? Number(topicId) : null });
      setResult(r);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const servicePacks = packs.filter((p) => p.topic_id != null);
  const packNames = new Map(packs.map((p) => [String(p.topic_id ?? 'base'), p.name]));

  return (
    <div className="add-box">
      <strong>Test what the bot would say</strong>
      <p className="muted">
        Pretend a lead sent this message. We put together the exact same context the bot would see, and show
        what it would answer. Nothing is sent, nothing is recorded on any conversation.
      </p>
      <textarea
        placeholder="Type a question a customer might ask"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
      />
      <label className="field">
        <span>Pretend they came through this service (optional)</span>
        <select value={topicId} onChange={(e) => setTopicId(e.target.value)}>
          <option value="">No campaign linked</option>
          {servicePacks.map((p) => (
            <option key={p.topic_id} value={p.topic_id}>{p.name}</option>
          ))}
        </select>
      </label>
      <div className="form-actions">
        <button className="btn" onClick={run} disabled={!text.trim() || busy}>
          {busy ? 'Running...' : 'Run'}
        </button>
        {err && <span className="error">{err}</span>}
      </div>

      {result && (
        <div className="sim-result">
          <div className="muted">
            Packs given to the bot:{' '}
            {result.packsIncluded.map((p) => packNames.get(String(p)) || `#${p}`).join(', ')}
            {result.keywordMatches.length > 0 && (
              <> · pulled in by keyword: {result.keywordMatches.map((id) => packNames.get(String(id)) || `#${id}`).join(', ')}</>
            )}
            {' · '}
            {result.faqCount} answer{result.faqCount === 1 ? '' : 's'}, about {result.contextTokens} tokens
            {result.droppedForBudget > 0 && ` (${result.droppedForBudget} dropped to fit)`}
          </div>

          {result.decision ? (
            <div className={`sim-decision ${result.decision.handoff ? 'handoff' : 'answer'}`}>
              {result.decision.handoff ? (
                <>
                  <strong>Would hand off to a person.</strong>
                  <div className="muted">Reason: {result.decision.reason || 'not given'}</div>
                  {result.decision.reply && <div className="muted">Holding message: {result.decision.reply}</div>}
                </>
              ) : (
                <>
                  <strong>Would answer:</strong>
                  <div>{result.decision.reply}</div>
                  {result.decision.sendFaqId && (
                    <div className="muted">Would also send the file attached to answer #{result.decision.sendFaqId}</div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="muted">
              No AI provider is configured, so we cannot show the actual answer. The context above is what would
              be sent when one is.
            </div>
          )}

          <button className="btn ghost" onClick={() => setContextOpen((v) => !v)}>
            {contextOpen ? 'Hide the exact prompt' : 'Show the exact prompt'}
          </button>
          {contextOpen && <pre className="sim-context">{result.context || '(no answers to show)'}</pre>}
        </div>
      )}
    </div>
  );
}

function FaqPane({ pack, onChange }) {
  const [data, error, reload] = useAsync(() => api.faqs(pack), [pack]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [verbatim, setVerbatim] = useState(false);
  const [msg, setMsg] = useState('');
  const [raw, setRaw] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const rows = data?.faqs || [];

  const refresh = () => {
    reload();
    onChange?.();
  };

  const add = async () => {
    setMsg('');
    try {
      await api.addFaq({
        topicId: pack === 'base' ? null : pack,
        question: question.trim(),
        answer: answer.trim(),
        verbatim,
      });
      setQuestion('');
      setAnswer('');
      setVerbatim(false);
      refresh();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const importText = async () => {
    setImportMsg('Processing...');
    try {
      const res = await api.importFaqs(raw, pack === 'base' ? null : pack);
      setImportMsg(`Added ${res.added}, skipped ${res.skipped} already covered.`);
      setRaw('');
      refresh();
    } catch (e) {
      setImportMsg(e.message);
    }
  };

  const move = async (index, delta) => {
    const next = [...rows];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await api.reorderFaqs(next.map((r) => r.id));
    refresh();
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="form">
      {pack !== 'base' && <PackSettings topicId={pack} onChanged={onChange} />}
      <div className="muted">{rows.length} answer{rows.length === 1 ? '' : 's'} in this pack.</div>

      {rows.map((f, i) => (
        <FaqRow
          key={f.id}
          faq={f}
          first={i === 0}
          last={i === rows.length - 1}
          onMove={(delta) => move(i, delta)}
          onChanged={refresh}
        />
      ))}

      <div className="add-box">
        <strong>Add an answer</strong>
        <input placeholder="Question a lead would ask, e.g. What does a logo cost?" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <textarea placeholder="The answer, written the way you want it said" value={answer} onChange={(e) => setAnswer(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={verbatim} onChange={(e) => setVerbatim(e.target.checked)} />
          <span>Quote this answer word for word. Use it for prices, timelines and anything an approximation would get wrong.</span>
        </label>
        <button className="btn" onClick={add} disabled={!question.trim() || !answer.trim()}>Add answer</button>
        {msg && <span className="error">{msg}</span>}
      </div>

      <div className="add-box">
        <strong>Or paste a document</strong>
        <p className="muted">
          Paste an FAQ, a price list or raw notes and we split it into separate answers in this pack. Anything
          whose question already exists here is skipped.
        </p>
        <textarea placeholder="Paste Q: A: pairs or paragraphs" value={raw} onChange={(e) => setRaw(e.target.value)} rows={8} />
        <button className="btn" onClick={importText} disabled={!raw.trim()}>Split and add</button>
        {importMsg && <span className="muted">{importMsg}</span>}
      </div>
    </div>
  );
}

function PackSettings({ topicId, onChanged }) {
  // Words that will pull this pack in without asking the model, plus a one
  // line description shown to the model when it decides whether to ask.
  const [topic, setTopic] = useState(null);
  const [form, setForm] = useState({ description: '', keywords: '' });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.topics().then((d) => {
      const t = (d.topics || []).find((x) => String(x.id) === String(topicId));
      if (t) {
        setTopic(t);
        setForm({ description: t.description || '', keywords: t.keywords || '' });
      }
    }).catch(() => {});
  }, [topicId]);

  const save = async () => {
    setMsg('Saving...');
    try {
      await api.updateTopic(topicId, {
        description: form.description.trim() || null,
        keywords: form.keywords.trim() || null,
      });
      setMsg('Saved.');
      onChanged?.();
    } catch (e) {
      setMsg(e.message);
    }
  };

  if (!topic) return null;
  return (
    <div className="add-box">
      <strong>How this pack gets pulled in</strong>
      <p className="muted">
        This pack always goes in when the lead came through the "{topic.name}" campaign. It also goes in when their
        message mentions any of the keywords below, so add the words customers actually use for this service.
      </p>
      <input
        placeholder="Keywords, comma separated (e.g. logo, branding, identity)"
        value={form.keywords}
        onChange={(e) => setForm({ ...form, keywords: e.target.value })}
      />
      <input
        placeholder="One line description shown to the assistant, so it knows what this pack covers"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />
      <div className="form-actions">
        <button className="btn" onClick={save}>Save</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
  );
}

function FaqRow({ faq, first, last, onMove, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    question: faq.question,
    answer: faq.answer,
    verbatim: faq.verbatim,
    pinned: faq.pinned,
    mediaAssetId: faq.media_asset_id,
  });
  const [history, setHistory] = useState(null);
  const [media, setMedia] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!editing || media) return;
    api.media(faq.topic_id).then((d) => setMedia(d.media || [])).catch(() => {});
  }, [editing, faq.topic_id, media]);

  const save = async () => {
    setMsg('');
    try {
      await api.updateFaq(faq.id, form);
      setEditing(false);
      onChanged();
    } catch (e) {
      setMsg(e.message);
    }
  };
  const remove = async () => {
    await api.deleteFaq(faq.id);
    onChanged();
  };
  const approve = async () => {
    await api.updateFaq(faq.id, { active: true });
    onChanged();
  };
  const toggleHistory = async () => {
    if (history) return setHistory(null);
    const d = await api.faqVersions(faq.id);
    setHistory(d.versions || []);
  };
  const restore = async (versionId) => {
    await api.rollbackFaq(versionId);
    setHistory(null);
    onChanged();
  };

  if (editing) {
    return (
      <div className="add-box">
        <input value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} />
        <textarea value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} />
        <label className="check">
          <input type="checkbox" checked={form.verbatim} onChange={(e) => setForm({ ...form, verbatim: e.target.checked })} />
          <span>Quote word for word</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />
          <span>Always include, even when trimming for length</span>
        </label>
        <label className="field">
          <span>Send this file with the answer, when it fits</span>
          <select
            value={form.mediaAssetId ?? ''}
            onChange={(e) => setForm({ ...form, mediaAssetId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">No file</option>
            {(media || []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.filename}
                {m.description ? ` - ${m.description}` : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button className="btn" onClick={save}>Save</button>
          <button className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
          {msg && <span className="error">{msg}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="list-row">
      <div>
        <strong>{faq.question}</strong>
        {faq.verbatim && <span className="tag human">word for word</span>}
        {faq.pinned && <span className="tag">always included</span>}
        {faq.media_asset_id && <span className="tag bot">has file</span>}
        {!faq.active && <span className="tag human">learned, awaiting review</span>}
        <div className="muted">{faq.answer}</div>
        {history && (
          <div className="history">
            {history.map((v) => (
              <div key={v.id} className="history-row">
                <div className="muted">
                  {new Date(v.created_at).toLocaleString()} by {v.actor || 'system'}
                  <div>{v.answer}</div>
                </div>
                <button className="btn ghost" onClick={() => restore(v.id)}>Restore</button>
              </div>
            ))}
            {history.length === 0 && <div className="muted">No history yet.</div>}
          </div>
        )}
      </div>
      <div className="form-actions">
        <button className="icon-btn" title="Move up" disabled={first} onClick={() => onMove(-1)}>↑</button>
        <button className="icon-btn" title="Move down" disabled={last} onClick={() => onMove(1)}>↓</button>
        {!faq.active && <button className="btn" onClick={approve}>Approve</button>}
        <button className="btn ghost" onClick={toggleHistory}>History</button>
        <button className="btn ghost" onClick={() => setEditing(true)}>Edit</button>
        <button className="btn ghost danger" onClick={remove}>{faq.active ? 'Delete' : 'Reject'}</button>
      </div>
    </div>
  );
}

function AddTopic({ onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [msg, setMsg] = useState('');
  const submit = async () => {
    setMsg('');
    try {
      const res = await api.addTopic({
        name: name.trim(),
        slug: slug.trim() || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        description: description.trim(),
        keywords: keywords.trim(),
      });
      onCreated(res.topic);
    } catch (e) {
      setMsg(e.message);
    }
  };
  return (
    <div className="add-box">
      <strong>Create a pack</strong>
      <input placeholder="Name, e.g. Logo Design" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="Slug (auto if blank)" value={slug} onChange={(e) => setSlug(e.target.value)} />
      <input placeholder="Short description shown to the assistant so it knows what this pack covers" value={description} onChange={(e) => setDescription(e.target.value)} />
      <input placeholder="Keywords that should pull this pack in, comma separated (e.g. logo, branding, identity)" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
      <div className="form-actions">
        <button className="btn" onClick={submit} disabled={!name.trim()}>Create</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        {msg && <span className="error">{msg}</span>}
      </div>
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

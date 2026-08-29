import React, { useCallback, useEffect, useState } from 'react';
import { Search, Plus, FlaskConical, BookOpen, ChevronDown, ChevronUp, Lightbulb } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../../components/ui/Button.jsx';
import { InputField } from '../../components/ui/Field.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import Drawer from '../../components/ui/Drawer.jsx';
import Badge from '../../components/ui/Badge.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import {
  AdminPage, Section, Card, CardHeader, CardBody,
  FormStack, FormActions, EmptyState, TabPills,
} from './Dashboard.jsx';

// ─── Simulator Drawer ───────────────────────────────────────────
function SimulatorDrawer({ packs, onClose }) {
  const [text, setText]           = useState('');
  const [topicId, setTopicId]     = useState('');
  const [result, setResult]       = useState(null);
  const [busy, setBusy]           = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const toast = useToast();

  const run = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await api.simulate({ text: text.trim(), topicId: topicId ? Number(topicId) : null });
      setResult(r);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  const servicePacks = packs.filter((p) => p.topic_id != null);
  const packNames    = new Map(packs.map((p) => [String(p.topic_id ?? 'base'), p.name]));

  return (
    <Drawer title="Test the AI" onClose={onClose}>
      <FormStack>
        <p className="text-sm text-gray-500 leading-relaxed">
          Type a message as if a customer sent it. The AI will respond exactly as it would in a live chat. Nothing is sent to any real conversation.
        </p>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide" style={{ letterSpacing: '0.06em' }}>Customer message</label>
          <textarea
            className="field-textarea"
            placeholder="e.g. How much does a logo cost?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
          />
        </div>
        {servicePacks.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide" style={{ letterSpacing: '0.06em' }}>Pretend they came through (optional)</label>
            <select className="field-input" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              <option value="">No specific campaign</option>
              {servicePacks.map((p) => <option key={p.topic_id} value={p.topic_id}>{p.name}</option>)}
            </select>
            <p className="text-[11px] text-gray-400">This biases the AI toward that service's answers.</p>
          </div>
        )}
        <Button variant="primary" size="md" onClick={run} disabled={!text.trim() || busy}>
          {busy ? 'Running…' : 'Run test'}
        </Button>

        {result && (
          <div className="border border-gray-200 rounded-lg overflow-hidden mt-2">
            {/* Info bar */}
            <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-50 border-b border-gray-200">
              <BookOpen size={14} className="text-gray-400" />
              <span className="text-[11px] text-gray-400">
                Packs: {result.packsIncluded.map((p) => packNames.get(String(p)) || `#${p}`).join(', ')} · {result.faqCount} answer{result.faqCount !== 1 ? 's' : ''} · ~{result.contextTokens} tokens
                {result.droppedForBudget > 0 && ` (${result.droppedForBudget} dropped for length)`}
              </span>
            </div>
            {/* Answer */}
            <div className="px-4 py-4">
              {result.decision ? (
                result.decision.handoff ? (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                    <strong className="text-amber-800">Would hand off to a team member.</strong>
                    <div className="mt-1 text-amber-700">Reason: {result.decision.reason || 'not given'}</div>
                    {result.decision.reply && (
                      <div className="mt-1 text-amber-700 italic">Holding message: "{result.decision.reply}"</div>
                    )}
                  </div>
                ) : (
                  <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-800 leading-relaxed">
                    {result.decision.reply}
                  </div>
                )
              ) : (
                <p className="text-sm text-gray-400">No AI provider configured. The context above is what would be sent.</p>
              )}

              <div className="mt-3">
                <button
                  onClick={() => setContextOpen((v) => !v)}
                  className="flex items-center gap-1 text-[11px] text-[var(--accent-text)] hover:text-[var(--accent)] transition-colors"
                >
                  {contextOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {contextOpen ? 'Hide full prompt' : 'Show full prompt sent to AI'}
                </button>
                {contextOpen && (
                  <pre className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded-lg text-[11px] text-gray-600 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">
                    {result.context || '(empty)'}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}
      </FormStack>
    </Drawer>
  );
}

// ─── Proposals ─────────────────────────────────────────────────
function Proposals({ reloadKey, onChange }) {
  const [data, setData] = useState(null);
  const toast = useToast();

  useEffect(() => {
    api.proposals('open').then(setData).catch(() => {});
  }, [reloadKey]);

  if (!data) return null;
  const proposals = data.proposals || [];
  if (proposals.length === 0) return null;

  const gaps    = proposals.filter((p) => p.kind === 'gap');
  const contras = proposals.filter((p) => p.kind === 'contradiction');

  return (
    <Section>
      <div className="flex items-center gap-2 mb-2">
        <Lightbulb size={16} className="text-amber-500" />
        <span className="text-xs font-bold uppercase tracking-[0.07em] text-gray-500">AI suggestions to review</span>
        <Badge variant="warning">{proposals.length}</Badge>
      </div>
      <p className="text-sm text-gray-500 mb-4 leading-relaxed">
        The AI found these gaps and conflicts while reviewing recent conversations. Review each one and approve or dismiss it.
      </p>
      <Card>
        {gaps.map((p)    => <GapProposal key={p.id} proposal={p} onChanged={onChange} />)}
        {contras.map((p) => <ContradictionProposal key={p.id} proposal={p} onChanged={onChange} />)}
      </Card>
    </Section>
  );
}

function GapProposal({ proposal, onChanged }) {
  const [question, setQuestion] = useState(proposal.question || '');
  const [answer, setAnswer]     = useState(proposal.answer || '');
  const toast = useToast();

  const approve = async () => {
    try {
      await api.approveProposal(proposal.id, { question: question.trim(), answer: answer.trim() });
      toast.success('Answer added to knowledge base');
      onChanged();
    } catch (e) { toast.error(e.message); }
  };
  const dismiss = async () => {
    await api.dismissProposal(proposal.id);
    toast.info('Dismissed');
    onChanged();
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-4 border-b border-gray-100 last:border-0">
      <div>
        <Badge variant="warning">Gap — question the AI couldn't answer</Badge>
        <div className="text-[11px] text-gray-400 mt-1">
          {proposal.topic_name || 'Base'}{proposal.reason ? ` · ${proposal.reason}` : ''}
          {proposal.sample_conversation_ids?.length > 0 && ` · seen in ${proposal.sample_conversation_ids.length} chat${proposal.sample_conversation_ids.length === 1 ? '' : 's'}`}
        </div>
      </div>
      <FormStack>
        <input className="field-input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="The question a customer would ask" />
        <textarea className="field-textarea" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="The answer, in the words you want it said" rows={3} />
      </FormStack>
      <FormActions>
        <Button variant="primary" size="sm" onClick={approve} disabled={!question.trim() || !answer.trim()}>Approve and add</Button>
        <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
      </FormActions>
    </div>
  );
}

function ContradictionProposal({ proposal, onChanged }) {
  const toast = useToast();
  const dismiss = async () => {
    await api.dismissProposal(proposal.id);
    toast.info('Dismissed — fix the conflicting answers in the list below');
    onChanged();
  };
  return (
    <div className="flex flex-col gap-3 px-4 py-4 border-b border-gray-100 last:border-0">
      <div>
        <Badge variant="warning">Conflict — two answers disagree</Badge>
        <div className="text-[11px] text-gray-400 mt-1">
          {proposal.topic_name || 'Base'}{proposal.reason ? ` · ${proposal.reason}` : ''}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'Answer A', q: proposal.faq_a_question, a: proposal.faq_a_answer },
          { label: 'Answer B', q: proposal.faq_b_question, a: proposal.faq_b_answer },
        ].map(({ label, q, a }) => (
          <div key={label} className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
            <div className="text-[10px] text-gray-400 mb-1">{label}</div>
            <div className="text-sm font-semibold text-gray-800">{q}</div>
            <div className="text-xs text-gray-500 mt-1">{a}</div>
          </div>
        ))}
      </div>
      <FormActions>
        <Button variant="secondary" size="sm" onClick={dismiss}>I've fixed it — dismiss</Button>
      </FormActions>
    </div>
  );
}

// ─── FAQ Row ───────────────────────────────────────────────────
function FaqRow({ faq, first, last, onMove, onChanged }) {
  const [editing, setEditing]           = useState(false);
  const [expanded, setExpanded]         = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [form, setForm] = useState({
    question: faq.question, answer: faq.answer,
    verbatim: faq.verbatim, pinned: faq.pinned,
    mediaAssetId: faq.media_asset_id,
  });
  const [history, setHistory] = useState(null);
  const [media, setMedia]     = useState(null);
  const toast = useToast();

  useEffect(() => {
    if (!editing || media) return;
    api.media(faq.topic_id).then((d) => setMedia(d.media || [])).catch(() => {});
  }, [editing, faq.topic_id, media]);

  const save = async () => {
    try { await api.updateFaq(faq.id, form); setEditing(false); toast.success('Answer updated'); onChanged(); }
    catch (e) { toast.error(e.message); }
  };
  const remove  = async () => { await api.deleteFaq(faq.id); toast.success('Answer removed'); onChanged(); };
  const approve = async () => { await api.updateFaq(faq.id, { active: true }); toast.success('Answer approved and now live'); onChanged(); };

  const toggleHistory = async () => {
    if (history) return setHistory(null);
    const d = await api.faqVersions(faq.id);
    setHistory(d.versions || []);
  };
  const restore = async (vId) => { await api.rollbackFaq(vId); setHistory(null); toast.success('Restored to previous version'); onChanged(); };

  if (editing) return (
    <div className="px-4 py-4 border-b border-gray-100 last:border-0 flex flex-col gap-3">
      <input className="field-input" value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} placeholder="Question" />
      <textarea className="field-textarea" value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} rows={4} placeholder="Answer" />
      <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
        <input type="checkbox" className="rounded" checked={form.verbatim} onChange={(e) => setForm({ ...form, verbatim: e.target.checked })} />
        Quote this answer word-for-word (use for exact prices or timelines)
      </label>
      <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
        <input type="checkbox" className="rounded" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />
        Always include, even if the knowledge base needs to be trimmed
      </label>
      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide" style={{ letterSpacing: '0.06em' }}>Attach a file (optional)</label>
        <select className="field-input" value={form.mediaAssetId ?? ''} onChange={(e) => setForm({ ...form, mediaAssetId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">No file</option>
          {(media || []).map((m) => <option key={m.id} value={m.id}>{m.filename}{m.description ? ` — ${m.description}` : ''}</option>)}
        </select>
        <p className="text-[11px] text-gray-400">The AI will send this file when it uses this answer and the customer asked about what it shows.</p>
      </div>
      <FormActions>
        <Button variant="primary" size="sm" onClick={save}>Save</Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
      </FormActions>
    </div>
  );

  return (
    <div className="border-b border-gray-100 last:border-0">
      {/* Row head */}
      <div
        className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-gray-800">{faq.question}</span>
            {faq.verbatim       && <Badge variant="neutral" className="text-[10px]">word-for-word</Badge>}
            {faq.pinned         && <Badge variant="neutral" className="text-[10px]">always included</Badge>}
            {faq.media_asset_id && <Badge variant="success" className="text-[10px]">has file</Badge>}
            {!faq.active        && <Badge variant="warning" className="text-[10px]">awaiting review</Badge>}
          </div>
          {!expanded && <div className="text-xs text-gray-400 mt-0.5 truncate">{faq.answer}</div>}
        </div>
        {/* Actions — stop propagation so click doesn't toggle row */}
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 disabled:opacity-30 text-[13px]" title="Move up" disabled={first} onClick={() => onMove(-1)}>↑</button>
          <button className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 disabled:opacity-30 text-[13px]" title="Move down" disabled={last} onClick={() => onMove(1)}>↓</button>
          {!faq.active && <Button variant="primary" size="sm" onClick={approve}>Approve</Button>}
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
          {!deleteConfirm
            ? <Button variant="danger-ghost" size="sm" onClick={() => setDeleteConfirm(true)}>Delete</Button>
            : (
              <span className="flex items-center gap-1 text-xs text-gray-500">
                Delete?
                <Button variant="danger" size="sm" onClick={remove}>Yes</Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(false)}>No</Button>
              </span>
            )
          }
        </div>
      </div>
      {/* Expanded */}
      {expanded && (
        <div className="px-4 pb-4 text-sm text-gray-600 leading-relaxed bg-gray-50/50">
          <p className="mb-3">{faq.answer}</p>
          {history && (
            <div className="border border-gray-200 rounded-lg overflow-hidden mb-3">
              {history.length === 0
                ? <div className="p-3 text-xs text-gray-400">No previous versions.</div>
                : history.map((v) => (
                  <div key={v.id} className="flex items-start gap-3 px-4 py-3 border-b border-gray-100 last:border-0">
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-gray-400">{new Date(v.created_at).toLocaleString()} by {v.actor || 'system'}</div>
                      <div className="text-xs text-gray-600 mt-1">{v.answer}</div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => restore(v.id)}>Restore</Button>
                  </div>
                ))
              }
            </div>
          )}
          <button
            className="text-[11px] text-[var(--accent-text)] hover:text-[var(--accent)] transition-colors"
            onClick={toggleHistory}
          >
            {history ? 'Hide history' : 'View history'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Pack Settings ─────────────────────────────────────────────
function PackSettings({ topicId, onChanged }) {
  const [topic, setTopic] = useState(null);
  const [form, setForm]   = useState({ description: '', keywords: '' });
  const toast = useToast();

  useEffect(() => {
    api.topics().then((d) => {
      const t = (d.topics || []).find((x) => String(x.id) === String(topicId));
      if (t) { setTopic(t); setForm({ description: t.description || '', keywords: t.keywords || '' }); }
    }).catch(() => {});
  }, [topicId]);

  const save = async () => {
    try {
      await api.updateTopic(topicId, { description: form.description.trim() || null, keywords: form.keywords.trim() || null });
      toast.success('Pack settings saved');
      onChanged?.();
    } catch (e) { toast.error(e.message); }
  };

  if (!topic) return null;
  return (
    <Card className="mb-4">
      <CardHeader title={`Pack settings — ${topic.name}`} />
      <CardBody>
        <FormStack>
          <InputField label="Keywords"
            helper="When a customer's message contains any of these words, this pack is automatically included."
            placeholder="logo, branding, identity, redesign"
            value={form.keywords}
            onChange={(e) => setForm({ ...form, keywords: e.target.value })} />
          <InputField label="Description for the AI"
            helper="One sentence shown to the AI so it knows what this pack covers and when to ask for it."
            placeholder="Logo and brand identity design services"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <FormActions>
            <Button variant="primary" size="sm" onClick={save}>Save</Button>
          </FormActions>
        </FormStack>
      </CardBody>
    </Card>
  );
}

// ─── FAQ Pane ──────────────────────────────────────────────────
function FaqPane({ pack, onChange }) {
  const [data, setData]           = useState(null);
  const [question, setQuestion]   = useState('');
  const [answer, setAnswer]       = useState('');
  const [verbatim, setVerbatim]   = useState(false);
  const [raw, setRaw]             = useState('');
  const [addOpen, setAddOpen]     = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const toast = useToast();

  const reload = useCallback(() => {
    api.faqs(pack).then(setData).catch(() => {});
  }, [pack]);

  useEffect(() => { reload(); }, [reload]);

  const rows    = data?.faqs || [];
  const refresh = () => { reload(); onChange?.(); };

  const add = async () => {
    try {
      await api.addFaq({ topicId: pack === 'base' ? null : pack, question: question.trim(), answer: answer.trim(), verbatim });
      setQuestion(''); setAnswer(''); setVerbatim(false); setAddOpen(false);
      toast.success('Answer added');
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  const importText = async () => {
    try {
      const res = await api.importFaqs(raw, pack === 'base' ? null : pack);
      toast.success(`Added ${res.added}, skipped ${res.skipped} (already covered)`);
      setRaw(''); setImportOpen(false);
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  const move = async (index, delta) => {
    const next   = [...rows];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await api.reorderFaqs(next.map((r) => r.id));
    refresh();
  };

  if (!data) return <div className="p-6"><Skeleton height={14} width="60%" /></div>;

  return (
    <div>
      {pack !== 'base' && <PackSettings topicId={pack} onChanged={onChange} />}

      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-gray-400">{rows.length} answer{rows.length !== 1 ? 's' : ''}</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => { setImportOpen((v) => !v); setAddOpen(false); }}>Import document</Button>
          <Button variant="primary" size="sm" onClick={() => { setAddOpen((v) => !v); setImportOpen(false); }}>
            <Plus size={14} /> Add answer
          </Button>
        </div>
      </div>

      {addOpen && (
        <Card className="mb-4 p-4">
          <FormStack>
            <InputField label="Question" placeholder="e.g. What does a logo design cost?" value={question} onChange={(e) => setQuestion(e.target.value)} required />
            <InputField label="Answer" textarea placeholder="The answer, written the way you want it said" value={answer} onChange={(e) => setAnswer(e.target.value)} required />
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" className="rounded" checked={verbatim} onChange={(e) => setVerbatim(e.target.checked)} />
              Quote word-for-word (use for prices, timelines, and anything an approximation would get wrong)
            </label>
            <FormActions>
              <Button variant="primary" size="sm" onClick={add} disabled={!question.trim() || !answer.trim()}>Add answer</Button>
              <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            </FormActions>
          </FormStack>
        </Card>
      )}

      {importOpen && (
        <Card className="mb-4 p-4">
          <FormStack>
            <p className="text-sm text-gray-500 leading-relaxed">
              Paste an FAQ document, price list, or raw notes. We'll split it into individual answers automatically. Anything already in this pack is skipped.
            </p>
            <textarea
              className="field-textarea"
              placeholder="Paste Q: A: pairs or paragraphs…"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={10}
            />
            <FormActions>
              <Button variant="primary" size="sm" onClick={importText} disabled={!raw.trim()}>Split and add</Button>
              <Button variant="ghost" size="sm" onClick={() => setImportOpen(false)}>Cancel</Button>
            </FormActions>
          </FormStack>
        </Card>
      )}

      {rows.length === 0 && !addOpen && !importOpen && (
        <EmptyState message="No answers in this pack yet. Add one above or import a document." />
      )}

      {rows.length > 0 && (
        <Card>
          {rows.map((f, i) => (
            <FaqRow key={f.id} faq={f} first={i === 0} last={i === rows.length - 1}
              onMove={(delta) => move(i, delta)} onChanged={refresh} />
          ))}
        </Card>
      )}
    </div>
  );
}

// ─── Search Results ────────────────────────────────────────────
function FaqSearchResults({ query, onChange }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.searchFaqs(query).then(setData).catch(() => {}); }, [query]);
  const rows = data?.faqs || [];
  if (!data) return <div className="p-4"><Skeleton height={14} width="40%" /></div>;
  return (
    <div>
      <p className="text-sm text-gray-400 mb-4">
        {rows.length === 0 ? 'No answers match that search.' : `${rows.length} result${rows.length !== 1 ? 's' : ''} across all packs.`}
      </p>
      {rows.length > 0 && (
        <Card>
          {rows.map((f, i) => (
            <FaqRow key={f.id} faq={f} first={i === 0} last={i === rows.length - 1}
              onMove={() => {}} onChanged={() => { api.searchFaqs(query).then(setData).catch(() => {}); onChange?.(); }} />
          ))}
        </Card>
      )}
    </div>
  );
}

// ─── Media Pane ────────────────────────────────────────────────
function MediaPane({ topics }) {
  const [topicId, setTopicId]         = useState(null);
  const [data, setData]               = useState(null);
  const [file, setFile]               = useState(null);
  const [uploadTopicId, setUploadTopicId] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading]     = useState(false);
  const [deleteId, setDeleteId]       = useState(null);
  const toast = useToast();

  const reload = useCallback(() => { api.media(topicId).then(setData).catch(() => {}); }, [topicId]);
  useEffect(() => { reload(); }, [reload]);

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadMedia(file, uploadTopicId ? Number(uploadTopicId) : null, description.trim());
      setFile(null); setDescription('');
      toast.success('File uploaded');
      reload();
    } catch (e) { toast.error(e.message); }
    finally { setUploading(false); }
  };

  const remove = async () => { await api.deleteMedia(deleteId); setDeleteId(null); toast.success('File deleted'); reload(); };

  const rows = data?.media || [];

  return (
    <div>
      {/* Topic filter */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-lg w-fit flex-wrap">
        <button
          onClick={() => setTopicId(null)}
          className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${topicId === null ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500 hover:text-gray-700'}`}
        >
          All
        </button>
        {topics.map((t) => (
          <button
            key={t.id}
            onClick={() => setTopicId(t.id)}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${String(topicId) === String(t.id) ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500 hover:text-gray-700'}`}
          >
            {t.name}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-gray-400">{!data ? '' : `${rows.length} file${rows.length !== 1 ? 's' : ''}`}</span>
      </div>

      {/* Upload */}
      <Card className="mb-5">
        <CardHeader title="Upload a file" />
        <CardBody>
          <FormStack>
            <input type="file" className="text-sm text-gray-600" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide" style={{ letterSpacing: '0.06em' }}>Topic</label>
              <select className="field-input" value={uploadTopicId} onChange={(e) => setUploadTopicId(e.target.value)}>
                <option value="">No topic</option>
                {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <InputField label="Description" textarea
              helper="Describe what the file shows. The AI uses this to decide when to attach it to a reply."
              placeholder="e.g. Pricing sheet for logo design packages (updated 2024)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <FormActions>
              <Button variant="primary" size="sm" onClick={upload} disabled={!file || uploading}>
                {uploading ? 'Uploading…' : 'Upload'}
              </Button>
            </FormActions>
          </FormStack>
        </CardBody>
      </Card>

      {/* File list */}
      {!data ? (
        <Card><div className="p-5"><Skeleton height={14} width="60%" /></div></Card>
      ) : rows.length === 0 ? (
        <EmptyState message="No files uploaded yet. Upload one above." />
      ) : (
        <Card>
          {rows.map((m) => (
            <div key={m.id} className="flex items-center gap-4 px-4 py-3 border-b border-gray-100 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-800 truncate">{m.filename}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <Badge variant="neutral">{m.kind}</Badge>
                  <span className="text-xs text-gray-400">{topics.find((t) => t.id === m.topic_id)?.name || 'No topic'}</span>
                  {m.description && <span className="text-xs text-gray-400 truncate">{m.description}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {deleteId === m.id ? (
                  <span className="flex items-center gap-1 text-xs text-gray-500">
                    Delete?
                    <Button variant="danger" size="sm" onClick={remove}>Yes</Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteId(null)}>No</Button>
                  </span>
                ) : (
                  <Button variant="danger-ghost" size="sm" onClick={() => setDeleteId(m.id)}>Delete</Button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ─── Add Topic Inline ─────────────────────────────────────────
function AddTopicInline({ onCancel, onCreate }) {
  const [name, setName]             = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords]     = useState('');
  const toast = useToast();

  const submit = async () => {
    try { await onCreate(name.trim(), '', description.trim(), keywords.trim()); }
    catch (e) { toast.error(e.message); }
  };

  return (
    <Card className="mt-4 p-4">
      <FormStack>
        <div className="text-xs font-bold uppercase tracking-[0.07em] text-gray-500">Create a new service pack</div>
        <InputField label="Pack name" placeholder="e.g. Logo Design" value={name} onChange={(e) => setName(e.target.value)} required />
        <InputField label="Keywords" helper="Words that pull this pack in automatically when a customer mentions them." placeholder="logo, branding, identity" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
        <InputField label="Description for the AI" helper="One sentence so the AI knows what this pack covers." placeholder="Logo and brand identity design services" value={description} onChange={(e) => setDescription(e.target.value)} />
        <FormActions>
          <Button variant="primary" size="sm" onClick={submit} disabled={!name.trim()}>Create pack</Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </FormActions>
      </FormStack>
    </Card>
  );
}

// ─── Knowledge Page ────────────────────────────────────────────
export default function Knowledge() {
  const [packs, setPacks]           = useState([]);
  const [pack, setPack]             = useState('base');
  const [reloadKey, setReloadKey]   = useState(0);
  const [addTopicOpen, setAddTopicOpen] = useState(false);
  const [search, setSearch]         = useState('');
  const [simOpen, setSimOpen]       = useState(false);
  const [learning, setLearning]     = useState(false);
  const [tab, setTab]               = useState('answers');
  const [topics, setTopics]         = useState([]);
  const toast = useToast();

  const reloadPacks = useCallback(() => {
    api.packs().then((d) => setPacks(d.packs || [])).catch(() => {});
    api.topics().then((d) => setTopics(d.topics || [])).catch(() => {});
  }, []);

  useEffect(() => { reloadPacks(); }, [reloadPacks, reloadKey]);

  const runLearning = async () => {
    setLearning(true);
    try {
      const res   = await api.runRefinement();
      const gaps  = res.gaps?.proposed || 0;
      const contras = res.contradictions?.proposed || 0;
      const parts = [];
      if (gaps)   parts.push(`${gaps} gap${gaps !== 1 ? 's' : ''}`);
      if (contras) parts.push(`${contras} conflict${contras !== 1 ? 's' : ''}`);
      toast.success(parts.length ? `Found ${parts.join(' and ')} — review them above.` : 'Nothing new to flag this time.');
      setReloadKey((k) => k + 1);
    } catch (e) { toast.error(e.message); }
    finally { setLearning(false); }
  };

  const doExport = async () => {
    const data = await api.exportFaqs();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `answers-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const createTopic = async (name, slug, description, keywords) => {
    const res = await api.addTopic({ name, slug: slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), description, keywords });
    setAddTopicOpen(false);
    setReloadKey((k) => k + 1);
    setPack(res.topic.id);
    toast.success('Pack created');
  };

  return (
    <AdminPage
      title="AI Knowledge"
      subtitle="Everything your AI knows. The base pack goes into every conversation. Service packs go in when a lead came through a linked campaign or mentions relevant keywords."
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={doExport}>Export</Button>
          <Button variant="secondary" size="sm" onClick={runLearning} disabled={learning}>
            {learning ? 'Scanning…' : 'Find gaps & conflicts'}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setSimOpen(true)}>
            <FlaskConical size={14} /> Test AI
          </Button>
        </>
      }
    >
      {/* Proposals */}
      <Proposals reloadKey={reloadKey} onChange={() => setReloadKey((k) => k + 1)} />

      {/* Tabs: Answers / Media */}
      <TabPills
        tabs={[
          { key: 'answers', label: 'Answers' },
          { key: 'media',   label: 'Files & Media' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'answers' && (
        <>
          {/* Pack tabs */}
          <div className="flex gap-1.5 flex-wrap mb-5 items-center">
            {packs.map((p) => (
              <button
                key={p.slug}
                onClick={() => { setPack(p.topic_id ?? 'base'); setSearch(''); }}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors border ${
                  String(pack) === String(p.topic_id ?? 'base')
                    ? 'bg-[var(--accent-dim)] text-[var(--accent-text)] border-[var(--accent-dim)]'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {p.name}
                <span className="text-[10px] opacity-60">{p.faq_count}</span>
              </button>
            ))}
            <button
              className="px-3 py-1.5 rounded-md text-[12px] font-medium text-[var(--accent-text)] border border-dashed border-gray-300 hover:border-[var(--accent)] transition-colors"
              onClick={() => setAddTopicOpen(true)}
            >
              + New pack
            </button>
          </div>

          {/* Search */}
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2 mb-5">
            <Search size={14} className="text-gray-400 flex-shrink-0" />
            <input
              className="flex-1 text-sm outline-none placeholder:text-gray-400 bg-transparent"
              placeholder="Search across all packs…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600 cursor-pointer">×</button>
            )}
          </div>

          {search.trim()
            ? <FaqSearchResults query={search.trim()} onChange={() => setReloadKey((k) => k + 1)} />
            : <FaqPane key={`${pack}-${reloadKey}`} pack={pack} onChange={() => setReloadKey((k) => k + 1)} />
          }

          {addTopicOpen && (
            <AddTopicInline onCancel={() => setAddTopicOpen(false)} onCreate={createTopic} />
          )}
        </>
      )}

      {tab === 'media' && <MediaPane topics={topics} />}

      {simOpen && <SimulatorDrawer packs={packs} onClose={() => setSimOpen(false)} />}
    </AdminPage>
  );
}

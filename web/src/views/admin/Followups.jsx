import React, { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../../components/ui/Button.jsx';
import { InputField } from '../../components/ui/Field.jsx';
import Badge from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import { parseDripSteps } from '../../lib.js';
import {
  AdminPage, Section, Card, CardHeader, CardBody,
  FormStack, FormActions, Divider, EmptyState,
} from './Dashboard.jsx';

// ─── Templates ─────────────────────────────────────────────────
function Templates() {
  const [data, setData]         = useState(null);
  const [name, setName]         = useState('');
  const [category, setCategory] = useState('UTILITY');
  const [body, setBody]         = useState('');
  const [syncing, setSyncing]   = useState(false);
  const toast = useToast();

  const reload = () => api.templates().then(setData).catch(() => {});
  useEffect(() => { reload(); }, []);

  const sync = async () => {
    setSyncing(true);
    try {
      const d = await api.syncTemplates();
      toast.success(`Synced ${d.synced} templates from Meta`);
      reload();
    } catch (e) { toast.error(e.message); }
    finally { setSyncing(false); }
  };

  const create = async () => {
    try {
      await api.createTemplate(name.trim(), category, body.trim());
      toast.success('Submitted to Meta for approval. It will appear here once approved.');
      setName(''); setBody('');
    } catch (e) { toast.error(e.message); }
  };

  const templates = data?.templates || [];

  return (
    <Section
      title="Approved templates"
      subtitle="Templates are pre-approved messages you can send outside the 24-hour window. They must be approved by Meta before they appear here."
    >
      <div className="flex items-center justify-end mb-3">
        <Button variant="secondary" size="sm" onClick={sync} disabled={syncing}>
          <RefreshCw size={13} /> {syncing ? 'Syncing…' : 'Sync from Meta'}
        </Button>
      </div>

      {!data ? (
        <Card><div className="p-5"><Skeleton height={14} width="60%" /></div></Card>
      ) : templates.length === 0 ? (
        <EmptyState message="No approved templates yet. Create one below or click Sync to pull from Meta." />
      ) : (
        <Card className="mb-5">
          {templates.map((t) => (
            <div key={t.name} className="flex items-start gap-4 px-4 py-3 border-b border-gray-100 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-800">{t.name}</div>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="neutral">{t.category || 'utility'}</Badge>
                  {t.body && <span className="text-xs text-gray-400 italic truncate">{t.body}</span>}
                </div>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Card>
        <CardHeader title="Create a new template" />
        <CardBody>
          <FormStack>
            <p className="text-sm text-gray-500 leading-relaxed">
              Use{' '}
              <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">{'{{1}}'}</code>
              ,{' '}
              <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">{'{{2}}'}</code>
              {' '}for values you fill in when sending. Meta will review and approve it before it can be used.
            </p>
            <InputField
              label="Template name"
              helper="Lowercase with underscores only."
              placeholder="e.g. follow_up_day3"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide" style={{ letterSpacing: '0.06em' }}>
                Category
              </label>
              <select
                className="field-input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="UTILITY">Utility — service updates, follow-ups</option>
                <option value="MARKETING">Marketing — promotions, offers</option>
              </select>
            </div>
            <InputField
              label="Message body"
              textarea
              placeholder={`Hi {{1}}, thanks for getting in touch with us. We'd love to follow up — are you still interested?`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <FormActions>
              <Button variant="primary" size="sm" onClick={create} disabled={!name.trim() || !body.trim()}>
                Submit for approval
              </Button>
            </FormActions>
          </FormStack>
        </CardBody>
      </Card>
    </Section>
  );
}

// ─── Drip Follow-ups ────────────────────────────────────────────
function DripFollowups() {
  const [settings, setSettings] = useState(null);
  const [steps, setSteps]       = useState([]);
  const toast = useToast();

  useEffect(() => {
    api.getSettings().then((d) => {
      const s = d.settings;
      setSettings(s);
      setSteps(parseDripSteps(s.drip_steps || ''));
    }).catch(() => {});
  }, []);

  const save = async () => {
    const raw = steps.map((s) => `${s.template}:${s.days}`).join(',');
    try {
      await api.saveSettings({ drip_steps: raw });
      toast.success('Follow-up schedule saved');
    } catch (e) { toast.error(e.message); }
  };

  const updateStep = (i, field, value) =>
    setSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, [field]: value } : s));

  const addStep    = () => setSteps((prev) => [...prev, { step: prev.length + 1, template: '', days: '' }]);
  const removeStep = (i) =>
    setSteps((prev) => prev.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step: idx + 1 })));

  if (!settings) return <Skeleton height={14} width="60%" />;

  return (
    <Section
      title="Automated follow-up messages"
      subtitle="After the AI replies to a lead, it schedules these messages automatically. Each one uses a pre-approved template sent at the specified number of days after the last activity. The schedule resets every time a lead replies."
    >
      <Card>
        <CardBody>
          <FormStack>
            {steps.length === 0 && (
              <p className="text-sm text-gray-400">No follow-up steps configured. Add one below.</p>
            )}
            {steps.map((s, i) => (
              <div key={i} className="flex items-center gap-3">
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                  style={{ background: 'var(--accent)' }}
                >
                  {i + 1}
                </div>
                <input
                  className="field-input flex-1"
                  placeholder="Template name (e.g. drip_day3)"
                  value={s.template}
                  onChange={(e) => updateStep(i, 'template', e.target.value)}
                />
                <input
                  className="field-input"
                  style={{ width: 72 }}
                  type="number"
                  min={1}
                  placeholder="Days"
                  value={s.days}
                  onChange={(e) => updateStep(i, 'days', e.target.value)}
                  title="Days after the last reply"
                />
                <span className="text-xs text-gray-400 whitespace-nowrap">days after last reply</span>
                <button
                  onClick={() => removeStep(i)}
                  className="text-red-400 hover:text-red-600 transition-colors p-1 rounded flex-shrink-0"
                  title="Remove step"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <FormActions>
              <Button variant="ghost" size="sm" onClick={addStep}>
                <Plus size={14} /> Add step
              </Button>
              <Button variant="primary" size="sm" onClick={save}>Save schedule</Button>
            </FormActions>
          </FormStack>
        </CardBody>
      </Card>
    </Section>
  );
}

// ─── Followups Page ────────────────────────────────────────────
export default function Followups() {
  return (
    <AdminPage
      title="Follow-ups"
      subtitle="Manage the templates used for re-engagement and configure the automated follow-up schedule."
    >
      <Templates />
      <Divider />
      <DripFollowups />
    </AdminPage>
  );
}

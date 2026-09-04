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

// Templates
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
      title="Approved messages"
      subtitle="Ready-to-send messages that WhatsApp lets you use after 24 hours of silence. Meta must approve each one before it can be sent."
    >
      <div className="flex items-center justify-end mb-3">
        <Button variant="secondary" size="sm" onClick={sync} disabled={syncing}>
          <RefreshCw size={14} /> {syncing ? 'Syncing…' : 'Sync from Meta'}
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
                <div className="flex items-center gap-2 mt-1.5 min-w-0">
                  <Badge variant="neutral" className="flex-shrink-0">{t.category || 'utility'}</Badge>
                  {t.body && <span className="text-sm text-gray-500 italic truncate min-w-0">{t.body}</span>}
                </div>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Card>
        <CardHeader title="Write a new message" />
        <CardBody>
          <FormStack>
            <p className="text-sm text-gray-500 leading-relaxed">
              Use{' '}
              <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">{'{{1}}'}</code>
              ,{' '}
              <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">{'{{2}}'}</code>
              {' '}wherever you want to slot in a name or detail at send time. Meta will review before it goes live.
            </p>
            <InputField
              label="Short name for this message"
              helper="Lowercase with underscores. This is how you pick the message later."
              placeholder="e.g. gentle_reminder"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-base font-medium text-gray-800">Kind</label>
              <select
                className="field-input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="UTILITY">Service update or follow-up</option>
                <option value="MARKETING">Promotion or offer</option>
              </select>
            </div>
            <InputField
              label="What the message says"
              textarea
              placeholder={`Hi {{1}}, thanks for reaching out earlier. Are you still keen to move ahead?`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <FormActions>
              <Button variant="primary" size="sm" onClick={create} disabled={!name.trim() || !body.trim()}>
                Send to Meta for approval
              </Button>
            </FormActions>
          </FormStack>
        </CardBody>
      </Card>
    </Section>
  );
}

// Drip Follow-ups
function DripFollowups() {
  const [settings, setSettings] = useState(null);
  const [steps, setSteps]       = useState([]);
  const [templates, setTemplates] = useState([]);
  const toast = useToast();

  useEffect(() => {
    Promise.all([
      api.getSettings(),
      api.templates()
    ]).then(([d, t]) => {
      const s = d.settings;
      setSettings(s);
      setSteps(parseDripSteps(s.drip_steps || ''));
      setTemplates(t.templates.filter(tmpl => tmpl.status === 'APPROVED') || []);
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
      title="Chase quiet leads automatically"
      subtitle="When a lead goes silent, the system automatically sends a follow-up message from your approved templates. Simply pick the template to send, and how many days to wait. The clock resets the moment they reply, so no one gets chased twice."
    >
      <Card>
        <CardBody>
          <FormStack>
            <datalist id="template-options">
              {templates.map(t => <option key={t.name} value={t.name} />)}
            </datalist>
            {steps.length === 0 && (
              <p className="text-sm text-gray-500">No follow-ups set up yet. Add one below.</p>
            )}
            {steps.map((s, i) => (
              <div key={i} className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 p-3 md:p-0 border border-gray-100 md:border-0 rounded-lg">
                <div className="flex items-center gap-3 w-full md:w-auto md:flex-1">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white flex-shrink-0"
                    style={{ background: 'var(--accent)' }}
                  >
                    {i + 1}
                  </div>
                  <input
                    className="field-input w-full md:w-64"
                    list="template-options"
                    placeholder="e.g. drip_day3"
                    value={s.template}
                    onChange={(e) => updateStep(i, 'template', e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-2 pl-11 md:pl-0">
                  <span className="text-sm text-gray-500 flex-shrink-0">Wait</span>
                  <input
                    type="number"
                    min="1"
                    className="field-input w-20 text-center"
                    placeholder="Days"
                    value={s.days}
                    onChange={(e) => updateStep(i, 'days', e.target.value)}
                  />
                  <span className="text-sm text-gray-500 whitespace-nowrap flex-1 md:flex-none">days of silence</span>
                  <button
                    onClick={() => removeStep(i)}
                    className="text-red-400 hover:text-red-600 transition-colors p-1.5 rounded flex-shrink-0"
                    title="Remove"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            <FormActions>
              <Button variant="ghost" size="sm" onClick={addStep}>
                <Plus size={14} /> Add another
              </Button>
              <Button variant="primary" size="sm" onClick={save}>Save</Button>
            </FormActions>
          </FormStack>
        </CardBody>
      </Card>
    </Section>
  );
}

// Followups Page
export default function Followups() {
  return (
    <AdminPage
      title="Follow-ups"
      subtitle="Nudge quiet leads back into a conversation. Set the messages you want sent and the days they should go out."
    >
      <Templates />
      <Divider />
      <DripFollowups />
    </AdminPage>
  );
}

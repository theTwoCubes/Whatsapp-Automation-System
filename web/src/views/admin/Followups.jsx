import React, { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../../components/ui/Button.jsx';
import Badge from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import { parseDripSteps } from '../../lib.js';
import {
  AdminPage, Section, Card, CardHeader, CardBody,
  FormStack, FormActions, Divider, EmptyState,
} from './Dashboard.jsx';

// Approved messages. Authoring happens in WhatsApp Manager - this only pulls
// in the current approval status so the drip editor knows what it can offer.
function Templates() {
  const [data, setData]       = useState(null);
  const [syncing, setSyncing] = useState(false);
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

  const templates = data?.templates || [];

  return (
    <Section
      title="Approved messages"
      subtitle="Templates you've created and had approved in WhatsApp Manager. Sync here whenever you add or change one so the follow-up schedules below can use it."
    >
      <div className="flex items-center justify-end mb-3">
        <Button variant="secondary" size="sm" onClick={sync} disabled={syncing}>
          <RefreshCw size={14} /> {syncing ? 'Syncing…' : 'Sync from Meta'}
        </Button>
      </div>

      {!data ? (
        <Card><div className="p-5"><Skeleton height={14} width="60%" /></div></Card>
      ) : templates.length === 0 ? (
        <EmptyState message="No approved templates yet. Create one in WhatsApp Manager, then sync." />
      ) : (
        <Card>
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
    </Section>
  );
}

// The step-list editor, shared by the general sequence and every per-service
// one below. Templates are picked from a dropdown of what's actually synced
// and approved - never typed by hand, so a typo can't silently break a drip.
function StepsEditor({ steps, templates, onChange }) {
  const updateStep = (i, field, value) =>
    onChange(steps.map((s, idx) => idx === i ? { ...s, [field]: value } : s));

  const addStep    = () => onChange([...steps, { step: steps.length + 1, template: '', days: '' }]);
  const removeStep = (i) =>
    onChange(steps.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step: idx + 1 })));

  return (
    <FormStack>
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
            <select
              className="field-input w-full md:w-64"
              value={s.template}
              onChange={(e) => updateStep(i, 'template', e.target.value)}
            >
              <option value="">Choose an approved message…</option>
              {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              {s.template && !templates.some((t) => t.name === s.template) && (
                <option value={s.template}>{s.template} (not currently synced)</option>
              )}
            </select>
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
      </FormActions>
    </FormStack>
  );
}

// Drip Follow-ups. One schedule for General (leads not tied to a specific
// service) plus one per active service pack. Everything lives here now -
// there is nothing to configure from the Knowledge section.
function DripFollowups() {
  const [settings, setSettings]   = useState(null);
  const [topics, setTopics]       = useState([]);
  const [templates, setTemplates] = useState([]);
  const [audience, setAudience]   = useState('general');
  const [steps, setSteps]         = useState([]);
  const [dirty, setDirty]         = useState(false);
  const toast = useToast();

  const reload = () => Promise.all([api.getSettings(), api.topics(), api.templates()]).then(([s, t, tpl]) => {
    setSettings(s.settings);
    setTopics((t.topics || []).filter((x) => x.active));
    setTemplates(tpl.templates || []);
  }).catch(() => {});

  useEffect(() => { reload(); }, []);

  useEffect(() => {
    if (!settings) return;
    if (audience === 'general') {
      setSteps(parseDripSteps(settings.drip_steps || ''));
    } else {
      const topic = topics.find((t) => String(t.id) === audience);
      setSteps(parseDripSteps(topic?.drip_steps || ''));
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience, settings, topics]);

  const changeSteps = (next) => { setSteps(next); setDirty(true); };

  const save = async () => {
    const raw = steps.filter((s) => s.template && s.days).map((s) => `${s.template}:${s.days}`).join(',');
    try {
      if (audience === 'general') {
        await api.saveSettings({ drip_steps: raw });
      } else {
        await api.updateTopic(audience, { dripSteps: raw || null });
      }
      toast.success('Follow-up schedule saved');
      setDirty(false);
      reload();
    } catch (e) { toast.error(e.message); }
  };

  if (!settings) return <Skeleton height={14} width="60%" />;

  const audiences = [
    { id: 'general', label: 'General', helper: 'Leads not tied to a specific service.' },
    ...topics.map((t) => ({ id: String(t.id), label: t.name, helper: `Leads linked to "${t.name}".` })),
  ];
  const current = audiences.find((a) => a.id === audience) || audiences[0];

  return (
    <Section
      title="Chase quiet leads automatically"
      subtitle="When a lead goes silent, the system sends a follow-up from your approved templates. Pick a message and how many days to wait. The clock resets the moment they reply."
    >
      <Card>
        <CardHeader title="Which leads is this for?" />
        <CardBody>
          <div className="flex flex-wrap gap-2 mb-1">
            {audiences.map((a) => (
              <button
                key={a.id}
                onClick={() => setAudience(a.id)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                  a.id === audience
                    ? 'text-white border-transparent'
                    : 'text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
                style={a.id === audience ? { background: 'var(--accent)' } : undefined}
              >
                {a.label}
              </button>
            ))}
          </div>
          <p className="text-sm text-gray-500 mb-4">
            {current.helper}{' '}
            {audience !== 'general' && 'Leave this empty to use the General schedule instead.'}
          </p>
          <StepsEditor steps={steps} templates={templates} onChange={changeSteps} />
          <FormActions>
            <Button variant="primary" size="sm" onClick={save} disabled={!dirty}>Save</Button>
          </FormActions>
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

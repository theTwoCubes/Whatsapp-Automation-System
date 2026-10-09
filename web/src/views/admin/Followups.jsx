import React, { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../../components/ui/Button.jsx';
import Badge from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import { parseDripSteps } from '../../lib.js';
import {
  AdminPage, Card, CardHeader, CardBody,
  FormStack, FormActions, EmptyState,
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
    <div className="min-w-0">
      <div className="flex items-center justify-between mb-3">
        <div className="text-base md:text-xl font-semibold text-slate-800">Approved messages</div>
        <Button variant="secondary" size="sm" onClick={sync} disabled={syncing}>
          <RefreshCw size={14} /> {syncing ? 'Syncing…' : 'Sync'}
        </Button>
      </div>

      {!data ? (
        <Card><div className="p-5"><Skeleton height={14} width="60%" /></div></Card>
      ) : templates.length === 0 ? (
        <EmptyState message="No approved templates yet. Create one in WhatsApp Manager, then sync." />
      ) : (
        <Card className="min-h-[420px] max-h-[70vh] overflow-y-auto">
          {templates.map((t) => (
            <div key={t.name} className="px-4 py-3 border-b border-gray-100 last:border-0">
              <div className="text-sm font-semibold text-gray-800">{t.name}</div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                <Badge variant="neutral">{t.category || 'utility'}</Badge>
                {t.language && <Badge variant="neutral">{t.language}</Badge>}
                {MEDIA_HEADER_TYPES.includes(t.header_type) && (
                  <Badge variant="neutral">{t.header_type.toLowerCase()} header</Badge>
                )}
              </div>
              {/* The whole body, newlines and blank lines intact. This used to
                  be a one line `truncate`, which hid everything past the first
                  clipped line - useless for checking what a template actually
                  says before putting it in a follow up step. */}
              {t.body && (
                <div className="mt-2 text-sm text-gray-600 whitespace-pre-wrap break-words">{t.body}</div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

const MEDIA_HEADER_TYPES = ['DOCUMENT', 'IMAGE', 'VIDEO'];

// The step-list editor, shared by the general sequence and every per-service
// one below. Templates are picked from a dropdown of what's actually synced
// and approved - never typed by hand, so a typo can't silently break a drip.
// When the chosen template has a media header, a file picker appears so the
// step can attach one of the files already uploaded to Meta.
function StepsEditor({ steps, templates, media, onChange }) {
  const updateStep = (i, field, value) =>
    onChange(steps.map((s, idx) => idx === i ? { ...s, [field]: value } : s));

  const addStep    = () => onChange([...steps, { step: steps.length + 1, template: '', days: '', mediaAssetId: '' }]);
  const removeStep = (i) =>
    onChange(steps.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step: idx + 1 })));

  const templateFor = (name) => templates.find((t) => t.name === name);

  return (
    <FormStack>
      {steps.length === 0 && (
        <p className="text-sm text-gray-500">No follow-ups set up yet. Add one below.</p>
      )}
      {steps.map((s, i) => {
        const tpl = templateFor(s.template);
        const needsMedia = tpl && MEDIA_HEADER_TYPES.includes(tpl.header_type);
        return (
          <div key={i} className="flex flex-col gap-2 p-3 md:p-0 border border-gray-100 md:border-0 rounded-lg">
            <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
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
                  <option value="">Choose a message</option>
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
            {needsMedia && (
              <div className="flex items-center gap-2 pl-11">
                <span className="text-sm text-gray-500 flex-shrink-0">Attach file</span>
                <select
                  className="field-input w-full md:w-64"
                  value={s.mediaAssetId || ''}
                  onChange={(e) => updateStep(i, 'mediaAssetId', e.target.value)}
                >
                  <option value="">No file</option>
                  {media.map((m) => <option key={m.id} value={m.id}>{m.filename}</option>)}
                </select>
                <span className="text-xs text-gray-400">This template's header needs a {tpl.header_type.toLowerCase()}</span>
              </div>
            )}
          </div>
        );
      })}
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
  const [media, setMedia]         = useState([]);
  const [audience, setAudience]   = useState('general');
  const [steps, setSteps]         = useState([]);
  const [dirty, setDirty]         = useState(false);
  const toast = useToast();

  const reload = () => Promise.all([api.getSettings(), api.topics(), api.templates(), api.media()]).then(([s, t, tpl, m]) => {
    setSettings(s.settings);
    setTopics((t.topics || []).filter((x) => x.active));
    setTemplates(tpl.templates || []);
    setMedia(m.media || []);
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
    const raw = steps
      .filter((s) => s.template && s.days)
      .map((s) => (s.mediaAssetId ? `${s.template}:${s.days}:${s.mediaAssetId}` : `${s.template}:${s.days}`))
      .join(',');
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
    ...topics.map((t) => ({ id: String(t.id), label: t.name, helper: `Leads tied to ${t.name}.` })),
  ];
  const current = audiences.find((a) => a.id === audience) || audiences[0];

  return (
    <div className="min-w-0">
      <div className="text-base md:text-xl font-semibold text-slate-800 mb-3">Follow-up schedule</div>
      <Card>
        <CardHeader title="Which leads is this for?" />
        <CardBody>
          <select
            className="field-input w-full md:w-72 mb-1"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          >
            {audiences.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          <p className="text-sm text-gray-500 mb-4 mt-2">
            {current.helper}{' '}
            {audience !== 'general' && 'Leave this empty to use the General schedule instead.'}
          </p>
          <StepsEditor steps={steps} templates={templates} media={media} onChange={changeSteps} />
          <FormActions>
            <Button variant="primary" size="sm" onClick={save} disabled={!dirty}>Save</Button>
          </FormActions>
        </CardBody>
      </Card>
    </div>
  );
}

// Followups Page
export default function Followups() {
  return (
    <AdminPage
      title="Follow-ups"
      subtitle="Automatic messages whenever a lead goes silent."
    >
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 items-start">
        <DripFollowups />
        <Templates />
      </div>
    </AdminPage>
  );
}

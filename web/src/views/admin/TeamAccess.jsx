import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../../components/ui/Button.jsx';
import { InputField } from '../../components/ui/Field.jsx';
import Avatar from '../../components/ui/Avatar.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import Modal from '../../components/ui/Modal.jsx';
import {
  AdminPage, Section, Card, CardHeader, CardBody,
  FormStack, FormActions, EmptyState, TabPills,
} from './Dashboard.jsx';

// ─── Agents ────────────────────────────────────────────────────
function Agents() {
  const [data, setData]         = useState(null);
  const [email, setEmail]       = useState('');
  const [name, setName]         = useState('');
  const [password, setPassword] = useState('');
  const [removeId, setRemoveId] = useState(null);
  const toast = useToast();

  const reload = () => api.agents().then(setData).catch(() => {});
  useEffect(() => { reload(); }, []);

  const add = async () => {
    try {
      await api.addAgent(email, name, password);
      setEmail(''); setName(''); setPassword('');
      toast.success(`${name || email} added`);
      reload();
    } catch (e) { toast.error(e.message); }
  };

  const confirmRemove = async () => {
    try {
      await api.deleteAgent(removeId);
      setRemoveId(null);
      toast.success('Agent removed');
      reload();
    } catch (e) { toast.error(e.message); }
  };

  const agents = data?.agents || [];

  return (
    <Section title="Team members" subtitle="People who can sign into this console to handle conversations.">
      {!data ? (
        <Card><div className="p-5"><Skeleton height={14} width="60%" /></div></Card>
      ) : (
        <Card className="mb-5">
          {agents.length === 0
            ? <EmptyState message="No agents yet. Add the first one below." />
            : agents.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 last:border-0">
                <Avatar name={a.name || a.email} waId={a.email} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-800 truncate">{a.name || a.email}</div>
                  {a.name && <div className="text-xs text-gray-400">{a.email}</div>}
                </div>
                <Button variant="danger-ghost" size="sm" onClick={() => setRemoveId(a.id)}>Remove</Button>
              </div>
            ))
          }
        </Card>
      )}

      <Card>
        <CardHeader title="Add a team member" />
        <CardBody>
          <FormStack>
            <InputField label="Email address" placeholder="agent@company.com"
              value={email} onChange={(e) => setEmail(e.target.value)} required />
            <InputField label="Name (optional)" placeholder="Sarah Johnson"
              value={name} onChange={(e) => setName(e.target.value)} />
            <InputField label="Password" helper="Must be at least 6 characters." placeholder="••••••••"
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <FormActions>
              <Button variant="primary" size="sm" onClick={add}
                disabled={!email.trim() || password.length < 6}>
                <Plus size={14} /> Add team member
              </Button>
            </FormActions>
          </FormStack>
        </CardBody>
      </Card>

      {removeId && (
        <Modal
          title="Remove this team member?"
          body="They will immediately lose access to the console. This cannot be undone."
          confirmLabel="Remove"
          variant="danger"
          onConfirm={confirmRemove}
          onClose={() => setRemoveId(null)}
        />
      )}
    </Section>
  );
}

// ─── Branding ──────────────────────────────────────────────────
function Branding() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const toast = useToast();

  useEffect(() => {
    api.getSettings().then((d) => { setData(d); setForm(d.settings || {}); }).catch(() => {});
  }, []);

  const save = async () => {
    try {
      await api.saveSettings({
        brand_name:       form.brand_name,
        brand_watermark:  form.brand_watermark,
        support_email:    form.support_email,
        accent_color:     form.accent_color,
      });
      toast.success('Branding saved. Reload the page to apply the new colour.');
    } catch (e) { toast.error(e.message); }
  };

  if (!data) return <Skeleton height={14} width="60%" />;

  return (
    <Section
      title="White-label branding"
      subtitle="Personalise the console with your brand name and accent colour. These settings affect all agents on this account."
    >
      <Card>
        <CardBody>
          <FormStack>
            <InputField label="Brand name"
              helper="Appears in the sidebar and the browser tab."
              placeholder="Your Company Name"
              value={form.brand_name || ''}
              onChange={(e) => setForm({ ...form, brand_name: e.target.value })} />
            <InputField label="Support email"
              helper="Shown on the login screen for agents who need help."
              placeholder="support@yourcompany.com"
              value={form.support_email || ''}
              onChange={(e) => setForm({ ...form, support_email: e.target.value })} />
            <InputField label="Footer watermark"
              helper="Appears at the bottom of every conversation. Leave blank to hide it."
              placeholder="Powered by Your Company"
              value={form.brand_watermark || ''}
              onChange={(e) => setForm({ ...form, brand_watermark: e.target.value })} />

            {/* Accent color picker */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide" style={{ letterSpacing: '0.06em' }}>
                Accent colour
              </label>
              <div className="flex items-center gap-2.5">
                <input
                  type="color"
                  value={form.accent_color || '#00a884'}
                  onChange={(e) => setForm({ ...form, accent_color: e.target.value })}
                  className="w-11 h-9 rounded-md border border-gray-200 cursor-pointer p-0.5"
                />
                <input
                  className="field-input"
                  style={{ maxWidth: 140 }}
                  placeholder="#00a884"
                  value={form.accent_color || ''}
                  onChange={(e) => setForm({ ...form, accent_color: e.target.value })}
                />
              </div>
              <p className="text-[11px] text-gray-400 leading-relaxed">
                Used for buttons, active states, and highlights throughout the console.
              </p>
            </div>

            <FormActions>
              <Button variant="primary" size="md" onClick={save}>Save branding</Button>
            </FormActions>
          </FormStack>
        </CardBody>
      </Card>
    </Section>
  );
}

// ─── Audit Log ─────────────────────────────────────────────────
function AuditLog() {
  const [data, setData] = useState(null);
  useEffect(() => { api.audit().then(setData).catch(() => {}); }, []);

  const entries = data?.audit || [];

  return (
    <Section title="Audit log" subtitle="A record of recent actions taken in the console.">
      {!data ? (
        <Card><div className="p-5"><Skeleton height={14} width="80%" /></div></Card>
      ) : entries.length === 0 ? (
        <EmptyState message="No activity recorded yet." />
      ) : (
        <Card>
          {entries.map((a) => (
            <div key={a.id} className="flex items-start gap-4 px-4 py-3 border-b border-gray-100 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-800">
                  {a.action}
                  {a.target && (
                    <span className="font-normal text-gray-500 ml-1.5">{a.target}</span>
                  )}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {a.actor || 'system'} · {new Date(a.created_at).toLocaleString()}
                  {a.detail && ` · ${a.detail}`}
                </div>
              </div>
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}

// ─── Team & Access Page ────────────────────────────────────────
export default function TeamAccess() {
  const [tab, setTab] = useState('agents');

  return (
    <AdminPage
      title="Team & Access"
      subtitle="Manage who can access the console, your brand settings, and view the activity log."
    >
      <TabPills
        tabs={[
          { key: 'agents',   label: 'Team members' },
          { key: 'branding', label: 'Branding' },
          { key: 'audit',    label: 'Audit log' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'agents'   && <Agents />}
      {tab === 'branding' && <Branding />}
      {tab === 'audit'    && <AuditLog />}
    </AdminPage>
  );
}

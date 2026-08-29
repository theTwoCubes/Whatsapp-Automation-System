import React, { useEffect, useMemo, useState } from 'react';
import {
  UserPlus, Shield, Palette, History, Trash2, Check,
  Users,
} from 'lucide-react';
import { api } from '../../api.js';
import Button from '../../components/ui/Button.jsx';
import { InputField } from '../../components/ui/Field.jsx';
import Avatar from '../../components/ui/Avatar.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import Modal from '../../components/ui/Modal.jsx';
import { dayLabel } from '../../lib.js';
import { AdminPage } from './Dashboard.jsx';

// Shared bits reused across the three tabs on this page. Cards and rows here
// are larger and airier than the ones in Dashboard.jsx so this page reads more
// like the console than a dense settings screen.
function Panel({ children, className = '' }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-2xl overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

function PanelHeader({ icon: Icon, title, subtitle, right }) {
  return (
    <div className="flex items-center gap-4 px-6 py-4 border-b border-gray-100">
      {Icon && (
        <div className="w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0 bg-gray-100">
          <Icon size={20} className="text-gray-600" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xl font-semibold text-gray-900 truncate">{title}</div>
        {subtitle && <div className="text-base text-gray-500 mt-1">{subtitle}</div>}
      </div>
      {right && <div className="flex-shrink-0">{right}</div>}
    </div>
  );
}

function SideTabs({ tabs, active, onChange }) {
  return (
    <nav className="flex flex-col gap-1" role="tablist">
      {tabs.map(({ key, label, description, icon: Icon }) => {
        const isActive = active === key;
        return (
          <button
            key={key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(key)}
            className={`
              flex items-start gap-3 text-left px-4 py-3.5 rounded-xl transition-colors duration-100
              ${isActive
                ? 'bg-white border border-gray-200 shadow-xs'
                : 'border border-transparent hover:bg-white/60'}
            `}
          >
            <div
              className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                isActive ? 'text-white' : 'bg-gray-100 text-gray-500'
              }`}
              style={isActive ? { background: 'var(--accent)' } : undefined}
            >
              <Icon size={16} />
            </div>
            <div className="min-w-0">
              <div className={`text-sm font-semibold ${isActive ? 'text-gray-900' : 'text-gray-700'}`}>
                {label}
              </div>
              <div className="text-sm text-gray-500 leading-snug mt-0.5">{description}</div>
            </div>
          </button>
        );
      })}
    </nav>
  );
}

function EmptyPanel({ icon: Icon, title, hint }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4 text-center px-6">
      <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center">
        <Icon size={22} className="text-gray-400" />
      </div>
      <div>
        <div className="text-base font-semibold text-gray-700">{title}</div>
        {hint && <div className="text-sm text-gray-500 mt-1 max-w-[280px]">{hint}</div>}
      </div>
    </div>
  );
}

// Agents
function Agents() {
  const [data, setData]         = useState(null);
  const [email, setEmail]       = useState('');
  const [name, setName]         = useState('');
  const [password, setPassword] = useState('');
  const [removeId, setRemoveId] = useState(null);
  const [adding, setAdding]     = useState(false);
  const toast = useToast();

  const reload = () => api.agents().then(setData).catch(() => {});
  useEffect(() => { reload(); }, []);

  const add = async () => {
    setAdding(true);
    try {
      await api.addAgent(email, name, password);
      setEmail(''); setName(''); setPassword('');
      toast.success(`${name || email} added to the team`);
      reload();
    } catch (e) { toast.error(e.message); }
    finally { setAdding(false); }
  };

  const confirmRemove = async () => {
    try {
      await api.deleteAgent(removeId);
      setRemoveId(null);
      toast.success('Removed from the team');
      reload();
    } catch (e) { toast.error(e.message); }
  };

  const agents = data?.agents || [];
  const canAdd = email.trim() && password.length >= 6;
  const removing = removeId ? agents.find((a) => a.id === removeId) : null;

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelHeader
          icon={Users}
          title="Team members"
          subtitle={agents.length === 0
            ? 'Anyone here can sign in and reply to conversations.'
            : `${agents.length} ${agents.length === 1 ? 'person' : 'people'} can sign into this console.`}
        />
        {!data && (
          <div className="px-6 py-6 flex flex-col gap-4">
            <Skeleton height={18} width="70%" />
            <Skeleton height={18} width="50%" />
            <Skeleton height={18} width="60%" />
          </div>
        )}
        {data && agents.length === 0 && (
          <EmptyPanel
            icon={Users}
            title="No team members yet"
            hint="Add the first one using the form below. They will be able to sign in immediately."
          />
        )}
        {data && agents.map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-4 px-6 py-4 border-t border-gray-100 first:border-t-0 hover:bg-gray-50/70 transition-colors"
          >
            <Avatar name={a.name || a.email} waId={a.email} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold text-gray-900 truncate">
                {a.name || a.email}
              </div>
              <div className="text-sm text-gray-500 truncate mt-0.5">
                {a.name ? a.email : 'Team member'}
              </div>
            </div>
            <span
              className="text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0"
              style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
            >
              Agent
            </span>
            <button
              type="button"
              onClick={() => setRemoveId(a.id)}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors flex-shrink-0"
              title="Remove from team"
              aria-label="Remove team member"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </Panel>

      <Panel>
        <PanelHeader
          icon={UserPlus}
          title="Add a team member"
          subtitle="They will get sign-in access straight away."
        />
        <div className="px-6 py-6 flex flex-col gap-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <InputField
              label="Email address"
              placeholder="agent@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <InputField
              label="Full name"
              placeholder="Sarah Johnson"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <InputField
            label="Temporary password"
            helper="Must be at least 6 characters. Share it with the agent so they can sign in."
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="flex items-center justify-end pt-1">
            <Button
              variant="primary"
              size="sm"
              onClick={add}
              disabled={!canAdd || adding}
            >
              <UserPlus size={14} />
              {adding ? 'Adding…' : 'Add team member'}
            </Button>
          </div>
        </div>
      </Panel>

      {removeId && (
        <Modal
          title={`Remove ${removing?.name || removing?.email}?`}
          body="They will lose access to the console immediately. This cannot be undone."
          confirmLabel="Remove"
          variant="danger"
          onConfirm={confirmRemove}
          onClose={() => setRemoveId(null)}
        />
      )}
    </div>
  );
}

// Branding
const ACCENT_PRESETS = [
  { name: 'WhatsApp green', value: '#00a884' },
  { name: 'Ocean',          value: '#0083c0' },
  { name: 'Indigo',         value: '#5b6cff' },
  { name: 'Violet',         value: '#7f66ff' },
  { name: 'Rose',           value: '#e0417a' },
  { name: 'Amber',          value: '#d9772b' },
  { name: 'Slate',          value: '#4b5563' },
];

function Branding() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.getSettings().then((d) => { setData(d); setForm(d.settings || {}); }).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings({
        brand_name:   form.brand_name,
        accent_color: form.accent_color,
      });
      toast.success('Branding saved. Reload to apply the new accent colour.');
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  if (!data) {
    return (
      <Panel>
        <div className="px-6 py-6 flex flex-col gap-4">
          <Skeleton height={20} width="60%" />
          <Skeleton height={20} width="80%" />
          <Skeleton height={20} width="70%" />
        </div>
      </Panel>
    );
  }

  const accent = form.accent_color || '#00a884';

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelHeader
          icon={Palette}
          title="White-label branding"
          subtitle="Personalise the console for your business. Affects every agent."
        />
        <div className="px-6 py-5 flex flex-col gap-5">
          <InputField
            label="Brand name"
            helper="Shown in the sidebar and browser tab."
            placeholder="Your Company Name"
            value={form.brand_name || ''}
            onChange={(e) => setForm({ ...form, brand_name: e.target.value })}
          />

          {/* Accent picker */}
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-base font-medium text-gray-800">Accent colour</div>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                Buttons, tabs, and highlights use this colour.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {ACCENT_PRESETS.map((p) => {
                const isSelected = (form.accent_color || '').toLowerCase() === p.value.toLowerCase();
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setForm({ ...form, accent_color: p.value })}
                    className={`
                      relative w-10 h-10 rounded-xl transition-transform duration-100
                      ${isSelected ? 'scale-105 ring-2 ring-offset-2 ring-gray-800' : 'hover:scale-105'}
                    `}
                    style={{ background: p.value }}
                    title={p.name}
                    aria-label={p.name}
                    aria-pressed={isSelected}
                  >
                    {isSelected && (
                      <span className="absolute inset-0 flex items-center justify-center">
                        <Check size={16} className="text-white drop-shadow" />
                      </span>
                    )}
                  </button>
                );
              })}
              <div className="w-px h-8 bg-gray-200 mx-1" />
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="color"
                  value={accent}
                  onChange={(e) => setForm({ ...form, accent_color: e.target.value })}
                  className="w-10 h-10 rounded-xl border border-gray-200 cursor-pointer p-0.5 bg-white"
                  aria-label="Custom colour"
                />
                <input
                  className="field-input"
                  style={{ width: 130 }}
                  placeholder="#00a884"
                  value={form.accent_color || ''}
                  onChange={(e) => setForm({ ...form, accent_color: e.target.value })}
                />
              </label>
            </div>
          </div>

          <div className="flex items-center justify-end pt-1">
            <Button variant="primary" size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save branding'}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// Audit log
function actionAccent(action) {
  const a = (action || '').toLowerCase();
  if (a.includes('remove') || a.includes('delete') || a.includes('reject')) {
    return { bg: '#fee2e2', fg: '#b91c1c' };
  }
  if (a.includes('add') || a.includes('create') || a.includes('accept')) {
    return { bg: 'var(--accent-dim)', fg: 'var(--accent)' };
  }
  return { bg: '#e5e7eb', fg: '#374151' };
}

function AuditLog() {
  const [data, setData] = useState(null);
  const [dateFilter, setDateFilter] = useState('');
  useEffect(() => { api.audit().then(setData).catch(() => {}); }, []);

  const entries = data?.audit || [];

  const filteredEntries = useMemo(() => {
    if (!dateFilter) return entries;
    return entries.filter(e => {
      // Compare local date string YYYY-MM-DD
      const d = new Date(e.created_at);
      const tzOffset = d.getTimezoneOffset() * 60000;
      const localISOTime = (new Date(d - tzOffset)).toISOString().slice(0, -1);
      return localISOTime.split('T')[0] === dateFilter;
    });
  }, [entries, dateFilter]);

  const grouped = useMemo(() => {
    const groups = [];
    let current = null;
    for (const e of filteredEntries) {
      const label = dayLabel(e.created_at);
      if (!current || current.label !== label) {
        current = { label, items: [] };
        groups.push(current);
      }
      current.items.push(e);
    }
    return groups;
  }, [filteredEntries]);

  return (
    <Panel>
      <PanelHeader
        icon={History}
        title="Audit log"
        subtitle={filteredEntries.length === 0
          ? 'Console activity will show up here.'
          : `${filteredEntries.length} recent ${filteredEntries.length === 1 ? 'entry' : 'entries'}.`}
        right={
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="field-input h-10 px-3 text-sm"
          />
        }
      />
      <div className="max-h-[500px] overflow-y-auto">
        {!data && (
          <div className="px-6 py-6 flex flex-col gap-4">
            <Skeleton height={18} width="80%" />
            <Skeleton height={18} width="70%" />
            <Skeleton height={18} width="75%" />
          </div>
        )}
        {data && filteredEntries.length === 0 && (
          <EmptyPanel
            icon={History}
            title="Nothing to show"
            hint="No activity matches your filters, or nothing has happened yet."
          />
        )}
        {data && grouped.map((g) => (
          <div key={g.label}>
            <div className="sticky top-0 z-10 px-6 py-3.5 bg-gray-50/90 backdrop-blur-sm border-t border-b border-gray-100 text-sm font-bold uppercase tracking-widest text-gray-500">
              {g.label}
            </div>
            {g.items.map((a) => {
              const accent = actionAccent(a.action);
              return (
                <div
                  key={a.id}
                  className="flex flex-col px-6 py-5 border-b border-gray-100 last:border-0 hover:bg-gray-50/70 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-lg font-bold text-gray-900 capitalize">{a.action}</span>
                      {a.target && (
                        <span className="text-base text-gray-500 truncate">{a.target}</span>
                      )}
                    </div>
                    <div className="text-base text-gray-500 mt-2 flex flex-wrap items-center gap-2">
                      <span
                        className="text-sm font-semibold px-2.5 py-1 rounded-full"
                        style={{ background: accent.bg, color: accent.fg }}
                      >
                        {a.actor || 'system'}
                      </span>
                      <span className="text-gray-400">·</span>
                      <span>{new Date(a.created_at).toLocaleString()}</span>
                      {a.detail && (
                        <>
                          <span className="text-gray-400">·</span>
                          <span className="truncate">{a.detail}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Panel>
  );
}

// Page
export default function TeamAccess() {
  const [tab, setTab] = useState('agents');

  const tabs = [
    { key: 'agents',   label: 'Team members', description: 'Who can sign in',       icon: Users },
    { key: 'branding', label: 'Branding',     description: 'Name, colour, footer',  icon: Palette },
    { key: 'audit',    label: 'Audit log',    description: 'Recent activity',       icon: History },
  ];

  return (
    <AdminPage
      title="Team & Access"
      subtitle="Manage sign-in access, your brand look, and the record of what happened."
    >
      <div className="flex flex-col md:flex-row items-start gap-6 md:gap-8">
        <aside className="w-full md:w-[260px] flex-shrink-0 md:sticky top-0">
          <div className="mb-4 px-2 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-gray-500">
            <Shield size={13} />
            Settings
          </div>
          <SideTabs tabs={tabs} active={tab} onChange={setTab} />
        </aside>
        <div className="flex-1 min-w-0">
          {tab === 'agents'   && <Agents />}
          {tab === 'branding' && <Branding />}
          {tab === 'audit'    && <AuditLog />}
        </div>
      </div>
    </AdminPage>
  );
}

import React, { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../../api.js';
import { Skeleton } from '../../components/ui/Skeleton.jsx';

// Shared admin layout primitives
export function AdminPage({ title, subtitle, actions, children }) {
  return (
    <div className="w-full max-w-[1400px] mx-auto px-8 py-8">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-4xl font-bold text-gray-900 tracking-tight">{title}</h1>
          {subtitle && <p className="text-lg text-gray-500 mt-2 max-w-2xl leading-relaxed">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Section({ title, subtitle, children }) {
  return (
    <div className="mb-8">
      {title && <div className="text-xl font-semibold text-gray-900 mb-1.5">{title}</div>}
      {subtitle && <p className="text-base text-gray-500 mb-4 leading-relaxed max-w-2xl">{subtitle}</p>}
      {children}
    </div>
  );
}

export function Card({ children, className = '' }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-xl overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ title, children }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-100">
      {title && <div className="text-lg font-semibold text-gray-800">{title}</div>}
      {children}
    </div>
  );
}

export function CardBody({ children }) {
  return <div className="p-5">{children}</div>;
}

export function FormStack({ children }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

// A titled block inside a card. Sits one clear step above a field label
// (sm/semibold gray-900 vs sm/medium gray-800) so the eye reads it as a
// heading, not another label. Use inside CardBody to split a long form.
export function SubSection({ title, description, children }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-base font-semibold text-gray-900">{title}</div>
        {description && <p className="text-sm text-gray-500 mt-1 leading-relaxed">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function FormActions({ children }) {
  return <div className="flex items-center justify-end gap-2 pt-2">{children}</div>;
}

export function Divider() {
  return <div className="border-t border-gray-100 my-6" />;
}

export function TabPills({ tabs, active, onChange }) {
  return (
    <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-lg w-fit">
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-3.5 py-1.5 rounded-md text-sm font-medium transition-all duration-100 ${
            active === key
              ? 'bg-white text-gray-900 shadow-xs'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function ListRow({ left, right }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-100 last:border-0">
      <div className="flex-1 min-w-0">{left}</div>
      {right && <div className="flex-shrink-0 flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function EmptyState({ message }) {
  return (
    <div className="py-10 text-center text-sm text-gray-400">{message}</div>
  );
}

// StatCard
function StatCard({ num, label, sub }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6">
      <div className="text-5xl font-extrabold text-gray-900 tracking-tight mb-2">
        {num ?? '—'}
      </div>
      <div className="text-lg font-medium text-gray-600">{label}</div>
      {sub && <div className="text-sm text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

function SkeletonStat() {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <Skeleton height={32} width={60} style={{ marginBottom: 8 }} />
      <Skeleton height={12} width="70%" />
    </div>
  );
}

// Dashboard
export default function Dashboard() {
  const [data, setCampaigns]     = useState(null);  // renamed below
  const [overview, setOverview]  = useState(null);
  const [campaigns, setCampaignData] = useState(null);
  const [topics, setTopics]      = useState([]);
  const [error, setError]        = useState('');

  useEffect(() => {
    api.overview().then(setOverview).catch((e) => setError(e.message));
    api.campaigns().then(setCampaignData).catch(() => {});
    api.topics().then((d) => setTopics(d.topics || [])).catch(() => {});
  }, []);

  const linkTopic = async (campaignId, topicId) => {
    await api.linkCampaignTopic(campaignId, topicId || null);
    api.campaigns().then(setCampaignData).catch(() => {});
  };

  const o = overview?.overview;

  return (
    <AdminPage title="Dashboard" subtitle="An overview of conversations and lead activity.">
      {error && (
        <p className="text-sm text-red-500 mb-4">{error}</p>
      )}

      {/* Conversation stats */}
      <Section title="Conversations">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {!o
            ? Array.from({ length: 4 }).map((_, i) => <SkeletonStat key={i} />)
            : <>
                <StatCard num={o.leads}        label="Total leads" />
                <StatCard num={o.bot_chats}    label="Handled by AI"          sub="No human needed" />
                <StatCard num={o.pending_chats} label="Waiting for team"      sub="Needs attention" />
                <StatCard num={o.human_chats}  label="With a team member"     sub="Agent is handling" />
              </>
          }
        </div>
      </Section>

      {/* Message volume */}
      <Section title="Message volume">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {!o
            ? Array.from({ length: 3 }).map((_, i) => <SkeletonStat key={i} />)
            : <>
                <StatCard num={o.inbound}   label="Messages received" />
                <StatCard num={o.outbound}  label="Messages sent" />
                <StatCard num={o.campaigns} label="Ad campaigns tracked" />
              </>
          }
        </div>
      </Section>

      {/* Lead sources */}
      <Section
        title="Lead sources & Growth"
        subtitle="Each lead is tracked back to the ad that brought them in, or marked organic. Link a campaign to a knowledge topic so leads from that ad get answers tailored to that service."
      >
        <div className="flex flex-col gap-6 mb-4">
          <Card className="flex flex-col">
            <CardHeader title="Leads over last 30 days" />
            <CardBody>
              <div className="h-[320px] w-full pt-2">
                {!o?.leads_per_day ? (
                  <div className="w-full h-full flex flex-col gap-2">
                    <Skeleton height={200} width="100%" />
                    <Skeleton height={20} width="100%" />
                  </div>
                ) : o.leads_per_day.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-sm text-gray-400">
                    No leads in the last 30 days
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={o.leads_per_day} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 11, fill: '#9ca3af' }}
                        tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        axisLine={false}
                        tickLine={false}
                        minTickGap={20}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: '#9ca3af' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                        labelStyle={{ color: '#6b7280', fontSize: '12px', marginBottom: '4px' }}
                        itemStyle={{ color: '#111827', fontSize: '14px', fontWeight: 'bold' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="count"
                        name="Leads"
                        stroke="var(--accent)"
                        strokeWidth={3}
                        dot={{ r: 3, fill: 'var(--accent)', strokeWidth: 0 }}
                        activeDot={{ r: 5 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </CardBody>
          </Card>
        </div>
      </Section>

      <Section
        title="Campaign Performance"
        subtitle="Detailed breakdown of how each ad campaign is performing in terms of leads and message volume."
      >
        <Card className="flex flex-col">
          {!campaigns ? (
            <CardBody>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="mb-3">
                  <Skeleton height={14} width="50%" style={{ marginBottom: 4 }} />
                  <Skeleton height={12} width="80%" />
                </div>
              ))}
            </CardBody>
          ) : (
            <>
              {(campaigns.campaigns || []).map((c) => (
                <div key={c.id} className="flex items-center gap-5 px-6 py-4 border-b border-gray-100 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-bold text-gray-800 truncate">
                      {c.headline || `Campaign #${c.id}`}
                    </div>
                    <div className="text-sm text-gray-500 mt-1">
                      {c.source_type || 'Click-to-WhatsApp ad'} · since {new Date(c.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <span className="text-base font-medium text-gray-700 flex-shrink-0">{c.leads} lead{c.leads === '1' ? '' : 's'}</span>
                  <span className="text-base font-medium text-gray-700 flex-shrink-0">{c.inbound} in / {c.outbound} out</span>
                  <select
                    className="field-input h-10 px-3 text-sm"
                    style={{ width: 180 }}
                    value={c.topic_id || ''}
                    onChange={(e) => linkTopic(c.id, e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">No topic linked</option>
                    {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              ))}

              {campaigns.organic && (
                <div className="flex items-center gap-5 px-6 py-4 border-b border-gray-100 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-bold text-gray-800">Organic</div>
                    <div className="text-sm text-gray-500 mt-1">Leads with no ad referral</div>
                  </div>
                  <span className="text-base font-medium text-gray-700 flex-shrink-0">{campaigns.organic.leads || 0} lead{campaigns.organic.leads === '1' ? '' : 's'}</span>
                  <span className="text-base font-medium text-gray-700 flex-shrink-0">{campaigns.organic.inbound || 0} in / {campaigns.organic.outbound || 0} out</span>
                </div>
              )}

              {(campaigns.campaigns || []).length === 0 && !campaigns.organic && (
                <EmptyState message="No ad campaigns tracked yet. Leads that arrive through click-to-WhatsApp ads will appear here." />
              )}
            </>
          )}
        </Card>
      </Section>
    </AdminPage>
  );
}

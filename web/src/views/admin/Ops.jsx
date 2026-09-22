import React, { useEffect, useState, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { api } from '../../api.js';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import Button from '../../components/ui/Button.jsx';
import { AdminPage, Section, Card, CardHeader, CardBody } from './Dashboard.jsx';

// Seconds from a query into "2m", "3h 12m" - Stat already handles null as a
// dash, this only needs to handle a real number.
function formatDuration(seconds) {
  if (seconds == null) return null;
  const s = Number(seconds);
  if (s < 60) return `${Math.round(s)}s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function Stat({ label, value, unit = '', warn = false, ok = false }) {
  const valueColor = warn ? 'text-red-600' : ok ? 'text-green-600' : 'text-gray-900';
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs font-medium text-gray-500 uppercase tracking-wider truncate">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${valueColor}`}>
        {value === null || value === undefined ? <span className="text-gray-300">-</span> : value}
        {unit && value !== null && value !== undefined && (
          <span className="text-sm font-normal text-gray-500 ml-1">{unit}</span>
        )}
      </div>
    </div>
  );
}

function HandoffBar({ breakdown }) {
  if (!breakdown?.length) return null;
  const total = breakdown.reduce((s, r) => s + r.count, 0);
  const colors = [
    'bg-[var(--accent)]', 'bg-blue-500', 'bg-slate-400', 'bg-red-500',
    'bg-violet-500', 'bg-sky-500', 'bg-stone-400', 'bg-gray-400',
  ];
  return (
    <Card>
      <CardBody>
        <div className="flex h-4 rounded-full overflow-hidden gap-px mb-3">
          {breakdown.map((r, i) => (
            <div
              key={r.reason_category}
              className={colors[i % colors.length]}
              style={{ width: `${(r.count / total) * 100}%` }}
              title={`${r.reason_category}: ${r.count}`}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {breakdown.map((r, i) => (
            <div key={r.reason_category} className="flex items-center gap-1.5 text-xs text-gray-600">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${colors[i % colors.length]}`} />
              <span className="capitalize">{r.reason_category.replace(/_/g, ' ')}</span>
              <span className="text-gray-400 font-mono">{r.count}</span>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function ActivityChart({ data }) {
  return (
    <Card>
      <CardHeader title="Activity (24h)" />
      <CardBody>
        <div className="h-[280px] w-full pt-2">
          {!data ? (
            <Skeleton height={220} width="100%" />
          ) : data.length === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-gray-400">No activity yet</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="hour" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} minTickGap={20} />
                <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  labelStyle={{ color: '#6b7280', fontSize: '12px', marginBottom: '4px' }}
                  itemStyle={{ fontSize: '13px', fontWeight: 'bold' }}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Line type="monotone" dataKey="inbound" name="Received" stroke="var(--accent)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="outbound" name="Sent" stroke="#0083c0" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="handoffs" name="Handoffs" stroke="#d9772b" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

export default function Ops() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.ops());
    } catch (err) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const db = data?.db ?? {};
  const proc = data?.process ?? {};
  const deadLetterWarn = Number(db.dead_letter_depth) > 0;
  const errorRateWarn = Number(proc.aiErrorRate) >= 10;
  const poolWarn = Number(proc.poolWaiting) > 5;
  const latencyWarn = Number(db.ai_ms_p50_1h) > 5000;

  return (
    <AdminPage
      title="Ops"
      subtitle="System health, refreshed every 30s."
      actions={
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </Button>
      }
    >
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-6 text-sm text-red-700">
          <AlertTriangle size={16} className="flex-shrink-0" />
          {error}
        </div>
      )}

      <Section>
        <ActivityChart data={db.activity_hourly} />
      </Section>

      <Section title="Queue">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Pending" value={db.pending_chats} warn={Number(db.pending_chats) > 5} />
          <Stat label="Bot" value={db.bot_chats} />
          <Stat label="Human" value={db.human_chats} />
          <Stat label="Dead-letter" value={db.dead_letter_depth ?? 0} warn={deadLetterWarn} ok={!deadLetterWarn} />
        </div>
      </Section>

      <Section title="Lead funnel (30 days)">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Stat label="Avg first response" value={formatDuration(db.avg_first_response_seconds)} />
          <Stat label="Avg time to qualified" value={formatDuration(db.avg_time_to_qualification_seconds)} />
          <Stat label="Qualified leads" value={db.qualified_30d} />
        </div>
      </Section>

      {db.handoff_breakdown?.length > 0 && (
        <Section title="Handoff reasons (7 days)">
          <HandoffBar breakdown={db.handoff_breakdown} />
        </Section>
      )}

      <Section title="Process">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="AI latency avg" value={db.ai_ms_p50_1h} unit="ms" warn={latencyWarn} />
          <Stat label="Meta latency avg" value={db.meta_ms_p50_1h} unit="ms" />
          <Stat label="WS clients" value={proc.wsClients} />
          <Stat label="DB pool waiting" value={proc.poolWaiting} warn={poolWarn} ok={!poolWarn && proc.poolWaiting !== undefined} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
          <Stat label="AI error rate" value={proc.aiErrorRate} unit="%" warn={errorRateWarn} ok={!errorRateWarn && proc.aiOk !== undefined} />
          <Stat label="Memory" value={proc.memoryMb} unit="MB" />
          <Stat label="Uptime" value={proc.uptimeSeconds ? Math.round(proc.uptimeSeconds / 60) : null} unit="min" />
          <Stat label="Pool idle / total" value={proc.poolTotal !== undefined ? `${proc.poolIdle}/${proc.poolTotal}` : null} />
        </div>
      </Section>
    </AdminPage>
  );
}

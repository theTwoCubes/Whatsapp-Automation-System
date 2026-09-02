import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';
import { RefreshCw, AlertTriangle, CheckCircle, Clock, Zap, Database, Wifi } from 'lucide-react';

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
    'bg-green-500', 'bg-blue-500', 'bg-amber-500', 'bg-red-500',
    'bg-purple-500', 'bg-teal-500', 'bg-orange-500', 'bg-gray-400',
  ];
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 col-span-2">
      <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Handoff reasons (7 days)</div>
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
    </div>
  );
}

export default function Ops() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.ops();
      setData(res);
      setLastRefresh(new Date());
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
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Ops health</h1>
          {lastRefresh && (
            <p className="text-xs text-gray-400 mt-0.5">
              Updated {lastRefresh.toLocaleTimeString()} — auto-refreshes every 30s
            </p>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-6 text-sm text-red-700">
          <AlertTriangle size={16} className="flex-shrink-0" />
          {error}
        </div>
      )}

      <div className="mb-5">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">
          <Database size={12} /> Queue
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Pending" value={db.pending_chats} warn={Number(db.pending_chats) > 5} />
          <Stat label="Bot" value={db.bot_chats} />
          <Stat label="Human" value={db.human_chats} />
          <Stat
            label="Dead-letter"
            value={db.dead_letter_depth ?? 0}
            warn={deadLetterWarn}
            ok={!deadLetterWarn}
          />
        </div>
      </div>

      <div className="mb-5">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">
          <Zap size={12} /> Activity (24 h)
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Replies sent" value={db.replies_24h} />
          <Stat label="Handoffs" value={db.handoffs_24h} />
          <Stat label="AI latency avg" value={db.ai_ms_p50_1h} unit="ms" warn={latencyWarn} />
          <Stat label="Meta latency avg" value={db.meta_ms_p50_1h} unit="ms" />
        </div>
      </div>

      <div className="mb-5">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">
          <Wifi size={12} /> Process
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="WS clients" value={proc.wsClients} />
          <Stat
            label="AI error rate"
            value={proc.aiErrorRate}
            unit="%"
            warn={errorRateWarn}
            ok={!errorRateWarn && proc.aiOk !== undefined}
          />
          <Stat label="Memory" value={proc.memoryMb} unit="MB" />
          <Stat
            label="DB pool waiting"
            value={proc.poolWaiting}
            warn={poolWarn}
            ok={!poolWarn && proc.poolWaiting !== undefined}
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
          <Stat label="Uptime" value={proc.uptimeSeconds ? Math.round(proc.uptimeSeconds / 60) : null} unit="min" />
          <Stat label="AI ok" value={proc.aiOk} ok={Number(proc.aiOk) > 0} />
          <Stat label="AI errors" value={proc.aiErr} warn={Number(proc.aiErr) > 0} ok={Number(proc.aiErr) === 0} />
          <Stat label="Pool idle / total" value={proc.poolTotal !== undefined ? `${proc.poolIdle}/${proc.poolTotal}` : null} />
        </div>
      </div>

      {db.handoff_breakdown && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <HandoffBar breakdown={db.handoff_breakdown} />
        </div>
      )}
    </div>
  );
}

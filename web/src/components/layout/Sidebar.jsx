import React, { useContext } from 'react';
import {
  MessageSquare, LayoutDashboard, Brain, Mail, Settings, Users, LogOut,
} from 'lucide-react';
import { BrandContext } from '../../brand.js';
import Avatar from '../ui/Avatar.jsx';

const NAV = [
  { key: 'conversations', label: 'Conversations', icon: MessageSquare },
  { section: 'Admin' },
  { key: 'dashboard', label: 'Dashboard',    icon: LayoutDashboard },
  { key: 'knowledge',  label: 'AI Knowledge', icon: Brain },
  { key: 'followups',  label: 'Follow-ups',   icon: Mail },
  { key: 'setup',      label: 'Setup',        icon: Settings },
  { key: 'team',       label: 'Team & Access', icon: Users },
];

export default function Sidebar({ view, onNavigate, onLogout, pendingCount = 0, agentEmail, mobileOpen, onCloseMobile }) {
  const brand     = useContext(BrandContext);
  const brandName = brand?.name || 'Console';
  const initials  = brandName.slice(0, 2).toUpperCase();

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div 
          className="fixed inset-0 bg-black/40 z-40 md:hidden" 
          onClick={onCloseMobile} 
          aria-hidden="true"
        />
      )}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 md:relative md:flex
          w-[280px] flex-shrink-0 flex-col bg-white border-r border-gray-200 overflow-hidden
          transition-transform duration-200 ease-out
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
        aria-label="Main navigation"
      >
      {/* Brand */}
      <div className="flex items-center gap-3.5 px-6 h-[72px] border-b border-gray-200 flex-shrink-0">
        <img
          src="/logo.png"
          alt={brandName}
          className="w-12 h-12 rounded-lg object-cover flex-shrink-0 shadow-sm"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            e.currentTarget.nextSibling.style.display = 'flex';
          }}
        />
        {/* Fallback initials block (hidden if logo loads) */}
        <div
          className="w-12 h-12 rounded-lg items-center justify-center text-white font-bold text-lg flex-shrink-0 hidden shadow-sm"
          style={{ background: 'var(--accent)', display: 'none' }}
        >
          {initials}
        </div>
        <span className="font-bold text-lg text-gray-900 truncate">{brandName}</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4 flex flex-col gap-1 px-3">
        {NAV.map((item, idx) => {
          // Section label
          if (item.section !== undefined && !item.key) {
            return (
              <div
                key={`s-${idx}`}
                className="px-3 pt-5 pb-2 text-xs font-bold uppercase tracking-widest text-gray-400"
              >
                {item.section}
              </div>
            );
          }

          const Icon     = item.icon;
          const isActive = view === item.key;

          return (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              aria-current={isActive ? 'page' : undefined}
              className={`
                relative flex items-center gap-3 w-full px-4 py-3 rounded-xl text-base font-medium
                transition-colors duration-100 text-left
                ${isActive
                  ? 'bg-[var(--accent-dim)] text-[var(--accent-text)] font-semibold'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}
              `}
            >
              {/* Active indicator bar */}
              {isActive && (
                <span
                  className="absolute left-0 top-2 bottom-2 w-1 rounded-r-sm"
                  style={{ background: 'var(--accent)' }}
                />
              )}
              <Icon size={18} className="flex-shrink-0" />
              <span className="flex-1 truncate">{item.label}</span>
              {item.key === 'conversations' && pendingCount > 0 && (
                <span
                  className="flex-shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-white text-[10px] font-bold px-1"
                  style={{ background: 'var(--accent)' }}
                  aria-label={`${pendingCount} waiting`}
                >
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="flex items-center gap-3 px-5 py-4 border-t border-gray-200 flex-shrink-0">
        <Avatar name={agentEmail} waId={agentEmail} size="md" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-700 truncate">
            {agentEmail || 'Agent'}
          </div>
        </div>
        <button
          onClick={onLogout}
          title="Sign out"
          aria-label="Sign out"
          className="flex-shrink-0 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors p-2 rounded-lg"
        >
          <LogOut size={18} />
        </button>
      </div>
    </aside>
    </>
  );
}

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Bookmark, Check, Trash2, X } from 'lucide-react';
import { shortTime } from '../../lib.js';
import {
  subscribe, refresh, getState,
  markRead as storeMarkRead, markAll as storeMarkAll,
  deleteOne as storeDelete, deleteAll as storeDeleteAll,
  toggleSave as storeToggleSave,
} from '../../notificationStore.js';

export default function NotificationBell({ onOpenConversation }) {
  const [open, setOpen] = useState(false);
  const [{ items, unread, loading }, setStore] = useState(getState());
  const [filter, setFilter] = useState('all');
  const [coords, setCoords] = useState(null);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => subscribe(setStore), []);

  const place = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    const openUp = r.top > window.innerHeight / 2;
    const left = Math.min(Math.max(12, r.right - width), window.innerWidth - width - 12);
    setCoords({
      left,
      width,
      openUp,
      top: openUp ? undefined : r.bottom + 8,
      bottom: openUp ? window.innerHeight - r.top + 8 : undefined,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    refresh();
    const onDown = (e) => {
      if (buttonRef.current?.contains(e.target)) return;
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    const onReflow = () => place();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, place]);

  const onClickRow = (n) => {
    if (!n.read_at) storeMarkRead(n.id);
    setOpen(false);
    if (n.conversation_id && onOpenConversation) onOpenConversation(n.conversation_id);
  };

  const filtered = filter === 'saved' ? items.filter((n) => n.saved_at) : items;

  const panel = open && coords ? createPortal(
    <div
      ref={panelRef}
      className="fixed z-[9998] bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden"
      style={{ left: coords.left, top: coords.top, bottom: coords.bottom, width: coords.width }}
    >
      <div className="flex flex-col max-h-[70vh]">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
          <div className="text-sm font-bold text-gray-900">Notifications</div>
          <div className="flex items-center gap-1">
            {unread > 0 && (
              <button
                type="button"
                onClick={() => storeMarkAll()}
                className="text-xs font-semibold text-gray-600 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-100 inline-flex items-center gap-1"
                title="Mark all as read"
              >
                <Check size={12} /> Read all
              </button>
            )}
            {items.length > 0 && (
              <button
                type="button"
                onClick={() => storeDeleteAll()}
                className="text-xs font-semibold text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 inline-flex items-center gap-1"
                title="Delete all notifications"
              >
                <Trash2 size={12} /> Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-7 h-7 rounded hover:bg-gray-100 text-gray-500 flex items-center justify-center"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="flex gap-1 px-4 py-1.5 border-b border-gray-100">
          {['all', 'saved'].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${filter === f ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'}`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto">
          {loading && items.length === 0 && (
            <div className="px-4 py-6 text-sm text-gray-500 text-center">Loading...</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="px-4 py-8 text-sm text-gray-500 text-center">
              {filter === 'saved' ? 'No saved notifications.' : 'Nothing here yet.'}
            </div>
          )}
          {filtered.map((n) => (
            <div
              key={n.id}
              className={`relative group border-b border-gray-100 hover:bg-gray-50 ${n.read_at ? '' : 'bg-[var(--accent-dim)]'}`}
            >
              <button
                type="button"
                onClick={() => onClickRow(n)}
                className="w-full text-left px-4 py-2.5 flex items-start gap-3"
              >
                <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${n.read_at ? 'bg-transparent' : 'bg-[var(--accent)]'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-900 truncate">{n.title}</div>
                  {n.body && <div className="text-xs text-gray-600 line-clamp-2">{n.body}</div>}
                  <div className="text-[11px] text-gray-400 mt-0.5">{shortTime(n.created_at)}</div>
                </div>
              </button>
              <div className="absolute right-2 top-2 hidden group-hover:flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); storeToggleSave(n.id); }}
                  className={`w-6 h-6 rounded flex items-center justify-center hover:bg-gray-200 ${n.saved_at ? 'text-gray-900' : 'text-gray-400'}`}
                  title={n.saved_at ? 'Unsave' : 'Save'}
                >
                  <Bookmark size={13} fill={n.saved_at ? 'currentColor' : 'none'} />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); storeDelete(n.id); }}
                  className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50"
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        aria-expanded={open}
        className="relative flex items-center justify-center w-9 h-9 rounded-full hover:bg-gray-100 text-gray-700"
        title="Notifications"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 rounded-full bg-red-500 text-white text-[10px] font-bold px-1 flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {panel}
    </>
  );
}

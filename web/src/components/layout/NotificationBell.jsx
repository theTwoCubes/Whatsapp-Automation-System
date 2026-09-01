import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, X } from 'lucide-react';
import { shortTime } from '../../lib.js';
import { subscribe, refresh, getState, markRead as storeMarkRead, markAll as storeMarkAll } from '../../notificationStore.js';

// Bell in the top bar. Reads the in-app notification inbox from the server.
// A dot on the icon means there are unread rows. Clicking opens a drawer,
// clicking again closes it. Push on/off lives elsewhere — the bell is the
// inbox, not the push toggle.
export default function NotificationBell({ onOpenConversation }) {
  const [open, setOpen] = useState(false);
  const [{ items, unread, loading }, setStore] = useState(getState());
  const [coords, setCoords] = useState(null);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  // Subscribe to the shared inbox store so both bells share one poll.
  useEffect(() => subscribe(setStore), []);

  // Position the portal panel from the button's on-screen rect. The bell can
  // sit in the sidebar footer (bottom of the viewport) or the mobile top bar,
  // so we open upward when the button is in the lower half and clamp inside
  // the viewport. Rendering in a portal means no parent can clip it.
  const place = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
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
  }, [open, load, place]);

  const onClickRow = (n) => {
    if (!n.read_at) storeMarkRead(n.id);
    setOpen(false);
    if (n.conversation_id && onOpenConversation) onOpenConversation(n.conversation_id);
  };

  const markAll = () => storeMarkAll();

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
                  onClick={markAll}
                  className="text-xs font-semibold text-gray-600 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-100 inline-flex items-center gap-1"
                  title="Mark all as read"
                >
                  <Check size={12} /> Mark all read
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

          <div className="overflow-y-auto">
            {loading && items.length === 0 && (
              <div className="px-4 py-6 text-sm text-gray-500 text-center">Loading…</div>
            )}
            {!loading && items.length === 0 && (
              <div className="px-4 py-8 text-sm text-gray-500 text-center">Nothing here yet.</div>
            )}
            {items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => onClickRow(n)}
                className={`w-full text-left px-4 py-2.5 border-b border-gray-100 hover:bg-gray-50 flex items-start gap-3 ${n.read_at ? '' : 'bg-amber-50/40'}`}
              >
                <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${n.read_at ? 'bg-transparent' : 'bg-amber-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-900 truncate">{n.title}</div>
                  {n.body && <div className="text-xs text-gray-600 line-clamp-2">{n.body}</div>}
                  <div className="text-[11px] text-gray-400 mt-0.5">{shortTime(n.created_at)}</div>
                </div>
              </button>
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

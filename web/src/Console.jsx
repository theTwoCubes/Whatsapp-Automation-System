import React, {
  useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Search, Paperclip, Library, Send, Clock, AlertCircle,
  CheckCheck, Check, ChevronRight, X, MessageSquare,
  FileText, Image as ImageIcon, ChevronDown, LayoutList,
  Download, Film, Mic, Pencil, Bot, UserRound, MoreHorizontal, ArrowDown,
  Pin, PinOff, Archive, ArchiveRestore, BellOff, Bell,
} from 'lucide-react';
import { api, getToken } from './api.js';
import { BrandContext } from './brand.js';
import {
  shortTime, groupByDay, templateParamCount,
  useAlias, setAlias, displayName,
} from './lib.js';
import { playChime, applyBadge, setViewingConversation } from './notifications.js';
import Avatar from './components/ui/Avatar.jsx';
import { StateBadge } from './components/ui/Badge.jsx';
import Button from './components/ui/Button.jsx';
import { ChatRowSkeleton } from './components/ui/Skeleton.jsx';
import Modal from './components/ui/Modal.jsx';
import { useToast } from './components/ui/Toast.jsx';

// Module-scoped so the value persists across Console mount/unmount cycles
// (e.g. when the agent navigates to Admin and back).
let savedListScroll = 0;

// Helpers
function daysSince(dateStr) {
  if (!dateStr) return null;
  const d    = new Date(dateStr);
  const diff = Math.floor((new Date() - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return `${diff} days ago`;
}

function windowLabel(conv) {
  return conv.window_open
    ? { label: '24h window open', open: true }
    : { label: 'Window closed',   open: false };
}

// A WhatsApp style attachment card. The file lives on Meta and stays there
// until the agent hits Download, so nothing is written to the VPS disk. The
// blurred gradient is just a placeholder that mimics WhatsApp's low quality
// preview, since we do not have a real thumbnail to show.
function mediaKindLabel(type) {
  const map = { image: 'Photo', document: 'Document', video: 'Video', audio: 'Voice note' };
  return map[type] || 'File';
}

function mediaKindIcon(type, size = 22) {
  if (type === 'image') return <ImageIcon size={size} className="text-white" />;
  if (type === 'video') return <Film size={size} className="text-white" />;
  if (type === 'audio' || type === 'voice') return <Mic size={size} className="text-white" />;
  return <FileText size={size} className="text-white" />;
}

function prettyBytes(n) {
  if (!n && n !== 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function guessFilename(message) {
  if (message.media_filename) return message.media_filename;
  const kind = mediaKindLabel(message.type).toLowerCase();
  const ext = (message.media_mime || '').split('/')[1] || '';
  const stamp = new Date(message.created_at || Date.now()).toISOString().slice(0, 16).replace(/[:T-]/g, '');
  return ext ? `${kind}-${stamp}.${ext}` : `${kind}-${stamp}`;
}

function InboundAttachment({ message }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [size, setSize] = useState(null);
  // Object URL for inline previews (image / audio / video). Fetched once,
  // reused for both preview and the download button, and revoked on unmount
  // so we do not leak blob URLs when the thread rerenders.
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewMime, setPreviewMime] = useState(null);
  const outbound = message.direction === 'outbound';

  const previewable = message.type === 'image' || message.type === 'video' || message.type === 'audio' || message.type === 'voice';

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const ensureBlob = async () => {
    if (previewUrl) return { url: previewUrl, contentType: previewMime };
    const { url, size: bytes, contentType } = await api.mediaObjectUrl(message.id);
    setSize(bytes);
    setPreviewUrl(url);
    setPreviewMime(contentType);
    return { url, contentType };
  };

  const preview = async () => {
    if (previewUrl) return;
    setDownloading(true);
    setError(null);
    try { await ensureBlob(); } catch (err) { setError(err.message || 'Preview failed'); }
    finally { setDownloading(false); }
  };

  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      const { url, contentType } = await ensureBlob();
      const isNative = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
      if (isNative) {
        try {
          const resp = await fetch(url);
          const arrBuf = await resp.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(arrBuf)));
          const filename = guessFilename(message);
          const { Share } = await import(/* @vite-ignore */ '@capacitor/share');
          await Share.share({
            title: filename,
            url: `data:${contentType};base64,${base64}`,
            dialogTitle: `Open ${filename}`,
          });
        } catch {
          window.open(url, '_blank');
        }
      } else {
        const filename = guessFilename(message);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 60_000);
      }
    } catch (err) {
      setError(err.message || 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const filename = guessFilename(message);
  const subtitle = [mediaKindLabel(message.type), prettyBytes(size), message.media_mime]
    .filter(Boolean)
    .join(' · ');

  // Inline preview slot: image renders as a tap-to-download thumbnail, audio
  // and video render native controls. Anything else keeps the blurred
  // placeholder tile.
  const renderPreview = () => {
    if (previewable && previewUrl) {
      if (message.type === 'image') {
        return (
          <button type="button" onClick={download} className="block w-full">
            <img src={previewUrl} alt={filename} className="w-full max-h-72 object-cover" />
          </button>
        );
      }
      if (message.type === 'video') {
        return <video src={previewUrl} controls className="w-full max-h-72 bg-black" />;
      }
      if (message.type === 'audio' || message.type === 'voice') {
        return <audio src={previewUrl} controls className="w-full h-10 px-3 py-2" />;
      }
    }
    return (
      <div className="relative h-24 overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(135deg, #d9e5df 0%, #9fbdb1 45%, #6f8f83 100%)',
            filter: 'blur(14px)',
            transform: 'scale(1.2)',
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            type="button"
            onClick={previewable ? preview : download}
            disabled={downloading}
            className="w-12 h-12 rounded-full bg-black/35 backdrop-blur-sm flex items-center justify-center hover:bg-black/50 transition-colors disabled:opacity-60"
            aria-label={previewable ? 'Load preview' : 'Download'}
          >
            {mediaKindIcon(message.type)}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={`w-full max-w-[280px] rounded-xl overflow-hidden ${outbound ? 'bg-white/10' : 'bg-black/5'}`}>
      {renderPreview()}

      <div className={`flex items-center gap-3 px-3 py-2.5 ${outbound ? 'text-white' : 'text-gray-800'}`}>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate" title={filename}>{filename}</div>
          <div className={`text-xs truncate ${outbound ? 'text-white/70' : 'text-gray-500'}`}>
            {error || subtitle}
          </div>
        </div>
        <button
          type="button"
          onClick={download}
          disabled={downloading}
          className={`
            flex items-center justify-center w-9 h-9 rounded-full flex-shrink-0 transition-colors
            ${outbound
              ? 'bg-white/20 hover:bg-white/30 text-white'
              : 'bg-gray-800 hover:bg-black text-white'}
            disabled:opacity-60
          `}
          title="Download to your computer"
          aria-label="Download attachment"
        >
          <Download size={16} />
        </button>
      </div>
    </div>
  );
}

// Watermark
function Watermark() {
  const brand = useContext(BrandContext);
  if (!brand?.watermark) return null;
  return (
    <div className="text-center text-xs text-gray-400 px-4 py-1.5 border-t border-gray-100">
      {brand.watermark}
      {brand.supportEmail && (
        <> · <a href={`mailto:${brand.supportEmail}`} className="hover:underline">{brand.supportEmail}</a></>
      )}
    </div>
  );
}

// Ticks
function Ticks({ status }) {
  if (!status) return null;
  if (status === 'sent')
    return <span className="text-white inline-flex"><Check size={16} /></span>;
  if (status === 'delivered')
    return <span className="text-white inline-flex"><CheckCheck size={16} /></span>;
  if (status === 'read')
    return <span className="text-red-500 inline-flex"><CheckCheck size={16} /></span>;
  if (status === 'failed')
    return <span className="text-red-500 inline-flex" title="Failed to send"><AlertCircle size={16} /></span>;
  return null;
}

// Console Root
export default function Console({ onConversationsChange, onThreadOpen, onOpenConversation }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected]           = useState(null);
  const [thread, setThread]               = useState(null);
  const [templates, setTemplates]         = useState([]);
  const [query, setQuery]                 = useState('');
  const [filter, setFilter]               = useState('all');
  const [loading, setLoading]             = useState(true);
  const [showContext, setShowContext]     = useState(false);
  const selectedRef                        = useRef(null);
  const toast                              = useToast();

  // Ids that are currently pending, so we can detect *new* pending ones on
  // the next refresh and fire a chime/toast without repeating for chats that
  // were already waiting when we opened the tab.
  const knownPendingRef = useRef(null);

  const loadList = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { conversations: list } = await api.conversations({ archived: filter === 'archived' });
      setConversations(list);
      onConversationsChange?.(list);

      const pending = new Set(
        list.filter((c) => c.state === 'pending').map((c) => c.id),
      );
      if (knownPendingRef.current == null) {
        // First load, do not fire a chime for the backlog.
        knownPendingRef.current = pending;
      } else {
        const fresh = [...pending].filter((id) => !knownPendingRef.current.has(id));
        if (fresh.length > 0) {
          playChime();
          for (const id of fresh) {
            const c = list.find((x) => x.id === id);
            if (!c) continue;
            const name = c.name || c.wa_id;
            toast.warning(`${name} needs a person${c.handoff_reason ? ` · ${c.handoff_reason}` : ''}`, 8000);
          }
        }
        knownPendingRef.current = pending;
      }
      applyBadge(pending.size);
    } catch (err) {
      if (err.message !== 'unauthorized') toast.error('Could not load conversations');
    } finally {
      setLoading(false);
    }
  }, [toast, onConversationsChange]);

  const fetchCounter = useRef(0);

  const loadThread = useCallback(async (id) => {
    if (!id) return;
    const currentFetch = ++fetchCounter.current;
    try { 
      const data = await api.conversation(id);
      if (currentFetch === fetchCounter.current) {
        setThread(data); 
        loadList(true);
      }
    } catch {
      // show error state only when it's the current conversation
      if (currentFetch === fetchCounter.current) setThread('error');
    }
  }, [loadList]);

  useEffect(() => {
    loadList();
    api.templates().then((d) => setTemplates(d.templates || [])).catch(() => {});
  }, [loadList]);

  // Notify parent when thread opens/closes so the mobile top bar hides
  useEffect(() => {
    onThreadOpen?.(Boolean(selected));
  }, [selected, onThreadOpen]);

  // Android hardware back button — intercept via history
  useEffect(() => {
    selectedRef.current = selected;
    // Let the service worker know which chat is open so it can suppress
    // OS notifications for messages the agent is already reading.
    setViewingConversation(selected);
    if (!selected) { loadThread(null); return; }
    // Load the thread data
    loadThread(selected);
    // Push a dummy state so the back gesture has something to pop
    history.pushState({ chatOpen: true }, '');
    const onPop = () => {
      setSelected(null);
      setThread(null);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Leaving the Console entirely counts as no chat open.
      setViewingConversation(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // WebSocket real-time with reconnect indicator
  const [wsOffline, setWsOffline] = useState(false);
  const wsRetryRef = useRef(null);

  useEffect(() => {
    let delay = 1000;
    let ws;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/stream?token=${getToken()}`);
      ws.onopen = () => { setWsOffline(false); delay = 1000; };
      ws.onmessage = () => {
        loadList(true);
        if (selectedRef.current) loadThread(selectedRef.current);
      };
      ws.onclose = () => {
        setWsOffline(true);
        delay = Math.min(delay * 2, 30000);
        wsRetryRef.current = setTimeout(connect, delay);
      };
    }
    connect();
    return () => { clearTimeout(wsRetryRef.current); ws?.close(); };
  }, [loadList, loadThread]);

  const filtered = useMemo(() => {
    let list = conversations;
    // 'archived' pulls its own list from the server, so the state filter does
    // not apply to it — everything the server returned should show.
    if (filter !== 'all' && filter !== 'archived') list = list.filter((c) => c.state === filter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((c) =>
      (c.name || '').toLowerCase().includes(q) || (c.wa_id || '').includes(q)
    );
    return list;
  }, [conversations, query, filter]);

  const counts = useMemo(() => ({
    all:     conversations.length,
    pending: conversations.filter((c) => c.state === 'pending').length,
    bot:     conversations.filter((c) => c.state === 'bot').length,
    human:   conversations.filter((c) => c.state === 'human').length,
  }), [conversations]);

  const syncTemplates = useCallback(async () => {
    const d = await api.syncTemplates();
    setTemplates(d.templates || []);
  }, []);

  // Reload the list when the filter switches between archived and any other
  // filter, since the two hit different server slices.
  useEffect(() => { loadList(true); /* eslint-disable-next-line */ }, [filter === 'archived']);

  // Allow external callers (e.g. notification click) to open a conversation by id.
  useEffect(() => {
    if (!onOpenConversation) return;
    onOpenConversation.current = (id) => {
      const numId = Number(id);
      setFilter('all');
      setSelected(numId);
    };
    return () => { if (onOpenConversation) onOpenConversation.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onOpenConversation]);

  const FILTERS = [
    { key: 'all',     label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'bot',     label: 'AI' },
    { key: 'human',   label: 'Agent' },
    { key: 'archived', label: 'Archived' },
  ];

  // Scroll restoration for mobile list. Position lives in a module-
  // scoped mutable so it outlives Console remounts — switching to Admin and
  // back preserves the scroll where the agent left it.
  const listScrollRef = useRef(null);
  const listPosRef    = { get current() { return savedListScroll; }, set current(v) { savedListScroll = v; } };
  useEffect(() => {
    if (listScrollRef.current && savedListScroll > 0) {
      listScrollRef.current.scrollTop = savedListScroll;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden relative w-full">

      {/* Chat List */}
      <div className={`
        flex-shrink-0 flex-col border-r border-gray-200 bg-white overflow-hidden
        w-full md:w-[440px]
        ${selected ? 'hidden md:flex' : 'flex'}
      `}>

        {/* Search bar */}
        <div className="flex-shrink-0 px-3 md:px-4 py-3 md:py-4 border-b border-gray-200">
          <div className="flex items-center gap-2.5 bg-gray-100 rounded-lg px-3 md:px-4 py-2 md:py-2.5">
            <Search size={16} className="text-gray-400 flex-shrink-0" />
            <input
              className="flex-1 min-w-0 text-sm md:text-base outline-none placeholder:text-gray-400 bg-transparent text-gray-900"
              placeholder="Search conversations…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search conversations"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-gray-400 hover:text-gray-600">
                <X size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex flex-shrink-0 border-b border-gray-100 px-2 md:px-4 gap-1 md:gap-2 overflow-x-auto" role="tablist">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
              className={`
                relative flex items-center gap-1.5 px-3 md:px-4 py-3 text-sm md:text-base font-medium transition-colors duration-100 whitespace-nowrap flex-shrink-0
                ${filter === key
                  ? 'text-gray-900'
                  : 'text-gray-400 hover:text-gray-600'}
              `}
            >
              {label}
              {filter === key && (
                <span
                  className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full"
                  style={{ background: 'var(--accent)' }}
                />
              )}
              {key === 'pending' && counts.pending > 0 && (
                <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold px-1">
                  {counts.pending}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Conversation list */}
        <div
          className="flex-1 overflow-y-auto"
          role="list"
          ref={listScrollRef}
          onScroll={() => { listPosRef.current = listScrollRef.current?.scrollTop ?? 0; }}
        >
          {loading && Array.from({ length: 6 }).map((_, i) => <ChatRowSkeleton key={i} />)}
          {!loading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center h-40 text-sm text-gray-400 px-6 text-center">
              {query ? 'No conversations match your search.' : 'No conversations yet.'}
            </div>
          )}
          {!loading && filtered.map((c) => {
            const isActive = String(selected) === String(c.id);
            return (
              <ConversationRow
                key={c.id}
                conversation={c}
                isActive={isActive}
                onSelect={() => {
                  setSelected(c.id);
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Thread */}
      <div className={`flex-1 flex-col min-h-0 overflow-hidden bg-white ${!selected ? 'hidden md:flex' : 'flex'}`}>
        {thread === 'error'
          ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 text-gray-400">
              <AlertCircle size={28} className="text-red-400" />
              <span className="text-sm">Could not load this conversation</span>
              <button
                className="text-sm px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700"
                onClick={() => loadThread(selected)}
              >Retry</button>
            </div>
          )
          : thread
          ? <ChatThread
              thread={thread}
              templates={templates}
              onSync={syncTemplates}
              onChanged={() => { loadThread(selected); loadList(true); }}
              showContext={showContext}
              onToggleContext={() => setShowContext(v => !v)}
              wsOffline={wsOffline}
              onBack={() => {
                listScrollRef.current && (listScrollRef.current.scrollTop = listPosRef.current);
                // Clean up the history entry we pushed when thread opened
                history.back();
              }}
            />
          : <EmptyChat />
        }
      </div>

      {/* Context Panel — on mobile it slides in on top, offset below the thread header */}
      <div
        className={`transition-[width,border] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] flex-shrink-0 bg-white overflow-hidden ${
          showContext && thread ? 'w-full md:w-[360px] border-l border-gray-200 fixed md:relative inset-0 md:inset-y-0 z-40' : 'w-0 border-l-0 border-transparent hidden md:block'
        }`}
      >
        <div className="w-full md:w-[360px] h-full flex flex-col">
          {thread && (
            <ContextPanel
              thread={thread}
              onChanged={() => { loadThread(selected); loadList(true); }}
              onCloseContext={() => setShowContext(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationRow({ conversation: c, isActive, onSelect }) {
  const alias = useAlias(c.wa_id);
  const name = alias || c.name || c.wa_id;
  // State-tinted left rail: amber for pending handoff, indigo while a human
  // is in the chat, transparent otherwise. Visible at a glance in a long list.
  const railColor =
    c.state === 'pending' ? 'bg-amber-500' :
    c.state === 'human'   ? 'bg-indigo-500' :
    'bg-transparent';
  return (
    <button
      role="listitem"
      onClick={onSelect}
      aria-current={isActive ? 'true' : undefined}
      className={`
        relative w-full flex items-center gap-3 md:gap-4 px-4 md:px-5 py-3.5 md:py-4 border-b border-gray-100 text-left transition-colors duration-100 cursor-pointer
        ${isActive
          ? 'bg-gray-100'
          : c.state === 'pending'
            ? 'bg-amber-50/50 hover:bg-amber-50'
            : 'hover:bg-gray-50'}
      `}
    >
      <span aria-hidden="true" className={`absolute left-0 top-0 bottom-0 w-1 ${railColor}`} />
      <Avatar name={name} waId={c.wa_id} size="xl" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-base md:text-lg font-bold text-gray-900 truncate flex items-center gap-1.5">
            {c.pinned_at && <Pin size={12} className="text-amber-600 flex-shrink-0" aria-label="Pinned" />}
            <span className="truncate">{name}</span>
          </span>
          <span className="text-xs md:text-base font-medium text-gray-400 flex-shrink-0">{shortTime(c.last_at)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={`text-sm md:text-base truncate ${c.unread_count > 0 ? 'text-gray-900 font-semibold' : 'text-gray-500'}`}>
            {c.last_message || 'No messages yet'}
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {c.state === 'human' && (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 bg-indigo-100 px-1.5 py-0.5 rounded-full">You</span>
            )}
            {c.unread_count > 0 ? (
              <span className="min-w-[22px] h-[22px] rounded-full flex items-center justify-center bg-amber-500 text-white text-xs font-bold px-1.5" aria-label={`${c.unread_count} unread`}>
                {c.unread_count}
              </span>
            ) : c.state === 'pending' ? (
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500" aria-label="Needs attention" />
            ) : null}
          </div>
        </div>
      </div>
    </button>
  );
}

// Inline nickname editor. Frontend only — never touches the backend. Clicking
// the pencil turns the name into an input; Enter or blur commits, Escape or
// clearing the field wipes the alias.
function EditableName({ waId, fallback, className }) {
  const alias = useAlias(waId);
  const current = alias || fallback || waId || '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  useEffect(() => { if (!editing) setDraft(current); }, [current, editing]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() === (current || '').trim()) return;
    setAlias(waId, draft);
  };

  if (editing) {
    return (
      <input
        autoFocus
        className={`${className || ''} bg-transparent border-b border-gray-300 outline-none min-w-0`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setDraft(current); setEditing(false); }
        }}
      />
    );
  }
  return (
    <span className={`flex items-center gap-1.5 min-w-0 group ${className || ''}`}>
      <span className="truncate min-w-0">{current}</span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex-shrink-0 text-gray-400 hover:text-gray-600 md:opacity-60 md:hover:opacity-100 transition-opacity"
        title={alias ? 'Rename this contact' : 'Give this contact a nickname'}
        aria-label="Rename contact"
      >
        <Pencil size={13} />
      </button>
    </span>
  );
}

// Empty Chat
function EmptyChat() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-gray-100">
        <MessageSquare size={28} className="text-gray-400" />
      </div>
      <div className="text-center">
        <p className="text-base font-semibold text-gray-700 mb-1">No conversation selected</p>
        <p className="text-sm text-gray-400 max-w-[220px]">
          Choose a conversation from the list to view messages and reply.
        </p>
      </div>
    </div>
  );
}

// Context Panel
function ContextPanel({ thread, onChanged, onCloseContext }) {
  const { conversation: c } = thread;
  const toast               = useToast();

  const act = async (fn, successMsg) => {
    try {
      await fn();
      onChanged();
      if (successMsg) toast.success(successMsg);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const isBot     = c.state === 'bot';
  const isPending = c.state === 'pending';
  const isHuman   = c.state === 'human';

  return (
    <aside
      className="flex-1 flex flex-col bg-white overflow-y-auto"
      aria-label="Conversation details"
    >
      {/* Contact header */}
      <div className="flex items-center gap-4 px-4 md:px-6 py-4 md:py-6 border-b border-gray-100 relative" style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}>
        <button 
          className="md:hidden absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-700 bg-gray-50 rounded-full"
          style={{ top: 'calc(1rem + env(safe-area-inset-top))' }}
          onClick={onCloseContext}
        >
          <X size={18} />
        </button>
        <Avatar name={displayName({ waId: c.wa_id, name: c.name })} waId={c.wa_id} size="xl" />
        <div className="min-w-0 flex-1 pr-8 md:pr-0">
          <EditableName
            waId={c.wa_id}
            fallback={c.name}
            className="text-base md:text-xl font-bold text-gray-900 max-w-full"
          />
          <div className="text-xs md:text-sm text-gray-400 mt-1 truncate">{c.wa_id}</div>
        </div>
      </div>

      {/* Meta section */}
      <div className="px-4 md:px-6 py-4 md:py-5 border-b border-gray-100 flex flex-col gap-3">
        <div className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-1">Details</div>
        <ContextRow label="Status"><StateBadge state={c.state} /></ContextRow>
        {c.assignee && <ContextRow label="Agent"><span className="text-sm font-medium text-gray-700">{c.assignee}</span></ContextRow>}
        <ContextRow label="24h window">
          <span className={`text-sm font-medium ${c.window_open ? 'text-gray-900' : 'text-gray-500'}`}>
            {c.window_open ? 'Open' : 'Closed'}
          </span>
        </ContextRow>
        <ContextRow label="Started"><span className="text-sm font-medium text-gray-700">{daysSince(c.created_at)}</span></ContextRow>
        {c.handoff_reason && (
          <div className="flex flex-col gap-1 bg-amber-50 rounded-lg px-3 py-2">
            <span className="text-xs font-semibold text-amber-700">Reason flagged</span>
            <span className="text-xs text-amber-800 italic">"{c.handoff_reason}"</span>
          </div>
        )}
      </div>

      {/* Source */}
      {(c.topic_name || c.campaign_id) && (
        <div className="px-4 md:px-6 py-4 md:py-5 border-b border-gray-100 flex flex-col gap-3">
          <div className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-1">Source</div>
          <ContextRow label="Campaign"><span className="text-sm font-medium text-gray-700">{c.topic_name || `#${c.campaign_id}`}</span></ContextRow>
        </div>
      )}

      {/* Actions */}
      <div className="px-4 md:px-6 py-4 md:py-5 flex flex-col gap-2">
        <div className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">Actions</div>
        {isHuman && (
          <Button variant="secondary" size="lg" className="w-full justify-center"
            onClick={() => act(() => api.handback(c.id), 'Returned to AI')}>
            Give back to AI
          </Button>
        )}
        {isPending && (
          <>
            <Button variant="primary" size="lg" className="w-full justify-center"
              onClick={() => act(() => api.acceptHandoff(c.id), 'Conversation accepted')}>
              Accept conversation
            </Button>
            <Button variant="secondary" size="lg" className="w-full justify-center"
              onClick={() => act(() => api.rejectHandoff(c.id), 'Rejected, AI taking over')}>
              Reject
            </Button>
          </>
        )}
        {isBot && (
          <Button variant="secondary" size="lg" className="w-full justify-center"
            onClick={() => act(() => api.takeover(c.id), 'You have taken over this conversation')}>
            Take over
          </Button>
        )}
      </div>
    </aside>
  );
}

function ContextRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-gray-400 flex-shrink-0">{label}</span>
      <span className="text-xs text-right">{children}</span>
    </div>
  );
}

// Chat Thread
function ChatThread({ thread, templates, onSync, onChanged, showContext, onToggleContext, onBack, wsOffline }) {
  const { conversation, messages } = thread;
  const [text, setText]               = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const [showLibrary, setShowLibrary]     = useState(false);
  const [confirmMedia, setConfirmMedia]   = useState(null);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const endRef    = useRef(null);
  const inputRef  = useRef(null);
  const scrollRef = useRef(null);
  const toast     = useToast();

  // Only auto-focus on desktop, to avoid triggering keyboard popup immediately on mobile
  useEffect(() => { 
    if (window.innerWidth >= 768) inputRef.current?.focus(); 
  }, [conversation.id]);

  // Smart scroll: only jump to bottom if already near it
  const [showNewMsg, setShowNewMsg] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 120) {
      endRef.current?.scrollIntoView({ block: 'end' });
      setShowNewMsg(false);
    } else {
      setShowNewMsg(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);
  // On conversation switch always scroll to bottom
  useEffect(() => {
    setShowNewMsg(false);
    setTimeout(() => endRef.current?.scrollIntoView({ block: 'end' }), 50);
  }, [conversation.id]);

  const act = async (fn, successMsg) => {
    try {
      const result = await fn();
      setText('');
      await onChanged();
      if (successMsg) toast.success(successMsg);
      return result;
    } catch (err) {
      toast.error(err.message);
    }
  };

  const send = () => {
    if (!text.trim()) return;
    act(() => api.send(conversation.id, text.trim()), 'Message sent');
  };

  const groups    = groupByDay(messages);
  const isPending = conversation.state === 'pending';
  const isHuman   = conversation.state === 'human';
  const isBot     = conversation.state === 'bot';
  const win       = windowLabel(conversation);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* WS offline indicator */}
      {wsOffline && (
        <div className="flex items-center justify-center gap-2 bg-yellow-50 border-b border-yellow-200 text-yellow-800 text-xs py-1.5 px-4">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
          Reconnecting...
        </div>
      )}

      {/* Thread header */}
      <div 
        className="flex items-center gap-3 md:gap-4 px-4 md:px-5 py-3.5 border-b border-gray-200 flex-shrink-0 bg-white"
        style={{
          minHeight: 72,
          paddingTop: 'calc(0.875rem + env(safe-area-inset-top))',
        }}
      >
        {onBack && (
          <button 
            className="md:hidden p-2 -ml-2 text-gray-500 hover:text-gray-900"
            onClick={onBack}
            aria-label="Back to conversations"
          >
            <ChevronDown size={22} className="rotate-90" />
          </button>
        )}
        <Avatar
          name={displayName({ waId: conversation.wa_id, name: conversation.name })}
          waId={conversation.wa_id}
          size="lg"
        />
        <div className="flex-1 min-w-0">
          <EditableName
            waId={conversation.wa_id}
            fallback={conversation.name}
            className="text-sm md:text-base font-bold text-gray-900 max-w-full"
          />
          <div className="flex items-center gap-1.5 text-xs md:text-sm text-gray-400 mt-0.5 min-w-0">
            <span className="truncate">{conversation.wa_id}</span>
            {conversation.assignee && (
              <>
                <ChevronRight size={12} className="flex-shrink-0" />
                <span className="truncate">with {conversation.assignee}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 md:gap-3 flex-shrink-0">

          {isHuman && (
            <Button variant="secondary" size="sm" className="md:!h-10 md:!px-4 md:!text-base"
              onClick={() => act(() => api.handback(conversation.id), 'Returned to AI')}>
              <span className="hidden sm:inline">Give back to AI</span>
              <Bot size={16} className="sm:hidden" aria-label="Give back to AI" />
            </Button>
          )}
          {isPending && (
            <>
              <Button variant="secondary" size="sm" className="hidden sm:flex md:!h-10 md:!px-4 md:!text-base"
                onClick={() => act(() => api.rejectHandoff(conversation.id), 'Rejected')}>
                Reject
              </Button>
              <Button variant="primary" size="sm" className="md:!h-10 md:!px-4 md:!text-base"
                onClick={() => act(() => api.acceptHandoff(conversation.id), 'Accepted')}>
                Accept
              </Button>
            </>
          )}
          {!isHuman && !isPending && (
            <Button variant="secondary" size="sm" className="md:!h-10 md:!px-4 md:!text-base"
              onClick={() => act(() => api.takeover(conversation.id), 'You have taken over this conversation')}>
              <span className="hidden sm:inline">Take over</span>
              <UserRound size={16} className="sm:hidden" aria-label="Take over" />
            </Button>
          )}
          <div className="w-px h-8 bg-gray-200 mx-1 hidden md:block" />
          {/* Pin, archive, mute — small icon-only controls so the header
              stays terse. State drives icon (Pin vs PinOff etc.). */}
          <button
            onClick={() => act(() => api.pinConversation(conversation.id, !conversation.pinned_at),
              conversation.pinned_at ? 'Unpinned' : 'Pinned')}
            className={`hidden md:flex items-center justify-center w-10 h-10 rounded-lg transition-colors flex-shrink-0 ${conversation.pinned_at ? 'bg-amber-100 text-amber-700' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
            title={conversation.pinned_at ? 'Unpin' : 'Pin to top'}
            aria-label={conversation.pinned_at ? 'Unpin' : 'Pin'}
          >
            {conversation.pinned_at ? <PinOff size={18} /> : <Pin size={18} />}
          </button>
          <button
            onClick={() => act(() => api.muteConversation(conversation.id, conversation.muted_until && new Date(conversation.muted_until) > new Date() ? 0 : 8),
              conversation.muted_until && new Date(conversation.muted_until) > new Date() ? 'Unmuted' : 'Muted for 8h')}
            className={`hidden md:flex items-center justify-center w-10 h-10 rounded-lg transition-colors flex-shrink-0 ${conversation.muted_until && new Date(conversation.muted_until) > new Date() ? 'bg-gray-200 text-gray-700' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
            title={conversation.muted_until && new Date(conversation.muted_until) > new Date() ? 'Unmute' : 'Mute for 8 hours'}
            aria-label="Mute"
          >
            {conversation.muted_until && new Date(conversation.muted_until) > new Date() ? <BellOff size={18} /> : <Bell size={18} />}
          </button>
          <button
            onClick={() => act(() => api.archiveConversation(conversation.id, !conversation.archived_at),
              conversation.archived_at ? 'Unarchived' : 'Archived')}
            className={`hidden md:flex items-center justify-center w-10 h-10 rounded-lg transition-colors flex-shrink-0 ${conversation.archived_at ? 'bg-gray-200 text-gray-700' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
            title={conversation.archived_at ? 'Unarchive' : 'Archive'}
            aria-label={conversation.archived_at ? 'Unarchive' : 'Archive'}
          >
            {conversation.archived_at ? <ArchiveRestore size={18} /> : <Archive size={18} />}
          </button>
          <button
            onClick={onToggleContext}
            className={`flex items-center justify-center w-9 h-9 md:w-10 md:h-10 rounded-lg transition-colors flex-shrink-0 ${showContext ? 'bg-gray-200 text-gray-800' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
            title="Toggle Details"
          >
            <LayoutList size={18} />
          </button>
        </div>
      </div>

      {/* Handoff banner */}
      {isPending && conversation.handoff_reason && (
        <div className="flex items-start gap-3 px-3 md:px-5 py-3 md:py-4 bg-gray-50 border-b border-gray-200 flex-shrink-0">
          <AlertCircle size={16} className="text-gray-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-gray-900">Waiting for a team member</div>
            <div className="text-xs text-gray-600 mt-0.5 break-words">{conversation.handoff_reason}</div>
            <div className="flex gap-2 mt-3">
              <Button variant="primary" size="sm"
                onClick={() => act(() => api.acceptHandoff(conversation.id), 'Accepted').then(() => onChanged())}>
                Accept
              </Button>
              <Button variant="secondary" size="sm"
                onClick={() => act(() => api.rejectHandoff(conversation.id), 'Rejected, AI taking over').then(() => onChanged())}>
                Reject
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 md:px-5 py-4 md:py-5 chat-bg flex flex-col gap-1 min-w-0 relative"
        role="log"
        aria-live="polite"
      >
        {groups.map((g) => (
          <React.Fragment key={g.label}>
            {/* Day divider */}
            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-px bg-black/10" />
              <span className="text-xs text-gray-500 bg-white/80 px-3 py-1 rounded-full font-medium shadow-xs">
                {g.label}
              </span>
              <div className="flex-1 h-px bg-black/10" />
            </div>
            {g.items.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'} mb-1`}
              >
                <div
                  className={`
                    relative max-w-[85%] md:max-w-[72%] px-3 md:px-5 py-2 md:py-3 rounded-2xl text-sm md:text-lg leading-relaxed shadow-xs
                    break-words [overflow-wrap:anywhere]
                    ${m.direction === 'outbound' ? 'msg-outbound bg-gray-800 text-white rounded-br-sm' : 'msg-inbound bg-white text-gray-900 rounded-bl-sm border border-black/5'}
                    ${m.direction === 'outbound' ? 'pr-14' : ''}
                  `}
                >
                  {m.type !== 'text'
                    ? (
                      <div className="flex flex-col gap-1.5">
                        <InboundAttachment message={m} />
                        {m.body && <div className="pt-0.5 truncate">{m.body}</div>}
                      </div>
                    )
                    : m.body
                  }
                  <span className={`flex items-center justify-end gap-1 text-xs font-semibold mt-1.5 ${m.direction === 'outbound' ? 'text-white/60' : 'text-gray-500'}`}>
                    {shortTime(m.sent_at || m.created_at)}
                    {m.direction === 'outbound' && <Ticks status={m.status} />}
                  </span>
                </div>
              </div>
            ))}
          </React.Fragment>
        ))}
        <div ref={endRef} />
        {/* New message button */}
        {showNewMsg && (
          <button
            className="sticky bottom-4 mx-auto flex items-center gap-1.5 bg-white border border-gray-200 text-gray-700 text-xs font-semibold px-3 py-1.5 rounded-full shadow-md hover:bg-gray-50 transition-colors"
            onClick={() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); setShowNewMsg(false); }}
          >
            <ArrowDown size={13} /> New message
          </button>
        )}
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 border-t border-gray-200 bg-white">
        {confirmMedia && (
          <Modal
            title="Send attachment"
            body={`Are you sure you want to send "${confirmMedia.name}" to this lead?`}
            confirmLabel="Send"
            onClose={() => setConfirmMedia(null)}
            onConfirm={() => {
              const file = confirmMedia;
              setConfirmMedia(null);
              act(async () => {
                const asset = await api.uploadMedia(file);
                await api.sendMedia(conversation.id, asset.id, text.trim() || undefined);
              }, 'File sent');
            }}
          />
        )}
        {/* Library / Template panels */}
        {showLibrary && (
          <LibraryPanel
            conversationId={conversation.id}
            onClose={() => setShowLibrary(false)}
            onSent={async () => { setShowLibrary(false); await onChanged(); }}
          />
        )}
        {showTemplates && (
          <TemplatePanel
            conversationId={conversation.id}
            templates={templates}
            onSync={onSync}
            onClose={() => setShowTemplates(false)}
            onSent={async () => { setShowTemplates(false); await onChanged(); }}
          />
        )}

        {/* Composer input row */}
        {conversation.window_open ? (
          <div className="flex items-center gap-1.5 md:gap-3 px-2 md:px-5 py-3 md:py-4">
            {/* File attach */}
            <label
              className="flex items-center justify-center w-10 h-10 md:w-11 md:h-11 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors cursor-pointer flex-shrink-0"
              title="Attach a photo or document"
            >
              <Paperclip size={18} className="md:hidden" />
              <Paperclip size={20} className="hidden md:block" />
              <input
                type="file"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) setConfirmMedia(file);
                }}
              />
            </label>
            {/* Library - hidden on mobile */}
            <button
              className={`hidden sm:flex items-center justify-center w-10 h-10 md:w-11 md:h-11 rounded-lg transition-colors flex-shrink-0 ${showLibrary ? 'bg-gray-200 text-gray-800' : 'text-gray-500 hover:bg-gray-100'}`}
              title="Send from media library"
              onClick={() => { setShowLibrary((v) => !v); setShowTemplates(false); }}
              aria-pressed={showLibrary}
            >
              <Library size={20} />
            </button>
            {/* Template toggle - hidden below sm behind overflow button */}
            <button
              className={`hidden sm:flex items-center justify-center w-10 h-10 md:w-11 md:h-11 rounded-lg transition-colors flex-shrink-0 ${showTemplates ? 'bg-gray-200 text-gray-800' : 'text-gray-500 hover:bg-gray-100'}`}
              title="Send a template"
              onClick={() => { setShowTemplates((v) => !v); setShowLibrary(false); }}
              aria-pressed={showTemplates}
            >
              <FileText size={20} />
            </button>
            {/* Overflow on xs: library + template behind a ... button */}
            <div className="relative sm:hidden">
              <button
                className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors flex-shrink-0 ${showMoreActions ? 'bg-gray-200 text-gray-800' : 'text-gray-500 hover:bg-gray-100'}`}
                onClick={() => setShowMoreActions(v => !v)}
                aria-label="More options"
              >
                <MoreHorizontal size={18} />
              </button>
              {showMoreActions && (
                <div className="absolute bottom-12 left-0 bg-white border border-gray-200 rounded-xl shadow-lg z-10 min-w-[160px] py-1">
                  <button className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => { setShowLibrary(v => !v); setShowTemplates(false); setShowMoreActions(false); }}>
                    <Library size={16} /> Media library
                  </button>
                  <button className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => { setShowTemplates(v => !v); setShowLibrary(false); setShowMoreActions(false); }}>
                    <FileText size={16} /> Templates
                  </button>
                </div>
              )}
            </div>
            {/* Text input */}
            <input
              ref={inputRef}
              className="flex-1 min-w-0 h-11 md:h-12 bg-gray-100 rounded-xl px-3 md:px-5 text-sm md:text-base outline-none placeholder:text-gray-400 border border-transparent focus:border-gray-300 focus:bg-white transition-colors"
              placeholder="Type a message…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
              aria-label="Message"
            />
            {/* Send */}
            <button
              className="w-11 h-11 md:w-12 md:h-12 rounded-xl flex items-center justify-center text-white transition-all duration-100 disabled:opacity-40 flex-shrink-0"
              style={{ background: 'var(--accent)' }}
              disabled={!text.trim()}
              onClick={send}
              aria-label="Send message"
            >
              <Send size={18} />
            </button>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 px-3 md:px-4 py-3">
            <div className="flex items-start gap-2 text-xs text-gray-500 min-w-0">
              <Clock size={13} className="text-gray-400 flex-shrink-0 mt-0.5" />
              <span>The 24h messaging window is closed. You can only send approved templates.</span>
            </div>
            <button
              className={`flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg transition-colors flex-shrink-0 self-start sm:self-auto ${showTemplates ? 'bg-gray-200 text-gray-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              onClick={() => setShowTemplates((v) => !v)}
            >
              <FileText size={14} />
              Templates
              <ChevronDown size={13} className={`transition-transform ${showTemplates ? 'rotate-180' : ''}`} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Library Panel
function LibraryPanel({ conversationId, onClose, onSent }) {
  const [topics, setTopics]   = useState([]);
  const [topicId, setTopicId] = useState(null);
  const [media, setMedia]     = useState([]);
  const toast                  = useToast();

  useEffect(() => {
    api.topics().then((d) => setTopics(d.topics || [])).catch(() => {});
  }, []);
  useEffect(() => {
    api.media(topicId).then((d) => setMedia(d.media || [])).catch(() => {});
  }, [topicId]);

  const send = async (assetId) => {
    try {
      await api.sendMedia(conversationId, assetId);
      toast.success('File sent');
      await onSent();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="border-b border-gray-200 bg-gray-50">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          <Library size={15} className="text-gray-500" />
          Media Library
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded">
          <X size={15} />
        </button>
      </div>
      {/* Topic filter */}
      <div className="px-4 py-2.5 border-b border-gray-200">
        <select
          className="w-full h-8 px-2.5 text-sm bg-white border border-gray-200 rounded-md outline-none focus:border-gray-400"
          value={topicId ?? ''}
          onChange={(e) => setTopicId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">All topics</option>
          {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      {/* Media list */}
      <div className="max-h-48 overflow-y-auto">
        {media.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-sm text-gray-400 gap-2">
            <ImageIcon size={20} className="text-gray-300" />
            No files in this library yet.
          </div>
        )}
        {media.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-gray-100 last:border-0 hover:bg-white transition-colors">
            <div className="min-w-0 flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gray-200 flex items-center justify-center flex-shrink-0">
                <ImageIcon size={14} className="text-gray-500" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-800 truncate">{m.filename}</div>
                {m.description && <div className="text-xs text-gray-400 truncate">{m.description}</div>}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => send(m.id)}>Send</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Template Panel
function TemplatePanel({ conversationId, templates, onSync, onClose, onSent }) {
  const [name, setName]     = useState('');
  const [params, setParams] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const toast = useToast();

  const selected = templates.find((t) => t.name === name);
  const count    = templateParamCount(selected?.body);

  useEffect(() => setParams(Array(count).fill('')), [name, count]);

  const send = async () => {
    try {
      await api.sendTemplate(conversationId, name, params);
      setName('');
      toast.success('Template sent');
      await onSent();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      await onSync();
      toast.success('Templates synced from Meta');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const preview = selected?.body
    ? selected.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] || `{{${n}}}`)
    : '';

  return (
    <div className="border-b border-gray-200 bg-gray-50">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          <FileText size={15} className="text-gray-500" />
          Send a Template
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={sync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync from Meta'}
          </Button>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="px-4 py-3 flex flex-col gap-3">
        {/* Template selector */}
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Template</label>
          <select
            className="w-full h-9 px-3 text-sm bg-white border border-gray-200 rounded-lg outline-none focus:border-gray-400"
            value={name}
            onChange={(e) => setName(e.target.value)}
          >
            <option value="">Select a template…</option>
            {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
          {templates.length === 0 && (
            <p className="text-xs text-gray-400 mt-1.5">No approved templates yet. Click "Sync from Meta" to pull them in.</p>
          )}
        </div>

        {/* Param inputs */}
        {count > 0 && (
          <div className="flex flex-col gap-2">
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide">Fill in variables</label>
            {Array.from({ length: count }).map((_, i) => (
              <input
                key={i}
                className="w-full h-9 px-3 text-sm bg-white border border-gray-200 rounded-lg outline-none focus:border-gray-400 placeholder:text-gray-400"
                placeholder={`Value for {{${i + 1}}}`}
                value={params[i] || ''}
                onChange={(e) => { const next = [...params]; next[i] = e.target.value; setParams(next); }}
              />
            ))}
          </div>
        )}

        {/* Preview */}
        {preview && (
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Preview</div>
            <div className="text-sm text-gray-700 italic leading-relaxed">{preview}</div>
          </div>
        )}

        {/* Send button */}
        {name && (
          <button
            className="w-full h-10 flex items-center justify-center gap-2 text-sm font-semibold text-white rounded-lg transition-all disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
            onClick={send}
          >
            <Send size={14} />
            Send Template
          </button>
        )}
      </div>
    </div>
  );
}

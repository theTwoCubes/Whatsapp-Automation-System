import React, {
  useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Search, Paperclip, Library, Send, Clock, AlertCircle,
  CheckCheck, Check, ChevronRight, X, MessageSquare,
  FileText, Image as ImageIcon, ChevronDown, LayoutList,
  Download, Film, Mic, Pencil, Bot, UserRound, MoreHorizontal, ArrowDown,
  Pin, PinOff, Archive, ArchiveRestore, BellOff, Bell, MoreVertical,
  ShieldBan, ShieldCheck, Trash2, Reply, Eraser, Smile, ListFilter, Plus,
} from 'lucide-react';

// Kept in sync with src/ai/reactions.js on the backend - the only emoji an
// agent (or the AI) can react with.
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
import { api, getToken } from './api.js';
import { BrandContext } from './brand.js';
import {
  shortTime, groupByDay, templateParamCount,
  useAlias, setAlias, displayName,
} from './lib.js';
import { playChime, applyBadge, setViewingConversation } from './notifications.js';
import { refresh as refreshNotifications } from './notificationStore.js';
import Avatar from './components/ui/Avatar.jsx';
import { StateBadge } from './components/ui/Badge.jsx';
import Button from './components/ui/Button.jsx';
import { ChatRowSkeleton } from './components/ui/Skeleton.jsx';
import Modal from './components/ui/Modal.jsx';
import { useToast } from './components/ui/Toast.jsx';

// Trigger a light haptic on native Android. Dynamic import so the web build
// never tries to bundle @capacitor/haptics (resolved at runtime by the WebView).
async function haptic(style = 'Light') {
  if (!window.Capacitor?.isNativePlatform?.()) return;
  try {
    const { Haptics, ImpactStyle } = await import(/* @vite-ignore */ '@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle[style] });
  } catch { /* plugin not installed or unavailable */ }
}

// Saves a downloaded file (the xlsx export) to disk. A plain <a download>
// click does not work inside the APK's WebView, so on native this writes to
// the cache dir via Filesystem and opens the share sheet instead; on the web
// it is a normal browser download.
async function downloadBlob(filename, blob) {
  if (window.Capacitor?.isNativePlatform?.()) {
    const { Filesystem, Directory } = await import(/* @vite-ignore */ '@capacitor/filesystem');
    const { Share } = await import(/* @vite-ignore */ '@capacitor/share');
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const { uri } = await Filesystem.writeFile({ path: filename, data: base64, directory: Directory.Cache });
    await Share.share({ title: filename, url: uri, dialogTitle: `Save ${filename}` });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Module-scoped so the value persists across Console mount/unmount cycles
// (e.g. when the agent navigates to Admin and back).
let savedListScroll = 0;

// Ids we have already raised a handoff toast for, kept at module scope and
// mutated synchronously the moment an id is seen. Two loadList calls racing on
// the same websocket burst can no longer both toast the same chat, which is
// what caused duplicate toasts.
const alertedPendingIds = new Set();

// Unions two message arrays by id, newest copy of a row winning (so a refresh
// carrying an updated status replaces the stale one), then sorts ascending by
// the same key the server pages on. Lets a refresh keep older pages the agent
// scrolled up to load instead of throwing them away.
// Takes over a chat, and if the server says a different agent already has it
// (409 already_assigned), asks the caller to confirm before retrying with
// override. Named so it can be reused from both the details drawer and the
// thread header.
async function takeoverWithConfirm(conversationId) {
  try {
    return await api.takeover(conversationId);
  } catch (err) {
    if (err?.code === 'already_assigned') {
      const who = err.data?.assignee || 'another agent';
      if (window.confirm(`${who} is already in this chat. Take over anyway?`)) {
        return api.takeover(conversationId, true);
      }
      throw new Error('takeover cancelled');
    }
    throw err;
  }
}

function mergeMessages(a, b) {
  const byId = new Map();
  for (const m of a) byId.set(m.id, m);
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => {
    const tx = new Date(x.sent_at || x.created_at).getTime();
    const ty = new Date(y.sent_at || y.created_at).getTime();
    return tx - ty || x.id - y.id;
  });
}

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

// Every WhatsApp inbound type that actually has a file behind it - anything
// else (location, contacts, order, system, unsupported, a tapped quick-reply
// button) gets a plain text bubble using the readable body the backend fills
// in for those, not a broken "File" card with a download button that 404s.
const MEDIA_TYPES = new Set(['image', 'document', 'video', 'audio', 'voice', 'sticker']);

// A WhatsApp style attachment card. The file lives on Meta and stays there
// until the agent hits Download, so nothing is written to the VPS disk. The
// blurred gradient is just a placeholder that mimics WhatsApp's low quality
// preview, since we do not have a real thumbnail to show.
function mediaKindLabel(type) {
  const map = { image: 'Photo', document: 'Document', video: 'Video', audio: 'Voice note', sticker: 'Sticker' };
  return map[type] || 'File';
}

// The conversation list preview - c.last_message is the real body when there
// is one (text, or the readable stand-in the backend fills in for things
// like a location or a tapped button); a true media message has no body of
// its own, so this falls back to a type label the same way WhatsApp's own
// chat list shows "Photo" instead of leaving the line blank. A type this
// does not recognise at all (future WhatsApp message type) reads as
// "Unidentified media" rather than silently showing nothing.
const MEDIA_PREVIEW_LABELS = {
  image: '📷 Photo', document: '📄 Document', video: '🎥 Video',
  audio: '🎤 Voice message', voice: '🎤 Voice message', sticker: '😀 Sticker',
};
function lastMessagePreview(c) {
  if (c.last_message) return c.last_message;
  if (!c.last_message_type) return 'No messages yet';
  return MEDIA_PREVIEW_LABELS[c.last_message_type] || 'Unidentified media';
}

function mediaKindIcon(type, size = 22) {
  if (type === 'image' || type === 'sticker') return <ImageIcon size={size} className="text-white" />;
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
          style={{ background: '#c4b5a0' }}
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
    return <span className="text-[#53bdeb] inline-flex"><CheckCheck size={16} /></span>;
  if (status === 'failed')
    return <span className="text-red-500 inline-flex" title="Failed to send"><AlertCircle size={16} /></span>;
  return null;
}

// Bulk Send Modal - paste a list of leads, pick a service and an approved
// template, and every recipient is queued for the scheduler to work through
// a few at a time. Polls the batch's progress while open so the client can
// watch it go out without needing to refresh anything.
function BulkSendModal({ onClose, onQueued }) {
  const [file, setFile]           = useState(null);
  const [topics, setTopics]       = useState([]);
  const [templates, setTemplates] = useState([]);
  const [topicId, setTopicId]     = useState('');
  const [templateName, setTemplateName] = useState('');
  const [busy, setBusy]           = useState(false);
  const [batch, setBatch]         = useState(null); // { batchId, queued, skipped, total }
  const [progress, setProgress]   = useState(null);
  const toast = useToast();

  useEffect(() => {
    api.topics().then((d) => setTopics(d.topics || [])).catch(() => {});
    api.templates().then((d) => setTemplates(d.templates || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!batch) return;
    let cancelled = false;
    const timer = setInterval(poll, 2500);
    async function poll() {
      try {
        const { progress: p } = await api.bulkSendProgress(batch.batchId);
        if (cancelled) return;
        setProgress(p);
        // Nothing left pending or sending - stop polling, there is nothing
        // left to watch for.
        if ((p.byStatus?.pending ?? 0) + (p.byStatus?.sending ?? 0) === 0) clearInterval(timer);
      } catch { /* transient, next tick retries */ }
    }
    poll();
    return () => { cancelled = true; clearInterval(timer); };
  }, [batch]);

  const submit = async () => {
    if (!file || !templateName) return;
    setBusy(true);
    try {
      const res = await api.bulkSend(file, templateName, topicId ? Number(topicId) : null);
      setBatch(res);
      onQueued?.();
      toast.success(`Queued ${res.queued} lead${res.queued === 1 ? '' : 's'}${res.skipped ? `, ${res.skipped} skipped (no valid mobile number)` : ''}`);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  const done = progress && (progress.byStatus?.pending ?? 0) + (progress.byStatus?.sending ?? 0) === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-shrink-0 items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">Bulk send</h2>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-700 rounded-full hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        {!batch ? (
          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
            <p className="text-sm text-gray-500 leading-relaxed">
              Upload an Excel file of leads. The first row must have column headers - one named <span className="font-medium text-gray-700">mobile</span> is required, <span className="font-medium text-gray-700">name</span>, <span className="font-medium text-gray-700">email</span> and <span className="font-medium text-gray-700">business</span> are picked up automatically if present, in any column order. Each lead gets an approved template message; WhatsApp does not allow anything else to someone who hasn't messaged in first.
            </p>
            <div className="flex flex-col gap-1.5">
              <label className="text-base font-medium text-gray-800">Leads file (.xlsx)</label>
              <input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="text-sm text-gray-600"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-base font-medium text-gray-800">Service <span className="text-gray-400 font-normal">(optional)</span></label>
              <select className="field-input h-10 px-3 text-sm" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
                <option value="">No specific service</option>
                {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-base font-medium text-gray-800">Template</label>
              <select className="field-input h-10 px-3 text-sm" value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
                <option value="">Choose an approved template</option>
                {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
              {templates.length === 0 && <p className="text-sm text-gray-400">No approved templates found - sync templates from Ops first.</p>}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
            <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="text-sm font-semibold text-gray-800 mb-1">
                {done ? 'Done' : 'Sending…'}
              </div>
              <div className="text-sm text-gray-600">
                {progress ? (
                  <>
                    {progress.byStatus?.sent || 0} sent
                    {progress.byStatus?.failed ? `, ${progress.byStatus.failed} failed` : ''}
                    {progress.byStatus?.stuck ? `, ${progress.byStatus.stuck} need a manual check` : ''}
                    {' '}of {batch.queued} queued
                    {batch.skipped ? ` (${batch.skipped} skipped for no valid mobile number)` : ''}
                  </>
                ) : 'Loading progress…'}
              </div>
              {!done && (
                <div className="w-full h-1.5 bg-gray-200 rounded-full mt-3 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${progress && batch.queued ? Math.round(((progress.byStatus?.sent || 0) + (progress.byStatus?.failed || 0) + (progress.byStatus?.stuck || 0)) / batch.queued * 100) : 0}%`,
                      background: 'var(--accent)',
                    }}
                  />
                </div>
              )}
            </div>
            <p className="text-sm text-gray-400">This keeps going in the background even if you close this window - come back to Bulk send to check on it again.</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-100">
          {!batch ? (
            <>
              <Button variant="secondary" size="md" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="primary" size="md" onClick={submit} disabled={busy || !file || !templateName}>
                {busy ? 'Queuing…' : 'Queue send'}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="md" onClick={onClose}>Close</Button>
          )}
        </div>
      </div>
    </div>
  );
}

// Console Root
export default function Console({ onConversationsChange, onThreadOpen, onOpenConversation }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected]           = useState(null);
  const [thread, setThread]               = useState(null);
  const [templates, setTemplates]         = useState([]);
  const [query, setQuery]                 = useState('');
  const [filter, setFilter]               = useState('all');
  const [serviceFilter, setServiceFilter] = useState(null);
  const [originFilter, setOriginFilter]   = useState(null); // null | 'lead' | 'business' — who started the conversation
  const [showServiceMenu, setShowServiceMenu] = useState(false);
  const serviceBtnRef                     = useRef(null);
  const [showBulkSend, setShowBulkSend]   = useState(false);
  const [exportBusy, setExportBusy]       = useState(false);
  const [loading, setLoading]             = useState(true);
  const [showContext, setShowContext]     = useState(false);
  const [ptrDist, setPtrDist]             = useState(0);
  const ptrStartY                         = useRef(null);
  const selectedRef                        = useRef(null);
  const toast                              = useToast();

  // Ids that are currently pending, so we can detect *new* pending ones on
  // the next refresh and fire a chime/toast without repeating for chats that
  // were already waiting when we opened the tab.
  const knownPendingRef = useRef(null);

  // Read at call time inside the stable loadList below, instead of loadList
  // depending on filter directly - switching tabs used to give loadList (and
  // everything built on it, including the websocket-connect effect further
  // down) a new identity, tearing the socket down and reconnecting it on
  // every tap of a filter chip.
  const filterRef = useRef(filter);
  filterRef.current = filter;

  // Guards against out-of-order responses: switching filters back and forth
  // fires overlapping requests, and without this the slower one can land
  // last and clobber the list with stale (or archived) data.
  const loadSeqRef = useRef(0);

  const loadList = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const seq = ++loadSeqRef.current;
    const archived = filterRef.current === 'archived';
    try {
      const { conversations: list } = await api.conversations({ archived });
      if (seq !== loadSeqRef.current) return;
      setConversations(list);

      // Archived is a side view onto chats that are done needing attention.
      // It must not drive the pending-toast bookkeeping, the OS/tab badge, or
      // the parent's global conversation list - doing so was overwriting the
      // real counts with the archived-only subset while browsing it, and then
      // re-toasting chats that were already pending once the user came back.
      if (archived) return;

      onConversationsChange?.(list);

      const pending = list.filter((c) => c.state === 'pending');
      const pendingIds = new Set(pending.map((c) => c.id));

      if (knownPendingRef.current == null) {
        // First load: seed the alerted set with the backlog so we don't chime
        // for chats that were already waiting when the tab opened.
        for (const id of pendingIds) alertedPendingIds.add(id);
        knownPendingRef.current = pendingIds;
      } else {
        // Synchronously claim each fresh id before any further await, so a
        // concurrent loadList cannot toast the same chat a second time.
        const fresh = pending.filter((c) => !alertedPendingIds.has(c.id));
        for (const c of fresh) alertedPendingIds.add(c.id);
        if (fresh.length > 0) {
          playChime();
          for (const c of fresh) {
            const name = c.name || c.wa_id;
            toast.warning(`${name} needs a person${c.handoff_reason ? ` · ${c.handoff_reason}` : ''}`, 8000);
          }
        }
        knownPendingRef.current = pendingIds;
      }
      // Drop ids that are no longer pending so a chat that comes back later
      // re-alerts. Keeps the set from growing without bound.
      for (const id of [...alertedPendingIds]) {
        if (!pendingIds.has(id)) alertedPendingIds.delete(id);
      }
      // Badge reflects everything needing attention: unread inbound messages
      // across every chat, not just the pending handoffs.
      const attention = list.reduce((n, c) => n + (c.unread_count || 0), 0) + pending.length;
      applyBadge(attention);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      if (err.message !== 'unauthorized') toast.error('Could not load conversations');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [toast, onConversationsChange]);

  // Coalesce bursts of websocket events into a single refetch. Without this a
  // single handoff (message insert + status + refresh events) triggered three
  // full reloads back to back.
  const reloadTimerRef = useRef(null);
  const scheduleReload = useCallback(() => {
    clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      loadList(true);
      if (selectedRef.current) loadThreadRef.current?.(selectedRef.current);
    }, 150);
  }, [loadList]);

  const fetchCounter = useRef(0);
  const loadThreadRef = useRef(null);
  const threadRef = useRef(null);
  useEffect(() => { threadRef.current = thread; }, [thread]);

  const loadThread = useCallback(async (id) => {
    if (!id) return;
    const currentFetch = ++fetchCounter.current;
    try {
      const data = await api.conversation(id); // { conversation, messages, hasMore }
      if (currentFetch !== fetchCounter.current) return;
      setThread((prev) => {
        // Same conversation refreshing: merge the newest page into whatever is
        // already loaded (including older pages the agent scrolled up for) so a
        // refresh does not discard them. Switching conversation: replace.
        if (prev && prev !== 'error' && prev.conversation?.id === data.conversation.id) {
          return {
            conversation: data.conversation,
            messages: mergeMessages(prev.messages, data.messages),
            hasMore: prev.hasMore,
          };
        }
        return data;
      });
      loadList(true);
    } catch {
      // show error state only when it's the current conversation
      if (currentFetch === fetchCounter.current) setThread('error');
    }
  }, [loadList]);
  useEffect(() => { loadThreadRef.current = loadThread; }, [loadThread]);

  // Clearing a chat does not delete messages, it just moves the cutoff the
  // server filters on - a normal refresh would still show them because
  // loadThread merges instead of replacing. Wipe the open thread locally too.
  const clearThreadMessages = useCallback((conversationId) => {
    setThread((prev) => (prev && prev !== 'error' && prev.conversation?.id === conversationId)
      ? { ...prev, messages: [], hasMore: false }
      : prev);
  }, []);

  // Fetches the previous page of messages for the open thread and prepends it.
  const loadOlder = useCallback(async () => {
    const t = threadRef.current;
    if (!t || t === 'error' || !t.hasMore || !t.messages?.length) return;
    const oldestId = t.messages[0].id;
    try {
      const { messages: older, hasMore } = await api.olderMessages(t.conversation.id, oldestId);
      setThread((prev) => (prev && prev !== 'error' && prev.conversation?.id === t.conversation.id)
        ? { ...prev, messages: mergeMessages(older, prev.messages), hasMore }
        : prev);
    } catch { /* leave the thread as-is on a failed older-page fetch */ }
  }, []);

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
    let cancelled = false;
    async function connect() {
      if (cancelled) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // Prefer a short-lived ticket so the JWT never lands in the URL, which
      // would leak into access logs and browser history. Fall back to the raw
      // token during rollout if the server has not yet been upgraded.
      let query;
      try {
        const { ticket } = await api.wsTicket();
        query = `ticket=${encodeURIComponent(ticket)}`;
      } catch {
        query = `token=${encodeURIComponent(getToken() || '')}`;
      }
      if (cancelled) return;
      ws = new WebSocket(`${proto}://${location.host}/api/stream?${query}`);
      ws.onopen = () => { setWsOffline(false); delay = 1000; };
      ws.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { /* non-JSON, treat as a plain refresh */ }
        // A delivery/read tick only changes one message's status. Patch it in
        // place instead of refetching the whole thread and list.
        if (msg?.type === 'status' && msg.wamid) {
          setThread((prev) => {
            if (!prev || prev === 'error') return prev;
            let changed = false;
            const messages = prev.messages.map((m) => {
              if (m.wa_message_id === msg.wamid && m.status !== msg.status) {
                changed = true;
                return { ...m, status: msg.status };
              }
              return m;
            });
            return changed ? { ...prev, messages } : prev;
          });
          return;
        }
        // Everything else: coalesce a burst of events into one refetch, and
        // pull the notification inbox forward so the bell updates live rather
        // than waiting up to 30s for its next poll.
        scheduleReload();
        refreshNotifications();
      };
      ws.onclose = () => {
        setWsOffline(true);
        delay = Math.min(delay * 2, 30000);
        wsRetryRef.current = setTimeout(connect, delay);
      };
    }
    connect();
    return () => {
      cancelled = true;
      clearTimeout(wsRetryRef.current);
      clearTimeout(reloadTimerRef.current);
      ws?.close();
    };
  }, [scheduleReload]);

  const filtered = useMemo(() => {
    let list = conversations;
    // 'archived' pulls its own list from the server, so the state filter does
    // not apply to it — everything the server returned should show.
    if (filter !== 'all' && filter !== 'archived') list = list.filter((c) => c.state === filter);
    if (serviceFilter != null) list = list.filter((c) => c.topic_id === serviceFilter);
    if (originFilter != null) list = list.filter((c) => (c.origin || 'lead') === originFilter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((c) =>
      (c.name || '').toLowerCase().includes(q) || (c.wa_id || '').includes(q)
    );
    return list;
  }, [conversations, query, filter, serviceFilter, originFilter]);

  // Which services have an active chat right now, with counts - built from
  // whatever is already loaded rather than a separate query. A dropdown
  // instead of another row of tabs, since the number of services can grow
  // past what fits on a phone screen without scrolling.
  const serviceOptions = useMemo(() => {
    const map = new Map();
    for (const c of conversations) {
      if (c.topic_id == null || !c.topic_name) continue;
      const cur = map.get(c.topic_id) || { id: c.topic_id, name: c.topic_name, count: 0 };
      cur.count += 1;
      map.set(c.topic_id, cur);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [conversations]);

  const activeService = serviceFilter != null ? serviceOptions.find((s) => s.id === serviceFilter) : null;

  const exportLeads = useCallback(async () => {
    setExportBusy(true);
    try {
      const blob = await api.exportContacts(serviceFilter);
      const suffix = activeService ? `-${activeService.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
      await downloadBlob(`leads${suffix}-${new Date().toISOString().slice(0, 10)}.xlsx`, blob);
    } catch (e) {
      toast.error('Export failed: ' + e.message);
    } finally {
      setExportBusy(false);
    }
  }, [serviceFilter, activeService, toast]);

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
        relative flex-shrink-0 flex-col border-r border-gray-200 bg-white overflow-hidden
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
            <button
              ref={serviceBtnRef}
              type="button"
              onClick={() => setShowServiceMenu((v) => !v)}
              className={`flex-shrink-0 relative ${(serviceFilter != null || originFilter != null) ? 'text-[var(--accent)]' : 'text-gray-400 hover:text-gray-600'}`}
              title="Filter"
              aria-label="Filter"
            >
              <ListFilter size={16} />
              {(serviceFilter != null || originFilter != null) && (
                <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
              )}
            </button>
            <button
              type="button"
              onClick={exportLeads}
              disabled={exportBusy}
              className="flex-shrink-0 text-gray-400 hover:text-gray-600 disabled:opacity-40"
              title={activeService ? `Export ${activeService.name} leads` : 'Export all leads'}
              aria-label="Export leads to Excel"
            >
              <Download size={16} />
            </button>
          </div>
          {showServiceMenu && (
            <ServiceFilterMenu
              anchorRef={serviceBtnRef}
              services={serviceOptions}
              selected={serviceFilter}
              onSelect={setServiceFilter}
              origin={originFilter}
              onSelectOrigin={setOriginFilter}
              onClose={() => setShowServiceMenu(false)}
            />
          )}
          {(activeService || originFilter != null) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {activeService && (
                <button
                  type="button"
                  onClick={() => setServiceFilter(null)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full"
                  style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
                >
                  {activeService.name}
                  <X size={12} />
                </button>
              )}
              {originFilter != null && (
                <button
                  type="button"
                  onClick={() => setOriginFilter(null)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full"
                  style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
                >
                  {originFilter === 'lead' ? 'Inbound' : 'Outbound'}
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          {showBulkSend && (
            <BulkSendModal
              onClose={() => setShowBulkSend(false)}
              onQueued={() => loadList(true)}
            />
          )}
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
          onTouchStart={(e) => {
            if (listScrollRef.current?.scrollTop === 0)
              ptrStartY.current = e.touches[0].clientY;
          }}
          onTouchMove={(e) => {
            if (ptrStartY.current === null) return;
            const d = e.touches[0].clientY - ptrStartY.current;
            if (d > 0) setPtrDist(Math.min(56, d * 0.45));
          }}
          onTouchEnd={() => {
            if (ptrDist > 38) loadList(true);
            ptrStartY.current = null;
            setPtrDist(0);
          }}
        >
          {ptrDist > 0 && (
            <div
              className="flex items-end justify-center text-xs text-gray-400 overflow-hidden transition-[height] duration-150"
              style={{ height: ptrDist }}
            >
              <span className="pb-1.5">{ptrDist > 38 ? 'Release to refresh' : 'Pull to refresh'}</span>
            </div>
          )}
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

        {/* Bulk send - WhatsApp-style floating action button. A single lead
            is just a one-row bulk send, so this is the only entry point. */}
        <button
          type="button"
          onClick={() => setShowBulkSend(true)}
          className="absolute bottom-5 right-5 md:bottom-6 md:right-6 z-10 w-14 h-14 rounded-full bg-[var(--accent)] text-white shadow-lg hover:brightness-95 active:scale-95 transition-all flex items-center justify-center"
          title="Bulk send"
          aria-label="Bulk send"
        >
          <Plus size={26} />
        </button>
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
              onCleared={clearThreadMessages}
              onLoadOlder={loadOlder}
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
  // State-tinted left rail: accent for pending handoff, slate while a human
  // is in the chat, transparent otherwise. Visible at a glance in a long list.
  const railColor =
    c.state === 'pending' ? 'bg-[var(--accent)]' :
    c.state === 'human'   ? 'bg-slate-400' :
    'bg-transparent';
  return (
    <button
      role="listitem"
      onClick={onSelect}
      aria-current={isActive ? 'true' : undefined}
      className={`
        relative w-full flex items-center gap-3 md:gap-4 px-4 md:px-5 py-3.5 md:py-4 border-b border-gray-100 text-left transition-colors duration-100 cursor-pointer
        ${isActive ? 'bg-gray-100' : 'hover:bg-gray-50'}
      `}
    >
      <span aria-hidden="true" className={`absolute left-0 top-0 bottom-0 w-1 ${railColor}`} />
      <Avatar name={name} waId={c.wa_id} size="xl" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-base md:text-lg font-bold text-gray-900 truncate flex items-center gap-1.5">
            {c.blocked_at && <ShieldBan size={12} className="text-red-500 flex-shrink-0" aria-label="Blocked" />}
            {c.pinned_at && <Pin size={12} className="text-gray-400 flex-shrink-0" aria-label="Pinned" />}
            <span className="truncate">{name}</span>
          </span>
          <span className="flex items-center gap-1 text-xs md:text-base font-medium text-gray-400 flex-shrink-0">
            {c.muted_until && new Date(c.muted_until) > new Date() && <BellOff size={12} aria-label="Muted" />}
            {shortTime(c.last_at)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={`text-sm md:text-base truncate ${c.unread_count > 0 ? 'text-gray-900 font-semibold' : 'text-gray-500'}`}>
            {lastMessagePreview(c)}
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {c.state === 'human' && (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded-full">You</span>
            )}
            {c.unread_count > 0 ? (
              <span className="min-w-[22px] h-[22px] rounded-full flex items-center justify-center text-white text-xs font-bold px-1.5" style={{ background: 'var(--accent)' }} aria-label={`${c.unread_count} unread`}>
                {c.unread_count}
              </span>
            ) : c.state === 'pending' ? (
              <span className="w-2.5 h-2.5 rounded-full bg-stone-400" aria-label="Needs attention" />
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

// Inline editor for a real, saved-to-the-contact field (name/email/business)
// - unlike EditableName's device-only nickname, this hits the server, is
// visible to the whole team, and is what the Excel export reads from.
function EditableContactField({ label, value, placeholder, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(value || '');
  const [saving, setSaving]   = useState(false);
  const toast = useToast();
  useEffect(() => { if (!editing) setDraft(value || ''); }, [value, editing]);

  const commit = async () => {
    const next = draft.trim();
    if (next === (value || '').trim()) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        disabled={saving}
        className="text-sm font-medium text-gray-900 bg-transparent border-b border-gray-300 outline-none min-w-0 w-full"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setDraft(value || ''); setEditing(false); }
        }}
      />
    );
  }
  return (
    <span className="flex items-center gap-1.5 min-w-0 group">
      <span className={`truncate min-w-0 text-sm font-medium ${value ? 'text-gray-900' : 'text-gray-400'}`}>
        {value || placeholder}
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex-shrink-0 text-gray-400 hover:text-gray-600 md:opacity-60 md:hover:opacity-100 transition-opacity"
        title={`Edit ${label.toLowerCase()}`}
        aria-label={`Edit ${label}`}
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

  const saveContactField = async (field, value) => {
    await api.updateContact(c.id, { [field]: value });
    onChanged();
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
          <div className="flex flex-col gap-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
            <span className="text-xs font-semibold text-gray-600">Reason flagged</span>
            <span className="text-xs text-gray-700 italic">"{c.handoff_reason}"</span>
          </div>
        )}
      </div>

      {/* Lead details - saved to the contact, shared with the whole team,
          and what the Excel export reads from. */}
      <div className="px-4 md:px-6 py-4 md:py-5 border-b border-gray-100 flex flex-col gap-3">
        <div className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-1">Lead details</div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-gray-400">Name</span>
          <EditableContactField label="Name" value={c.name} placeholder="Not saved yet"
            onSave={(v) => saveContactField('name', v)} />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-gray-400">Phone</span>
          <span className="text-sm font-medium text-gray-700">{c.wa_id}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-gray-400">Email</span>
          <EditableContactField label="Email" value={c.email} placeholder="Not saved yet"
            onSave={(v) => saveContactField('email', v)} />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-gray-400">Business</span>
          <EditableContactField label="Business" value={c.business} placeholder="Not saved yet"
            onSave={(v) => saveContactField('business', v)} />
        </div>
      </div>

      {/* Mobile Actions (Hidden on desktop since they are in the header) */}
      <div className="md:hidden px-4 md:px-6 py-4 md:py-5 border-b border-gray-100 flex flex-col gap-3">
        <div className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-1">Actions</div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" className="flex-1 justify-center gap-1.5"
            onClick={() => act(() => api.pinConversation(c.id, !c.pinned_at), c.pinned_at ? 'Unpinned' : 'Pinned')}>
            {c.pinned_at ? <PinOff size={16} /> : <Pin size={16} />}
            <span className="text-xs">{c.pinned_at ? 'Unpin' : 'Pin'}</span>
          </Button>
          <Button variant="secondary" size="sm" className="flex-1 justify-center gap-1.5"
            onClick={() => act(() => api.muteConversation(c.id, c.muted_until && new Date(c.muted_until) > new Date() ? 0 : 8),
              c.muted_until && new Date(c.muted_until) > new Date() ? 'Unmuted' : 'Muted 8h')}>
            {c.muted_until && new Date(c.muted_until) > new Date() ? <BellOff size={16} /> : <Bell size={16} />}
            <span className="text-xs">{c.muted_until && new Date(c.muted_until) > new Date() ? 'Unmute' : 'Mute'}</span>
          </Button>
          <Button variant="secondary" size="sm" className="flex-1 justify-center gap-1.5"
            onClick={() => act(() => api.archiveConversation(c.id, !c.archived_at), c.archived_at ? 'Unarchived' : 'Archived')}>
            {c.archived_at ? <ArchiveRestore size={16} /> : <Archive size={16} />}
            <span className="text-xs">{c.archived_at ? 'Unarchive' : 'Archive'}</span>
          </Button>
        </div>
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
            onClick={() => act(() => takeoverWithConfirm(c.id), 'You have taken over this conversation')}>
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

// Overflow menu for per-chat actions (pin, mute, archive, and — added in
// phase 2 — block and delete). Works the same on mobile and desktop, which is
// what makes unpin/unmute/unarchive reachable on a phone. Renders through a
// portal positioned off the trigger so no ancestor can clip it.
// Portaled to <body> and positioned from the anchor button's own bounding
// rect, the same way ChatActionsMenu escapes the scrollable messages pane -
// rendering this inline inside the bubble (the original approach) got it
// clipped by the pane's overflow:auto whenever the target message was near
// the top of the currently scrolled view.
// Portaled dropdown for filtering the conversation list by service - a
// button + popover instead of another row of tabs, since the number of
// services (logo design, packaging, website, ...) can grow past what fits
// on a phone screen without needing its own scroll.
function ServiceFilterMenu({ anchorRef, services, selected, onSelect, origin, onSelectOrigin, onClose }) {
  const [coords, setCoords] = useState(null);
  const menuRef = useRef(null);

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const width = 240;
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(12, r.left), window.innerWidth - width - 12);
    setCoords({ left, width, top: r.bottom + 6 });
  }, [anchorRef]);

  useLayoutEffect(() => { place(); }, [place]);
  useEffect(() => {
    const onDown = (e) => {
      if (anchorRef.current?.contains(e.target)) return;
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const reflow = () => place();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [place, onClose, anchorRef]);

  if (!coords) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9998] bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden py-1 max-h-80 overflow-y-auto"
      style={{ left: coords.left, top: coords.top, width: coords.width }}
    >
      {onSelectOrigin && (
        <>
          <div className="px-3.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Who started it</div>
          {[
            { key: null, label: 'Any' },
            { key: 'lead', label: 'Inbound' },
            { key: 'business', label: 'Outbound' },
          ].map((d) => (
            <button
              key={String(d.key)}
              type="button"
              onClick={() => { onSelectOrigin(d.key); onClose(); }}
              className={`w-full flex items-center px-3.5 py-2 text-sm text-left hover:bg-gray-50 ${origin === d.key ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
            >
              {d.label}
            </button>
          ))}
          <div className="my-1 border-t border-gray-100" />
          <div className="px-3.5 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Service</div>
        </>
      )}
      <button
        type="button"
        onClick={() => { onSelect(null); onClose(); }}
        className={`w-full flex items-center px-3.5 py-2.5 text-sm text-left hover:bg-gray-50 ${selected == null ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
      >
        All services
      </button>
      {services.length === 0 && (
        <div className="px-3.5 py-3 text-xs text-gray-400">No services on any active chat yet.</div>
      )}
      {services.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => { onSelect(s.id); onClose(); }}
          className={`w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm text-left hover:bg-gray-50 ${selected === s.id ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
        >
          <span className="truncate">{s.name}</span>
          <span className="text-xs text-gray-400 flex-shrink-0">{s.count}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

function ReactionPicker({ anchorRef, align, onPick, onClose }) {
  const [coords, setCoords] = useState(null);
  const pickerRef = useRef(null);

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const width = REACTION_EMOJIS.length * 32 + 16;
    const r = el.getBoundingClientRect();
    const openUp = r.top > 60;
    const left = align === 'right'
      ? Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8)
      : Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setCoords({
      left, width,
      top: openUp ? undefined : r.bottom + 6,
      bottom: openUp ? window.innerHeight - r.top + 6 : undefined,
    });
  }, [anchorRef, align]);

  useLayoutEffect(() => { place(); }, [place]);
  useEffect(() => {
    const onDown = (e) => {
      if (anchorRef.current?.contains(e.target)) return;
      if (pickerRef.current && !pickerRef.current.contains(e.target)) onClose();
    };
    const reflow = () => place();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [place, onClose, anchorRef]);

  if (!coords) return null;
  return createPortal(
    <div
      ref={pickerRef}
      className="fixed z-[9998] flex items-center gap-0.5 bg-white border border-gray-200 rounded-full shadow-lg px-1.5 py-1"
      style={{ left: coords.left, top: coords.top, bottom: coords.bottom, width: coords.width }}
    >
      {REACTION_EMOJIS.map((e) => (
        <button key={e} type="button" onClick={() => onPick(e)}
          className="text-lg leading-none w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors">
          {e}
        </button>
      ))}
    </div>,
    document.body,
  );
}

function ChatActionsMenu({ conversation, act, onChanged, onCleared, toast, onClose }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const muted = conversation.muted_until && new Date(conversation.muted_until) > new Date();
  const pinned = Boolean(conversation.pinned_at);
  const archived = Boolean(conversation.archived_at);
  const blocked = Boolean(conversation.blocked_at);

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 220;
    const openUp = r.top > window.innerHeight / 2;
    const left = Math.min(Math.max(12, r.right - width), window.innerWidth - width - 12);
    setCoords({
      left, width, openUp,
      top: openUp ? undefined : r.bottom + 6,
      bottom: openUp ? window.innerHeight - r.top + 6 : undefined,
    });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    };
    const reflow = () => place();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [open, place]);

  const run = (fn, msg) => { setOpen(false); act(fn, msg); };

  const Item = ({ icon: Icon, label, onClick, danger }) => (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-sm text-left hover:bg-gray-50 ${danger ? 'text-red-600' : 'text-gray-700'}`}
    >
      <Icon size={16} className="flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );

  const menu = open && coords ? createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9998] bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden py-1"
      style={{ left: coords.left, top: coords.top, bottom: coords.bottom, width: coords.width }}
    >
      <Item icon={pinned ? PinOff : Pin} label={pinned ? 'Unpin' : 'Pin to top'}
        onClick={() => run(() => api.pinConversation(conversation.id, !pinned), pinned ? 'Unpinned' : 'Pinned')} />
      {muted ? (
        <Item icon={Bell} label="Unmute"
          onClick={() => run(() => api.muteConversation(conversation.id, 0), 'Unmuted')} />
      ) : (
        <>
          <Item icon={BellOff} label="Mute 8 hours"
            onClick={() => run(() => api.muteConversation(conversation.id, 8), 'Muted for 8 hours')} />
          <Item icon={BellOff} label="Mute 1 week"
            onClick={() => run(() => api.muteConversation(conversation.id, 24 * 7), 'Muted for 1 week')} />
          <Item icon={BellOff} label="Mute always"
            onClick={() => run(() => api.muteConversation(conversation.id, 24 * 365 * 10), 'Muted')} />
        </>
      )}
      <Item icon={archived ? ArchiveRestore : Archive} label={archived ? 'Unarchive' : 'Archive'}
        onClick={() => run(() => api.archiveConversation(conversation.id, !archived), archived ? 'Unarchived' : 'Archived')} />
      <div className="my-1 border-t border-gray-100" />
      <Item icon={blocked ? ShieldCheck : ShieldBan} label={blocked ? 'Unblock contact' : 'Block contact'} danger={!blocked}
        onClick={() => {
          setOpen(false);
          const verb = blocked ? 'Unblock' : 'Block';
          if (window.confirm(`${verb} this contact?${blocked ? '' : ' The bot will stop replying to them.'}`)) {
            act(() => api.blockConversation(conversation.id, !blocked), blocked ? 'Unblocked' : 'Blocked');
          }
        }} />
      <Item icon={Eraser} label="Clear chat"
        onClick={async () => {
          setOpen(false);
          if (window.confirm('Clear all messages? The chat stays but the AI starts fresh.')) {
            await act(() => api.clearChat(conversation.id), 'Chat cleared');
            onCleared?.(conversation.id);
          }
        }} />
      <Item icon={Trash2} label="Delete chat" danger
        onClick={async () => {
          setOpen(false);
          if (window.confirm('Delete this chat? It will be hidden and permanently removed after 30 days.')) {
            await act(() => api.deleteConversation(conversation.id), 'Chat deleted');
            onClose?.();
          }
        }} />
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Chat actions"
        aria-expanded={open}
        className={`flex items-center justify-center w-9 h-9 md:w-10 md:h-10 rounded-lg transition-colors flex-shrink-0 ${open ? 'bg-gray-200 text-gray-800' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
        title="More actions"
      >
        <MoreVertical size={18} />
      </button>
      {menu}
    </>
  );
}

// Chat Thread
function ChatThread({ thread, templates, onSync, onChanged, onCleared, onLoadOlder, showContext, onToggleContext, onBack, wsOffline }) {
  const { conversation, messages, hasMore } = thread;
  const [text, setText]               = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const [showLibrary, setShowLibrary]     = useState(false);
  const [confirmMedia, setConfirmMedia]   = useState(null);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [replyTo, setReplyTo]             = useState(null);
  const [search, setSearch]               = useState('');
  const [showSearch, setShowSearch]       = useState(false);
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

  // Infinite scroll-up: near the top, pull the previous page. Record the
  // scroll height first so the layout effect below can hold the viewport in
  // place once older messages are prepended (no jump).
  const loadingOlderRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < 80 && hasMore && !loadingOlderRef.current && onLoadOlder) {
      loadingOlderRef.current = true;
      prevScrollHeightRef.current = el.scrollHeight;
      Promise.resolve(onLoadOlder()).finally(() => { loadingOlderRef.current = false; });
    }
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !prevScrollHeightRef.current) return;
    const diff = el.scrollHeight - prevScrollHeightRef.current;
    if (diff > 0) el.scrollTop = el.scrollTop + diff;
    prevScrollHeightRef.current = 0;
  }, [messages.length]);

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
    haptic('Light');
    const replyWamid = replyTo?.wa_message_id || null;
    act(() => api.send(conversation.id, text.trim(), replyWamid), 'Message sent');
    setReplyTo(null);
  };

  // Quote lookup: resolve a message's reply_to_wamid to the referenced message
  // already loaded in the thread, for rendering the quoted snippet.
  const messageByWamid = useMemo(() => {
    const map = new Map();
    for (const m of messages) if (m.wa_message_id) map.set(m.wa_message_id, m);
    return map;
  }, [messages]);

  // Reactions never get their own bubble - each one just annotates the
  // message it reacted to. Keeps at most one per direction per target (the
  // way WhatsApp itself only shows one active reaction per person), with a
  // later reaction replacing an earlier one and an empty emoji clearing it.
  const reactionsByTarget = useMemo(() => {
    const map = new Map();
    for (const m of messages) {
      if (m.type !== 'reaction' || !m.reacted_to_wamid) continue;
      const existing = map.get(m.reacted_to_wamid) || {};
      existing[m.direction] = m.reaction_emoji || null;
      map.set(m.reacted_to_wamid, existing);
    }
    return map;
  }, [messages]);

  const [reactingTo, setReactingTo] = useState(null);
  const react = async (m, emoji) => {
    setReactingTo(null);
    try {
      await api.sendReaction(conversation.id, m.wa_message_id, emoji);
      await onChanged();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const snippet = (m) => {
    if (!m) return '';
    if (m.body) return m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body;
    return m.type && m.type !== 'text' ? `[${m.type}]` : '';
  };

  // In-chat search filters the rendered messages to those matching the query.
  const q = search.trim().toLowerCase();
  const visibleMessages = (q
    ? messages.filter((m) => (m.body || '').toLowerCase().includes(q))
    : messages
  ).filter((m) => {
    if (m.type !== 'reaction') return true;
    // A reaction whose target message is currently loaded renders as a badge
    // on that bubble instead (see reactionsByTarget) and is dropped here. One
    // whose target is on an older page not yet fetched would otherwise just
    // vanish with no trace - shown as its own small line instead of being
    // silently lost.
    return !m.reacted_to_wamid || !messageByWamid.has(m.reacted_to_wamid);
  });
  const groups    = groupByDay(visibleMessages);
  const isPending = conversation.state === 'pending';
  const isHuman   = conversation.state === 'human';
  const isBot     = conversation.state === 'bot';
  const win       = windowLabel(conversation);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* WS offline indicator */}
      {wsOffline && (
        <div className="flex items-center justify-center gap-2 bg-gray-900 text-gray-200 text-xs py-1.5 px-4">
          <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse" />
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
              onClick={() => act(() => takeoverWithConfirm(conversation.id), 'You have taken over this conversation')}>
              <span className="hidden sm:inline">Take over</span>
              <UserRound size={16} className="sm:hidden" aria-label="Take over" />
            </Button>
          )}
          <div className="w-px h-8 bg-gray-200 mx-1 hidden md:block" />
          <button
            onClick={() => setShowSearch((v) => { if (v) setSearch(''); return !v; })}
            className={`flex items-center justify-center w-9 h-9 md:w-10 md:h-10 rounded-lg transition-colors flex-shrink-0 ${showSearch ? 'bg-gray-200 text-gray-800' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
            title="Search in chat"
            aria-label="Search in chat"
          >
            <Search size={18} />
          </button>
          <button
            onClick={onToggleContext}
            className={`flex items-center justify-center w-9 h-9 md:w-10 md:h-10 rounded-lg transition-colors flex-shrink-0 ${showContext ? 'bg-gray-200 text-gray-800' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
            title="Toggle Details"
          >
            <LayoutList size={18} />
          </button>
          <ChatActionsMenu conversation={conversation} act={act} onChanged={onChanged} onCleared={onCleared} toast={toast} onClose={onBack} />
        </div>
      </div>

      {/* In-chat search bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 md:px-5 py-2 border-b border-gray-200 bg-white flex-shrink-0">
          <Search size={16} className="text-gray-400 flex-shrink-0" />
          <input
            autoFocus
            className="flex-1 min-w-0 text-sm outline-none bg-transparent text-gray-900 placeholder:text-gray-400"
            placeholder="Search in this chat…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="text-xs text-gray-400 flex-shrink-0">
            {search.trim() ? `${visibleMessages.length} found` : ''}
          </span>
          <button
            onClick={() => { setSearch(''); setShowSearch(false); }}
            className="text-gray-400 hover:text-gray-700 flex-shrink-0"
            aria-label="Close search"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Blocked banner */}
      {conversation.blocked_at && (
        <div className="flex items-center gap-2 px-3 md:px-5 py-2.5 bg-red-50 border-b border-red-200 flex-shrink-0 text-red-700">
          <ShieldBan size={16} className="flex-shrink-0" />
          <span className="text-sm font-medium">This contact is blocked. The bot ignores their messages.</span>
        </div>
      )}

      {/* Handoff banner */}
      {isPending && conversation.handoff_reason && (
        <div className="flex items-start gap-3 px-3 md:px-5 py-3 md:py-4 bg-gray-50 border-b border-gray-200 flex-shrink-0">
          <AlertCircle size={16} className="text-gray-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-gray-900">Waiting for a team member</div>
            <div className="text-xs text-gray-600 mt-0.5 break-words">{conversation.handoff_reason}</div>
            <div className="flex gap-2 mt-3">
              <Button variant="primary" size="sm"
                onClick={() => act(() => api.acceptHandoff(conversation.id), 'Accepted')}>
                Accept
              </Button>
              <Button variant="secondary" size="sm"
                onClick={() => act(() => api.rejectHandoff(conversation.id), 'Rejected, AI taking over')}>
                Reject
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 md:px-5 py-4 md:py-5 chat-bg flex flex-col gap-1 min-w-0 relative"
        role="log"
        aria-live="polite"
      >
        {hasMore && (
          <div className="flex justify-center py-2">
            <span className="text-xs text-gray-400">Loading earlier messages…</span>
          </div>
        )}
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
            {g.items.map((m) => {
              if (m.type === 'reaction') {
                // Its target is on a page not currently loaded - say so
                // rather than showing nothing, so it is not mistaken for a
                // reaction that never happened.
                return (
                  <div key={m.id} className="flex justify-center my-1">
                    <span className="text-xs text-gray-400 italic">
                      {m.direction === 'inbound' ? 'They' : 'You'} reacted {m.reaction_emoji || ''} to an earlier message
                    </span>
                  </div>
                );
              }
              const quoted = m.reply_to_wamid ? messageByWamid.get(m.reply_to_wamid) : null;
              const reactions = m.wa_message_id ? reactionsByTarget.get(m.wa_message_id) : null;
              const reactionBadge = reactions && (reactions.inbound || reactions.outbound);
              const picking = reactingTo === m.id;
              const reactAnchorRef = { current: null };
              return (
              <div
                key={m.id}
                className={`group relative flex items-center gap-1.5 ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'} ${reactionBadge ? 'mb-3.5' : 'mb-1'}`}
              >
                {/* Reply / react affordances, mirrored so they always sit toward
                    the centre of the row. Appear on hover (desktop) and are
                    always tappable on touch. */}
                {m.direction === 'outbound' && (
                  <div className="flex items-center gap-1 opacity-50 md:opacity-0 md:group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button type="button" onClick={() => setReplyTo(m)}
                      className="text-gray-400 hover:text-gray-700" title="Reply" aria-label="Reply">
                      <Reply size={15} />
                    </button>
                    <button ref={reactAnchorRef} type="button" onClick={() => setReactingTo(picking ? null : m.id)}
                      className="text-gray-400 hover:text-gray-700" title="React" aria-label="React">
                      <Smile size={15} />
                    </button>
                  </div>
                )}
                {picking && (
                  <ReactionPicker
                    anchorRef={reactAnchorRef}
                    align={m.direction === 'outbound' ? 'right' : 'left'}
                    onPick={(e) => react(m, e)}
                    onClose={() => setReactingTo(null)}
                  />
                )}
                <div
                  className={`
                    relative max-w-[85%] md:max-w-[72%] px-3 md:px-5 py-2 md:py-3 rounded-2xl text-sm md:text-lg leading-relaxed shadow-xs
                    break-words [overflow-wrap:anywhere]
                    ${m.direction === 'outbound' ? 'msg-outbound bg-gray-800 text-white rounded-br-sm' : 'msg-inbound bg-white text-gray-900 rounded-bl-sm border border-black/5'}
                    ${m.direction === 'outbound' ? 'pr-14' : ''}
                  `}
                >
                  {quoted && (
                    <div className={`mb-1.5 px-2.5 py-1.5 rounded-lg border-l-2 text-xs ${m.direction === 'outbound' ? 'bg-white/10 border-white/40 text-white/80' : 'bg-black/5 border-gray-400 text-gray-600'}`}>
                      <div className="font-semibold opacity-80">{quoted.direction === 'outbound' ? 'You' : (conversation.name || conversation.wa_id)}</div>
                      <div className="truncate">{snippet(quoted)}</div>
                    </div>
                  )}
                  {MEDIA_TYPES.has(m.type)
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
                  {/* Reaction badge, WhatsApp style: sits on the outer bottom
                      corner of the bubble it reacted to. Shows one emoji per
                      side if both the lead and the business reacted. */}
                  {reactionBadge && (
                    <div className={`absolute -bottom-3.5 flex items-center gap-0.5 bg-white border border-black/10 rounded-full shadow-xs px-1 py-0.5 text-sm leading-none ${m.direction === 'outbound' ? 'left-2' : 'right-2'}`}>
                      {reactions.inbound && <span>{reactions.inbound}</span>}
                      {reactions.outbound && <span>{reactions.outbound}</span>}
                    </div>
                  )}
                </div>
                {m.direction !== 'outbound' && (
                  <div className="flex items-center gap-1 opacity-50 md:opacity-0 md:group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button ref={reactAnchorRef} type="button" onClick={() => setReactingTo(picking ? null : m.id)}
                      className="text-gray-400 hover:text-gray-700" title="React" aria-label="React">
                      <Smile size={15} />
                    </button>
                    <button type="button" onClick={() => setReplyTo(m)}
                      className="text-gray-400 hover:text-gray-700" title="Reply" aria-label="Reply">
                      <Reply size={15} />
                    </button>
                  </div>
                )}
              </div>
              );
            })}
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

        {/* Reply preview — the message being quoted, with a cancel button */}
        {replyTo && (
          <div className="flex items-center gap-2 px-3 md:px-5 py-2 border-t border-gray-100 bg-gray-50">
            <div className="w-1 self-stretch rounded-full bg-[var(--accent)] flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-gray-700">
                Replying to {replyTo.direction === 'outbound' ? 'yourself' : (conversation.name || conversation.wa_id)}
              </div>
              <div className="text-xs text-gray-500 truncate">{snippet(replyTo)}</div>
            </div>
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              className="text-gray-400 hover:text-gray-700 flex-shrink-0"
              aria-label="Cancel reply"
            >
              <X size={16} />
            </button>
          </div>
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

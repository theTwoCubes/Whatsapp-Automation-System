// Small view helpers for the console.

import { useEffect, useState } from 'react';

// Local nicknames for phone numbers. The backend never sees these, they live in
// the browser only. Keyed by wa_id so a number gets the same label across every
// place it shows up in the UI.
const aliasKey = (waId) => `wa_alias:${waId}`;
const aliasEvent = 'wa-alias-changed';

export function getAlias(waId) {
  if (!waId) return null;
  try { return localStorage.getItem(aliasKey(waId)) || null; } catch { return null; }
}

export function setAlias(waId, name) {
  if (!waId) return;
  const trimmed = (name || '').trim();
  try {
    if (trimmed) localStorage.setItem(aliasKey(waId), trimmed);
    else localStorage.removeItem(aliasKey(waId));
  } catch { /* storage disabled */ }
  window.dispatchEvent(new CustomEvent(aliasEvent, { detail: { waId, name: trimmed || null } }));
}

// Reactive lookup for one number, so any component listing conversations
// re-renders when a nickname changes elsewhere.
export function useAlias(waId) {
  const [alias, setState] = useState(() => getAlias(waId));
  useEffect(() => {
    setState(getAlias(waId));
    const onChange = (e) => {
      if (!e.detail || e.detail.waId === waId) setState(getAlias(waId));
    };
    window.addEventListener(aliasEvent, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(aliasEvent, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, [waId]);
  return alias;
}

// The name to actually show for a contact. Alias wins over whatever WhatsApp
// gave us, and the wa_id is the last resort so a row is never blank.
export function displayName({ waId, name } = {}) {
  return getAlias(waId) || name || waId || '';
}

const avatarColors = ['#0083c0', '#00a884', '#7f66ff', '#d9772b', '#c0392b', '#2a7d6f', '#b2417a'];

export function initials(name, fallback) {
  const base = (name || fallback || '?').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function avatarColor(key) {
  const s = String(key || '');
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return avatarColors[hash % avatarColors.length];
}

export function shortTime(value) {
  if (!value) return '';
  const d = new Date(value);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(value) {
  if (!value) return '';
  const d = new Date(value);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

// Highest {{n}} placeholder in a template body, so the console can ask for that
// many parameter values.
export function templateParamCount(body) {
  if (!body) return 0;
  const nums = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

// Groups messages by calendar day for the date separators.
export function groupByDay(messages) {
  const groups = [];
  let current = null;
  for (const m of messages) {
    const label = dayLabel(m.sent_at || m.created_at);
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(m);
  }
  return groups;
}

// Saves a downloaded file (an xlsx export, a knowledge-base attachment) to
// disk. A plain <a download> click does not work inside the APK's WebView,
// so on native this writes to the cache dir via Filesystem and opens the
// share sheet instead; on the web it is a normal browser download.
export async function downloadBlob(filename, blob) {
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

// Parses the raw drip_steps setting string (e.g. "template1:3,template2:7" or
// "template1:3:42" when a media asset id is attached to that step) into an
// array of { step, template, days, mediaAssetId } objects for the UI.
export function parseDripSteps(raw) {
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map((part, i) => {
    const [template, days, mediaAssetId] = part.trim().split(':');
    return {
      step: i + 1,
      template: template?.trim() || '',
      days: days?.trim() || '',
      mediaAssetId: mediaAssetId?.trim() || '',
    };
  }).filter((s) => s.template);
}


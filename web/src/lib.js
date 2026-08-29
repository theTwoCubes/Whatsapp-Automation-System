// Small view helpers for the console.

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
    const label = dayLabel(m.created_at);
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(m);
  }
  return groups;
}

// Parses the raw drip_steps setting string (e.g. "template1:3,template2:7")
// into an array of { step, template, days } objects for the UI.
export function parseDripSteps(raw) {
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map((part, i) => {
    const [template, days] = part.trim().split(':');
    return { step: i + 1, template: template?.trim() || '', days: days?.trim() || '' };
  }).filter((s) => s.template);
}


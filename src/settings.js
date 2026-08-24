import { parseDripSteps } from './config.js';

// Runtime settings the client edits from the console. They are stored in the
// settings table and fall back to the env driven config defaults. Cached for a
// few seconds so a busy webhook path is not querying on every message.

let cache = null;
let cachedAt = 0;
const ttlMs = 15000;

export function invalidateSettings() {
  cache = null;
}

export async function getSettings(pool, config) {
  const now = Date.now();
  if (cache && now - cachedAt < ttlMs) return cache;

  const rows = (await pool.query('select key, value from settings')).rows;
  const db = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = resolve(db, config);
  cachedAt = now;
  return cache;
}

// The raw editable values for the settings form, current value or the default.
export async function getEditableSettings(pool, config) {
  const rows = (await pool.query('select key, value from settings')).rows;
  const db = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    business_name: db.business_name ?? config.businessName,
    business_about: db.business_about ?? config.businessAbout,
    business_tone: db.business_tone ?? config.businessTone,
    fallback_message: db.fallback_message ?? config.fallbackMessage,
    handoff_message: db.handoff_message ?? config.handoffMessage,
    drip_steps: db.drip_steps ?? serializeDrip(config.dripSteps),
    resume_minutes: db.resume_minutes ?? String(config.resumeMinutes),
  };
}

export const editableKeys = [
  'business_name',
  'business_about',
  'business_tone',
  'fallback_message',
  'handoff_message',
  'drip_steps',
  'resume_minutes',
];

function resolve(db, config) {
  const dripRaw = db.drip_steps ?? serializeDrip(config.dripSteps);
  return {
    businessName: db.business_name ?? config.businessName,
    businessAbout: db.business_about ?? config.businessAbout,
    businessTone: db.business_tone ?? config.businessTone,
    fallbackMessage: db.fallback_message ?? config.fallbackMessage,
    handoffMessage: db.handoff_message ?? config.handoffMessage,
    dripSteps: parseDripSteps(dripRaw),
    dripLanguage: config.dripLanguage,
    resumeMinutes: db.resume_minutes != null ? Number(db.resume_minutes) : config.resumeMinutes,
  };
}

function serializeDrip(steps) {
  return (steps || []).map((s) => `${s.template}:${s.days}`).join(',');
}

import { parseDripSteps } from './config.js';
import { setSettings } from './db/repo.js';

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
    attachment_message: db.attachment_message ?? config.attachmentMessage,
    drip_steps: db.drip_steps ?? serializeDrip(config.dripSteps),
    resume_minutes: db.resume_minutes ?? String(config.resumeMinutes),
    brand_name: db.brand_name ?? config.brandName,
    brand_watermark: db.brand_watermark ?? config.brandWatermark,
    support_email: db.support_email ?? config.supportEmail,
    accent_color: db.accent_color ?? config.accentColor,
    website_url: db.website_url ?? config.websiteUrl,
    contact_phone: db.contact_phone ?? config.contactPhone,
    instagram_url: db.instagram_url ?? config.instagramUrl,
  };
}

// Public branding for the console shell, safe to serve without auth.
export async function getBranding(pool, config) {
  const rows = (await pool.query('select key, value from settings')).rows;
  const db = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    name: db.brand_name ?? config.brandName,
    watermark: db.brand_watermark ?? config.brandWatermark,
    supportEmail: db.support_email ?? config.supportEmail,
    accentColor: db.accent_color ?? config.accentColor,
  };
}

export const editableKeys = [
  'business_name',
  'business_about',
  'business_tone',
  'fallback_message',
  'handoff_message',
  'attachment_message',
  'drip_steps',
  'resume_minutes',
  'brand_name',
  'brand_watermark',
  'support_email',
  'accent_color',
  'website_url',
  'contact_phone',
  'instagram_url',
];

function resolve(db, config) {
  const dripRaw = db.drip_steps ?? serializeDrip(config.dripSteps);
  return {
    businessName: db.business_name ?? config.businessName,
    businessAbout: db.business_about ?? config.businessAbout,
    businessTone: db.business_tone ?? config.businessTone,
    fallbackMessage: db.fallback_message ?? config.fallbackMessage,
    handoffMessage: db.handoff_message ?? config.handoffMessage,
    attachmentMessage: db.attachment_message ?? config.attachmentMessage,
    dripSteps: parseDripSteps(dripRaw),
    dripLanguage: config.dripLanguage,
    resumeMinutes: db.resume_minutes != null ? Number(db.resume_minutes) : config.resumeMinutes,
    aiProvider: db.ai_provider ?? config.aiProvider,
    openaiApiKey: db.openai_api_key ?? config.openaiApiKey,
    openaiModel: db.openai_model ?? config.openaiModel,
    geminiApiKey: db.gemini_api_key ?? config.geminiApiKey,
    geminiModel: db.gemini_model ?? config.geminiModel,
    websiteUrl: db.website_url ?? config.websiteUrl,
    contactPhone: db.contact_phone ?? config.contactPhone,
    instagramUrl: db.instagram_url ?? config.instagramUrl,
    supportEmail: db.support_email ?? config.supportEmail,
  };
}

function serializeDrip(steps) {
  return (steps || []).map((s) => `${s.template}:${s.days}`).join(',');
}

// Admin-only view of the AI provider config. Keys are never sent back to the
// browser in full - only whether one is set and its last 4 characters, so the
// form can show "a key is already saved" without the network tab leaking it.
export async function getAiSettings(pool, config) {
  const rows = (await pool.query('select key, value from settings')).rows;
  const db = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const openaiApiKey = db.openai_api_key ?? config.openaiApiKey;
  const geminiApiKey = db.gemini_api_key ?? config.geminiApiKey;
  return {
    aiProvider: db.ai_provider ?? config.aiProvider,
    openaiModel: db.openai_model ?? config.openaiModel,
    openaiConfigured: Boolean(openaiApiKey),
    openaiKeyHint: openaiApiKey ? `••••${openaiApiKey.slice(-4)}` : null,
    geminiModel: db.gemini_model ?? config.geminiModel,
    geminiConfigured: Boolean(geminiApiKey),
    geminiKeyHint: geminiApiKey ? `••••${geminiApiKey.slice(-4)}` : null,
  };
}

// A blank or omitted key field means "keep the existing one" - the form never
// has the real value to send back, so there is nothing else it could mean.
export async function saveAiSettings(pool, fields) {
  const entries = {};
  if (fields.aiProvider === 'openai' || fields.aiProvider === 'gemini') entries.ai_provider = fields.aiProvider;
  if (fields.openaiModel) entries.openai_model = fields.openaiModel;
  if (fields.geminiModel) entries.gemini_model = fields.geminiModel;
  if (fields.openaiApiKey) entries.openai_api_key = fields.openaiApiKey;
  if (fields.geminiApiKey) entries.gemini_api_key = fields.geminiApiKey;
  await setSettings(pool, entries);
  invalidateSettings();
}

import pg from 'pg';
import { runMigrations } from '../../../src/db/migrate.js';
import { invalidateSettings } from '../../../src/settings.js';

// A test database, kept separate from the dev one. Override with TEST_DATABASE_URL.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL || 'postgres://whatsapp:whatsapp@localhost:5432/whatsapp_test';

export async function setupPool() {
  await ensureDatabase(testDatabaseUrl);
  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  await runMigrations(pool);
  return pool;
}

// Creates the test database if it is not there yet, so `npm test` works on a
// fresh machine. Best effort: if the role cannot create it, the connection
// below fails with a clear error instead.
async function ensureDatabase(url) {
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await admin.query(`create database ${dbName}`);
    }
  } catch {
    // ignore, the pool below will surface a real connection error if needed
  } finally {
    await admin.end();
  }
}

export async function resetTables(pool) {
  await pool.query(
    'truncate messages, conversations, contacts, campaigns, knowledge_base, faqs, faq_versions, faq_proposals, handoff_events, drip_jobs, templates, settings, media_assets, audit_log, topics restart identity cascade',
  );
  await pool.query(
    'update learning_state set last_message_id = 0, last_handoff_id = 0, last_run_at = null where id = 1',
  );
  invalidateSettings();
}

// Records outbound sends instead of calling Meta.
export class FakeMeta {
  constructor() {
    this.sends = [];
    this.templates = [];
  }
  async sendText(to, body) {
    const wamid = `wamid.OUT${this.sends.length + 1}`;
    this.sends.push({ to, body, wamid });
    return wamid;
  }
  async sendTemplate(to, name, language, components) {
    const wamid = `wamid.TPL${this.templates.length + 1}`;
    this.templates.push({ to, name, language, components, wamid });
    return wamid;
  }
  async fetchTemplates() {
    return [
      { name: 'drip_day3', language: 'en', category: 'MARKETING', status: 'APPROVED', body: 'Hi {{1}}, still thinking it over?' },
      { name: 'pending_one', language: 'en', category: 'UTILITY', status: 'PENDING', body: 'Your order {{1}}' },
    ];
  }
  async getBusinessProfile() {
    return this.profile ?? { about: 'We design logos and brands', email: 'hi@x.com' };
  }
  async updateBusinessProfile(fields) {
    this.profile = { ...(this.profile ?? {}), ...fields };
    return { success: true };
  }
  async uploadMedia(buffer, mimeType, filename) {
    this.uploads = this.uploads ?? [];
    this.uploads.push({ mimeType, filename });
    return `media-${this.uploads.length}`;
  }
  async sendMedia(to, kind, opts) {
    this.media = this.media ?? [];
    const wamid = `wamid.MED${this.media.length + 1}`;
    this.media.push({ to, kind, opts, wamid });
    return wamid;
  }
  async createTemplate(t) {
    this.created = this.created ?? [];
    this.created.push(t);
    return { id: 'tpl-1', status: 'PENDING' };
  }
  async getMediaUrl(id) {
    return `https://media.example/${id}`;
  }
  async downloadMedia() {
    return { buffer: Buffer.from('fake-bytes'), contentType: 'image/png' };
  }
}

// Returns a fixed reply instead of calling OpenAI. Set fail=true to simulate the
// api being unavailable.
export class FakeAi {
  constructor(reply = JSON.stringify({ action: 'answer', reply: 'Here is a helpful answer.' }), fail = false) {
    this.reply = reply;
    this.fail = fail;
    this.calls = 0;
    this.enabled = true;
  }
  async complete() {
    this.calls += 1;
    if (this.fail) throw new Error('ai unavailable');
    return this.reply;
  }
}


export const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silentLog;
  },
};

export const testConfig = {
  businessName: 'Test Studio',
  businessAbout: 'We design logos and brands.',
  businessTone: 'friendly',
  fallbackMessage: 'Thanks, the team will get back to you.',
  handoffMessage: 'Connecting you with a person now.',
  attachmentMessage: 'Got your file, connecting you with a person now.',
  faqBudgetTokens: 6000,
  messageBatchDebounceMs: 30,
  messageBatchMaxWaitMs: 200,
  mediaResendCooldownMinutes: 180,
  dripSteps: [
    { step: 1, template: 'drip_day3', days: 3 },
    { step: 2, template: 'drip_day5', days: 5 },
    { step: 3, template: 'drip_day8', days: 8 },
  ],
  dripLanguage: 'en',
  resumeMinutes: 0,
  brandName: 'theTwoCubes',
  brandWatermark: 'Made by theTwoCubes',
  supportEmail: 'build@thetwocubes.com',
  accentColor: '#00a884',
};

import pg from 'pg';
import { runMigrations } from '../../../src/db/migrate.js';

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
    'truncate messages, conversations, contacts, campaigns, knowledge_base, drip_jobs, templates restart identity cascade',
  );
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
  async sendTemplate(to, name, language) {
    const wamid = `wamid.TPL${this.templates.length + 1}`;
    this.templates.push({ to, name, language, wamid });
    return wamid;
  }
}

// Returns a fixed reply instead of calling OpenAI. Set fail=true to simulate the
// api being unavailable.
export class FakeAi {
  constructor(reply = 'Here is a helpful answer.', fail = false) {
    this.reply = reply;
    this.fail = fail;
    this.calls = 0;
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
  dripSteps: [
    { step: 1, template: 'drip_day3', days: 3 },
    { step: 2, template: 'drip_day5', days: 5 },
    { step: 3, template: 'drip_day8', days: 8 },
  ],
  dripLanguage: 'en',
};

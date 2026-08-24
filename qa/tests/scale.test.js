import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../../src/server.js';
import { claimDueDrips, recordInbound } from '../../src/db/repo.js';
import { setupPool, resetTables, testConfig } from './support/harness.js';

let pool;
let app;
const config = {
  ...testConfig,
  jwtSecret: 's',
  graphApiVersion: 'v21.0',
  phoneNumberId: 'x',
  accessToken: 'x',
  verifyToken: 'x',
  appSecret: 'x',
  openaiApiKey: '',
  geminiApiKey: '',
  aiProvider: 'openai',
  adminEmail: '',
  adminPassword: '',
};

before(async () => {
  pool = await setupPool();
  app = buildServer(config, pool);
  await app.ready();
});
after(async () => {
  await app?.close();
  await pool?.end();
});
beforeEach(async () => {
  await resetTables(pool);
});

test('the readiness endpoint reports ready when the db is up', async () => {
  const res = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ready');
});

test('the metrics endpoint exposes counters', async () => {
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /wa_leads \d+/);
  assert.match(res.body, /wa_drip_pending \d+/);
});

test('a due drip is claimed once so concurrent schedulers never double send', async () => {
  const { conversationId } = await recordInbound(pool, {
    waId: '919000000000',
    name: 'X',
    waMessageId: 'wamid.D',
    type: 'text',
    body: 'hi',
    referral: null,
    raw: {},
  });
  await pool.query(
    `insert into drip_jobs (conversation_id, step, template_name, run_at)
     values ($1, 1, 'drip_day3', now() - interval '1 minute')`,
    [conversationId],
  );

  const first = await claimDueDrips(pool, 10);
  const second = await claimDueDrips(pool, 10);
  assert.equal(first.length, 1, 'first claim gets the job');
  assert.equal(second.length, 0, 'a second claim gets nothing');
});

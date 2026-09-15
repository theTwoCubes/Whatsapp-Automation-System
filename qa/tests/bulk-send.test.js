import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';

import { registerApi } from '../../src/routes/api.js';
import { runBulkSend } from '../../src/scheduler.js';
import { queueBulkSend, bulkSendBatchProgress, createAgent } from '../../src/db/repo.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { hashPassword } from '../../src/auth.js';
import { setupPool, resetTables, FakeMeta, FakeAi, silentLog, testConfig } from './support/harness.js';

let pool;
const apiConfig = { ...testConfig, jwtSecret: 'test-secret' };
const noopRealtime = { emit() {}, add() {}, size: () => 0 };

before(async () => {
  pool = await setupPool();
});
after(async () => {
  await pool?.end();
});
beforeEach(async () => {
  await resetTables(pool);
  await pool.query('truncate agents restart identity cascade');
  await createAgent(pool, { email: 'a@b.com', name: 'A', passwordHash: hashPassword('secret'), role: 'admin' });
});

async function buildApp(meta) {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret' });
  await app.register(fastifyWebsocket);
  registerApi(app, { pool, meta, ai: new FakeAi(), config: apiConfig, realtime: noopRealtime });
  await app.ready();
  return app;
}

async function tokenFor(app) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.com', password: 'secret' } });
  return res.json().token;
}

test('queued leads are sent their template a batch at a time and marked sent', async () => {
  const batchId = randomUUID();
  const queued = await queueBulkSend(pool, batchId, [
    { waId: '919000000001', name: 'Asha' },
    { waId: '919000000002', name: 'Bhavesh' },
  ], 'drip_day3');
  assert.equal(queued, 2);

  const meta = new FakeMeta();
  const processed = await runBulkSend({ pool, meta, config: testConfig, log: silentLog });
  assert.equal(processed, 2);
  assert.equal(meta.templates.length, 2);
  assert.deepEqual(meta.templates.map((t) => t.to).sort(), ['919000000001', '919000000002']);

  const progress = await bulkSendBatchProgress(pool, batchId);
  assert.equal(progress.total, 2);
  assert.equal(progress.byStatus.sent, 2);
});

test('a queued lead gets a real conversation, tagged with the chosen service', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const batchId = randomUUID();
  await queueBulkSend(pool, batchId, [
    { waId: '919000000003', name: 'Chetan', business: 'Chetan Traders', email: 'chetan@example.com', topicId: topic.id },
  ], 'drip_day3');

  await runBulkSend({ pool, meta: new FakeMeta(), config: testConfig, log: silentLog });

  const row = await pool.query(
    `select c.last_topic_id, ct.name, ct.business, ct.email
     from conversations c join contacts ct on ct.id = c.contact_id
     where ct.wa_id = '919000000003'`,
  );
  assert.equal(Number(row.rows[0].last_topic_id), Number(topic.id));
  assert.equal(row.rows[0].name, 'Chetan');
  assert.equal(row.rows[0].business, 'Chetan Traders');
  assert.equal(row.rows[0].email, 'chetan@example.com');
});

test('a send that throws before Meta confirms anything is marked failed with the error, not silently dropped', async () => {
  const batchId = randomUUID();
  await queueBulkSend(pool, batchId, [{ waId: '919000000004', name: 'Dev' }], 'drip_day3');

  const meta = new FakeMeta();
  meta.sendTemplate = async () => { throw new Error('template not approved'); };

  const processed = await runBulkSend({ pool, meta, config: testConfig, log: silentLog });
  assert.equal(processed, 1);

  const progress = await bulkSendBatchProgress(pool, batchId);
  assert.equal(progress.byStatus.failed, 1);
  const row = await pool.query('select error from bulk_send_jobs where batch_id = $1', [batchId]);
  assert.equal(row.rows[0].error, 'template not approved');
});

test('re-queuing the same number reuses the existing conversation instead of creating a duplicate', async () => {
  const batchId = randomUUID();
  await queueBulkSend(pool, batchId, [{ waId: '919000000005', name: 'Esha' }], 'drip_day3');
  await runBulkSend({ pool, meta: new FakeMeta(), config: testConfig, log: silentLog });

  const batchId2 = randomUUID();
  await queueBulkSend(pool, batchId2, [{ waId: '919000000005', name: 'Esha' }], 'drip_day3');
  await runBulkSend({ pool, meta: new FakeMeta(), config: testConfig, log: silentLog });

  const count = await pool.query('select count(*)::int as n from conversations');
  assert.equal(count.rows[0].n, 1);
});

async function insertApprovedTemplate(name = 'drip_day3') {
  await pool.query(
    `insert into templates (name, language, category, body, status, active) values ($1, 'en', 'MARKETING', 'Hi {{1}}', 'APPROVED', true)`,
    [name],
  );
}

test('POST /api/bulk-send parses the pasted list, rejects a template that is not approved', async () => {
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);

  const notApproved = await app.inject({
    method: 'POST', url: '/api/bulk-send', headers: { authorization: `Bearer ${token}` },
    payload: { text: 'Asha, 919000000010', templateName: 'not_a_real_template' },
  });
  assert.equal(notApproved.statusCode, 400);

  await insertApprovedTemplate();
  const res = await app.inject({
    method: 'POST', url: '/api/bulk-send', headers: { authorization: `Bearer ${token}` },
    payload: { text: 'Asha, 919000000010\nBhavesh, 919000000011\nJust a name with no number', templateName: 'drip_day3' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.queued, 2);
  assert.equal(body.skipped, 1, 'the line with no usable phone number is reported, not silently dropped');

  const progress = await app.inject({ method: 'GET', url: `/api/bulk-send/${body.batchId}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(progress.json().progress.total, 2);
  await app.close();
});

test('POST /api/bulk-send rejects a topicId for a service that does not exist, with a 400 not a raw db error', async () => {
  await insertApprovedTemplate();
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);

  const res = await app.inject({
    method: 'POST', url: '/api/bulk-send', headers: { authorization: `Bearer ${token}` },
    payload: { text: 'Asha, 919000000012', templateName: 'drip_day3', topicId: 999999 },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /api/bulk-send/batches lists recent batches with their progress', async () => {
  await insertApprovedTemplate();
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);

  await app.inject({
    method: 'POST', url: '/api/bulk-send', headers: { authorization: `Bearer ${token}` },
    payload: { text: 'Asha, 919000000013', templateName: 'drip_day3' },
  });

  const res = await app.inject({ method: 'GET', url: '/api/bulk-send/batches', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().batches.length, 1);
  assert.equal(res.json().batches[0].total, 1);
  await app.close();
});

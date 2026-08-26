import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';

import { registerApi } from '../../src/routes/api.js';
import { createAgent, getConversationById } from '../../src/db/repo.js';
import { hashPassword } from '../../src/auth.js';
import { processWebhook } from '../../src/handlers/message.js';
import { inboundText, inboundImage } from './support/fixtures.js';
import { setupPool, resetTables, FakeMeta, FakeAi, FakeEmbeddings, silentLog, testConfig } from './support/harness.js';

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
  await createAgent(pool, { email: 'a@b.com', name: 'A', passwordHash: hashPassword('secret') });
});

async function buildApp() {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret' });
  await app.register(fastifyWebsocket);
  registerApi(app, {
    pool,
    meta: new FakeMeta(),
    ai: new FakeAi(),
    embeddings: new FakeEmbeddings(),
    config: apiConfig,
    realtime: noopRealtime,
  });
  await app.ready();
  return app;
}

async function tokenFor(app) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.com', password: 'secret' } });
  return res.json().token;
}

async function pendingConversation() {
  await processWebhook(inboundText({ id: `wamid.${Math.random()}`, body: 'can I talk to a human' }), {
    meta: new FakeMeta(),
    ai: new FakeAi(),
    embeddings: new FakeEmbeddings(),
    pool,
    config: testConfig,
    log: silentLog,
  });
  return (await pool.query('select id from conversations limit 1')).rows[0].id;
}

test('a lead sending an attachment queues a pending handoff with a reason', async () => {
  await processWebhook(inboundImage({ id: 'wamid.att1' }), {
    meta: new FakeMeta(),
    ai: new FakeAi(),
    embeddings: new FakeEmbeddings(),
    pool,
    config: testConfig,
    log: silentLog,
  });
  const row = (await pool.query('select state, handoff_reason from conversations limit 1')).rows[0];
  assert.equal(row.state, 'pending');
  assert.match(row.handoff_reason, /image/i);
});

test('accepting a pending handoff claims it for the agent', async () => {
  const id = await pendingConversation();
  const app = await buildApp();
  const token = await tokenFor(app);
  const h = { authorization: `Bearer ${token}` };

  const res = await app.inject({ method: 'POST', url: `/api/conversations/${id}/accept`, headers: h });
  assert.equal(res.statusCode, 200);

  const conv = await getConversationById(pool, id);
  assert.equal(conv.state, 'human');
  assert.equal(conv.assignee, 'a@b.com');
  await app.close();
});

test('rejecting a pending handoff sends it back to the bot', async () => {
  const id = await pendingConversation();
  const app = await buildApp();
  const token = await tokenFor(app);
  const h = { authorization: `Bearer ${token}` };

  const res = await app.inject({ method: 'POST', url: `/api/conversations/${id}/reject`, headers: h });
  assert.equal(res.statusCode, 200);

  const conv = await getConversationById(pool, id);
  assert.equal(conv.state, 'bot');
  assert.equal(conv.assignee, null);
  assert.equal(conv.handoff_reason, null);
  await app.close();
});

test('accept and reject refuse a conversation that is not pending', async () => {
  const app = await buildApp();
  const token = await tokenFor(app);
  const h = { authorization: `Bearer ${token}` };

  await processWebhook(inboundText({ id: `wamid.${Math.random()}`, body: 'hi' }), {
    meta: new FakeMeta(),
    ai: new FakeAi(),
    embeddings: new FakeEmbeddings(),
    pool,
    config: testConfig,
    log: silentLog,
  });
  const id = (await pool.query('select id from conversations limit 1')).rows[0].id;

  const res = await app.inject({ method: 'POST', url: `/api/conversations/${id}/accept`, headers: h });
  assert.equal(res.statusCode, 409);
  await app.close();
});

test('an agent replying to a pending chat implicitly accepts it', async () => {
  const id = await pendingConversation();
  await pool.query("update conversations set window_expires_at = now() + interval '1 hour' where id = $1", [id]);
  const app = await buildApp();
  const token = await tokenFor(app);
  const h = { authorization: `Bearer ${token}` };

  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${id}/messages`,
    headers: h,
    payload: { body: 'Hey, I can help with that' },
  });
  assert.equal(res.statusCode, 200);

  const conv = await getConversationById(pool, id);
  assert.equal(conv.state, 'human');
  assert.equal(conv.assignee, 'a@b.com');
  await app.close();
});

test('an agent messaging a chat the bot still owns claims it and stops the drips', async () => {
  await processWebhook(inboundText({ id: `wamid.${Math.random()}`, body: 'hi' }), {
    meta: new FakeMeta(),
    ai: new FakeAi(),
    embeddings: new FakeEmbeddings(),
    pool,
    config: testConfig,
    log: silentLog,
  });
  const id = (await pool.query('select id from conversations limit 1')).rows[0].id;
  const before = await pool.query("select count(*) as n from drip_jobs where conversation_id = $1 and status = 'pending'", [id]);
  assert.ok(Number(before.rows[0].n) > 0, 'the bot reply already scheduled follow ups');

  const app = await buildApp();
  const token = await tokenFor(app);
  const h = { authorization: `Bearer ${token}` };

  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${id}/messages`,
    headers: h,
    payload: { body: "I'll take it from here" },
  });
  assert.equal(res.statusCode, 200);

  const conv = await getConversationById(pool, id);
  assert.equal(conv.state, 'human', 'sending a message claims a bot owned chat, not just a pending one');
  assert.equal(conv.assignee, 'a@b.com');

  const after = await pool.query("select count(*) as n from drip_jobs where conversation_id = $1 and status = 'pending'", [id]);
  assert.equal(Number(after.rows[0].n), 0, 'the drip follow ups are cancelled once an agent has stepped in');
  await app.close();
});

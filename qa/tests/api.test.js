import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';

import { registerApi } from '../../src/routes/api.js';
import { createAgent, getConversationById } from '../../src/db/repo.js';
import { hashPassword } from '../../src/auth.js';
import { processWebhook } from '../../src/handlers/message.js';
import { inboundText } from './support/fixtures.js';
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
  await createAgent(pool, { email: 'a@b.com', name: 'A', passwordHash: hashPassword('secret') });
});

async function buildApp(meta) {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret' });
  await app.register(fastifyWebsocket);
  registerApi(app, { pool, meta, config: apiConfig, realtime: noopRealtime });
  await app.ready();
  return app;
}

async function tokenFor(app) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.com', password: 'secret' } });
  return res.json().token;
}

async function makeConversation() {
  await processWebhook(inboundText({ id: `wamid.${Math.random()}`, body: 'hi' }), {
    meta: new FakeMeta(),
    ai: new FakeAi(),
    pool,
    config: testConfig,
    log: silentLog,
  });
  return (await pool.query('select id from conversations limit 1')).rows[0].id;
}

test('login succeeds with the right password and fails otherwise', async () => {
  const app = await buildApp(new FakeMeta());
  const ok = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.com', password: 'secret' } });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().token);

  const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.com', password: 'nope' } });
  assert.equal(bad.statusCode, 401);
  await app.close();
});

test('protected routes reject a missing token', async () => {
  const app = await buildApp(new FakeMeta());
  const res = await app.inject({ method: 'GET', url: '/api/conversations' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('an agent can list conversations with a token', async () => {
  await makeConversation();
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const res = await app.inject({ method: 'GET', url: '/api/conversations', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().conversations.length, 1);
  await app.close();
});

test('take over and give back flip the conversation state', async () => {
  const id = await makeConversation();
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const h = { authorization: `Bearer ${token}` };

  await app.inject({ method: 'POST', url: `/api/conversations/${id}/takeover`, headers: h });
  assert.equal((await getConversationById(pool, id)).state, 'human');

  await app.inject({ method: 'POST', url: `/api/conversations/${id}/handback`, headers: h });
  assert.equal((await getConversationById(pool, id)).state, 'bot');
  await app.close();
});

test('an agent reply is sent through meta and stored', async () => {
  const id = await makeConversation();
  const meta = new FakeMeta();
  const app = await buildApp(meta);
  const token = await tokenFor(app);

  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${id}/messages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { body: 'hello from an agent' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(meta.sends.at(-1).body, 'hello from an agent');
  await app.close();
});

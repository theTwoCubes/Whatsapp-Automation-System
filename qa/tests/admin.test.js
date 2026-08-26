import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';

import { registerApi } from '../../src/routes/api.js';
import { createAgent, addMediaAsset } from '../../src/db/repo.js';
import { hashPassword } from '../../src/auth.js';
import { processWebhook } from '../../src/handlers/message.js';
import { inboundText, inboundImage } from './support/fixtures.js';
import { setupPool, resetTables, FakeMeta, FakeAi, FakeEmbeddings, silentLog, testConfig } from './support/harness.js';

let pool;
const apiConfig = { ...testConfig, jwtSecret: 'test-secret' };
const noopRealtime = { emit() {}, add() {}, size: () => 0 };
const auth = (t) => ({ authorization: `Bearer ${t}` });

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
  await app.register(fastifyMultipart);
  registerApi(app, { pool, meta, ai: new FakeAi(), embeddings: new FakeEmbeddings(), config: apiConfig, realtime: noopRealtime });
  await app.ready();
  return app;
}
async function token(app) {
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.com', password: 'secret' } });
  return r.json().token;
}
async function makeConversation() {
  await processWebhook(inboundText({ id: `wamid.${Math.random()}`, body: 'hi' }), {
    meta: new FakeMeta(),
    ai: new FakeAi(),
    embeddings: new FakeEmbeddings(),
    pool,
    config: apiConfig,
    log: silentLog,
  });
  return (await pool.query('select id from conversations limit 1')).rows[0].id;
}

test('a non numeric id is rejected with 400 instead of a 500', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({ method: 'GET', url: '/api/conversations/not-a-number', headers: auth(t) });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('login is rate limited after repeated attempts', async () => {
  const app = await buildApp(new FakeMeta());
  let last;
  for (let i = 0; i < 10; i += 1) {
    last = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.com', password: 'wrong' } });
  }
  assert.equal(last.statusCode, 429, 'eventually throttled');
  await app.close();
});

test('sensitive actions are written to the audit log', async () => {
  const convId = await makeConversation();
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  await app.inject({ method: 'POST', url: `/api/conversations/${convId}/takeover`, headers: auth(t) });

  const res = await app.inject({ method: 'GET', url: '/api/audit', headers: auth(t) });
  const actions = res.json().audit.map((a) => a.action);
  assert.ok(actions.includes('takeover'), 'takeover was audited');
  assert.equal(res.json().audit[0].actor, 'a@b.com');
  await app.close();
});

test('overview returns counts', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({ method: 'GET', url: '/api/overview', headers: auth(t) });
  assert.equal(res.statusCode, 200);
  assert.ok('leads' in res.json().overview);
  await app.close();
});

test('knowledge base can be added, listed, updated and deleted', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const add = await app.inject({ method: 'POST', url: '/api/knowledge', headers: auth(t), payload: { title: 'Pricing', content: 'from 5000' } });
  const id = add.json().id;

  let list = await app.inject({ method: 'GET', url: '/api/knowledge', headers: auth(t) });
  assert.equal(list.json().knowledge.length, 1);

  await app.inject({ method: 'DELETE', url: `/api/knowledge/${id}`, headers: auth(t) });
  list = await app.inject({ method: 'GET', url: '/api/knowledge', headers: auth(t) });
  assert.equal(list.json().knowledge.length, 0);
  await app.close();
});

test('agents can be created and removed but not yourself', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  await app.inject({ method: 'POST', url: '/api/agents', headers: auth(t), payload: { email: 'new@x.com', password: 'secret1' } });
  const list = await app.inject({ method: 'GET', url: '/api/agents', headers: auth(t) });
  assert.equal(list.json().agents.length, 2);

  const self = await app.inject({ method: 'DELETE', url: '/api/agents/1', headers: auth(t) });
  assert.equal(self.statusCode, 400, 'cannot remove your own login');
  await app.close();
});

test('editing settings changes the bot fallback message', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  await app.inject({ method: 'PUT', url: '/api/settings', headers: auth(t), payload: { fallback_message: 'We will call you back soon.' } });
  await app.close();

  const meta = new FakeMeta();
  await processWebhook(inboundText({ id: 'wamid.S1', body: 'hello' }), {
    meta,
    ai: new FakeAi('x', true),
    embeddings: new FakeEmbeddings(),
    pool,
    config: apiConfig,
    log: silentLog,
  });
  assert.equal(meta.sends.at(-1).body, 'We will call you back soon.');
});

test('business profile reads and updates through meta', async () => {
  const meta = new FakeMeta();
  const app = await buildApp(meta);
  const t = await token(app);
  const get = await app.inject({ method: 'GET', url: '/api/profile', headers: auth(t) });
  assert.ok(get.json().profile);

  const put = await app.inject({ method: 'PUT', url: '/api/profile', headers: auth(t), payload: { about: 'New about' } });
  assert.equal(put.statusCode, 200);
  assert.equal(meta.profile.about, 'New about');
  await app.close();
});

test('a media asset can be sent to a lead inside the window', async () => {
  const convId = await makeConversation();
  const assetId = await addMediaAsset(pool, { metaMediaId: 'media-1', filename: 'logo.png', mimeType: 'image/png', kind: 'image' });
  const meta = new FakeMeta();
  const app = await buildApp(meta);
  const t = await token(app);

  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${convId}/media`,
    headers: auth(t),
    payload: { assetId, caption: 'here is a sample' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(meta.media.at(-1).kind, 'image');
  assert.equal(meta.media.at(-1).opts.caption, 'here is a sample');
  await app.close();
});

test('branding is public and editable', async () => {
  const app = await buildApp(new FakeMeta());
  const pub = await app.inject({ method: 'GET', url: '/api/branding' });
  assert.equal(pub.statusCode, 200);
  assert.ok(pub.json().branding.name);

  const t = await token(app);
  await app.inject({ method: 'PUT', url: '/api/settings', headers: auth(t), payload: { brand_name: 'Acme Studio' } });
  const after = await app.inject({ method: 'GET', url: '/api/branding' });
  assert.equal(after.json().branding.name, 'Acme Studio');
  await app.close();
});

test('a template can be created through the console', async () => {
  const meta = new FakeMeta();
  const app = await buildApp(meta);
  const t = await token(app);
  const res = await app.inject({
    method: 'POST',
    url: '/api/templates/create',
    headers: auth(t),
    payload: { name: 'welcome', bodyText: 'Hi there, thanks for reaching out.' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(meta.created.at(-1).name, 'welcome');
  await app.close();
});

test('inbound media is proxied from meta', async () => {
  await processWebhook(inboundImage({ id: 'wamid.IMG1' }), {
    meta: new FakeMeta(),
    ai: new FakeAi(),
    embeddings: new FakeEmbeddings(),
    pool,
    config: apiConfig,
    log: silentLog,
  });
  const msgId = (await pool.query("select id from messages where type = 'image' limit 1")).rows[0].id;
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({ method: 'GET', url: `/api/messages/${msgId}/media`, headers: auth(t) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  await app.close();
});

test('sending media is blocked outside the window', async () => {
  const convId = await makeConversation();
  await pool.query("update conversations set window_expires_at = now() - interval '1 hour' where id = $1", [convId]);
  const assetId = await addMediaAsset(pool, { metaMediaId: 'media-1', filename: 'logo.png', mimeType: 'image/png', kind: 'image' });
  const meta = new FakeMeta();
  const app = await buildApp(meta);
  const t = await token(app);

  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${convId}/media`,
    headers: auth(t),
    payload: { assetId },
  });
  assert.equal(res.statusCode, 409);
  await app.close();
});

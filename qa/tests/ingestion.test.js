import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';

import { registerApi } from '../../src/routes/api.js';
import { ingestText } from '../../src/knowledge/ingestion.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { createAgent } from '../../src/db/repo.js';
import { hashPassword } from '../../src/auth.js';
import { setupPool, resetTables, FakeMeta, FakeAi, silentLog, testConfig } from './support/harness.js';

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
  await createAgent(pool, { email: 'a@b.com', name: 'A', passwordHash: hashPassword('secret'), role: 'admin' });
});

async function buildApp() {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret' });
  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart);
  registerApi(app, {
    pool,
    meta: new FakeMeta(),
    ai: new FakeAi(),
    config: apiConfig,
    realtime: noopRealtime,
  });
  await app.ready();
  return app;
}
async function token(app) {
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.com', password: 'secret' } });
  return r.json().token;
}

test('a topic can be created and listed', async () => {
  const app = await buildApp();
  const t = await token(app);
  const create = await app.inject({
    method: 'POST',
    url: '/api/topics',
    headers: auth(t),
    payload: { name: 'Logo Design', slug: 'logo_design', description: 'Our logo service' },
  });
  assert.equal(create.statusCode, 200);
  assert.equal(create.json().topic.slug, 'logo_design');

  const list = await app.inject({ method: 'GET', url: '/api/topics', headers: auth(t) });
  assert.equal(list.json().topics.length, 1);
  await app.close();
});

test('an answer can be added to a pack and listed under it', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const app = await buildApp();
  const t = await token(app);
  const add = await app.inject({
    method: 'POST',
    url: '/api/faqs',
    headers: auth(t),
    payload: { question: 'What does a logo cost?', answer: 'The logo package is 20000 rupees.', topicId: topic.id },
  });
  assert.equal(add.statusCode, 200);
  assert.equal(add.json().faq.question, 'What does a logo cost?');

  const list = await app.inject({ method: 'GET', url: `/api/faqs?pack=${topic.id}`, headers: auth(t) });
  assert.equal(list.json().faqs.length, 1);
  await app.close();
});

test('importing a Q colon A colon document splits it into separate answers', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const raw = [
    'Q: What is your logo design price?',
    'A: The logo package is 15000 rupees plus GST.',
    '',
    'Q: How many revisions do I get?',
    'A: The package includes two rounds of revisions.',
  ].join('\n');

  const res = await ingestText(pool, new FakeAi('not-json'), raw, { topicId: topic.id });
  assert.equal(res.added, 2, 'both answers inserted');
});

test('re-importing the same document adds nothing the second time', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const raw = 'Q: Price?\nA: The logo package is 15000 rupees plus GST.';
  const first = await ingestText(pool, new FakeAi('not-json'), raw, { topicId: topic.id });
  assert.equal(first.added, 1);
  const second = await ingestText(pool, new FakeAi('not-json'), raw, { topicId: topic.id });
  assert.equal(second.added, 0, 'nothing new to add');
  assert.equal(second.skipped, 1);
});

test('re-pasting a pack with one answer edited updates it in place instead of duplicating', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const first = await ingestText(pool, new FakeAi('not-json'), 'Q: Price?\nA: The logo package is 15000 rupees plus GST.', { topicId: topic.id });
  assert.equal(first.added, 1);

  const second = await ingestText(pool, new FakeAi('not-json'), 'Q: Price?\nA: The logo package is now 25000 rupees plus GST.', { topicId: topic.id });
  assert.equal(second.added, 0, 'the question already exists, so this is an update not a new entry');
  assert.equal(second.updated, 1);
  assert.equal(second.skipped, 0);

  const list = (await pool.query('select question, answer from faqs where topic_id = $1', [topic.id])).rows;
  assert.equal(list.length, 1, 'still only one answer, not a duplicate');
  assert.equal(list[0].answer, 'The logo package is now 25000 rupees plus GST.');
});

test('the same question worded with different punctuation is still a duplicate', async () => {
  const first = await ingestText(pool, new FakeAi('not-json'), 'Q: Price?\nA: 20000 rupees.', {});
  assert.equal(first.added, 1);
  const second = await ingestText(pool, new FakeAi('not-json'), 'Q: price\nA: 20000 rupees.', {});
  assert.equal(second.added, 0, 'case and punctuation are normalised before comparing');
});

test('importing through the api reports counts', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const app = await buildApp();
  const t = await token(app);
  const raw = 'Q: Price?\nA: Twenty thousand rupees plus GST.';
  const res = await app.inject({
    method: 'POST',
    url: '/api/faqs/import',
    headers: auth(t),
    payload: { text: raw, topicId: topic.id },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().added, 1);
  await app.close();
});

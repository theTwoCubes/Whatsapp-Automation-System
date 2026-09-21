import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';

import { registerApi } from '../../src/routes/api.js';
import { createAgent, getConversationById, addActivePackIds, setLastTopicId, addMediaAsset, recordOutbound, clearChat, findOrCreateComposeConversation } from '../../src/db/repo.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
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

// findOrCreateComposeConversation no longer has an HTTP route of its own
// (compose-a-fresh-conversation was folded into bulk send), but it's still
// what runBulkSend calls per lead in scheduler.js, so its behavior is
// exercised directly here rather than through the API.
test('composing starts a fresh conversation with no window open, so only a template can be sent', async () => {
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const id = await findOrCreateComposeConversation(pool, { waId: '919876543210', name: 'Cold Lead' });
  assert.ok(id);

  const conv = await getConversationById(pool, id);
  assert.equal(conv.wa_id, '919876543210');
  assert.equal(conv.window_expires_at, null, 'no inbound message yet, so no open window');

  const detail = await app.inject({ method: 'GET', url: `/api/conversations/${id}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(detail.json().conversation.window_open, false, 'the composer will only offer a template, same as any closed-window chat');
  await app.close();
});

test('composing twice for the same number reuses the one conversation', async () => {
  const first = await findOrCreateComposeConversation(pool, { waId: '918000000000' });
  const second = await findOrCreateComposeConversation(pool, { waId: '918000000000' });
  assert.equal(first, second);
});

test('an organic conversation surfaces the service the ai pulled in, for the console\'s service filter', async () => {
  const id = await makeConversation();
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await addActivePackIds(pool, id, [topic.id]);
  await setLastTopicId(pool, id, topic.id);

  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const res = await app.inject({ method: 'GET', url: '/api/conversations', headers: { authorization: `Bearer ${token}` } });
  const conv = res.json().conversations.find((c) => c.id === id);
  assert.equal(Number(conv.topic_id), Number(topic.id), 'no campaign involved, but the ai\'s own pack pick is still surfaced');
  assert.equal(conv.topic_name, 'Logo Design');
  await app.close();
});

test('the service filter follows the most recently discussed service, not the first one ever mentioned', async () => {
  const id = await makeConversation();
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const sciLogo = await upsertTopic(pool, { slug: 'scientific_logo_design', name: 'Scientific Logo Design' });

  // The chat started general, touched Logo Design first, then moved on to
  // Scientific Logo Design - active_pack_ids now holds both, but the filter
  // should reflect the one the lead is actually talking about right now.
  await addActivePackIds(pool, id, [logo.id]);
  await setLastTopicId(pool, id, logo.id);
  await addActivePackIds(pool, id, [sciLogo.id]);
  await setLastTopicId(pool, id, sciLogo.id);

  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const res = await app.inject({ method: 'GET', url: '/api/conversations', headers: { authorization: `Bearer ${token}` } });
  const conv = res.json().conversations.find((c) => c.id === id);
  assert.equal(conv.topic_name, 'Scientific Logo Design', 'the most recent service wins, not the first one discussed');
  await app.close();
});

test('the conversation list reports who started it, for the inbound/outbound filter', async () => {
  const organicId = await makeConversation();
  const composedId = await findOrCreateComposeConversation(pool, { waId: '919000009999', name: 'Reached Out To' });

  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const res = await app.inject({ method: 'GET', url: '/api/conversations', headers: { authorization: `Bearer ${token}` } });
  const conversations = res.json().conversations;

  assert.equal(conversations.find((c) => c.id === organicId).origin, 'lead', 'the lead messaged in on their own');
  assert.equal(conversations.find((c) => c.id === composedId).origin, 'business', 'we reached out first, via compose or bulk send');
  await app.close();
});

test('clearing a chat resets its list preview instead of still showing the wiped message', async () => {
  const id = await makeConversation();

  let app = await buildApp(new FakeMeta());
  let token = await tokenFor(app);
  let res = await app.inject({ method: 'GET', url: '/api/conversations', headers: { authorization: `Bearer ${token}` } });
  let conv = res.json().conversations.find((c) => c.id === id);
  assert.ok(conv.last_message, 'sanity check: the preview shows a real last message before clearing');
  await app.close();

  await clearChat(pool, id);

  app = await buildApp(new FakeMeta());
  token = await tokenFor(app);
  res = await app.inject({ method: 'GET', url: '/api/conversations', headers: { authorization: `Bearer ${token}` } });
  conv = res.json().conversations.find((c) => c.id === id);
  assert.equal(conv.last_message, null, 'the cleared message must not still surface in the list preview');
  assert.equal(conv.last_message_type, null);
  await app.close();
});

test('a file the bot sent from the media library can still be downloaded', async () => {
  const id = await makeConversation();
  const assetId = await addMediaAsset(pool, {
    metaMediaId: 'lib-media-1', filename: 'portfolio.pdf', mimeType: 'application/pdf', kind: 'document',
  });
  await recordOutbound(pool, {
    conversationId: id, waMessageId: `wamid.${Math.random()}`, type: 'document',
    body: '[document] portfolio.pdf', mediaAssetId: assetId,
  });
  const msgId = (await pool.query("select id from messages where media_asset_id = $1", [assetId])).rows[0].id;

  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const res = await app.inject({ method: 'GET', url: `/api/messages/${msgId}/media`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200, 'a bot-sent file must resolve through the media library, not just raw inbound payloads');
  await app.close();
});

test('the contacts export produces a real xlsx workbook, optionally filtered to one service', async () => {
  const id = await makeConversation();
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await setLastTopicId(pool, id, topic.id);
  await pool.query('update contacts set email = $2, business = $3 where id = (select contact_id from conversations where id = $1)', [id, 'lead@example.com', 'Acme Co']);

  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);

  const all = await app.inject({ method: 'GET', url: '/api/contacts/export', headers: { authorization: `Bearer ${token}` } });
  assert.equal(all.statusCode, 200);
  assert.equal(all.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(all.rawPayload);
  const sheet = workbook.getWorksheet('Leads');
  const row = sheet.getRow(2);
  assert.equal(row.getCell(3).value, 'lead@example.com');
  assert.equal(row.getCell(4).value, 'Acme Co');
  assert.equal(row.getCell(5).value, 'Logo Design');

  const otherTopic = await upsertTopic(pool, { slug: 'branding', name: 'Branding' });
  const filtered = await app.inject({ method: 'GET', url: `/api/contacts/export?topicId=${otherTopic.id}`, headers: { authorization: `Bearer ${token}` } });
  const filteredWorkbook = new ExcelJS.Workbook();
  await filteredWorkbook.xlsx.load(filtered.rawPayload);
  assert.equal(filteredWorkbook.getWorksheet('Leads').rowCount, 1, 'only the header row - no lead is in the Branding pack');
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

test('the conversation detail reports whether the 24 hour window is open', async () => {
  const id = await makeConversation();
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const h = { authorization: `Bearer ${token}` };

  const open = await app.inject({ method: 'GET', url: `/api/conversations/${id}`, headers: h });
  assert.equal(open.json().conversation.window_open, true);

  await pool.query("update conversations set window_expires_at = now() - interval '1 hour' where id = $1", [id]);
  const closed = await app.inject({ method: 'GET', url: `/api/conversations/${id}`, headers: h });
  assert.equal(closed.json().conversation.window_open, false);
  await app.close();
});

test('the conversation detail surfaces the topic and campaign it came in through, and the contact\'s email/business', async () => {
  const id = await makeConversation();
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await setLastTopicId(pool, id, topic.id);
  await pool.query('update contacts set email = $2, business = $3 where id = (select contact_id from conversations where id = $1)', [id, 'lead@example.com', 'Acme Co']);

  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const res = await app.inject({ method: 'GET', url: `/api/conversations/${id}`, headers: { authorization: `Bearer ${token}` } });
  const conv = res.json().conversation;
  assert.equal(conv.topic_name, 'Logo Design', 'the side panel\'s Source section needs this to ever render');
  assert.equal(conv.email, 'lead@example.com');
  assert.equal(conv.business, 'Acme Co');
  await app.close();
});

test('PUT /api/conversations/:id/contact saves lead details, and clearing a field with an empty string actually clears it', async () => {
  const id = await makeConversation();
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const h = { authorization: `Bearer ${token}` };

  const save = await app.inject({
    method: 'PUT', url: `/api/conversations/${id}/contact`, headers: h,
    payload: { name: 'Priya', email: 'priya@example.com', business: 'Priya Bakes', address: '221B Baker Street' },
  });
  assert.equal(save.statusCode, 200);
  assert.deepEqual(save.json().contact, { name: 'Priya', email: 'priya@example.com', business: 'Priya Bakes', address: '221B Baker Street' });

  // Only touching one field must not wipe the others.
  const partial = await app.inject({
    method: 'PUT', url: `/api/conversations/${id}/contact`, headers: h,
    payload: { business: 'Priya Bakes & Co' },
  });
  assert.equal(partial.json().contact.name, 'Priya', 'untouched fields survive a partial update');
  assert.equal(partial.json().contact.business, 'Priya Bakes & Co');

  const cleared = await app.inject({
    method: 'PUT', url: `/api/conversations/${id}/contact`, headers: h,
    payload: { email: '' },
  });
  assert.equal(cleared.json().contact.email, '', 'an explicit empty string clears the field rather than being ignored');
  await app.close();
});

test('a freeform reply is blocked once the window has closed', async () => {
  const id = await makeConversation();
  await pool.query("update conversations set window_expires_at = now() - interval '1 hour' where id = $1", [id]);
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);

  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${id}/messages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { body: 'you there?' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'window_closed');
  await app.close();
});

test('a template with parameters sends even outside the window', async () => {
  const id = await makeConversation();
  await pool.query("update conversations set window_expires_at = now() - interval '1 hour' where id = $1", [id]);
  const meta = new FakeMeta();
  const app = await buildApp(meta);
  const token = await tokenFor(app);

  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${id}/template`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'drip_day3', params: ['Akshat'] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(meta.templates.at(-1).name, 'drip_day3');
  assert.equal(meta.templates.at(-1).components[0].parameters[0].text, 'Akshat');
  await app.close();
});

test('templates sync from meta and only approved ones are listed', async () => {
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const res = await app.inject({ method: 'POST', url: '/api/templates/sync', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  const templates = res.json().templates;
  const names = templates.map((t) => t.name);
  assert.ok(names.includes('drip_day3'));
  assert.ok(!names.includes('pending_one'), 'pending templates are hidden');
  const withHeader = templates.find((t) => t.name === 'drip_logo_day3');
  assert.equal(withHeader.header_type, 'DOCUMENT', 'header type is captured so the console knows a file is needed');
  await app.close();
});

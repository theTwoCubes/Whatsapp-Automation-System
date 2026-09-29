import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';

import { registerApi } from '../../src/routes/api.js';
import { createAgent, addMediaAsset, recordHandoff, setLastTopicId, dismissLead } from '../../src/db/repo.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { hashPassword } from '../../src/auth.js';
import { processWebhook } from '../../src/handlers/message.js';
import { inboundText, inboundImage } from './support/fixtures.js';
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

async function buildApp(meta) {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret' });
  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart);
  registerApi(app, { pool, meta, ai: new FakeAi(), config: apiConfig, realtime: noopRealtime });
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

test('ops reports lead funnel timing: first response and time to qualification', async () => {
  const convId = await makeConversation();
  // Pin known timestamps so the averages are exact, not dependent on how
  // fast this test happens to run.
  await pool.query("update conversations set created_at = now() - interval '10 minutes' where id = $1", [convId]);
  await pool.query(
    "update messages set created_at = now() - interval '10 minutes', sent_at = now() - interval '10 minutes' where conversation_id = $1 and direction = 'inbound'",
    [convId],
  );
  await pool.query(
    "update messages set created_at = now() - interval '8 minutes', sent_at = now() - interval '8 minutes' where conversation_id = $1 and direction = 'outbound'",
    [convId],
  );
  await recordHandoff(pool, { conversationId: convId, source: 'ai', reason: 'test' });
  await pool.query("update handoff_events set created_at = now() - interval '5 minutes' where conversation_id = $1", [convId]);

  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({ method: 'GET', url: '/api/admin/ops', headers: auth(t) });
  assert.equal(res.statusCode, 200);
  const db = res.json().db;
  assert.ok(Math.abs(db.avg_first_response_seconds - 120) < 5, `expected ~120s, got ${db.avg_first_response_seconds}`);
  assert.ok(Math.abs(db.avg_time_to_qualification_seconds - 300) < 5, `expected ~300s, got ${db.avg_time_to_qualification_seconds}`);
  assert.equal(Number(db.qualified_30d), 1);
  await app.close();
});

test('a contact with no name saved does not count or show up as a lead', async () => {
  await makeConversation();
  await pool.query(
    "insert into contacts (wa_id) values ('918800000000')",
  );

  const app = await buildApp(new FakeMeta());
  const t = await token(app);

  const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: auth(t) });
  assert.equal(Number(overview.json().overview.leads), 1, 'the nameless contact is not counted');

  const leads = await app.inject({ method: 'GET', url: '/api/leads', headers: auth(t) });
  assert.equal(leads.json().leads.length, 1);
  assert.equal(leads.json().leads[0].wa_id, '918766226219');
  await app.close();
});

test('the leads endpoint surfaces address and lead_details for the console dashboard', async () => {
  const id = await makeConversation();
  await pool.query(
    "update contacts set address = $2, lead_details = $3 where id = (select contact_id from conversations where id = $1)",
    [id, '221B Baker Street', JSON.stringify({ requirement: 'A new logo', budget: '10k' })],
  );

  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({ method: 'GET', url: '/api/leads', headers: auth(t) });
  const lead = res.json().leads[0];
  assert.equal(lead.address, '221B Baker Street');
  assert.equal(lead.lead_details.requirement, 'A new logo');
  await app.close();
});

test('the leads endpoint can be filtered by service, status, and a text search', async () => {
  const id = await makeConversation();
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await setLastTopicId(pool, id, topic.id);
  await pool.query(
    "update contacts set business = 'Acme Co' where id = (select contact_id from conversations where id = $1)",
    [id],
  );

  const app = await buildApp(new FakeMeta());
  const t = await token(app);

  const byTopic = await app.inject({ method: 'GET', url: `/api/leads?topicId=${topic.id}`, headers: auth(t) });
  assert.equal(byTopic.json().leads.length, 1);

  const otherTopic = await upsertTopic(pool, { slug: 'branding', name: 'Branding' });
  const wrongTopic = await app.inject({ method: 'GET', url: `/api/leads?topicId=${otherTopic.id}`, headers: auth(t) });
  assert.equal(wrongTopic.json().leads.length, 0, 'a lead in another service pack is not returned');

  const byState = await app.inject({ method: 'GET', url: '/api/leads?state=bot', headers: auth(t) });
  assert.equal(byState.json().leads.length, 1);
  const wrongState = await app.inject({ method: 'GET', url: '/api/leads?state=human', headers: auth(t) });
  assert.equal(wrongState.json().leads.length, 0);

  const bySearch = await app.inject({ method: 'GET', url: '/api/leads?search=acme', headers: auth(t) });
  assert.equal(bySearch.json().leads.length, 1, 'search matches business name, case insensitive');
  const noMatch = await app.inject({ method: 'GET', url: '/api/leads?search=nonexistent', headers: auth(t) });
  assert.equal(noMatch.json().leads.length, 0);
  await app.close();
});

test('dismissing a lead removes it from the list and count without touching the chat', async () => {
  const id = await makeConversation();
  const contactId = (await pool.query('select contact_id from conversations where id = $1', [id])).rows[0].contact_id;

  const app = await buildApp(new FakeMeta());
  const t = await token(app);

  const before = await app.inject({ method: 'GET', url: '/api/leads', headers: auth(t) });
  assert.equal(before.json().leads.length, 1);

  const res = await app.inject({ method: 'POST', url: `/api/leads/${contactId}/dismiss`, headers: auth(t) });
  assert.equal(res.statusCode, 200);

  const after = await app.inject({ method: 'GET', url: '/api/leads', headers: auth(t) });
  assert.equal(after.json().leads.length, 0);

  const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: auth(t) });
  assert.equal(Number(overview.json().overview.leads), 0);

  const conv = await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(t) });
  assert.equal(conv.json().conversations.length, 1, 'dismissing a lead does not touch its conversation');
  await app.close();
});

test('a media library file can be downloaded by an admin', async () => {
  const assetId = await addMediaAsset(pool, {
    metaMediaId: 'lib-media-dl', filename: 'ratecard.pdf', mimeType: 'application/pdf', kind: 'document',
  });

  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({ method: 'GET', url: `/api/media/${assetId}/download`, headers: auth(t) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /ratecard\.pdf/);
  await app.close();
});

test('downloading a media asset that has no meta media id 404s instead of erroring', async () => {
  const assetId = await addMediaAsset(pool, { filename: 'orphan.pdf', mimeType: 'application/pdf', kind: 'document' });

  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({ method: 'GET', url: `/api/media/${assetId}/download`, headers: auth(t) });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('answers can be added, listed and deleted through the api', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const add = await app.inject({
    method: 'POST',
    url: '/api/faqs',
    headers: auth(t),
    payload: { question: 'What does it cost?', answer: 'From 5000 rupees.' },
  });
  const id = add.json().faq.id;

  let list = await app.inject({ method: 'GET', url: '/api/faqs?pack=base', headers: auth(t) });
  assert.equal(list.json().faqs.length, 1);

  const packs = await app.inject({ method: 'GET', url: '/api/packs', headers: auth(t) });
  assert.equal(packs.json().packs[0].faq_count, 1, 'the base pack count reflects it');

  await app.inject({ method: 'DELETE', url: `/api/faqs/${id}`, headers: auth(t) });
  list = await app.inject({ method: 'GET', url: '/api/faqs?pack=base', headers: auth(t) });
  assert.equal(list.json().faqs.length, 0);
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

test('a new team member defaults to the agent role unless admin is explicitly picked', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  await app.inject({ method: 'POST', url: '/api/agents', headers: auth(t), payload: { email: 'plain@x.com', password: 'secret1' } });
  await app.inject({ method: 'POST', url: '/api/agents', headers: auth(t), payload: { email: 'boss@x.com', password: 'secret1', role: 'admin' } });

  const list = (await app.inject({ method: 'GET', url: '/api/agents', headers: auth(t) })).json().agents;
  assert.equal(list.find((a) => a.email === 'plain@x.com').role, 'agent', 'no role sent, defaults to the least privileged one');
  assert.equal(list.find((a) => a.email === 'boss@x.com').role, 'admin', 'admin only when explicitly requested');
  await app.close();
});

test('a plain agent cannot reach admin-only routes like AI settings', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  await app.inject({ method: 'POST', url: '/api/agents', headers: auth(t), payload: { email: 'plain@x.com', password: 'secret1' } });
  const plainToken = (await app.inject({
    method: 'POST', url: '/api/login', payload: { email: 'plain@x.com', password: 'secret1' },
  })).json().token;

  const res = await app.inject({ method: 'GET', url: '/api/ai-settings', headers: auth(plainToken) });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('AI settings are readable and writable by an admin, keys never sent back in full', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);

  const before = (await app.inject({ method: 'GET', url: '/api/ai-settings', headers: auth(t) })).json().aiSettings;
  assert.equal(before.geminiConfigured, false);

  const save = await app.inject({
    method: 'PUT', url: '/api/ai-settings', headers: auth(t),
    payload: { aiProvider: 'gemini', geminiApiKey: 'super-secret-key-value', geminiModel: 'gemini-2.5-flash' },
  });
  assert.equal(save.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(save.json()), /super-secret-key-value/, 'the raw key never comes back in the response');

  const after = (await app.inject({ method: 'GET', url: '/api/ai-settings', headers: auth(t) })).json().aiSettings;
  assert.equal(after.aiProvider, 'gemini');
  assert.equal(after.geminiConfigured, true);
  assert.equal(after.geminiKeyHint, '••••alue');

  const blankKey = await app.inject({
    method: 'PUT', url: '/api/ai-settings', headers: auth(t),
    payload: { geminiApiKey: '' },
  });
  const stillSet = blankKey.json().aiSettings;
  assert.equal(stillSet.geminiConfigured, true, 'a blank key on save means keep the existing one');
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

test('media can be filtered to general (no topic) files only', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design_media_test', name: 'Logo Design' });
  await addMediaAsset(pool, { metaMediaId: 'media-general', filename: 'overview.pdf', mimeType: 'application/pdf', kind: 'document' });
  await addMediaAsset(pool, { metaMediaId: 'media-topic', filename: 'logo-portfolio.pdf', mimeType: 'application/pdf', kind: 'document', topicId: topic.id });

  const app = await buildApp(new FakeMeta());
  const t = await token(app);

  const general = await app.inject({ method: 'GET', url: '/api/media?topicId=general', headers: auth(t) });
  const generalNames = general.json().media.map((m) => m.filename);
  assert.deepEqual(generalNames, ['overview.pdf']);

  const scoped = await app.inject({ method: 'GET', url: `/api/media?topicId=${topic.id}`, headers: auth(t) });
  assert.deepEqual(scoped.json().media.map((m) => m.filename), ['logo-portfolio.pdf']);

  const all = await app.inject({ method: 'GET', url: '/api/media', headers: auth(t) });
  assert.equal(all.json().media.length, 2);
  await app.close();
});

test('payment links can be created, listed by topic, updated, and deleted', async () => {
  const topic = await upsertTopic(pool, { slug: 'scientific_logo_design_pl', name: 'Scientific Logo Design' });
  const app = await buildApp(new FakeMeta());
  const t = await token(app);

  const create = await app.inject({
    method: 'POST', url: '/api/payment-links', headers: auth(t),
    payload: { topicId: topic.id, label: 'Logo analysis fee', amountInr: 450, url: 'https://rzp.io/l/abc', description: 'For reviewing a previous logo' },
  });
  assert.equal(create.statusCode, 200);
  const id = create.json().id;

  const scoped = await app.inject({ method: 'GET', url: `/api/payment-links?topicId=${topic.id}`, headers: auth(t) });
  assert.equal(scoped.json().paymentLinks.length, 1);
  assert.equal(scoped.json().paymentLinks[0].label, 'Logo analysis fee');

  const update = await app.inject({
    method: 'PUT', url: `/api/payment-links/${id}`, headers: auth(t),
    payload: { topicId: topic.id, label: 'Logo analysis fee (updated)', url: 'https://rzp.io/l/abc', active: false },
  });
  assert.equal(update.statusCode, 200);
  const afterUpdate = await app.inject({ method: 'GET', url: `/api/payment-links?topicId=${topic.id}`, headers: auth(t) });
  assert.equal(afterUpdate.json().paymentLinks[0].label, 'Logo analysis fee (updated)');
  assert.equal(afterUpdate.json().paymentLinks[0].active, false);

  const del = await app.inject({ method: 'DELETE', url: `/api/payment-links/${id}`, headers: auth(t) });
  assert.equal(del.statusCode, 200);
  const afterDelete = await app.inject({ method: 'GET', url: `/api/payment-links?topicId=${topic.id}`, headers: auth(t) });
  assert.equal(afterDelete.json().paymentLinks.length, 0);
  await app.close();
});

test('a payment link needs a label and a url', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({ method: 'POST', url: '/api/payment-links', headers: auth(t), payload: { label: 'Deposit' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('a payment link must be a real http or https url', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({
    method: 'POST', url: '/api/payment-links', headers: auth(t),
    payload: { label: 'Deposit', url: 'javascript:alert(1)' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('hosted links can be created, listed by topic, updated, and deleted', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design_hl', name: 'Logo Design HL' });
  const other = await upsertTopic(pool, { slug: 'brand_identity_hl', name: 'Brand Identity HL' });
  const app = await buildApp(new FakeMeta());
  const t = await token(app);

  const create = await app.inject({
    method: 'POST', url: '/api/hosted-links', headers: auth(t),
    payload: { topicId: topic.id, label: 'Demo reel', url: 'https://drive.google.com/file/d/xyz/view', description: 'When they ask for our showreel' },
  });
  assert.equal(create.statusCode, 200);
  const id = create.json().id;

  const scoped = await app.inject({ method: 'GET', url: `/api/hosted-links?topicId=${topic.id}`, headers: auth(t) });
  assert.equal(scoped.json().hostedLinks.length, 1);
  assert.equal(scoped.json().hostedLinks[0].label, 'Demo reel');

  // Editing moves the link to a different service and updates active state.
  const update = await app.inject({
    method: 'PUT', url: `/api/hosted-links/${id}`, headers: auth(t),
    payload: { topicId: other.id, label: 'Demo reel (updated)', url: 'https://drive.google.com/file/d/xyz/view', active: false },
  });
  assert.equal(update.statusCode, 200);
  const afterUpdate = await app.inject({ method: 'GET', url: `/api/hosted-links?topicId=${other.id}`, headers: auth(t) });
  assert.equal(afterUpdate.json().hostedLinks[0].label, 'Demo reel (updated)');
  assert.equal(afterUpdate.json().hostedLinks[0].active, false);
  const originalTopic = await app.inject({ method: 'GET', url: `/api/hosted-links?topicId=${topic.id}`, headers: auth(t) });
  assert.equal(originalTopic.json().hostedLinks.length, 0, 'the link moved off the original topic');

  const del = await app.inject({ method: 'DELETE', url: `/api/hosted-links/${id}`, headers: auth(t) });
  assert.equal(del.statusCode, 200);
  const afterDelete = await app.inject({ method: 'GET', url: `/api/hosted-links?topicId=${other.id}`, headers: auth(t) });
  assert.equal(afterDelete.json().hostedLinks.length, 0);
  await app.close();
});

test('a hosted link needs a label and a url', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({ method: 'POST', url: '/api/hosted-links', headers: auth(t), payload: { label: 'Demo reel' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('a hosted link must be a real http or https url', async () => {
  const app = await buildApp(new FakeMeta());
  const t = await token(app);
  const res = await app.inject({
    method: 'POST', url: '/api/hosted-links', headers: auth(t),
    payload: { label: 'Demo reel', url: 'javascript:alert(1)' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('tags can be created, applied, listed on a conversation, and removed', async () => {
  const convId = await makeConversation();
  const app = await buildApp(new FakeMeta());
  const t = await token(app);

  const create = await app.inject({ method: 'POST', url: '/api/tags', headers: auth(t), payload: { name: 'Hot lead', color: '#dc2626' } });
  assert.equal(create.statusCode, 200);
  const tagId = create.json().tag.id;

  const reuse = await app.inject({ method: 'POST', url: '/api/tags', headers: auth(t), payload: { name: 'hot lead' } });
  assert.equal(reuse.json().tag.id, tagId, 'creating with the same name (any case) reuses the existing tag');

  const apply = await app.inject({ method: 'POST', url: `/api/conversations/${convId}/tags`, headers: auth(t), payload: { tagId } });
  assert.equal(apply.statusCode, 200);

  const list = await app.inject({ method: 'GET', url: `/api/conversations/${convId}`, headers: auth(t) });
  assert.deepEqual(list.json().conversation.tags.map((x) => x.name), ['Hot lead']);

  const remove = await app.inject({ method: 'DELETE', url: `/api/conversations/${convId}/tags/${tagId}`, headers: auth(t) });
  assert.equal(remove.statusCode, 200);

  const after = await app.inject({ method: 'GET', url: `/api/conversations/${convId}`, headers: auth(t) });
  assert.deepEqual(after.json().conversation.tags, []);
  await app.close();
});

test('only an admin can delete a tag outright', async () => {
  await createAgent(pool, { email: 'agent3@b.com', name: 'Agent Three', passwordHash: hashPassword('secret3'), role: 'agent' });
  const app = await buildApp(new FakeMeta());
  const adminToken = await token(app);
  const create = await app.inject({ method: 'POST', url: '/api/tags', headers: auth(adminToken), payload: { name: 'Spam' } });
  const tagId = create.json().tag.id;

  const agentLogin = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'agent3@b.com', password: 'secret3' } });
  const agentToken = agentLogin.json().token;

  const denied = await app.inject({ method: 'DELETE', url: `/api/tags/${tagId}`, headers: auth(agentToken) });
  assert.equal(denied.statusCode, 403);

  const allowed = await app.inject({ method: 'DELETE', url: `/api/tags/${tagId}`, headers: auth(adminToken) });
  assert.equal(allowed.statusCode, 200);
  await app.close();
});

test('internal notes can be added, listed, and deleted by their author or an admin', async () => {
  const convId = await makeConversation();
  const app = await buildApp(new FakeMeta());
  const t = await token(app);

  const add = await app.inject({
    method: 'POST', url: `/api/conversations/${convId}/notes`, headers: auth(t),
    payload: { note: 'Called them, will follow up tomorrow' },
  });
  assert.equal(add.statusCode, 200);
  const noteId = add.json().note.id;

  const list = await app.inject({ method: 'GET', url: `/api/conversations/${convId}/notes`, headers: auth(t) });
  assert.equal(list.json().notes.length, 1);
  assert.equal(list.json().notes[0].agent_email, 'a@b.com');

  const del = await app.inject({ method: 'DELETE', url: `/api/conversations/${convId}/notes/${noteId}`, headers: auth(t) });
  assert.equal(del.statusCode, 200);

  const afterDelete = await app.inject({ method: 'GET', url: `/api/conversations/${convId}/notes`, headers: auth(t) });
  assert.equal(afterDelete.json().notes.length, 0);
  await app.close();
});

test('a note cannot be deleted by someone other than its author unless they are admin', async () => {
  const convId = await makeConversation();
  await createAgent(pool, { email: 'agent2@b.com', name: 'Agent Two', passwordHash: hashPassword('secret2'), role: 'agent' });
  const app = await buildApp(new FakeMeta());
  const t1 = await token(app);
  const t2res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'agent2@b.com', password: 'secret2' } });
  const t2 = t2res.json().token;

  const add = await app.inject({
    method: 'POST', url: `/api/conversations/${convId}/notes`, headers: auth(t1),
    payload: { note: 'First agent note' },
  });
  const noteId = add.json().note.id;

  const deniedDelete = await app.inject({ method: 'DELETE', url: `/api/conversations/${convId}/notes/${noteId}`, headers: auth(t2) });
  assert.equal(deniedDelete.statusCode, 404, 'a non-admin cannot delete someone else\'s note');

  const stillThere = await app.inject({ method: 'GET', url: `/api/conversations/${convId}/notes`, headers: auth(t1) });
  assert.equal(stillThere.json().notes.length, 1);
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


test('inbound media is proxied from meta', async () => {
  await processWebhook(inboundImage({ id: 'wamid.IMG1' }), {
    meta: new FakeMeta(),
    ai: new FakeAi(),
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

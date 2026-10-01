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

async function buildApp() {
  return (await buildAppWithDeps()).app;
}

async function buildAppWithDeps(overrides = {}) {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret' });
  await app.register(fastifyWebsocket);
  const deps = {
    pool,
    meta: overrides.meta || new FakeMeta(),
    ai: overrides.ai || new FakeAi(),
    config: apiConfig,
    realtime: noopRealtime,
    log: silentLog,
  };
  registerApi(app, deps);
  await app.ready();
  return { app, deps };
}

async function tokenFor(app) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.com', password: 'secret' } });
  return res.json().token;
}

async function pendingConversation(from) {
  const waId = from || '918766226219';
  // First inbound lands the contact; then we pre-qualify (server-side gate
  // requires it) and fire the handoff-triggering message.
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'hi' }));
  const shared = { meta: new FakeMeta(), ai, pool, config: testConfig, log: silentLog };
  await processWebhook(inboundText({ from, id: `wamid.${Math.random()}`, body: 'hi' }), shared);
  await pool.query("update contacts set business = 'ACME Studio', email = 'lead@acme.co', address = 'Mumbai', lead_details = jsonb_build_object('requirement', 'Scientific logo for Ayurveda clinic') where wa_id = $1", [waId]);
  ai.reply = JSON.stringify({ action: 'handoff', reply: 'Connecting you.', reason: 'customer asked for a person' });
  await processWebhook(inboundText({ from, id: `wamid.${Math.random()}`, body: 'can I talk to a human' }), shared);
  return (
    await pool.query(
      `select c.id from conversations c join contacts ct on ct.id = c.contact_id where ct.wa_id = $1`,
      [waId],
    )
  ).rows[0].id;
}

test('an attachment alone does not queue a pending handoff', async () => {
  await processWebhook(inboundImage({ id: 'wamid.att1' }), {
    meta: new FakeMeta(),
    ai: new FakeAi(),
    pool,
    config: testConfig,
    log: silentLog,
  });
  const row = (await pool.query('select state from conversations limit 1')).rows[0];
  assert.equal(row.state, 'bot');
});

test('the ai can still hand off after an attachment, once it judges the lead is qualified', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'thanks for the image' }));
  const shared = { meta: new FakeMeta(), ai, pool, config: testConfig, log: silentLog };
  // Land the contact and pre-qualify so the server-side handoff gate lets
  // the escalation clear.
  await processWebhook(inboundText({ id: 'wamid.att2a', body: 'hi' }), shared);
  await pool.query("update contacts set business = 'ACME Studio', email = 'lead@acme.co', address = 'Mumbai', lead_details = jsonb_build_object('requirement', 'Scientific logo for Ayurveda clinic')");
  ai.reply = JSON.stringify({
    action: 'handoff', reply: 'Connecting you now.', reason: 'qualified: paid the analysis fee for a logo review',
  });
  await processWebhook(inboundImage({ id: 'wamid.att2' }), shared);
  const row = (await pool.query('select state, handoff_reason from conversations limit 1')).rows[0];
  assert.equal(row.state, 'pending');
  assert.match(row.handoff_reason, /qualified/i);
});

test('a new pending handoff gets a round-robin suggested agent that rotates', async () => {
  await createAgent(pool, { email: 'b@b.com', name: 'B', passwordHash: hashPassword('secret'), role: 'agent' });
  await createAgent(pool, { email: 'c@b.com', name: 'C', passwordHash: hashPassword('secret'), role: 'agent' });

  const id1 = await pendingConversation('919000000001');
  const id2 = await pendingConversation('919000000002');
  const id3 = await pendingConversation('919000000003');
  const id4 = await pendingConversation('919000000004');

  const suggestions = [];
  for (const id of [id1, id2, id3, id4]) {
    const conv = await getConversationById(pool, id);
    suggestions.push(conv.suggested_agent);
  }
  assert.deepEqual(suggestions, ['a@b.com', 'b@b.com', 'c@b.com', 'a@b.com'], 'rotates through every agent in order, then wraps around');
});

test('suggested_agent is cleared once a handoff is accepted, rejected, or given back', async () => {
  const id = await pendingConversation();
  const app = await buildApp();
  const token = await tokenFor(app);
  const h = { authorization: `Bearer ${token}` };

  const before = await getConversationById(pool, id);
  assert.ok(before.suggested_agent, 'a suggestion exists while pending');

  await app.inject({ method: 'POST', url: `/api/conversations/${id}/accept`, headers: h });
  const afterAccept = await getConversationById(pool, id);
  assert.equal(afterAccept.suggested_agent, null);

  await app.inject({ method: 'POST', url: `/api/conversations/${id}/handback`, headers: h });
  const afterHandback = await getConversationById(pool, id);
  assert.equal(afterHandback.suggested_agent, null);
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

test('POST /handback catches up on an unanswered inbound end-to-end', async () => {
  // Full route wiring test: click "Resume bot", verify the bot actually
  // replies to what the human left behind. Covers the /handback endpoint's
  // integration with catchUpAfterHandback, not just the helper in isolation.
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'hi there' }));
  const { app, deps } = await buildAppWithDeps({ ai });
  const token = await tokenFor(app);
  const h = { authorization: `Bearer ${token}` };

  // Turn 1: lead's first message, AI answers.
  await processWebhook(inboundText({ id: 'wamid.RH1', body: 'hi' }), deps);
  const convId = (await pool.query('select id from conversations limit 1')).rows[0].id;

  // Human takes over, lead follows up, human never replies.
  await app.inject({ method: 'POST', url: `/api/conversations/${convId}/accept`, headers: h }).catch(() => {});
  await pool.query("update conversations set state='human', assignee='a@b.com' where id=$1", [convId]);
  await processWebhook(inboundText({ id: 'wamid.RH2', body: 'what about pricing?' }), deps);
  const sendsBeforeHandback = deps.meta.sends.length;

  ai.reply = JSON.stringify({ action: 'answer', reply: 'Pricing depends on the service - which one?' });
  const res = await app.inject({ method: 'POST', url: `/api/conversations/${convId}/handback`, headers: h });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().caughtUp, true, 'route reports the catch-up ran');
  assert.equal(deps.meta.sends.length, sendsBeforeHandback + 1, 'the bot replied to the pending inbound');
  assert.match(deps.meta.sends[deps.meta.sends.length - 1].body, /Pricing depends on the service/);

  await app.close();
});

test('rejecting a pending handoff sends it straight back to the bot', async () => {
  // Reject now means "the AI should not have escalated this", so the chat
  // returns to the bot - no human owner, no handoff reason - and the bot
  // picks up the next inbound. Previously reject assigned the chat to the
  // rejecting agent, which read as the opposite of what the admin meant.
  const id = await pendingConversation();
  const { app } = await buildAppWithDeps();
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

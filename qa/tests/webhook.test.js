import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { processWebhook } from '../../src/handlers/message.js';
import { inboundText, inboundImage, statusUpdate, adReferral } from './support/fixtures.js';
import { setupPool, resetTables, FakeMeta, FakeAi, FakeEmbeddings, silentLog, testConfig } from './support/harness.js';

let pool;

before(async () => {
  pool = await setupPool();
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await resetTables(pool);
});

function deps(overrides = {}) {
  return {
    meta: overrides.meta ?? new FakeMeta(),
    ai: overrides.ai ?? new FakeAi(),
    embeddings: overrides.embeddings ?? new FakeEmbeddings(),
    pool,
    config: testConfig,
    log: silentLog,
  };
}

const count = async (table) => Number((await pool.query(`select count(*) as n from ${table}`)).rows[0].n);

test('inbound from a click to whatsapp ad captures the campaign and the bot replies', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.A1', body: 'saw your ad', referral: adReferral }), d);

  assert.equal(await count('campaigns'), 1);
  assert.equal(await count('contacts'), 1);
  assert.equal(await count('conversations'), 1);
  assert.equal(d.ai.calls, 1, 'ai was asked for a reply');
  assert.equal(d.meta.sends.length, 1, 'one reply sent');
  assert.equal(d.meta.sends[0].body, 'Here is a helpful answer.');

  const conv = await pool.query('select campaign_id, state from conversations limit 1');
  assert.ok(conv.rows[0].campaign_id, 'conversation linked to the campaign');
  assert.equal(conv.rows[0].state, 'bot');
});

test('a plain message with no ad still works and attaches no campaign', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.P1', body: 'hi there' }), d);

  assert.equal(await count('campaigns'), 0);
  assert.equal(await count('contacts'), 1);
  assert.equal(d.meta.sends.length, 1);
});

test('duplicate webhook retry does not create a second message or a second reply', async () => {
  const d = deps();
  const payload = inboundText({ id: 'wamid.D1', body: 'hello' });
  await processWebhook(payload, d);
  await processWebhook(payload, d);

  assert.equal(await count('messages'), 2, 'one inbound plus one outbound only');
  assert.equal(d.meta.sends.length, 1, 'reply sent once');
});

test('rapid fire messages in the same conversation are coalesced into one ai call', async () => {
  const d = deps();
  const p1 = processWebhook(inboundText({ id: 'wamid.B1', body: 'hi, quick question' }), d);
  await new Promise((r) => setTimeout(r, 5));
  const p2 = processWebhook(inboundText({ id: 'wamid.B2', body: 'are you open on weekends' }), d);
  await Promise.all([p1, p2]);

  assert.equal(await count('messages'), 3, 'two inbound plus one outbound reply');
  assert.equal(d.ai.calls, 1, 'coalesced into a single ai call');
  assert.equal(d.meta.sends.length, 1, 'a single reply sent for both messages');
});

test('asking for a human queues the conversation and stops the bot', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.H1', body: 'can I talk to a human please' }), d);

  const conv = await pool.query('select state, handoff_reason from conversations limit 1');
  assert.equal(conv.rows[0].state, 'pending');
  assert.ok(conv.rows[0].handoff_reason, 'a reason is recorded for the agent');
  assert.equal(d.ai.calls, 0, 'ai not called on handoff');
  assert.equal(d.meta.sends[0].body, testConfig.handoffMessage);
});

test('once a handoff is pending the bot stays quiet', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.H2', body: 'talk to a person' }), d);
  const sendsAfterHandoff = d.meta.sends.length;

  await processWebhook(inboundText({ id: 'wamid.H3', body: 'are you there' }), d);
  assert.equal(d.meta.sends.length, sendsAfterHandoff, 'no new bot reply while pending on a human');
});

test('ai failure falls back to a canned reply instead of going silent', async () => {
  const d = deps({ ai: new FakeAi('unused', true) });
  await processWebhook(inboundText({ id: 'wamid.F1', body: 'hello' }), d);

  assert.equal(d.meta.sends.length, 1);
  assert.equal(d.meta.sends[0].body, testConfig.fallbackMessage);
});

test('the ai can decide on its own to hand a chat to a human', async () => {
  const ai = new FakeAi(
    JSON.stringify({ action: 'handoff', reply: 'Let me get a colleague to help with that.', reason: 'price negotiation' }),
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.AI1', body: 'can you do 2000 instead of 5000?' }), d);

  const conv = await pool.query('select state, handoff_reason from conversations limit 1');
  assert.equal(conv.rows[0].state, 'pending', 'ai handoff queues the conversation');
  assert.equal(conv.rows[0].handoff_reason, 'price negotiation');
  assert.equal(d.meta.sends[0].body, 'Let me get a colleague to help with that.');
});

test('the reply is cleaned of ai style formatting before sending', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Our logos are **great** and start at 5000 — really' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.AI2', body: 'tell me about logos' }), d);

  assert.equal(d.meta.sends[0].body, 'Our logos are great and start at 5000 - really');
});

test('status callbacks update the stored message status', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.S1', body: 'hi' }), d);
  const wamid = d.meta.sends[0].wamid;

  await processWebhook(statusUpdate({ id: wamid, status: 'read' }), d);
  const row = await pool.query('select status from messages where wa_message_id = $1', [wamid]);
  assert.equal(row.rows[0].status, 'read');
});

test('the model asking for another pack pulls it in and answers on the second call', async () => {
  const { upsertTopic } = await import('../../src/knowledge/topics.js');
  const { createFaq } = await import('../../src/knowledge/faqs.js');
  // No keywords, so only the model can pull this pack in.
  const poster = await upsertTopic(pool, { slug: 'poster', name: 'Poster' });
  await createFaq(pool, { topicId: poster.id, question: 'Poster price?', answer: 'From 3000 rupees.' });
  await createFaq(pool, { question: 'Hours?', answer: 'Monday to Saturday.' });

  // First call asks for the poster pack, second call answers from it.
  const replies = [
    JSON.stringify({ action: 'need_packs', pack_ids: [Number(poster.id)] }),
    JSON.stringify({ action: 'answer', reply: 'Posters start from 3000 rupees.' }),
  ];
  const ai = { enabled: true, calls: 0, async complete() { const r = replies[this.calls]; this.calls += 1; return r; } };

  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.PKR1', body: 'hi, do you also do print stuff' }), d);

  assert.equal(ai.calls, 2, 'exactly one extra round trip');
  assert.equal(d.meta.sends.length, 1);
  assert.equal(d.meta.sends[0].body, 'Posters start from 3000 rupees.');

  const conv = await pool.query('select active_pack_ids from conversations limit 1');
  assert.deepEqual(conv.rows[0].active_pack_ids.map(Number), [Number(poster.id)], 'the pack is sticky for the next turn');
});

test('a matching keyword pulls a pack in with no extra ai call', async () => {
  const { upsertTopic } = await import('../../src/knowledge/topics.js');
  const { createFaq } = await import('../../src/knowledge/faqs.js');
  const poster = await upsertTopic(pool, { slug: 'poster', name: 'Poster', keywords: 'poster' });
  await createFaq(pool, { topicId: poster.id, question: 'Poster price?', answer: 'From 3000 rupees.' });

  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.KW1', body: 'what does a poster cost?' }), d);

  assert.equal(d.ai.calls, 1, 'no extra call needed, the keyword already pulled the pack in');
  const conv = await pool.query('select active_pack_ids from conversations limit 1');
  assert.deepEqual(conv.rows[0].active_pack_ids.map(Number), [Number(poster.id)], 'the keyword match is sticky');
});

test('a pack pulled in once stays for the next turn without being renegotiated', async () => {
  const { upsertTopic } = await import('../../src/knowledge/topics.js');
  const { createFaq } = await import('../../src/knowledge/faqs.js');
  const poster = await upsertTopic(pool, { slug: 'poster', name: 'Poster', keywords: 'poster' });
  await createFaq(pool, { topicId: poster.id, question: 'Poster price?', answer: 'From 3000 rupees.' });

  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.S1', body: 'what does a poster cost?' }), d);
  // The next inbound has no keyword hit, but the sticky pack should still be in.
  const spy = { enabled: true, calls: 0, async complete(msgs) { this.lastSystem = msgs[0].content; this.calls += 1; return JSON.stringify({ action: 'answer', reply: 'ok' }); } };
  const d2 = deps({ ai: spy });
  await processWebhook(inboundText({ id: 'wamid.S2', body: 'and how long does that take?' }), d2);

  assert.match(spy.lastSystem, /Poster price\?/, 'the sticky pack survives into the next turn');
});

test('non text messages are stored and hand off to a human instead of being dropped', async () => {
  const d = deps();
  await processWebhook(inboundImage({ id: 'wamid.I1' }), d);

  assert.equal(await count('messages'), 2, 'image stored plus the handoff reply');
  assert.equal(d.meta.sends.length, 1, 'a handoff message is sent instead of silence');
  assert.equal(d.meta.sends[0].body, testConfig.attachmentMessage);

  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'pending', 'conversation queued for a human');
});

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { processWebhook } from '../../src/handlers/message.js';
import { handToHuman, handToBot } from '../../src/handoff.js';
import { catchUpAfterHandback } from '../../src/scheduler.js';
import { inboundText, inboundImage, inboundReaction, inboundButtonReply, inboundInteractiveReply, inboundLocation, statusUpdate, adReferral } from './support/fixtures.js';
import { setupPool, resetTables, FakeMeta, FakeAi, silentLog, testConfig } from './support/harness.js';

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
  const ai = new FakeAi(
    JSON.stringify({ action: 'handoff', reply: 'Let me connect you with someone.', reason: 'customer asked for a person' }),
  );
  const d = deps({ ai });
  // Pre-qualify so the server-side handoff gate lets the escalation through.
  await processWebhook(inboundText({ id: 'wamid.H1a', body: 'hi' }), d);
  await pool.query("update contacts set business = 'ACME Studio'");
  await processWebhook(inboundText({ id: 'wamid.H1', body: 'can I talk to a human please' }), d);

  const conv = await pool.query('select state, handoff_reason from conversations limit 1');
  assert.equal(conv.rows[0].state, 'pending');
  assert.ok(conv.rows[0].handoff_reason, 'a reason is recorded for the agent');
  assert.equal(d.meta.sends[1].body, 'Let me connect you with someone.');
});

test('a hard opt-out phrase is honoured immediately, without ever calling the ai', async () => {
  const ai = new FakeAi();
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.OO1', body: 'hello, tell me about your logo packages' }), d);
  await processWebhook(inboundText({ id: 'wamid.OO2', body: 'STOP' }), d);

  assert.equal(ai.calls, 1, 'the opt-out message itself never reaches the ai');
  assert.equal(d.meta.sends.length, 2, 'a greeting reply, then the opt-out confirmation');
  assert.equal(d.meta.sends[1].body, testConfig.optOutMessage);

  const contact = await pool.query('select opted_out_at from contacts limit 1');
  assert.ok(contact.rows[0].opted_out_at, 'the contact is marked opted out');
});

test('softer opt-out phrasing is caught by the ai action, not just the hard keyword list', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'opt_out', reply: 'Understood, no more messages from us.' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.OO3', body: 'please take me off your messaging list, thanks' }), d);

  assert.equal(d.meta.sends[0].body, 'Understood, no more messages from us.');
  const contact = await pool.query('select opted_out_at from contacts limit 1');
  assert.ok(contact.rows[0].opted_out_at);
});

test('an opted-out contact still gets a normal reply if they message in again', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.OO4', body: 'stop' }), d);
  await processWebhook(inboundText({ id: 'wamid.OO5', body: 'actually, tell me about pricing' }), d);

  assert.equal(d.meta.sends.length, 2);
  assert.equal(d.meta.sends[1].body, 'Here is a helpful answer.');

  const drips = await pool.query('select count(*)::int as n from drip_jobs');
  assert.equal(drips.rows[0].n, 0, 'no drips get scheduled for an opted-out contact even on a later normal reply');
});

test('once a handoff is pending the bot stays quiet', async () => {
  const ai = new FakeAi(
    JSON.stringify({ action: 'handoff', reply: 'Connecting you.', reason: 'customer asked for a person' }),
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.H2', body: 'talk to a person' }), d);
  // Seed enough on the contact that the server-side qualification gate lets
  // the handoff go through; without this the gate downgrades to answer, and
  // the point of THIS test is the post-handoff-quiet behavior.
  await pool.query("update contacts set business = 'ACME Studio'");
  await processWebhook(inboundText({ id: 'wamid.H2b', body: 'yes, please connect me' }), d);
  const sendsAfterHandoff = d.meta.sends.length;

  await processWebhook(inboundText({ id: 'wamid.H3', body: 'are you there' }), d);
  assert.equal(d.meta.sends.length, sendsAfterHandoff, 'no new bot reply while pending on a human');
});

test('after handback the bot catches up on an inbound the human left unanswered', async () => {
  // Turn 1: lead sends first message, AI answers.
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Hi, how can I help?' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.CU1', body: 'hi there' }), d);
  const conversationId = (await pool.query('select id from conversations limit 1')).rows[0].id;

  // Human takes over, lead follows up, human ignores, then hands back.
  await handToHuman(pool, conversationId, 'a@b.com');
  await processWebhook(inboundText({ id: 'wamid.CU2', body: 'and what about the timeline?' }), d);
  const sendsBeforeHandback = d.meta.sends.length;

  await handToBot(pool, conversationId);
  ai.reply = JSON.stringify({ action: 'answer', reply: 'Timelines depend on the service - which one were you looking at?' });
  const caughtUp = await catchUpAfterHandback(d, conversationId);
  assert.equal(caughtUp, true, 'catch-up should run when the last message is an inbound');
  assert.equal(d.meta.sends.length, sendsBeforeHandback + 1, 'the bot picked up the pending inbound');
  assert.match(d.meta.sends[d.meta.sends.length - 1].body, /Timelines depend on the service/);
});

test('handback catch-up does nothing when the human already replied before handing back', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Hi.' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.CU3', body: 'hi' }), d);
  const conversationId = (await pool.query('select id from conversations limit 1')).rows[0].id;

  await handToHuman(pool, conversationId, 'a@b.com');
  // Human replies manually - the last message is now outbound.
  await pool.query(
    "insert into messages (conversation_id, direction, type, body, wa_message_id) values ($1, 'outbound', 'text', 'agent reply', 'wamid.OUTX')",
    [conversationId],
  );
  await handToBot(pool, conversationId);
  const sendsBefore = d.meta.sends.length;
  const caughtUp = await catchUpAfterHandback(d, conversationId);
  assert.equal(caughtUp, false, 'nothing to catch up on when the human already replied');
  assert.equal(d.meta.sends.length, sendsBefore, 'no extra outbound send');
});

test('a human-owned conversation (including one an agent just rejected) stays quiet until handed back', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'hi there' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.R1', body: 'hello' }), d);
  const conversationId = (await pool.query('select id from conversations limit 1')).rows[0].id;

  // Rejecting a pending handoff lands here too - the rejecting agent becomes
  // the owner (handToHuman), not a separate silent state.
  await handToHuman(pool, conversationId, 'a@b.com');
  await processWebhook(inboundText({ id: 'wamid.R2', body: 'still there?' }), d);
  assert.equal(d.meta.sends.length, 1, 'no reply while a human owns it');

  await handToBot(pool, conversationId);
  await processWebhook(inboundText({ id: 'wamid.R3', body: 'hello again' }), d);
  assert.equal(d.meta.sends.length, 2, 'bot replies again once given back');
});

test('ai failure falls back to a canned reply instead of going silent', async () => {
  const d = deps({ ai: new FakeAi('unused', true) });
  await processWebhook(inboundText({ id: 'wamid.F1', body: 'hello' }), d);

  assert.equal(d.meta.sends.length, 1);
  assert.equal(d.meta.sends[0].body, testConfig.fallbackMessage);
});

test('an unqualified ai handoff is downgraded to answer instead of escalating a stranger', async () => {
  // The AI wants to hand off, but the contact has no business/requirement
  // beyond the fixture-default name. The server-side qualification gate
  // should downgrade this to an answer, keep the state at bot, use the
  // AI's own reply (which is in the customer's language), and still
  // schedule drips so the lead is not dropped.
  const ai = new FakeAi(
    JSON.stringify({ action: 'handoff', reply: 'Sure, connecting you.', reason: 'customer asked for a person' }),
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.GATE1', body: 'talk to a human please' }), d);

  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot', 'unqualified handoff stays with the bot, not queued for a person');
  assert.equal(d.meta.sends.length, 1, 'the holding message still went out');
  assert.equal(d.meta.sends[0].body, 'Sure, connecting you.', "the ai's own reply was used, not a hardcoded fallback");
  const drips = await pool.query('select count(*)::int as n from drip_jobs');
  assert.ok(drips.rows[0].n > 0, 'drips still get scheduled so the lead is not dropped after downgrade');
});

test('an empty-string budget in lead_details does not qualify a lead', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'hi' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.EMPTY1', body: 'hi' }), d);
  // Simulate the AI writing an empty-string field on some prior turn - the
  // jsonb `?` operator would have counted this as qualified before the fix.
  await pool.query(`update contacts set lead_details = '{"budget":""}'::jsonb`);
  ai.reply = JSON.stringify({ action: 'handoff', reply: 'Connecting you.', reason: 'customer asked for a person' });
  await processWebhook(inboundText({ id: 'wamid.EMPTY2', body: 'talk to a human please' }), d);

  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot', 'empty-string details do not clear the qualification gate');
});

test('a complaint handoff bypasses the qualification gate', async () => {
  const ai = new FakeAi(
    JSON.stringify({ action: 'handoff', reply: 'I am so sorry, someone will be with you shortly.', reason: 'complaint about undelivered file' }),
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.COMPL1', body: 'the file you sent is broken, this is a problem' }), d);

  const conv = await pool.query('select state, handoff_reason from conversations limit 1');
  assert.equal(conv.rows[0].state, 'pending', 'complaint escalates even without full lead details');
  assert.match(conv.rows[0].handoff_reason, /complaint/);
});

test('the ai can decide on its own to hand a chat to a human', async () => {
  const ai = new FakeAi(
    JSON.stringify({ action: 'handoff', reply: 'Let me get a colleague to help with that.', reason: 'price negotiation' }),
  );
  const d = deps({ ai });
  // Land the contact first, then pre-qualify so the handoff clears the gate.
  await processWebhook(inboundText({ id: 'wamid.AI0', body: 'hi there' }), d);
  await pool.query("update contacts set business = 'ACME Studio'");
  await processWebhook(inboundText({ id: 'wamid.AI1', body: 'can you do 2000 instead of 5000?' }), d);

  const conv = await pool.query('select state, handoff_reason from conversations limit 1');
  assert.equal(conv.rows[0].state, 'pending', 'ai handoff queues the conversation');
  assert.equal(conv.rows[0].handoff_reason, 'price negotiation');
  assert.equal(d.meta.sends[1].body, 'Let me get a colleague to help with that.');
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
  const ai = { enabled: true, calls: 0, async complete() { const r = replies[this.calls]; this.calls += 1; return { text: r, provider: 'fake', failedProviders: [] }; } };

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
  const spy = { enabled: true, calls: 0, async complete(msgs) { this.lastSystem = msgs[0].content; this.calls += 1; return { text: JSON.stringify({ action: 'answer', reply: 'ok' }), provider: 'fake', failedProviders: [] }; } };
  const d2 = deps({ ai: spy });
  await processWebhook(inboundText({ id: 'wamid.S2', body: 'and how long does that take?' }), d2);

  assert.match(spy.lastSystem, /Poster price\?/, 'the sticky pack survives into the next turn');
});

test('the ai naming a media id sends the file alongside the reply', async () => {
  const assetId = (
    await pool.query(
      "insert into media_assets (kind, filename, meta_media_id, description) values ('document', 'prices.pdf', 'meta-1', 'The price sheet') returning id",
    )
  ).rows[0].id;

  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Here is the price sheet.', send_media_id: Number(assetId) }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.MED1', body: 'what does it cost?' }), d);

  assert.equal(d.meta.sends.length, 1, 'the text reply went out');
  assert.equal(d.meta.media?.length, 1, 'the attachment went out too');
  assert.equal(d.meta.media[0].opts.filename, 'prices.pdf');
});

test('a claimed payment is logged on the contact and notifies agents, without a handoff', async () => {
  await pool.query(
    `insert into push_subscriptions (agent_email, transport, endpoint) values ('a@b.com', 'web', 'https://push.example/1')`,
  );
  const ai = new FakeAi(JSON.stringify({
    action: 'answer', reply: "Great, thank you! We'll be in touch.", payment_claimed: true,
  }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.PAID1', body: "I've just paid the deposit" }), d);

  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot', 'a payment claim alone does not force a handoff');

  const contact = await pool.query("select lead_details->>'payment_claimed_at' as claimed from contacts limit 1");
  assert.ok(contact.rows[0].claimed, 'the claim is timestamped on the contact');

  const notif = await pool.query("select kind, title from notifications where kind = 'payment_claimed'");
  assert.equal(notif.rows.length, 1);
  assert.match(notif.rows[0].title, /says they paid/i);
});

test('the ai naming a payment link sends it as a follow up text after the reply', async () => {
  const linkId = (
    await pool.query(
      "insert into payment_links (label, amount_inr, url, description) values ('Logo analysis fee', 450, 'https://rzp.io/l/abc', 'For reviewing a previous logo') returning id",
    )
  ).rows[0].id;

  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Here is the link for that.', send_payment_link_id: Number(linkId) }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.PAY1', body: 'can you review my old logo?' }), d);

  assert.equal(d.meta.sends.length, 2, 'the reply and the payment link both went out');
  assert.equal(d.meta.sends[0].body, 'Here is the link for that.');
  assert.match(d.meta.sends[1].body, /Logo analysis fee/);
  assert.match(d.meta.sends[1].body, /https:\/\/rzp\.io\/l\/abc/);
});

test('a send_payment_link_id with no matching link sends nothing extra, only the reply', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Sure thing.', send_payment_link_id: 999999 }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.PAY2', body: 'ok' }), d);

  assert.equal(d.meta.sends.length, 1, 'no invented link gets sent');
});

test('the ai naming a hosted link sends it as a follow up text after the reply', async () => {
  const linkId = (
    await pool.query(
      "insert into hosted_links (label, url, description) values ('Logo design demo reel', 'https://drive.google.com/file/d/xyz/view', 'When a customer asks to see our showreel') returning id",
    )
  ).rows[0].id;

  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Sure, here it is.', send_hosted_link_id: Number(linkId) }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.HL1', body: 'do you have a demo reel?' }), d);

  assert.equal(d.meta.sends.length, 2, 'the reply and the hosted link both went out');
  assert.equal(d.meta.sends[0].body, 'Sure, here it is.');
  assert.match(d.meta.sends[1].body, /Logo design demo reel/);
  assert.match(d.meta.sends[1].body, /https:\/\/drive\.google\.com\/file\/d\/xyz\/view/);
});

test('a send_hosted_link_id with no matching link sends nothing extra, only the reply', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Got it.', send_hosted_link_id: 999999 }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.HL2', body: 'ok' }), d);

  assert.equal(d.meta.sends.length, 1, 'no invented link gets sent');
});

test('a send_media_id with no matching asset sends nothing extra, only the reply', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Monday to Saturday.', send_media_id: 999999 }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.MED2', body: 'when are you open?' }), d);

  assert.equal(d.meta.sends.length, 1);
  assert.equal(d.meta.media?.length ?? 0, 0, 'nothing to attach, so nothing is sent');
});

test('the same attachment is not sent twice inside the cooldown window', async () => {
  const assetId = (
    await pool.query(
      "insert into media_assets (kind, filename, meta_media_id, description) values ('document', 'p.pdf', 'meta-2', 'A sample document') returning id",
    )
  ).rows[0].id;

  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Here.', send_media_id: Number(assetId) }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.CD1', body: 'prices?' }), d);
  await processWebhook(inboundText({ id: 'wamid.CD2', body: 'and again?' }), d);

  assert.equal(d.meta.media?.length, 1, 'a repeat within the cooldown is silently skipped, no duplicate goes out');
});

test('an image is handled by the ai like a text message, never handed off just for being a file', async () => {
  const d = deps();
  await processWebhook(inboundImage({ id: 'wamid.I1' }), d);

  assert.equal(await count('messages'), 2, 'image stored plus the bot reply');
  assert.equal(d.meta.sends.length, 1, 'the bot replies instead of going silent');
  assert.equal(d.meta.sends[0].body, 'Here is a helpful answer.');

  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot', 'an attachment alone never hands the conversation off');
});

test('a lead reacting to a message is stored but never hands off, replies, or interrupts drips', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.RX1', body: 'what does a logo cost?' }), d);
  const repliesSoFar = d.meta.sends.length;
  const dripsSoFar = await count('drip_jobs');

  await processWebhook(inboundReaction({ id: 'wamid.RX2', targetWamid: 'wamid.RX1', emoji: '👍' }), d);

  assert.equal(await count('messages'), 3, 'both the text and the reaction are stored');
  assert.equal(d.meta.sends.length, repliesSoFar, 'no reply, template, or attachment message was sent for the reaction');
  assert.equal(await count('drip_jobs'), dripsSoFar, 'the follow up schedule was left untouched');

  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot', 'the conversation stays with the bot, a reaction is not a handoff trigger');

  const stored = await pool.query("select raw from messages where type = 'reaction'");
  assert.equal(stored.rows[0].raw.reaction.emoji, '👍');
  assert.equal(stored.rows[0].raw.reaction.message_id, 'wamid.RX1');
});

test('a tapped quick-reply button goes to the ai like a typed reply, not a human handoff', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Great, tell me more about what you need.' }));
  const d = deps({ ai });
  await processWebhook(inboundButtonReply({ id: 'wamid.BTN1', text: 'Yes, interested' }), d);

  assert.equal(d.meta.sends.length, 1, 'the ai answered directly, no handoff message');
  assert.equal(d.meta.sends[0].body, 'Great, tell me more about what you need.');
  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot', 'stays with the bot instead of queuing for a person');

  const stored = await pool.query("select body from messages where type = 'button'");
  assert.equal(stored.rows[0].body, 'Tapped: Yes, interested', 'readable in the thread instead of a blank body');
});

test('a tapped interactive list option also reaches the ai instead of handing off', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Logo design it is - what is the timeline you are working with?' }));
  const d = deps({ ai });
  await processWebhook(inboundInteractiveReply({ id: 'wamid.INT1', title: 'Logo Design' }), d);

  assert.equal(d.meta.sends.length, 1);
  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot');
});

test('a location share is handled by the ai too, with a readable body instead of blank', async () => {
  const d = deps();
  await processWebhook(inboundLocation({ id: 'wamid.LOC1' }), d);

  assert.equal(d.meta.sends.length, 1, 'the bot replies instead of going silent');
  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot');

  const stored = await pool.query("select body from messages where type = 'location'");
  assert.equal(stored.rows[0].body, 'Location shared: Ahmedabad');
});

test('the language the ai chose is persisted and carried into its next reply', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Kem cho!', reply_language: 'Gujarati' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.LANG1', body: 'Gujarati ma vaat karo' }), d);

  const conv = await pool.query('select reply_language from conversations limit 1');
  assert.equal(conv.rows[0].reply_language, 'Gujarati');
});

test('the first successful ai reply marks the chat introduced, and a lead detail it learns is saved to the contact', async () => {
  const ai = new FakeAi(JSON.stringify({
    action: 'answer', reply: "Hey, I'm Adi! Nice to meet you.", reply_language: 'English',
    lead_name: 'Priya', lead_business: 'Priya Bakes', lead_email: 'priya@example.com',
  }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.INTRO1', body: 'hi there' }), d);

  const row = await pool.query(
    `select c.introduced_at, ct.business, ct.email from conversations c join contacts ct on ct.id = c.contact_id limit 1`,
  );
  assert.ok(row.rows[0].introduced_at, 'the chat is marked introduced after a real ai reply');
  assert.equal(row.rows[0].business, 'Priya Bakes');
  assert.equal(row.rows[0].email, 'priya@example.com');
});

test('address, requirement, budget, and timeline learned by the ai are saved to the contact end to end', async () => {
  const ai = new FakeAi(JSON.stringify({
    action: 'answer', reply: 'Got it, thanks!', reply_language: 'English',
    lead_address: '221B Baker Street, Ahmedabad', lead_requirement: 'A new logo for a bakery',
    lead_budget: '10-15k', lead_timeline: 'next month',
  }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.DETAILS1', body: 'I run a bakery and want a new logo, budget 10-15k, need it next month' }), d);

  const row = await pool.query(
    `select ct.address, ct.lead_details from conversations c join contacts ct on ct.id = c.contact_id limit 1`,
  );
  assert.equal(row.rows[0].address, '221B Baker Street, Ahmedabad');
  assert.deepEqual(row.rows[0].lead_details, { requirement: 'A new logo for a bakery', budget: '10-15k', timeline: 'next month' });
});

test('a mark_as_bot decision silently blocks the conversation without pushing or replying', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'mark_as_bot', reason: 'peer sent identical menu options twice' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.MB1', body: 'Reply *1* for menu' }), d);

  assert.equal(d.meta.sends.length, 0, 'no reply is sent when the peer is another bot');
  const row = await pool.query('select blocked_at, handoff_reason from conversations limit 1');
  assert.ok(row.rows[0].blocked_at, 'the conversation is blocked so future inbounds are ignored');
  assert.match(row.rows[0].handoff_reason, /^peer_bot:/, 'handoff_reason carries the peer_bot prefix for the UI');
});

test('the safety net blocks a bot-loop even when the ai keeps replying past the threshold', async () => {
  // Seed the conversation with 6 recent outbound messages to a nameless
  // contact (matching the safety-net threshold: 6 replies inside 15 minutes
  // without any lead info captured). Then send one more inbound - the safety
  // net should trip before the AI is called. Real WhatsApp Business
  // auto-replies (the primary bot-loop source) come in with no profile name
  // at all, so nulling it out here matches production reality.
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'this should not be sent' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.SN0', body: 'hi', name: null }), d);
  const conv = await pool.query('select id from conversations limit 1');
  const conversationId = conv.rows[0].id;
  await pool.query(`update contacts set name = null, business = null, email = null, address = null`);
  for (let i = 0; i < 6; i += 1) {
    await pool.query(
      `insert into messages (conversation_id, direction, type, body, wa_message_id)
       values ($1, 'outbound', 'text', $2, $3)`,
      [conversationId, `earlier reply ${i}`, `wamid.seed${i}`],
    );
  }
  ai.calls = 0;
  const beforeSends = d.meta.sends.length;
  await processWebhook(inboundText({ id: 'wamid.TRIP', body: 'trigger the check', name: null }), d);

  const row = await pool.query('select blocked_at, handoff_reason from conversations where id = $1', [conversationId]);
  assert.ok(row.rows[0].blocked_at, 'the conversation got blocked before the loop could keep going');
  assert.match(row.rows[0].handoff_reason, /^peer_bot: auto:/, 'the auto-trip carries a distinct reason');
  assert.equal(ai.calls, 0, 'the AI is not called when the safety net trips');
  assert.equal(d.meta.sends.length, beforeSends, 'no new reply is sent once the safety net trips');
});

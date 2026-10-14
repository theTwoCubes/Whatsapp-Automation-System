import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { processWebhook } from '../../src/handlers/message.js';
import { handToHuman, handToBot } from '../../src/handoff.js';
import { catchUpAfterHandback } from '../../src/scheduler.js';
import { inboundText, inboundImage, inboundReaction, inboundButtonReply, inboundInteractiveReply, inboundLocation, statusUpdate, adReferral } from './support/fixtures.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { createFaq } from '../../src/knowledge/faqs.js';
import { setupPool, resetTables, FakeMeta, FakeAi, silentLog, testConfig } from './support/harness.js';
import { isLeadQualifiedEnough } from '../../src/db/repo.js';

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
  await pool.query("update contacts set business = 'ACME Studio', email = 'lead@acme.co', address = 'Mumbai', lead_details = jsonb_build_object('requirement', 'Scientific logo for Ayurveda clinic')");
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
  await pool.query("update contacts set business = 'ACME Studio', email = 'lead@acme.co', address = 'Mumbai', lead_details = jsonb_build_object('requirement', 'Scientific logo for Ayurveda clinic')");
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
  // Distinct replies per turn, otherwise the reply after handback is word for
  // word the one from before it and the repeat guard holds it back - which is
  // correct behaviour, but not what this test is checking.
  const ai = new FakeAi().queueReplies(
    JSON.stringify({ action: 'answer', reply: 'hi there' }),
    JSON.stringify({ action: 'answer', reply: 'welcome back' }),
  );
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

test('an unqualified ai handoff is downgraded and the ai\'s reply goes out as a plain answer', async () => {
  // The gate blocks the handoff because the contact does not have all four
  // required fields (business, email, address, requirement). We discard the
  // handoff flag, send decision.reply as-is, keep state at bot. One AI call
  // per turn - no regen dance. The prompt is where this gets prevented in
  // the first place; the gate is the thin safety net.
  const ai = new FakeAi(
    JSON.stringify({ action: 'handoff', reply: 'Haan bilkul, pehle thoda bata denge aapka business kya hai?', reason: 'customer asked for a person' }),
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.GATE1', body: 'talk to a human please' }), d);

  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot', 'unqualified handoff stays with the bot');
  assert.equal(ai.calls, 1, 'one AI call per turn - no regen');
  assert.equal(d.meta.sends.length, 1);
  assert.match(d.meta.sends[0].body, /business/, "the ai's reply goes out as a plain answer");
  const drips = await pool.query('select count(*)::int as n from drip_jobs');
  assert.ok(drips.rows[0].n > 0, 'drips still get scheduled after downgrade');
});

test('unparseable ai output on an unqualified lead sends a neutral holding line, not a handoff promise', async () => {
  // The AI returned text that JSON.parse chokes on (seen in production
  // when the response was truncated by maxOutputTokens). parseDecision
  // defaults to handoff:true and marks parseFailed:true. On a lead who
  // has not been qualified yet, the gate downgrades, and the fallback
  // text must NOT be settings.fallbackMessage (which reads as "someone
  // will get back to you" - a lie because we did not actually hand off).
  const ai = new FakeAi('this is not { valid json');
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.PARSE1', body: 'hi' }), d);

  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot', 'state stays bot - no actual handoff');
  assert.equal(d.meta.sends.length, 1);
  assert.doesNotMatch(d.meta.sends[0].body, /team will get back|someone from our team/i, 'the fallback line must not promise a human');
  assert.match(d.meta.sends[0].body, /moment|second|check/i, 'uses a neutral "one moment" line');
});

test('a lead with every other field but no email AND no decline does NOT qualify', async () => {
  // Negative gate: business + address + requirement all set, but email is
  // null and email_declined is absent. Handoff must be downgraded. Proves
  // the gate reads email specifically, not "any lead_details key present".
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'hi' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.NO_EMAIL1', body: 'hi' }), d);
  await pool.query(
    "update contacts set business = 'ACME Studio', address = 'Mumbai', lead_details = jsonb_build_object('requirement', 'Scientific logo for Ayurveda clinic')",
  );
  ai.reply = JSON.stringify({ action: 'handoff', reply: 'Great, team se connect karvate hain.', reason: 'qualified and ready to proceed' });
  await processWebhook(inboundText({ id: 'wamid.NO_EMAIL2', body: 'ok lets proceed' }), d);

  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'bot', 'missing email with no decline blocks the handoff');
});

test('a lead who says they have no email can still qualify when email_declined is set', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'hi' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.ED1', body: 'hi' }), d);
  // All hard-required fields plus email_declined; email itself stays null.
  await pool.query(
    "update contacts set business = 'ACME Studio', address = 'Mumbai', lead_details = jsonb_build_object('requirement', 'Scientific logo for Ayurveda clinic', 'email_declined', true)",
  );
  ai.reply = JSON.stringify({ action: 'handoff', reply: 'Great, team se connect karvate hain.', reason: 'qualified and ready to proceed' });
  await processWebhook(inboundText({ id: 'wamid.ED2', body: 'ok lets proceed' }), d);

  const conv = await pool.query('select state from conversations limit 1');
  assert.equal(conv.rows[0].state, 'pending', 'email_declined counts the same as a real email for the gate');
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
  await pool.query("update contacts set business = 'ACME Studio', email = 'lead@acme.co', address = 'Mumbai', lead_details = jsonb_build_object('requirement', 'Scientific logo for Ayurveda clinic')");
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

test("a payment link's note always goes out underneath the url, in the same message", async () => {
  const note = 'After payment kindly email your existing logo, business category, Business website if any and your phone number. We will revert back in 24-48 hours.';
  const linkId = (
    await pool.query(
      "insert into payment_links (label, amount_inr, url, description, note) values ('Existing logo analysis', 510, 'https://rzp.io/l/sci', 'For reviewing a logo they already have', $1) returning id",
      [note],
    )
  ).rows[0].id;

  // The model is told nothing about the note, so this proves the sender
  // appends it rather than the ai being trusted to remember it.
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Here you go.', send_payment_link_id: Number(linkId) }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.PAYNOTE1', body: 'please check my current logo' }), d);

  assert.equal(d.meta.sends.length, 2);
  const linkMessage = d.meta.sends[1].body;
  assert.match(linkMessage, /Existing logo analysis - ₹510/);
  assert.ok(
    linkMessage.indexOf('https://rzp.io/l/sci') < linkMessage.indexOf('After payment kindly email'),
    'the note sits below the url, not above it',
  );
  assert.ok(linkMessage.endsWith(note), 'the note is sent verbatim');
});

test('a payment link with no note is sent exactly as before', async () => {
  const linkId = (
    await pool.query(
      "insert into payment_links (label, amount_inr, url) values ('Project deposit', 25002, 'https://rzp.io/l/dep') returning id",
    )
  ).rows[0].id;

  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Sure.', send_payment_link_id: Number(linkId) }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.PAYNOTE2', body: 'i want a new logo' }), d);

  assert.equal(d.meta.sends[1].body, 'Project deposit - ₹25002\nhttps://rzp.io/l/dep');
});

// The exact failure seen in production: the model wrote its own razorpay-ish
// url into the reply AND set send_payment_link_id, so the lead got two links -
// one real, one invented and dead. A dead payment link in front of a paying
// customer is the worst output this bot has, so it is enforced, not requested.
test('an invented payment url in the reply never reaches the lead, only the real link does', async () => {
  const linkId = (
    await pool.query(
      "insert into payment_links (label, amount_inr, url, description) values ('Existing logo analysis', 510, 'https://rzp.io/l/real', 'For reviewing an existing logo') returning id",
    )
  ).rows[0].id;

  const ai = new FakeAi(JSON.stringify({
    action: 'answer',
    reply: "Sure Akshat, here's the link: https://razorpay.com/payment-link/plink_invented",
    send_payment_link_id: Number(linkId),
  }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.FAKEURL', body: 'send me the payment link' }), d);

  assert.equal(d.meta.sends.length, 2, 'the reply and the one real link');
  assert.ok(!d.meta.sends[0].body.includes('plink_invented'), 'the invented url is gone from the reply');
  assert.ok(!d.meta.sends[0].body.includes('http'), 'and no url survives in the reply at all');
  assert.equal(d.meta.sends[0].body, "Sure Akshat, here's the link");
  assert.match(d.meta.sends[1].body, /https:\/\/rzp\.io\/l\/real/, 'the real link is still sent');
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

// A real lead answered "Mera business software development ka hain delhi main"
// and the bot recorded the city and the email decline off that same sentence
// but not the business, so the lead could never satisfy the handoff gate. The
// pipeline was fine; the prompt asked for "a sentence or two, concrete" and a
// two word answer did not look like one. A terse business has to be accepted,
// because it is a true answer and the gate depends on it.
test('a two word business answer is recorded and is enough to qualify the lead', async () => {
  const ai = new FakeAi(JSON.stringify({
    action: 'answer', reply: 'Got it, software development in Delhi.', reply_language: 'English',
    lead_business: 'Software development', lead_address: 'Delhi',
    lead_requirement: 'Rebrand of the existing logo', lead_email_declined: true,
  }));
  const d = deps({ ai });
  await processWebhook(
    inboundText({ id: 'wamid.TERSE1', body: 'Mera business software development ka hain delhi main, email address to ni h merepe' }),
    d,
  );

  const row = (
    await pool.query('select ct.id, ct.business, ct.address, ct.lead_details from conversations c join contacts ct on ct.id = c.contact_id limit 1')
  ).rows[0];
  assert.equal(row.business, 'Software development', 'the short business answer is stored, not discarded');
  assert.equal(row.address, 'Delhi');
  assert.equal(row.lead_details.email_declined, true);

  const conv = (await pool.query('select id from conversations limit 1')).rows[0];
  assert.equal(
    await isLeadQualifiedEnough(pool, conv.id),
    true,
    'business + address + requirement + declined email is a qualified lead',
  );
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

test('the service recorded for a lead is the strongest keyword match, not the weakest', async () => {
  // Mirrors a real miscategorisation: "scientific logo" matches the scientific
  // pack on its own two-word keyword AND the plain logo pack on the single word
  // "logo". keywordPacks ranks the stronger match first, so that is what the
  // conversation must be filed under. Taking the last element instead filed
  // these leads under plain Logo Design.
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design', keywords: 'logo, branding' });
  const sci = await upsertTopic(pool, {
    slug: 'scientific_logo_design',
    name: 'Scientific Logo Design',
    keywords: 'scientific logo, yantra, vedic',
  });
  await createFaq(pool, { topicId: logo.id, question: 'Logo cost?', answer: '20000 + GST.' });
  await createFaq(pool, { topicId: sci.id, question: 'Scientific cost?', answer: '50004.' });

  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.SVC1', body: 'Scientific logo' }), d);

  const row = await pool.query('select last_topic_id, active_pack_ids from conversations limit 1');
  assert.equal(
    Number(row.rows[0].last_topic_id),
    Number(sci.id),
    'filed under Scientific Logo Design: "scientific logo" outranks a bare "logo"',
  );
  // Both packs are still pulled in for context - only the recorded service is ranked.
  const packs = row.rows[0].active_pack_ids.map(Number);
  assert.ok(packs.includes(Number(sci.id)), 'scientific pack attached');
});

test('a plain logo enquiry is still filed under plain Logo Design', async () => {
  // The other direction of the same ranking: no scientific keyword appears, so
  // the generic pack must win outright rather than the specific one leaking in.
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design', keywords: 'logo, branding' });
  const sci = await upsertTopic(pool, {
    slug: 'scientific_logo_design',
    name: 'Scientific Logo Design',
    keywords: 'scientific logo, yantra, vedic',
  });
  await createFaq(pool, { topicId: logo.id, question: 'Logo cost?', answer: '20000 + GST.' });
  await createFaq(pool, { topicId: sci.id, question: 'Scientific cost?', answer: '50004.' });

  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.SVC2', body: 'I want logo design' }), d);

  const row = await pool.query('select last_topic_id, active_pack_ids from conversations limit 1');
  assert.equal(Number(row.rows[0].last_topic_id), Number(logo.id), 'filed under Logo Design');
  assert.ok(
    !row.rows[0].active_pack_ids.map(Number).includes(Number(sci.id)),
    'the scientific pack is not pulled in at all',
  );
});

test('lead_service from the ai overrides the keyword guess', async () => {
  // The whole point of the field: the lead never says "scientific", so keyword
  // matching can only see "logo" and files them under plain Logo Design. The
  // model understands what they mean and says so.
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design', keywords: 'logo, branding' });
  const sci = await upsertTopic(pool, {
    slug: 'scientific_logo_design',
    name: 'Scientific Logo Design',
    keywords: 'scientific logo, yantra, vedic',
  });
  await createFaq(pool, { topicId: logo.id, question: 'Logo cost?', answer: '20000 + GST.' });
  await createFaq(pool, { topicId: sci.id, question: 'Scientific cost?', answer: '50004.' });

  const ai = new FakeAi(JSON.stringify({
    action: 'answer',
    reply: 'That is our Scientific Logo Design service.',
    lead_service: 'Scientific Logo Design',
  }));
  await processWebhook(inboundText({ id: 'wamid.LS1', body: 'i want a logo that brings luck to my business' }), deps({ ai }));

  const row = await pool.query('select last_topic_id from conversations limit 1');
  assert.equal(
    Number(row.rows[0].last_topic_id),
    Number(sci.id),
    'the ai-named service wins over the keyword match on "logo"',
  );
});

test('a lead_service the ai invents is ignored rather than wiping the real one', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design', keywords: 'logo, branding' });
  await createFaq(pool, { topicId: logo.id, question: 'Logo cost?', answer: '20000 + GST.' });

  const ai = new FakeAi(JSON.stringify({
    action: 'answer',
    reply: 'Sure.',
    lead_service: 'Interpretive Dance Branding',
  }));
  await processWebhook(inboundText({ id: 'wamid.LS2', body: 'i want a logo' }), deps({ ai }));

  const row = await pool.query('select last_topic_id from conversations limit 1');
  assert.equal(
    Number(row.rows[0].last_topic_id),
    Number(logo.id),
    'the hallucinated service is discarded and the keyword match survives',
  );
});

test('lead_service matches on the slug and tolerates casing and punctuation', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design', keywords: 'logo' });
  const sci = await upsertTopic(pool, { slug: 'scientific_logo_design', name: 'Scientific Logo Design', keywords: 'yantra' });
  await createFaq(pool, { topicId: logo.id, question: 'A?', answer: 'B.' });
  await createFaq(pool, { topicId: sci.id, question: 'C?', answer: 'D.' });

  const ai = new FakeAi(JSON.stringify({
    action: 'answer',
    reply: 'ok',
    lead_service: 'scientific-logo-design',
  }));
  await processWebhook(inboundText({ id: 'wamid.LS3', body: 'i want a logo' }), deps({ ai }));

  const row = await pool.query('select last_topic_id from conversations limit 1');
  assert.equal(Number(row.rows[0].last_topic_id), Number(sci.id), 'slug form resolves too');
});

// The production failure this group exists for: a lead opened with "need logo
// design for scientific", which scores the plain Logo Design pack on the
// phrase "logo design" and the Scientific pack on nothing. The service was
// filed correctly from lead_service but the knowledge was not, so the whole
// conversation was answered out of the wrong pack and the lead was quoted
// 20000 + GST for a 50004 service.
test('the service the ai names replaces the keyword guess as the conversation pack', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design', keywords: 'logo, branding' });
  const sci = await upsertTopic(pool, {
    slug: 'scientific_logo_design',
    name: 'Scientific Logo Design',
    keywords: 'yantra, vedic',
  });
  await createFaq(pool, { topicId: logo.id, question: 'Logo cost?', answer: '20000 + GST.' });
  await createFaq(pool, { topicId: sci.id, question: 'Scientific cost?', answer: '50004 all in.' });

  const ai = new FakeAi(JSON.stringify({
    action: 'answer',
    reply: 'That is our Scientific Logo Design service.',
    lead_service: 'Scientific Logo Design',
  }));
  await processWebhook(inboundText({ id: 'wamid.PK1', body: 'need logo design for scientific' }), deps({ ai }));

  const row = (await pool.query('select last_topic_id, active_pack_ids from conversations limit 1')).rows[0];
  assert.equal(Number(row.last_topic_id), Number(sci.id));
  assert.deepEqual(
    (row.active_pack_ids || []).map(Number),
    [Number(sci.id)],
    'the wrong keyword pack is replaced, not left sitting alongside the right one',
  );
});

test('the turn where the service is identified is answered again with that service pack', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design', keywords: 'logo, branding' });
  const sci = await upsertTopic(pool, {
    slug: 'scientific_logo_design',
    name: 'Scientific Logo Design',
    keywords: 'yantra, vedic',
  });
  await createFaq(pool, { topicId: logo.id, question: 'Logo cost?', answer: '20000 + GST.' });
  await createFaq(pool, { topicId: sci.id, question: 'Scientific cost?', answer: '50004 all in.' });

  const ai = new FakeAi().queueReplies(
    // First pass: written without the scientific pack, but it names the service.
    JSON.stringify({ action: 'answer', reply: 'It is 20000 + GST.', lead_service: 'Scientific Logo Design' }),
    // Second pass, now that the pack is loaded.
    JSON.stringify({ action: 'answer', reply: 'It is 50004 all in.' }),
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.PK2', body: 'need logo design for scientific, kya charge hai' }), d);

  assert.equal(ai.calls, 2, 'the reply is built a second time once the right pack is known');
  assert.equal(
    d.meta.sends[d.meta.sends.length - 1].body,
    'It is 50004 all in.',
    'the lead sees the answer from the correct pack, not the one written without it',
  );
});

test("a later turn still loads the recorded service's pack when nothing matches by keyword", async () => {
  const sci = await upsertTopic(pool, {
    slug: 'scientific_logo_design',
    name: 'Scientific Logo Design',
    keywords: 'yantra, vedic',
  });
  await createFaq(pool, { topicId: sci.id, question: 'Scientific cost?', answer: '50004 all in.' });

  const ai = new FakeAi().queueReplies(
    JSON.stringify({ action: 'answer', reply: 'Sure, happy to help.', lead_service: 'Scientific Logo Design' }),
    JSON.stringify({ action: 'answer', reply: 'It is 50004 all in.' }),
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.PK3', body: 'i need a new mark for my firm' }), d);
  // Nothing in this message matches any keyword at all.
  await processWebhook(inboundText({ id: 'wamid.PK4', body: 'kya charge hai' }), d);

  const row = (await pool.query('select active_pack_ids from conversations limit 1')).rows[0];
  assert.deepEqual((row.active_pack_ids || []).map(Number), [Number(sci.id)]);
});

// The loop that was most visible to leads in production: the bot answered an
// image by asking for the image, word for word the message it had sent on the
// previous turn, and did it twice in one conversation.
test('a reply that repeats the previous one word for word is rewritten', async () => {
  const ai = new FakeAi().queueReplies(
    JSON.stringify({ action: 'answer', reply: 'Could you share your logo?' }),
    // Second turn: the model repeats itself...
    JSON.stringify({ action: 'answer', reply: 'Could you share your logo?' }),
    // ...and on being told, writes something that actually moves on.
    JSON.stringify({ action: 'answer', reply: 'Got it, thanks - what does the business do?' }),
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.LP1', body: 'hello' }), d);
  await processWebhook(inboundText({ id: 'wamid.LP2', body: 'here it is' }), d);

  assert.equal(ai.calls, 3, 'the repeat triggers one more attempt');
  assert.equal(d.meta.sends.length, 2);
  assert.equal(d.meta.sends[1].body, 'Got it, thanks - what does the business do?');
});

test('a repeat the model insists on is not sent at all, but the follow up is still booked', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'Could you share your logo?' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.LP3', body: 'hello' }), d);
  await processWebhook(inboundText({ id: 'wamid.LP4', body: 'here it is' }), d);

  assert.equal(d.meta.sends.length, 1, 'the customer never sees the same message twice in a row');
  const outbound = await pool.query("select count(*) as n from messages where direction = 'outbound'");
  assert.equal(Number(outbound.rows[0].n), 1, 'and nothing phantom is recorded as sent');
  assert.ok(await count('drip_jobs') > 0, 'a lead who now goes quiet is still followed up');
});

test('the repeat guard never swallows a handoff', async () => {
  // Same reply text both turns, but the second is a handoff: the state change
  // has to land regardless of how the message reads.
  const handoff = JSON.stringify({
    action: 'handoff',
    reply: 'Let me get someone on this.',
    reason: 'wants a person',
    lead_business: 'steel bars',
    lead_requirement: 'new scientific logo for a steel bar business',
    lead_address: 'Ahmedabad',
    lead_email_declined: true,
  });
  const ai = new FakeAi().queueReplies(
    JSON.stringify({ action: 'answer', reply: 'Let me get someone on this.' }),
    handoff,
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.LP5', body: 'hello' }), d);
  await processWebhook(inboundText({ id: 'wamid.LP6', body: 'i want to talk to a person' }), d);

  const state = (await pool.query('select state from conversations limit 1')).rows[0].state;
  assert.equal(state, 'pending', 'the handoff landed even though the text repeated');
});

test('a lead who asks the same question twice in a row still gets the answer', async () => {
  // The guard only ever fires on a repeat that survived an explicit
  // correction, so a genuine repeat answer is not held back.
  const ai = new FakeAi().queueReplies(
    JSON.stringify({ action: 'answer', reply: 'The fee is 50004, GST included.' }),
    JSON.stringify({ action: 'answer', reply: 'The fee is 50004, GST included.' }),
    JSON.stringify({ action: 'answer', reply: 'Same as before - 50004, GST included.' }),
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.LP7', body: 'kya charge hai' }), d);
  await processWebhook(inboundText({ id: 'wamid.LP8', body: 'kya charge hai' }), d);

  assert.equal(d.meta.sends.length, 2, 'they are answered both times');
  assert.equal(d.meta.sends[1].body, 'Same as before - 50004, GST included.');
});

test('saying "logo" again does not move an established scientific lead onto the plain logo service', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design', keywords: 'logo, branding' });
  const sci = await upsertTopic(pool, {
    slug: 'scientific_logo_design',
    name: 'Scientific Logo Design',
    keywords: 'scientific, yantra, vedic',
  });
  await createFaq(pool, { topicId: logo.id, question: 'Cost?', answer: '20000 + GST.' });
  await createFaq(pool, { topicId: sci.id, question: 'Cost?', answer: '50004 all in.' });

  // Turn 1 settles the service. Turn 2 says "logo", which matches the plain
  // pack on a keyword - the weakest evidence there is, and not enough to move
  // a lead onto a service with a completely different price.
  const ai = new FakeAi().queueReplies(
    JSON.stringify({ action: 'answer', reply: 'That is Scientific Logo Design.', lead_service: 'Scientific Logo Design' }),
    JSON.stringify({ action: 'answer', reply: 'Of course.' }),
  );
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.KW1', body: 'i want a scientific one' }), d);
  await processWebhook(inboundText({ id: 'wamid.KW2', body: 'mujhe naya logo chahiye' }), d);

  const row = (await pool.query('select last_topic_id from conversations limit 1')).rows[0];
  assert.equal(
    Number(row.last_topic_id),
    Number(sci.id),
    'the service stays where the ai put it until the ai itself moves it',
  );
});

// The "it replied to me three times" complaint. The debounce only covers the
// gap between messages; the AI call itself takes seconds, and a message
// landing during it used to open its own batch and earn its own reply a few
// seconds behind the first.
//
// The timings matter. The two later messages are spaced further apart than the
// debounce (30ms in tests) so the debounce alone could NOT batch them - the
// only thing that can is the in-flight hold. Both still land inside the 250ms
// the first reply takes. Distinct replies on purpose, so this is proven by the
// batching and not papered over by the repeat guard.
test('messages that land while a reply is being written join one batch, not one reply each', async () => {
  class SlowAi extends FakeAi {
    async complete(messages, options) {
      await new Promise((r) => setTimeout(r, 250));
      return super.complete(messages, options);
    }
  }
  const ai = new SlowAi().queueReplies(
    JSON.stringify({ action: 'answer', reply: 'First answer.' }),
    JSON.stringify({ action: 'answer', reply: 'Second answer.' }),
    JSON.stringify({ action: 'answer', reply: 'Third answer.' }),
  );
  const d = deps({ ai });

  const p1 = processWebhook(inboundText({ id: 'wamid.BT1', body: 'mera steel bar ka manufacturing hai' }), d);
  await new Promise((r) => setTimeout(r, 80));
  const p2 = processWebhook(inboundText({ id: 'wamid.BT2', body: 'ye mera website hai' }), d);
  await new Promise((r) => setTimeout(r, 100));
  const p3 = processWebhook(inboundText({ id: 'wamid.BT3', body: 'naya logo chahiye' }), d);
  await Promise.all([p1, p2, p3]);

  assert.equal(ai.calls, 2, 'one call for the first message, one for the two that arrived during it');
  assert.equal(d.meta.sends.length, 2, 'two replies for three messages, not three');
  assert.equal(d.meta.sends[1].body, 'Second answer.');
  assert.equal(await count('messages'), 5, 'three inbound, two outbound - every message still recorded');
});

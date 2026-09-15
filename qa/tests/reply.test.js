import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildReply } from '../../src/ai/reply.js';
import { REACTION_EMOJIS } from '../../src/ai/reactions.js';
import { createFaq } from '../../src/knowledge/faqs.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { recordInbound } from '../../src/db/repo.js';
import { setupPool, resetTables, FakeAi, testConfig } from './support/harness.js';

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

// Captures the messages it was asked to complete, so the tests can assert on
// what the model would actually have been shown.
class SpyAi extends FakeAi {
  async complete(messages, options) {
    this.lastMessages = messages;
    return super.complete(messages, options);
  }
}

async function conversation(body = 'what does a logo cost?') {
  const { conversationId } = await recordInbound(pool, {
    waId: '919000000123',
    name: 'Test Lead',
    waMessageId: `wamid.${Math.random()}`,
    type: 'text',
    body,
    referral: null,
    raw: {},
  });
  return conversationId;
}

test('an answer action produces a reply and no handoff', async () => {
  await createFaq(pool, { question: 'What does a logo cost?', answer: '20000 rupees plus GST.' });
  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'answer', reply: 'A logo is 20000 rupees plus GST.' }));

  const decision = await buildReply(pool, ai, testConfig, id, {});
  assert.equal(decision.handoff, false);
  assert.equal(decision.reply, 'A logo is 20000 rupees plus GST.');
});

test('a handoff action carries its reason through for the team', async () => {
  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'handoff', reply: 'Let me get a colleague.', reason: 'wants a discount' }));

  const decision = await buildReply(pool, ai, testConfig, id, {});
  assert.equal(decision.handoff, true);
  assert.equal(decision.reason, 'wants a discount');
  assert.equal(decision.reply, 'Let me get a colleague.');
});

test('output that is not valid json hands off rather than being sent as a reply', async () => {
  const id = await conversation();
  const ai = new SpyAi('Sure, a logo is around 20k I think');

  const decision = await buildReply(pool, ai, testConfig, id, {});
  assert.equal(decision.handoff, true, 'unparseable output must never reach the lead');
  assert.equal(decision.reply, '');
});

test('an unknown action hands off rather than guessing what was meant', async () => {
  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'something_else', reply: 'hello' }));

  const decision = await buildReply(pool, ai, testConfig, id, {});
  assert.equal(decision.handoff, true);
});

test('an answer action with an empty reply hands off instead of sending nothing', async () => {
  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'answer', reply: '   ' }));

  const decision = await buildReply(pool, ai, testConfig, id, {});
  assert.equal(decision.handoff, true);
});

test('the prompt carries the pack answers and the rule against inventing figures', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await createFaq(pool, { question: 'What are your hours?', answer: 'Monday to Saturday.' });
  await createFaq(pool, { topicId: logo.id, question: 'What does a logo cost?', answer: '20000 rupees plus GST.', verbatim: true });

  const id = await conversation();
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, { packs: ['base', logo.id] });

  const system = ai.lastMessages[0].content;
  assert.match(system, /20000 rupees plus GST/, 'the answer itself is in the prompt');
  assert.match(system, /Monday to Saturday/, 'the base pack is there too');
  assert.match(system, /quote this answer exactly/, 'the verbatim marker survives into the prompt');
  assert.match(system, /do not make them up/, 'the rule against inventing specifics is there');
  assert.match(system, /"action": "handoff"/, 'the contract is spelled out');
});

test('the shared instructions are separated from anything lead specific, for caching', async () => {
  await createFaq(pool, { question: 'What are your hours?', answer: 'Monday to Saturday.' });
  const first = await conversation('hello');
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, first, {});
  const sharedForFirst = ai.lastMessages[0].content;

  await pool.query('update contacts set name = $1', ['Someone Else']);
  const second = await conversation('hello again');
  await buildReply(pool, ai, testConfig, second, {});

  assert.equal(ai.lastMessages[0].content, sharedForFirst, 'the first message is identical across leads');
  assert.match(ai.lastMessages[1].content, /About the customer/, 'per lead detail lives in the second message');
  assert.doesNotMatch(sharedForFirst, /Someone Else/, 'no lead name leaks into the cacheable prefix');
});

test('with no answers written yet the bot is told to hand everything over', async () => {
  const id = await conversation();
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, {});
  assert.match(ai.lastMessages[0].content, /No specific FAQ answers have been added yet/);
});

test('the catalog of other packs the model can ask for is in the prompt', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const poster = await upsertTopic(pool, { slug: 'poster', name: 'Poster', description: 'Print and digital posters' });
  await createFaq(pool, { topicId: logo.id, question: 'Cost?', answer: '20000.' });
  await createFaq(pool, { topicId: poster.id, question: 'Turnaround?', answer: '3 days.' });

  const id = await conversation();
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, { packs: ['base', logo.id] });

  const system = ai.lastMessages[0].content;
  assert.match(system, new RegExp(`Pack ${poster.id}: Poster`));
  assert.match(system, /need_packs/);
  assert.doesNotMatch(system, new RegExp(`Pack ${logo.id}: Logo Design`), 'a pack already in the reply is not offered again');
});

test('a need_packs response returns the requested ids for the caller to include', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const poster = await upsertTopic(pool, { slug: 'poster', name: 'Poster' });
  await createFaq(pool, { topicId: logo.id, question: 'Cost?', answer: '20000.' });
  await createFaq(pool, { topicId: poster.id, question: 'Turnaround?', answer: '3 days.' });

  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'need_packs', pack_ids: [Number(poster.id)] }));
  const decision = await buildReply(pool, ai, testConfig, id, { packs: ['base', logo.id] });

  assert.equal(decision.handoff, false);
  assert.equal(decision.reply, '');
  assert.deepEqual(decision.requestedPackIds, [Number(poster.id)]);
});

test('a request for a pack the catalog does not offer is treated as a handoff, not obeyed', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await createFaq(pool, { topicId: logo.id, question: 'Cost?', answer: '20000.' });

  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'need_packs', pack_ids: [99999] }));
  const decision = await buildReply(pool, ai, testConfig, id, { packs: ['base', logo.id] });

  assert.equal(decision.handoff, true, 'a pack id we did not offer is a handoff, not a retry');
  assert.deepEqual(decision.requestedPackIds, []);
});

test('with pack requests disabled the need_packs action is not offered', async () => {
  await upsertTopic(pool, { slug: 'poster', name: 'Poster' });
  const id = await conversation();
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, { packs: ['base'], allowPackRequests: false });

  const system = ai.lastMessages[0].content;
  assert.doesNotMatch(system, /need_packs/);
  assert.match(system, /"action": "answer"/);
  assert.match(system, /"action": "handoff"/);
  assert.match(system, /"action": "warn"/);
  assert.match(system, /"action": "block"/);
});

test('media with a description is offered in the prompt with its id, media with none is not', async () => {
  const withDesc = (
    await pool.query(
      "insert into media_assets (kind, filename, description) values ('document', 'pricing.pdf', 'The full price sheet') returning id",
    )
  ).rows[0].id;
  await pool.query("insert into media_assets (kind, filename) values ('document', 'no-description.pdf')");

  const id = await conversation();
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, {});

  const system = ai.lastMessages[0].content;
  assert.match(system, new RegExp(`\\[id ${withDesc}\\] pricing.pdf - The full price sheet`));
  assert.doesNotMatch(system, /no-description\.pdf/, 'a file with no description gives the model nothing to judge relevance from');
  assert.match(system, /send_media_id/);
});

test('send_media_id is only trusted when the asset was actually in the catalog given', async () => {
  const assetId = (
    await pool.query(
      "insert into media_assets (kind, filename, description) values ('document', 'p.pdf', 'A sample document') returning id",
    )
  ).rows[0].id;

  const id = await conversation();
  const good = new SpyAi(JSON.stringify({ action: 'answer', reply: 'Here it is.', send_media_id: Number(assetId) }));
  const goodDecision = await buildReply(pool, good, testConfig, id, {});
  assert.equal(goodDecision.sendMediaId, Number(assetId));

  const bad = new SpyAi(JSON.stringify({ action: 'answer', reply: 'Here it is.', send_media_id: 99999 }));
  const badDecision = await buildReply(pool, bad, testConfig, id, {});
  assert.equal(badDecision.sendMediaId, null, 'an id not in the catalog given is dropped rather than trusted');
  assert.equal(badDecision.reply, 'Here it is.', 'the reply itself still goes through');
});

test('media already sent in this chat is listed so the model knows not to resend it', async () => {
  const assetId = (
    await pool.query(
      "insert into media_assets (kind, filename, description) values ('document', 'portfolio.pdf', 'Sample portfolio') returning id",
    )
  ).rows[0].id;
  const id = await conversation();
  await pool.query(
    `insert into messages (conversation_id, wa_message_id, direction, type, body, media_asset_id)
     values ($1, 'wamid.sent1', 'outbound', 'document', 'here you go', $2)`,
    [id, assetId],
  );

  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, {});
  const system = ai.lastMessages[0].content;
  assert.match(system, /Already sent in this chat/);
  assert.match(system, /portfolio\.pdf, sent/);
});

test('an answer can react instead of typing a reply, using an emoji from the fixed list', async () => {
  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'answer', reply: '', react_emoji: REACTION_EMOJIS[0] }));
  const decision = await buildReply(pool, ai, testConfig, id, {});

  assert.equal(decision.handoff, false, 'a reaction alone is a complete response, not an empty one');
  assert.equal(decision.reply, '');
  assert.equal(decision.reactEmoji, REACTION_EMOJIS[0]);
});

test('an emoji outside the fixed list is dropped rather than sent', async () => {
  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'answer', reply: 'Sure thing!', react_emoji: '🤡' }));
  const decision = await buildReply(pool, ai, testConfig, id, {});

  assert.equal(decision.reactEmoji, null, 'an emoji not on the approved list is never trusted');
  assert.equal(decision.reply, 'Sure thing!', 'the reply text itself still goes through');
});

test('a genuinely empty answer with no reaction either still hands off', async () => {
  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'answer', reply: '   ', react_emoji: null }));
  const decision = await buildReply(pool, ai, testConfig, id, {});
  assert.equal(decision.handoff, true);
});

test('the model is told it can react, using the approved emoji list', async () => {
  const id = await conversation();
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, {});
  const system = ai.lastMessages[0].content;
  assert.match(system, /react_emoji/);
  for (const e of REACTION_EMOJIS) assert.ok(system.includes(e), `${e} should be listed as an allowed reaction`);
});

test('contact details set on the console are offered to the model, and skipped when blank', async () => {
  const id = await conversation();

  const withContact = { ...testConfig, websiteUrl: 'https://advoice.online', contactPhone: '+91 98765 43210', instagramUrl: 'https://instagram.com/advoice' };
  const ai1 = new SpyAi();
  await buildReply(pool, ai1, withContact, id, {});
  const withSystem = ai1.lastMessages[0].content;
  assert.match(withSystem, /https:\/\/advoice\.online/);
  assert.match(withSystem, /\+91 98765 43210/);
  assert.match(withSystem, /instagram\.com\/advoice/);

  const id2 = await conversation('hi again');
  const blank = { ...testConfig, supportEmail: '', websiteUrl: '', contactPhone: '', instagramUrl: '' };
  const ai2 = new SpyAi();
  await buildReply(pool, ai2, blank, id2, {});
  const blankSystem = ai2.lastMessages[0].content;
  assert.doesNotMatch(blankSystem, /Contact details/, 'no facts on file means no section, rather than an empty one telling the model to invent something');
});

test('reply_language is in the contract and the model gets told it has not settled on one yet, on a fresh chat', async () => {
  const id = await conversation();
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, {});
  const system = ai.lastMessages[0].content;
  assert.match(system, /reply_language/);
  assert.match(system, /Language:/);
  const leadSystem = ai.lastMessages[1].content;
  assert.match(leadSystem, /not settled on a language/i);
});

test('the model is shown the language it has been using so far, once one is set', async () => {
  const id = await conversation();
  await pool.query('update conversations set reply_language = $2 where id = $1', [id, 'Gujarati']);
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, {});
  const leadSystem = ai.lastMessages[1].content;
  assert.match(leadSystem, /replying in Gujarati/);
});

test('the language the model chose comes back on the decision, trimmed and length capped', async () => {
  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'answer', reply: 'Kem cho!', reply_language: '  Gujarati  ' }));
  const decision = await buildReply(pool, ai, testConfig, id, {});
  assert.equal(decision.replyLanguage, 'Gujarati');

  const id2 = await conversation('hi');
  const longLang = 'x'.repeat(200);
  const ai2 = new SpyAi(JSON.stringify({ action: 'answer', reply: 'hi', reply_language: longLang }));
  const decision2 = await buildReply(pool, ai2, testConfig, id2, {});
  assert.equal(decision2.replyLanguage.length, 40, 'an implausibly long value is capped rather than stored as-is');
});

test('the model is told to introduce itself by name on a fresh chat, and told not to once it already has', async () => {
  const id = await conversation();
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, {});
  const leadSystem = ai.lastMessages[1].content;
  assert.match(leadSystem, /have not introduced yourself/i);
  assert.match(leadSystem, /Adi/, 'the configured bot name is what it is told to introduce itself as');

  await pool.query('update conversations set introduced_at = now() where id = $1', [id]);
  const ai2 = new SpyAi();
  await buildReply(pool, ai2, testConfig, id, {});
  const leadSystem2 = ai2.lastMessages[1].content;
  assert.match(leadSystem2, /already introduced yourself/i);
  assert.doesNotMatch(leadSystem2, /have not introduced/i);
});

test('a lead detail the model picks up on comes back on the decision, sanitised', async () => {
  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({
    action: 'answer', reply: 'Nice to meet you!', reply_language: 'English',
    lead_name: '  Priya  ', lead_business: 'Priya Bakes', lead_email: 'priya@example.com',
  }));
  const decision = await buildReply(pool, ai, testConfig, id, {});
  assert.deepEqual(decision.leadProfile, { name: 'Priya', business: 'Priya Bakes', email: 'priya@example.com' });

  const id2 = await conversation('hi');
  const ai2 = new SpyAi(JSON.stringify({ action: 'answer', reply: 'hi', lead_email: 'not-an-email' }));
  const decision2 = await buildReply(pool, ai2, testConfig, id2, {});
  assert.equal(decision2.leadProfile, null, 'an unusable email and no other field means nothing worth storing');
});

test('once the lead\'s business and email are known, the model is shown them and does not have to ask again', async () => {
  const id = await conversation();
  await pool.query(
    `update contacts set business = $2, email = $3 where id = (select contact_id from conversations where id = $1)`,
    [id, 'Priya Bakes', 'priya@example.com'],
  );
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, {});
  const leadSystem = ai.lastMessages[1].content;
  assert.match(leadSystem, /Priya Bakes/);
  assert.match(leadSystem, /priya@example\.com/);
});

test('a need_packs response is treated as a handoff when pack requests are disabled', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await createFaq(pool, { topicId: logo.id, question: 'Cost?', answer: '20000.' });

  const id = await conversation();
  const ai = new SpyAi(JSON.stringify({ action: 'need_packs', pack_ids: [Number(logo.id)] }));
  const decision = await buildReply(pool, ai, testConfig, id, {
    packs: ['base'],
    allowPackRequests: false,
  });
  assert.equal(decision.handoff, true, 'no catalog to draw from, so it cannot request anything');
});

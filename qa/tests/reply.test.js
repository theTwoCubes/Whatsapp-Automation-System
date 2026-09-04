import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildReply } from '../../src/ai/reply.js';
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

test('faqs with a file attached are flagged in the prompt and the id is shown', async () => {
  const assetId = (
    await pool.query("insert into media_assets (kind, filename) values ('document', 'p.pdf') returning id")
  ).rows[0].id;
  const faq = await createFaq(pool, { question: 'Prices?', answer: 'See sheet.', mediaAssetId: assetId });

  const id = await conversation();
  const ai = new SpyAi();
  await buildReply(pool, ai, testConfig, id, {});

  const system = ai.lastMessages[0].content;
  assert.match(system, new RegExp(`Q \\[id ${faq.id}\\]:`), 'each faq shows its id so the model can name it');
  assert.match(system, /has an attached file you can send with this answer/);
  assert.match(system, /send_faq_id/);
});

test('send_faq_id is only trusted when the id was actually in the packs given', async () => {
  const assetId = (
    await pool.query("insert into media_assets (kind, filename) values ('document', 'p.pdf') returning id")
  ).rows[0].id;
  const faq = await createFaq(pool, { question: 'Prices?', answer: 'See sheet.', mediaAssetId: assetId });

  const id = await conversation();
  const good = new SpyAi(JSON.stringify({ action: 'answer', reply: 'Here it is.', send_faq_id: Number(faq.id) }));
  const goodDecision = await buildReply(pool, good, testConfig, id, {});
  assert.equal(goodDecision.sendFaqId, Number(faq.id));

  const bad = new SpyAi(JSON.stringify({ action: 'answer', reply: 'Here it is.', send_faq_id: 99999 }));
  const badDecision = await buildReply(pool, bad, testConfig, id, {});
  assert.equal(badDecision.sendFaqId, null, 'an id not in the given packs is dropped rather than trusted');
  assert.equal(badDecision.reply, 'Here it is.', 'the reply itself still goes through');
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

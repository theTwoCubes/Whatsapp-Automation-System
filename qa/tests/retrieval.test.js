import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { retrieveKnowledge } from '../../src/knowledge/retrieval.js';
import { addKnowledgeUnit } from '../../src/knowledge/writer.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { buildReply } from '../../src/ai/reply.js';
import { recordInbound } from '../../src/db/repo.js';
import { setupPool, resetTables, FakeEmbeddings, FakeAi, testConfig } from './support/harness.js';

let pool;
let embed;

before(async () => {
  pool = await setupPool();
  embed = new FakeEmbeddings();
});
after(async () => {
  await pool?.end();
});
beforeEach(async () => {
  await resetTables(pool);
});

async function seed() {
  const logoTopic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const posterTopic = await upsertTopic(pool, { slug: 'poster', name: 'Poster' });

  await addKnowledgeUnit(pool, embed, {
    title: 'Contact',
    content: 'You can reach the team on WhatsApp during business hours.',
    scope: 'base',
  });
  await addKnowledgeUnit(pool, embed, {
    title: 'Logo pricing',
    content: 'The standard logo design package is 20000 rupees plus GST.',
    scope: 'topic',
    topicId: logoTopic.id,
  });
  await addKnowledgeUnit(pool, embed, {
    title: 'Logo revisions',
    content: 'The logo design package includes two rounds of revisions.',
    scope: 'topic',
    topicId: logoTopic.id,
  });
  await addKnowledgeUnit(pool, embed, {
    title: 'Poster turnaround',
    content: 'Poster designs are usually delivered in 3 working days.',
    scope: 'topic',
    topicId: posterTopic.id,
  });

  return { logoTopic, posterTopic };
}

test('retrieval returns matching facts and prefers the lead topic', async () => {
  const { logoTopic } = await seed();
  const results = await retrieveKnowledge(pool, embed, 'how many revisions do I get on the logo', {
    topicId: logoTopic.id,
  });
  assert.ok(results.length > 0);
  assert.equal(results[0].title, 'Logo revisions', 'top hit is the specific fact');
});

test('a logo campaign lead asking about posters still gets the poster fact', async () => {
  const { logoTopic, posterTopic } = await seed();
  const results = await retrieveKnowledge(pool, embed, 'how long for a poster', {
    topicId: logoTopic.id,
  });
  const titles = results.map((r) => r.title);
  assert.ok(titles.includes('Poster turnaround'), 'shared brain finds cross topic facts');
});

test('base knowledge is eligible alongside topic knowledge', async () => {
  const { logoTopic } = await seed();
  const results = await retrieveKnowledge(pool, embed, 'when can I reach the team on whatsapp', {
    topicId: logoTopic.id,
  });
  const titles = results.map((r) => r.title);
  assert.ok(titles.includes('Contact'), 'a base fact is retrieved even while biased to a topic');
});

test('the token budget caps how many facts are packed', async () => {
  const { logoTopic } = await seed();
  const results = await retrieveKnowledge(pool, embed, 'logo revisions pricing', {
    topicId: logoTopic.id,
    tokenBudget: 30,
  });
  assert.ok(results.length <= 2, 'packed conservatively into a small budget');
});

test('empty knowledge returns nothing rather than hallucinating', async () => {
  const results = await retrieveKnowledge(pool, embed, 'anything at all');
  assert.equal(results.length, 0);
});

test('dedup skips a near identical insert', async () => {
  const { logoTopic } = await seed();
  const first = await addKnowledgeUnit(pool, embed, {
    title: 'Logo pricing',
    content: 'The standard logo design package is 20000 rupees plus GST.',
    scope: 'topic',
    topicId: logoTopic.id,
  });
  assert.equal(first.added, false, 'exact same fact is deduped');
  assert.ok(first.duplicateOf, 'duplicateOf is populated');
});

test('a genuinely new fact under the same topic is added', async () => {
  const { logoTopic } = await seed();
  const res = await addKnowledgeUnit(pool, embed, {
    title: 'Logo formats',
    content: 'Delivered files include PNG, SVG, PDF and vector source.',
    scope: 'topic',
    topicId: logoTopic.id,
  });
  assert.equal(res.added, true);
});

test('buildReply actually forwards the configured retrieval limits to retrieval', async () => {
  const { logoTopic } = await seed();
  const { conversationId } = await recordInbound(pool, {
    waId: '919999999999',
    name: 'Config Check',
    waMessageId: `wamid.${Math.random()}`,
    type: 'text',
    body: 'logo revisions pricing',
    referral: null,
    raw: {},
  });

  const ai = new FakeAi(JSON.stringify({ reply: 'ok', handoff: false }));
  const decision = await buildReply(pool, ai, embed, testConfig, conversationId, {
    query: 'logo revisions pricing',
    topicId: logoTopic.id,
    tokenBudget: 30,
  });
  assert.ok(decision.facts.length <= 2, 'a tight token budget passed through opts actually limits what gets packed');
});

test('retrieval keeps working when embeddings fail, using full text fallback', async () => {
  await seed();
  const failing = new FakeEmbeddings({ fail: true });
  const results = await retrieveKnowledge(pool, failing, 'revisions', { topicId: null });
  const titles = results.map((r) => r.title);
  assert.ok(titles.includes('Logo revisions'), 'full text fallback finds the fact');
});

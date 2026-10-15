import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { simulateReply } from '../../src/knowledge/simulator.js';
import { createFaq } from '../../src/knowledge/faqs.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
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

class SpyAi extends FakeAi {
  async complete(messages, options) {
    this.lastMessages = messages;
    return super.complete(messages, options);
  }
}

test('the trace reports the packs and answers the model would have seen', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await createFaq(pool, { question: 'What does a logo cost?', answer: '20000 rupees plus GST.', topicId: logo.id });
  await createFaq(pool, { question: 'What are your hours?', answer: 'Monday to Saturday.' });

  const trace = await simulateReply(pool, null, testConfig, testConfig, {
    text: 'how much for a logo?',
    topicId: logo.id,
    callAi: false,
  });

  assert.deepEqual(trace.packsIncluded, ['base', Number(logo.id)]);
  assert.equal(trace.faqCount, 2, 'both packs are counted');
  assert.match(trace.context, /20000 rupees plus GST/);
  assert.match(trace.context, /Monday to Saturday/);
  assert.equal(trace.decision, null, 'no ai call was made');
});

// The simulator has to assemble packs exactly the way a live turn does, or a
// client verifies a change here and gets different behaviour in a real chat.
// Live loads every service regardless of what the message says, so this does.
test('every service is loaded, matching what a live turn gets', async () => {
  const poster = await upsertTopic(pool, { slug: 'poster', name: 'Poster', keywords: 'poster, banner' });
  await createFaq(pool, { topicId: poster.id, question: 'Poster cost?', answer: '3000.' });

  const trace = await simulateReply(pool, null, testConfig, testConfig, {
    text: 'hello, what do you charge',
    callAi: false,
  });

  assert.ok(
    trace.packsIncluded.includes(Number(poster.id)),
    'the poster answers are there even though the message never mentions posters',
  );
  assert.match(trace.context, /3000/);
});

test('with the ai configured, the decision is what the pipeline would actually send', async () => {
  await createFaq(pool, { question: 'Hours?', answer: 'Monday to Saturday.' });
  const ai = new SpyAi(JSON.stringify({ action: 'answer', reply: 'Monday to Saturday.' }));

  const trace = await simulateReply(pool, ai, testConfig, testConfig, {
    text: 'when are you open?',
    callAi: true,
  });

  assert.ok(trace.decision);
  assert.equal(trace.decision.handoff, false);
  assert.equal(trace.decision.reply, 'Monday to Saturday.');
  // The synthetic message reaches the model as a user turn after the two
  // system messages.
  const userTurn = ai.lastMessages.find((m) => m.role === 'user');
  assert.equal(userTurn.content, 'when are you open?');
});

test('a handoff decision reaches the trace with its reason, and nothing is persisted', async () => {
  const ai = new SpyAi(JSON.stringify({ action: 'handoff', reply: 'Let me get someone.', reason: 'no answer covers this' }));

  const before = Number((await pool.query('select count(*) as n from conversations')).rows[0].n);
  const trace = await simulateReply(pool, ai, testConfig, testConfig, {
    text: 'do you do 3d renders',
    callAi: true,
  });
  const after = Number((await pool.query('select count(*) as n from conversations')).rows[0].n);

  assert.equal(before, after, 'the simulator never creates a conversation');
  assert.equal(trace.decision.handoff, true);
  assert.equal(trace.decision.reason, 'no answer covers this');
});

test('an empty message is rejected instead of being sent to the model', async () => {
  await assert.rejects(
    () => simulateReply(pool, new SpyAi(), testConfig, testConfig, { text: '   ' }),
    /message is required/,
  );
});

test('when the ai is disabled the trace still shows what the prompt would have looked like', async () => {
  await createFaq(pool, { question: 'Hours?', answer: 'Monday to Saturday.' });
  const disabled = new FakeAi();
  disabled.enabled = false;

  const trace = await simulateReply(pool, disabled, testConfig, testConfig, {
    text: 'when are you open?',
    callAi: true,
  });

  assert.equal(trace.decision, null);
  assert.match(trace.context, /Monday to Saturday/, 'the context is there so the client can still verify it');
});

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { runWeeklyLearning, getLearningCursor } from '../../src/knowledge/learning.js';
import { recordInbound, recordOutbound } from '../../src/db/repo.js';
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

async function seedConversation(body) {
  const { conversationId } = await recordInbound(pool, {
    waId: '917000000001',
    name: 'Learning Lead',
    waMessageId: `wamid.${Math.random()}`,
    type: 'text',
    body: 'do you offer rush delivery',
    referral: null,
    raw: {},
  });
  await recordOutbound(pool, { conversationId, waMessageId: `wamid.${Math.random()}`, body });
  return conversationId;
}

test('a fact the team stated is queued for review, not activated', async () => {
  await seedConversation('Yes, we do rush delivery in 24 hours for an extra fee.');
  const ai = new FakeAi(JSON.stringify({ faqs: [{ question: 'Do you offer rush delivery?', answer: 'Rush delivery is available in 24 hours for an extra fee.' }] }));

  const result = await runWeeklyLearning(pool, ai);
  assert.equal(result.added, 1);

  const row = (
    await pool.query("select active, source from faqs where question = 'Do you offer rush delivery?'")
  ).rows[0];
  assert.equal(row.active, false, 'not live until approved');
  assert.equal(row.source, 'learned');
});

test('the cursor advances so a second run does not rescan the same messages', async () => {
  await seedConversation('Yes, we do rush delivery in 24 hours for an extra fee.');
  const ai = new FakeAi(JSON.stringify({ faqs: [{ question: 'Do you offer rush delivery?', answer: 'Rush delivery is available in 24 hours for an extra fee.' }] }));

  const first = await runWeeklyLearning(pool, ai);
  assert.equal(first.conversationsScanned, 1);

  const second = await runWeeklyLearning(pool, ai);
  assert.equal(second.conversationsScanned, 0, 'no new messages since the last run');

  const cursor = await getLearningCursor(pool);
  assert.ok(cursor.lastMessageId > 0);
  assert.ok(cursor.lastRunAt);
});

test('learning is a no-op when the ai is disabled', async () => {
  await seedConversation('Yes, we do rush delivery in 24 hours for an extra fee.');
  const disabledAi = new FakeAi();
  disabledAi.enabled = false;

  const result = await runWeeklyLearning(pool, disabledAi);
  assert.deepEqual(result, { conversationsScanned: 0, added: 0, skipped: 0 });
});

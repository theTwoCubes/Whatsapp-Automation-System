import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { runAutoResume } from '../../src/scheduler.js';
import { recordInbound } from '../../src/db/repo.js';
import { handToHuman } from '../../src/handoff.js';
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

async function humanConversationWaiting() {
  const { conversationId } = await recordInbound(pool, {
    waId: '911111111111',
    name: 'Waiting Lead',
    waMessageId: `wamid.${Math.random()}`,
    type: 'text',
    body: 'anyone there?',
    referral: null,
    raw: {},
  });
  await handToHuman(pool, conversationId, 'agent@x.com');
  return conversationId;
}

test('a stalled human chat is resumed and the lead gets a reply', async () => {
  const id = await humanConversationWaiting();
  // make the takeover look old
  await pool.query("update conversations set assigned_at = now() - interval '30 min' where id = $1", [id]);

  const meta = new FakeMeta();
  const resumed = await runAutoResume({
    pool,
    meta,
    ai: new FakeAi('Sorry for the wait, how can I help?'),
    embeddings: new FakeEmbeddings(),
    config: { ...testConfig, resumeMinutes: 15 },
    log: silentLog,
  });

  assert.equal(resumed, 1);
  const state = (await pool.query('select state from conversations where id = $1', [id])).rows[0].state;
  assert.equal(state, 'bot', 'conversation handed back to the bot');
  assert.equal(meta.sends.length, 1, 'the waiting lead got an answer');
});

test('a recently handled human chat is left alone', async () => {
  const id = await humanConversationWaiting();
  // taken over just now, within the window
  const meta = new FakeMeta();
  const resumed = await runAutoResume({
    pool,
    meta,
    ai: new FakeAi('hi'),
    embeddings: new FakeEmbeddings(),
    config: { ...testConfig, resumeMinutes: 15 },
    log: silentLog,
  });

  assert.equal(resumed, 0);
  const state = (await pool.query('select state from conversations where id = $1', [id])).rows[0].state;
  assert.equal(state, 'human', 'still with the human');
});

test('auto resume does nothing when disabled', async () => {
  const id = await humanConversationWaiting();
  await pool.query("update conversations set assigned_at = now() - interval '30 min' where id = $1", [id]);
  const resumed = await runAutoResume({
    pool,
    meta: new FakeMeta(),
    ai: new FakeAi('hi'),
    embeddings: new FakeEmbeddings(),
    config: { ...testConfig, resumeMinutes: 0 },
    log: silentLog,
  });
  assert.equal(resumed, 0);
});

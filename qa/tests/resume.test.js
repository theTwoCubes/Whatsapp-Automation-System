import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { runAutoResume, runRetryAttempts } from '../../src/scheduler.js';
import { recordInbound, scheduleRetry } from '../../src/db/repo.js';
import { handToHuman, handToPending } from '../../src/handoff.js';
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
    ai: new FakeAi(JSON.stringify({ action: 'answer', reply: 'Sorry for the wait, how can I help?' })),
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
    ai: new FakeAi(JSON.stringify({ action: 'answer', reply: 'hi' })),
    config: { ...testConfig, resumeMinutes: 15 },
    log: silentLog,
  });

  assert.equal(resumed, 0);
  const state = (await pool.query('select state from conversations where id = $1', [id])).rows[0].state;
  assert.equal(state, 'human', 'still with the human');
});

test('a pending handoff nobody accepted in time also resumes to the bot', async () => {
  const { conversationId } = await recordInbound(pool, {
    waId: '911111111112',
    name: 'Unclaimed Lead',
    waMessageId: `wamid.${Math.random()}`,
    type: 'text',
    body: 'can I speak to someone',
    referral: null,
    raw: {},
  });
  await handToPending(pool, conversationId, 'Lead asked to speak with a person');
  await pool.query("update conversations set assigned_at = now() - interval '30 min' where id = $1", [conversationId]);

  const meta = new FakeMeta();
  const resumed = await runAutoResume({
    pool,
    meta,
    ai: new FakeAi(JSON.stringify({ action: 'answer', reply: 'Sorry for the wait, how can I help?' })),
    config: { ...testConfig, resumeMinutes: 15 },
    log: silentLog,
  });

  assert.equal(resumed, 1);
  const row = (await pool.query('select state, handoff_reason from conversations where id = $1', [conversationId])).rows[0];
  assert.equal(row.state, 'bot', 'nobody claimed it in time, so the bot resumes');
  assert.equal(row.handoff_reason, null, 'the stale handoff reason is cleared');
  assert.equal(meta.sends.length, 1, 'the waiting lead got an answer');
});

test('auto resume applies the same qualification gate as live respondToLead', async () => {
  // Contact was never qualified (no business/email/address/requirement) - if
  // the AI on auto-resume tries to hand off, the gate must downgrade and
  // the AI's reply must still go out as a plain answer, mirroring the live
  // respondToLead path exactly.
  const id = await humanConversationWaiting();
  await pool.query("update conversations set assigned_at = now() - interval '30 min' where id = $1", [id]);

  const ai = new FakeAi(
    JSON.stringify({ action: 'handoff', reply: 'Haan bilkul, pehle apna business bata denge?', reason: 'customer asked for a person' }),
  );
  const meta = new FakeMeta();
  const resumed = await runAutoResume({
    pool,
    meta,
    ai,
    config: { ...testConfig, resumeMinutes: 15 },
    log: silentLog,
  });

  assert.equal(resumed, 1);
  const state = (await pool.query('select state from conversations where id = $1', [id])).rows[0].state;
  assert.equal(state, 'bot', 'unqualified handoff on auto-resume stays with the bot');
  assert.equal(ai.calls, 1, 'one AI call per turn - no regen');
  assert.equal(meta.sends.length, 1);
  assert.match(meta.sends[0].body, /business/, "the ai's own reply went out as a plain answer");
});

test('auto resume does nothing when disabled', async () => {
  const id = await humanConversationWaiting();
  await pool.query("update conversations set assigned_at = now() - interval '30 min' where id = $1", [id]);
  const resumed = await runAutoResume({
    pool,
    meta: new FakeMeta(),
    ai: new FakeAi(JSON.stringify({ action: 'answer', reply: 'hi' })),
    config: { ...testConfig, resumeMinutes: 0 },
    log: silentLog,
  });
  assert.equal(resumed, 0);
});

async function botConversationWithPendingInbound() {
  const { conversationId } = await recordInbound(pool, {
    waId: '911111111113',
    name: 'Stuck Lead',
    waMessageId: `wamid.${Math.random()}`,
    type: 'text',
    body: 'hello?',
    referral: null,
    raw: {},
  });
  await pool.query("update conversations set state = 'bot' where id = $1", [conversationId]);
  return conversationId;
}

test('a retry whose ai now returns a clean answer delivers that answer', async () => {
  const id = await botConversationWithPendingInbound();
  await scheduleRetry(pool, id, 0);

  const meta = new FakeMeta();
  const processed = await runRetryAttempts({
    pool,
    meta,
    ai: new FakeAi(JSON.stringify({ action: 'answer', reply: 'Here is the real answer.' })),
    config: testConfig,
    log: silentLog,
  });

  assert.equal(processed, 1);
  assert.equal(meta.sends.length, 1, 'the retry delivered the ai answer');
  assert.match(meta.sends[0].body, /real answer/);
  const retryAt = (await pool.query('select retry_at from conversations where id = $1', [id])).rows[0].retry_at;
  assert.equal(retryAt, null, 'retry_at cleared after the attempt');
});

test('a retry whose ai is still broken stays silent instead of sending another holding line', async () => {
  const id = await botConversationWithPendingInbound();
  await scheduleRetry(pool, id, 0);

  const meta = new FakeMeta();
  // The AI returns garbage again - parseDecision will set parseFailed=true
  // and synthesise handoff:true. The retry must not fire another fallback.
  const processed = await runRetryAttempts({
    pool,
    meta,
    ai: new FakeAi('not valid json at all'),
    config: testConfig,
    log: silentLog,
  });

  assert.equal(processed, 1);
  assert.equal(meta.sends.length, 0, 'no second holding message was sent');
  const retryAt = (await pool.query('select retry_at from conversations where id = $1', [id])).rows[0].retry_at;
  assert.equal(retryAt, null, 'retry_at cleared even on a silent retry');
});

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { processWebhook } from '../../src/handlers/message.js';
import { runDueDrips } from '../../src/scheduler.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { createFaq } from '../../src/knowledge/faqs.js';
import { inboundText } from './support/fixtures.js';
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

const pending = async () =>
  Number((await pool.query("select count(*) as n from drip_jobs where status = 'pending'")).rows[0].n);
const byStatus = async (status) =>
  Number((await pool.query('select count(*) as n from drip_jobs where status = $1', [status])).rows[0].n);
const firstConversation = async () => (await pool.query('select id from conversations limit 1')).rows[0].id;

test('a bot reply schedules the drip follow ups', async () => {
  await processWebhook(inboundText({ id: 'wamid.G1', body: 'hi' }), deps());
  assert.equal(await pending(), 3, 'three follow ups scheduled');
});

test('a new lead message resets the drip schedule', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.G1', body: 'hi' }), d);
  await processWebhook(inboundText({ id: 'wamid.G2', body: 'still there?' }), d);

  assert.equal(await pending(), 3, 'still three pending after reset');
  assert.equal(await byStatus('cancelled'), 3, 'the previous three were cancelled');
});

test('handing off to a human cancels the drips', async () => {
  const ai = new FakeAi();
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.G1', body: 'hi' }), d);
  assert.equal(await pending(), 3);

  ai.reply = JSON.stringify({ action: 'handoff', reply: 'Connecting you.', reason: 'customer asked for a person' });
  await processWebhook(inboundText({ id: 'wamid.G2', body: 'can I talk to a human' }), d);
  assert.equal(await pending(), 0, 'no follow ups once a human is involved');
});

test('a service pack with its own drip steps overrides the general sequence', async () => {
  const topic = await upsertTopic(pool, {
    slug: 'packaging_design',
    name: 'Packaging Design',
    keywords: 'packaging',
    dripSteps: 'drip_packaging_day3:3,drip_packaging_day5:5,drip_packaging_day8:8',
  });
  await createFaq(pool, { topicId: topic.id, question: 'What is packaging design?', answer: 'We design product packaging.' });

  await processWebhook(inboundText({ id: 'wamid.P1', body: 'I need packaging design for my product' }), deps());

  const names = (await pool.query(
    "select template_name from drip_jobs where status = 'pending' order by step",
  )).rows.map((r) => r.template_name);
  assert.deepEqual(names, ['drip_packaging_day3', 'drip_packaging_day5', 'drip_packaging_day8']);
});

test('a service pack with no drip steps of its own falls back to the general sequence', async () => {
  const topic = await upsertTopic(pool, { slug: 'video_creation', name: 'Video', keywords: 'videoclip' });
  await createFaq(pool, { topicId: topic.id, question: 'Do you make videos?', answer: 'Yes, short videos.' });

  await processWebhook(inboundText({ id: 'wamid.P2', body: 'I want a videoclip made' }), deps());

  const names = (await pool.query(
    "select template_name from drip_jobs where status = 'pending' order by step",
  )).rows.map((r) => r.template_name);
  assert.deepEqual(names, ['drip_day3', 'drip_day5', 'drip_day8']);
});

test('a due follow up sends its template and is marked sent', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.G1', body: 'hi' }), d);
  const conv = await firstConversation();
  await pool.query(
    `insert into drip_jobs (conversation_id, step, template_name, run_at)
     values ($1, 9, 'drip_day3', now() - interval '1 minute')`,
    [conv],
  );

  const processed = await runDueDrips({ pool, meta: d.meta, config: testConfig, log: silentLog });
  assert.equal(processed, 1, 'one due job processed');
  assert.equal(d.meta.templates.length, 1, 'one template sent');
  assert.equal(d.meta.templates[0].name, 'drip_day3');

  const status = (await pool.query('select status from drip_jobs where step = 9')).rows[0].status;
  assert.equal(status, 'sent');
});

test('due follow ups are skipped once a human owns the conversation', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'handoff', reply: 'Connecting you.', reason: 'customer asked for a person' }));
  const d = deps({ ai });
  await processWebhook(inboundText({ id: 'wamid.G1', body: 'talk to a human' }), d);
  const conv = await firstConversation();
  await pool.query(
    `insert into drip_jobs (conversation_id, step, template_name, run_at)
     values ($1, 9, 'drip_day3', now() - interval '1 minute')`,
    [conv],
  );

  const meta = new FakeMeta();
  const processed = await runDueDrips({ pool, meta, config: testConfig, log: silentLog });
  assert.equal(processed, 0, 'nothing sent while a human owns it');
  assert.equal(meta.templates.length, 0);
});

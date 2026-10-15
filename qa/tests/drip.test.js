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

  // Server-side gate requires qualified lead before a handoff clears.
  await pool.query("update contacts set business = 'ACME Studio', email = 'lead@acme.co', address = 'Mumbai', lead_details = jsonb_build_object('requirement', 'Scientific logo for Ayurveda clinic')");
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

  // The service has to be recorded for its follow ups to apply, and only the
  // ai records it now - a word in the message does not.
  const ai = new FakeAi(JSON.stringify({
    action: 'answer', reply: 'Happy to help with packaging.',
    lead_service: 'Packaging Design', service_basis: 'stated',
  }));
  await processWebhook(inboundText({ id: 'wamid.P1', body: 'I need packaging design for my product' }), deps({ ai }));

  const names = (await pool.query(
    "select template_name from drip_jobs where status = 'pending' order by step",
  )).rows.map((r) => r.template_name);
  assert.deepEqual(names, ['drip_packaging_day3', 'drip_packaging_day5', 'drip_packaging_day8']);
});

test('a service pack with no drip steps of its own falls back to the general sequence', async () => {
  const topic = await upsertTopic(pool, { slug: 'video_creation', name: 'Video', keywords: 'videoclip' });
  await createFaq(pool, { topicId: topic.id, question: 'Do you make videos?', answer: 'Yes, short videos.' });

  const ai = new FakeAi(JSON.stringify({
    action: 'answer', reply: 'Yes, we make short videos.',
    lead_service: 'Video', service_basis: 'stated',
  }));
  await processWebhook(inboundText({ id: 'wamid.P2', body: 'I want a videoclip made' }), deps({ ai }));

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

test('a due follow up is never sent to a contact who has opted out', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.OO1', body: 'hi' }), d);
  const conv = await firstConversation();
  await pool.query(
    `insert into drip_jobs (conversation_id, step, template_name, run_at)
     values ($1, 9, 'drip_day3', now() - interval '1 minute')`,
    [conv],
  );
  await pool.query(
    `update contacts set opted_out_at = now() where id = (select contact_id from conversations where id = $1)`,
    [conv],
  );

  const processed = await runDueDrips({ pool, meta: d.meta, config: testConfig, log: silentLog });
  assert.equal(processed, 0, 'nothing gets claimed for an opted-out contact');
  assert.equal(d.meta.templates.length, 0);
});

test('a drip step with a media asset sends it as the template header', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.M1', body: 'hi' }), d);
  const conv = await firstConversation();
  const asset = await pool.query(
    `insert into media_assets (meta_media_id, filename, mime_type, kind)
     values ('meta-media-1', 'logo-design-portfolio.pdf', 'application/pdf', 'document') returning id`,
  );
  await pool.query(
    `insert into drip_jobs (conversation_id, step, template_name, media_asset_id, run_at)
     values ($1, 9, 'drip_logo_day3', $2, now() - interval '1 minute')`,
    [conv, asset.rows[0].id],
  );

  const processed = await runDueDrips({ pool, meta: d.meta, config: testConfig, log: silentLog });
  assert.equal(processed, 1);
  const sent = d.meta.templates[0];
  assert.equal(sent.name, 'drip_logo_day3');
  assert.deepEqual(sent.components, [
    { type: 'header', parameters: [{ type: 'document', document: { id: 'meta-media-1', filename: 'logo-design-portfolio.pdf' } }] },
  ]);
});

test('a drip step whose media kind cannot be a template header sends without it', async () => {
  const d = deps();
  await processWebhook(inboundText({ id: 'wamid.M2', body: 'hi' }), d);
  const conv = await firstConversation();
  const asset = await pool.query(
    `insert into media_assets (meta_media_id, filename, mime_type, kind)
     values ('meta-media-2', 'voice.ogg', 'audio/ogg', 'audio') returning id`,
  );
  await pool.query(
    `insert into drip_jobs (conversation_id, step, template_name, media_asset_id, run_at)
     values ($1, 9, 'drip_day3', $2, now() - interval '1 minute')`,
    [conv, asset.rows[0].id],
  );

  const processed = await runDueDrips({ pool, meta: d.meta, config: testConfig, log: silentLog });
  assert.equal(processed, 1);
  assert.equal(d.meta.templates[0].components, undefined);
});

test('due follow ups are skipped once a human owns the conversation', async () => {
  const ai = new FakeAi(JSON.stringify({ action: 'answer', reply: 'hi there' }));
  const d = deps({ ai });
  // First message gets an answer, then pre-qualify + hand off so the gate
  // lets the escalation through.
  await processWebhook(inboundText({ id: 'wamid.G0', body: 'hi' }), d);
  await pool.query("update contacts set business = 'ACME Studio', email = 'lead@acme.co', address = 'Mumbai', lead_details = jsonb_build_object('requirement', 'Scientific logo for Ayurveda clinic')");
  ai.reply = JSON.stringify({ action: 'handoff', reply: 'Connecting you.', reason: 'customer asked for a person' });
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

// Regression: a keyword match makes its pack sticky, so resolving the drip
// sequence off the pack list works for those leads. The ai naming the service
// through lead_service does NOT make it sticky - it only records it on the
// conversation. So for a lead the ai classified rather than keyword matched,
// the pack list is just ['base'], and resolving off it alone fell through to
// the general sequence. A client running purely per-service follow ups has
// that empty, which meant the console showed the lead under a service with a
// follow up configured while nothing was ever scheduled for them.
test('a service the ai named becomes the conversation\'s pack, and is followed up', async () => {
  const topic = await upsertTopic(pool, {
    slug: 'scientific-logo-design',
    name: 'Scientific Logo Design',
    keywords: 'scientific logo',
    dripSteps: 'any_update:1',
  });
  await createFaq(pool, { topicId: topic.id, question: 'What is it?', answer: 'A logo as a visual Yantra.' });

  // No keyword in the text - the service comes purely from the ai's own read.
  const ai = new FakeAi(JSON.stringify({
    action: 'answer',
    reply: 'Happy to help with that.',
    lead_service: 'Scientific Logo Design',
    service_basis: 'stated',
  }));
  const emptyGeneral = { ...testConfig, dripSteps: [] };
  await processWebhook(
    inboundText({ id: 'wamid.SVC1', body: 'i need help with my brand identity' }),
    { ...deps({ ai }), config: emptyGeneral },
  );

  const conv = await firstConversation();
  const row = (await pool.query('select last_topic_id, service_basis from conversations where id = $1', [conv])).rows[0];
  assert.equal(Number(row.last_topic_id), Number(topic.id), 'recorded against the service the ai named');
  assert.equal(row.service_basis, 'stated');

  const jobs = (
    await pool.query("select template_name, run_at, created_at from drip_jobs where status = 'pending' order by step")
  ).rows;
  assert.equal(jobs.length, 1, 'the service follow up was still scheduled');
  assert.equal(jobs[0].template_name, 'any_update');
  const gapHours = (new Date(jobs[0].run_at) - new Date(jobs[0].created_at)) / 3600000;
  assert.ok(gapHours > 23 && gapHours < 25, `scheduled ~1 day out, got ${gapHours}h`);
});

test('with no service follow ups configured the general sequence still applies', async () => {
  const topic = await upsertTopic(pool, {
    slug: 'scientific-logo-design',
    name: 'Scientific Logo Design',
    keywords: 'scientific logo',
  });
  await createFaq(pool, { topicId: topic.id, question: 'What is it?', answer: 'A logo as a visual Yantra.' });
  await processWebhook(inboundText({ id: 'wamid.SVC3', body: 'i want a scientific logo' }), deps());
  assert.equal(await pending(), 3, 'falls back to the three general steps');
});

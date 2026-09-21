import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { describeAttachment } from '../../src/ai/vision.js';
import { processWebhook } from '../../src/handlers/message.js';
import { inboundImage } from './support/fixtures.js';
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

test('describeAttachment returns nothing when gemini is not configured', async () => {
  const note = await describeAttachment({ geminiApiKey: '' }, Buffer.from('x'), 'image/png');
  assert.equal(note, null);
});

test('describeAttachment skips a mime type it does not support, even when configured', async () => {
  const note = await describeAttachment({ geminiApiKey: 'k', geminiModel: 'gemini-2.5-flash' }, Buffer.from('x'), 'audio/ogg');
  assert.equal(note, null);
});

test('a vision note is saved against the message and rides along in the next prompt', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'a hand-drawn logo sketch' }] } }] }),
  });
  try {
    const config = { ...testConfig, geminiApiKey: 'test-key', geminiModel: 'gemini-2.5-flash' };
    const d = { meta: new FakeMeta(), ai: new FakeAi(), pool, config, log: silentLog };
    await processWebhook(inboundImage({ id: 'wamid.V1' }), d);

    const row = await pool.query("select attachment_context from messages where type = 'image'");
    assert.equal(row.rows[0].attachment_context, 'a hand-drawn logo sketch');
  } finally {
    global.fetch = originalFetch;
  }
});

test('the per-hour cap stops further vision calls without blocking the reply', async () => {
  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'note' }] } }] }) };
  };
  try {
    const config = { ...testConfig, geminiApiKey: 'test-key', geminiModel: 'gemini-2.5-flash', mediaAnalysisMaxPerHour: 1 };
    const d = { meta: new FakeMeta(), ai: new FakeAi(), pool, config, log: silentLog };
    await processWebhook(inboundImage({ id: 'wamid.V2' }), d);
    await processWebhook(inboundImage({ id: 'wamid.V3' }), d);

    assert.equal(fetchCalls, 1, 'the second image within the window is not sent for analysis');
    assert.equal(d.meta.sends.length, 2, 'the bot still replies to both, it just does not analyse the second');

    const rows = await pool.query("select attachment_context from messages where type = 'image' order by id");
    assert.equal(rows.rows[0].attachment_context, 'note');
    assert.equal(rows.rows[1].attachment_context, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a failed vision call is swallowed and the bot still replies', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) });
  try {
    const config = { ...testConfig, geminiApiKey: 'test-key', geminiModel: 'gemini-2.5-flash' };
    const d = { meta: new FakeMeta(), ai: new FakeAi(), pool, config, log: silentLog };
    await processWebhook(inboundImage({ id: 'wamid.V4' }), d);

    assert.equal(d.meta.sends.length, 1, 'the reply still goes out even though vision failed');
    const row = await pool.query("select attachment_context from messages where type = 'image'");
    assert.equal(row.rows[0].attachment_context, null);
  } finally {
    global.fetch = originalFetch;
  }
});

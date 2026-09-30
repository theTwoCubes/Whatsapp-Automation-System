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

test('describeAttachment returns nothing when neither gemini nor openai is configured', async () => {
  const note = await describeAttachment({ geminiApiKey: '', openaiApiKey: '' }, Buffer.from('x'), 'image/png');
  assert.equal(note, null);
});

test('describeAttachment skips a mime type it does not support, even when configured', async () => {
  const note = await describeAttachment({ geminiApiKey: 'k', geminiModel: 'gemini-2.5-flash' }, Buffer.from('x'), 'audio/ogg');
  assert.equal(note, null);
});

test('describeAttachment falls back to openai when gemini fails', async () => {
  const originalFetch = global.fetch;
  const seenHosts = [];
  global.fetch = async (url) => {
    seenHosts.push(String(url).split('/')[2]);
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return { ok: false, status: 500, json: async () => ({ error: { message: 'gemini down' } }) };
    }
    if (String(url).includes('api.openai.com')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'a logo with a blue circle' } }] }) };
    }
    throw new Error(`unexpected host ${url}`);
  };
  try {
    const config = { geminiApiKey: 'g', geminiModel: 'gemini-2.5-flash', openaiApiKey: 'sk-test', openaiModel: 'gpt-4o-mini' };
    const note = await describeAttachment(config, Buffer.from('x'), 'image/png');
    assert.equal(note, 'a logo with a blue circle');
    assert.ok(seenHosts.includes('generativelanguage.googleapis.com'), 'gemini was tried first');
    assert.ok(seenHosts.includes('api.openai.com'), 'openai was tried as fallback');
  } finally {
    global.fetch = originalFetch;
  }
});

test('describeAttachment returns null when both providers fail', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return { ok: false, status: 500, json: async () => ({ error: { message: 'gemini down' } }) };
    }
    if (String(url).includes('api.openai.com')) {
      return { ok: false, status: 500, json: async () => ({ error: { message: 'openai down too' } }) };
    }
    throw new Error(`unexpected host ${url}`);
  };
  try {
    const config = { geminiApiKey: 'g', geminiModel: 'gemini-2.5-flash', openaiApiKey: 'sk-test', openaiModel: 'gpt-4o-mini' };
    const note = await describeAttachment(config, Buffer.from('x'), 'image/png');
    assert.equal(note, null, 'both providers failing must return null, not throw');
  } finally {
    global.fetch = originalFetch;
  }
});

test('describeAttachment uses openai directly when only openai is configured', async () => {
  const originalFetch = global.fetch;
  let openaiCalled = false;
  global.fetch = async (url) => {
    if (String(url).includes('api.openai.com')) {
      openaiCalled = true;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'a brochure draft' } }] }) };
    }
    throw new Error(`unexpected host ${url}`);
  };
  try {
    const config = { geminiApiKey: '', openaiApiKey: 'sk-test', openaiModel: 'gpt-4o-mini' };
    const note = await describeAttachment(config, Buffer.from('x'), 'image/png');
    assert.equal(note, 'a brochure draft');
    assert.equal(openaiCalled, true);
  } finally {
    global.fetch = originalFetch;
  }
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

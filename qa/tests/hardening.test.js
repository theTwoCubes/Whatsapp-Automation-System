import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, maskSensitiveQuery } from '../../src/server.js';
import { setupPool, resetTables, testConfig, silentLog } from './support/harness.js';

let pool;
const config = {
  ...testConfig,
  jwtSecret: 's',
  graphApiVersion: 'v21.0',
  phoneNumberId: 'x',
  accessToken: 'x',
  verifyToken: 'x',
  appSecret: 'x',
  openaiApiKey: '',
  geminiApiKey: '',
  aiProvider: 'openai',
  adminEmail: '',
  adminPassword: '',
};

before(async () => {
  pool = await setupPool();
  await resetTables(pool);
});
after(async () => {
  await pool?.end();
});

test('security headers are set on every response', async () => {
  const app = buildServer(config, pool);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  await app.close();
});

test('an unexpected route error is logged but never echoed to the client', async () => {
  const app = buildServer(config, pool);
  app.get('/__boom', async () => {
    throw new Error('internal detail: postgres://user:secret@db/prod should never reach a client');
  });
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/__boom' });
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body, /postgres:\/\//, 'the underlying error detail is not echoed back');
  assert.deepEqual(res.json(), { error: 'something went wrong on our end' });
  await app.close();
});

test('the api as a whole is rate limited per ip on top of the login specific one', async () => {
  const app = buildServer(config, pool);
  await app.ready();

  let lastStatus = 200;
  for (let i = 0; i < 305; i += 1) {
    const res = await app.inject({ method: 'GET', url: '/api/conversations' });
    lastStatus = res.statusCode;
    if (lastStatus === 429) break;
  }
  assert.equal(lastStatus, 429, 'eventually rate limited');
  await app.close();
});

test('a verify token in a query string is never written to the request log', () => {
  const masked = maskSensitiveQuery('/webhook?hub.mode=subscribe&hub.verify_token=s3cr3t-value&hub.challenge=12345');
  assert.ok(!masked.includes('s3cr3t-value'), 'the token value is gone');
  assert.match(masked, /hub\.verify_token=\[redacted\]/);
  // The parts that make the log useful are kept.
  assert.match(masked, /hub\.mode=subscribe/);
  assert.match(masked, /hub\.challenge=12345/);
});

test('a websocket ticket is redacted too, and ordinary params are left alone', () => {
  assert.match(maskSensitiveQuery('/api/stream?ticket=abc123'), /ticket=\[redacted\]/);
  assert.equal(maskSensitiveQuery('/api/conversations?topicId=3&state=bot'), '/api/conversations?topicId=3&state=bot');
  assert.equal(maskSensitiveQuery('/health'), '/health');
});

// A blunt ceiling that does not care why the bot is replying too much. Every
// other guard is specific to a known failure; this one is the backstop for
// the ones nobody has thought of yet.
test('a conversation has a hard ceiling on replies per window, whatever else happens', async () => {
  const { processWebhook } = await import('../../src/handlers/message.js');
  const { inboundText } = await import('./support/fixtures.js');
  const { FakeMeta, FakeAi } = await import('./support/harness.js');

  const meta = new FakeMeta();
  // Distinct replies each turn so neither the repeat guard nor the peer-bot
  // net is what stops it - this has to be the cap and nothing else.
  const ai = new FakeAi();
  let n = 0;
  ai.complete = async () => {
    n += 1;
    return {
      text: JSON.stringify({ action: 'answer', reply: `Reply number ${n} about your project.`, lead_business: 'steel bars' }),
      provider: 'fake',
      failedProviders: [],
    };
  };
  const d = { meta, ai, pool, config: testConfig, log: silentLog };

  for (let i = 0; i < 20; i += 1) {
    await processWebhook(inboundText({ id: `wamid.CAP${i}`, body: `question ${i}` }), d);
  }

  assert.ok(meta.sends.length <= 12, `capped, got ${meta.sends.length} replies`);
  assert.ok(meta.sends.length >= 10, `but not strangling a normal chat, got ${meta.sends.length}`);
});

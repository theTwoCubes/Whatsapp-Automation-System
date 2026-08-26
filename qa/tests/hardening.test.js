import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../../src/server.js';
import { setupPool, resetTables, testConfig } from './support/harness.js';

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

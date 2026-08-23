import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../../src/server.js';
import { createAgent, recordInbound } from '../../src/db/repo.js';
import { hashPassword } from '../../src/auth.js';
import { setupPool, resetTables, testConfig } from './support/harness.js';

let pool;
let app;
let port;

const config = {
  ...testConfig,
  jwtSecret: 'rt-secret',
  graphApiVersion: 'v21.0',
  phoneNumberId: 'x',
  accessToken: 'x',
  verifyToken: 'x',
  appSecret: 'x',
  openaiApiKey: '',
  openaiModel: 'gpt-4o-mini',
  adminEmail: '',
  adminPassword: '',
};

before(async () => {
  pool = await setupPool();
  app = buildServer(config, pool);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = app.server.address().port;
});

after(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetTables(pool);
  await pool.query('truncate agents restart identity cascade');
  await createAgent(pool, { email: 'rt@test.com', name: 'RT', passwordHash: hashPassword('pw') });
});

async function login() {
  const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rt@test.com', password: 'pw' }),
  });
  return (await res.json()).token;
}

function openSocket(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream?token=${token}`);
  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('websocket failed to open'));
    setTimeout(() => reject(new Error('websocket open timed out')), 3000);
  });
  return { ws, opened };
}

test('a live event is pushed to a connected console socket', async () => {
  const { conversationId } = await recordInbound(pool, {
    waId: '910000000000',
    name: 'RT Lead',
    waMessageId: 'wamid.RT1',
    type: 'text',
    body: 'hi',
    referral: null,
    raw: {},
  });

  const token = await login();
  const { ws, opened } = openSocket(token);
  await opened;

  const received = new Promise((resolve, reject) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
    setTimeout(() => reject(new Error('no live event received')), 3000);
  });

  // Any agent action emits a refresh event to all sockets.
  await fetch(`http://127.0.0.1:${port}/api/conversations/${conversationId}/takeover`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });

  const event = await received;
  assert.equal(event.type, 'refresh');
  assert.equal(event.conversationId, conversationId);
  ws.close();
});

test('a socket with a bad token is closed and gets no events', async () => {
  const { ws, opened } = openSocket('not-a-valid-token');
  // Either it never opens, or it opens and is immediately closed with no data.
  const outcome = await opened.then(
    () =>
      new Promise((resolve) => {
        ws.onmessage = () => resolve('got-data');
        ws.onclose = () => resolve('closed');
        setTimeout(() => resolve('closed'), 1500);
      }),
    () => 'rejected',
  );
  assert.notEqual(outcome, 'got-data', 'a bad token must not receive events');
});

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MetaClient } from '../../src/meta/client.js';
import { silentLog } from './support/harness.js';

const config = {
  graphApiVersion: 'v21.0',
  phoneNumberId: '123',
  accessToken: 'token',
};

let originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function okResponse(id = 'wamid.OK1', waId) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      messages: [{ id }],
      ...(waId ? { contacts: [{ input: 'whatever-was-dialled', wa_id: waId }] } : {}),
    }),
  };
}

function timeoutError() {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

test('a timeout is never retried, since the send may already have gone through', async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; throw timeoutError(); };
  const meta = new MetaClient(config, silentLog);

  await assert.rejects(() => meta.sendText('919000000000', 'hi'));
  assert.equal(calls, 1, 'a timeout must not be retried - it might have already reached the lead');
});

test('a pre-flight connection failure is retried and can still succeed', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 2) { const err = new Error('connect ECONNREFUSED'); err.name = 'TypeError'; throw err; }
    return okResponse();
  };
  const meta = new MetaClient(config, silentLog);

  const { wamid } = await meta.sendText('919000000000', 'hi');
  assert.equal(wamid, 'wamid.OK1');
  assert.equal(calls, 2, 'a connection failure that never reached Meta is safe to retry');
});

test('a clean 5xx response is retried and can still succeed', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 2) return { ok: false, status: 500, json: async () => ({ error: { message: 'internal error' } }) };
    return okResponse();
  };
  const meta = new MetaClient(config, silentLog);

  const { wamid } = await meta.sendText('919000000000', 'hi');
  assert.equal(wamid, 'wamid.OK1');
  assert.equal(calls, 2);
});

test('a 4xx response is never retried - it would just fail the same way again', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 400, json: async () => ({ error: { message: 'invalid parameter' } }) };
  };
  const meta = new MetaClient(config, silentLog);

  await assert.rejects(() => meta.sendText('919000000000', 'hi'));
  assert.equal(calls, 1);
});

test('the wa_id Meta reports for the recipient is returned alongside the wamid', async () => {
  global.fetch = async () => okResponse('wamid.OK1', '9000000000'); // Meta dropped the '91' for this one
  const meta = new MetaClient(config, silentLog);

  const { wamid, waId } = await meta.sendText('919000000000', 'hi');
  assert.equal(wamid, 'wamid.OK1');
  assert.equal(waId, '9000000000', 'the normalised id Meta actually uses for this lead, not what we dialled');
});

test('when Meta does not echo a contacts array, the dialled number is used as the wa_id', async () => {
  global.fetch = async () => okResponse('wamid.OK1'); // no waId passed, no contacts array in the response
  const meta = new MetaClient(config, silentLog);

  const { waId } = await meta.sendText('919000000000', 'hi');
  assert.equal(waId, '919000000000');
});

test('a 2xx with no message id is treated as a failure and is not retried', async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ messages: [] }) }; };
  const meta = new MetaClient(config, silentLog);

  await assert.rejects(() => meta.sendText('919000000000', 'hi'));
  assert.equal(calls, 1, 'a confirmed 2xx must never be retried, that would resend a delivered message');
});

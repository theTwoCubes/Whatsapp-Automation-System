import test from 'node:test';
import assert from 'node:assert/strict';
import { AiClient, orderProviders } from '../../src/ai/client.js';
import { silentLog } from './support/harness.js';

function provider(name, result) {
  return {
    name,
    calls: 0,
    async complete() {
      this.calls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test('the primary provider is used first', async () => {
  const openai = provider('openai', 'from openai');
  const gemini = provider('gemini', 'from gemini');
  const ai = new AiClient({ aiProvider: 'openai' }, silentLog, { openai, gemini });
  assert.equal(await ai.complete([]), 'from openai');
  assert.equal(gemini.calls, 0, 'fallback not touched when primary works');
});

test('it fails over to the other provider when the primary errors', async () => {
  const openai = provider('openai', new Error('openai down'));
  const gemini = provider('gemini', 'from gemini');
  const ai = new AiClient({ aiProvider: 'openai' }, silentLog, { openai, gemini });
  assert.equal(await ai.complete([]), 'from gemini');
  assert.equal(openai.calls, 1);
  assert.equal(gemini.calls, 1);
});

test('AI_PROVIDER chooses which one is primary', async () => {
  const openai = provider('openai', 'from openai');
  const gemini = provider('gemini', 'from gemini');
  const ai = new AiClient({ aiProvider: 'gemini' }, silentLog, { openai, gemini });
  assert.equal(await ai.complete([]), 'from gemini');
});

test('when every provider errors, complete throws so the caller can fall back', async () => {
  const openai = provider('openai', new Error('openai down'));
  const gemini = provider('gemini', new Error('gemini down'));
  const ai = new AiClient({ aiProvider: 'openai' }, silentLog, { openai, gemini });
  await assert.rejects(() => ai.complete([]));
});

test('with no providers configured the client is disabled and throws', async () => {
  const ai = new AiClient({ aiProvider: 'openai' }, silentLog, {});
  assert.equal(ai.enabled, false);
  await assert.rejects(() => ai.complete([]));
});

test('order puts the primary first then the rest', () => {
  assert.deepEqual(orderProviders('gemini', { openai: {}, gemini: {} }), ['gemini', 'openai']);
  assert.deepEqual(orderProviders('openai', { openai: {}, gemini: {} }), ['openai', 'gemini']);
  assert.deepEqual(orderProviders('gemini', { openai: {} }), ['openai'], 'primary not configured, use what exists');
});

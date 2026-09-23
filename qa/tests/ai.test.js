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
  const result = await ai.complete([]);
  assert.equal(result.text, 'from openai');
  assert.equal(result.provider, 'openai', 'reports which provider actually answered');
  assert.deepEqual(result.failedProviders, [], 'nothing failed when the primary works');
  assert.equal(gemini.calls, 0, 'fallback not touched when primary works');
});

test('it fails over to the other provider when the primary errors, and says so', async () => {
  const openai = provider('openai', new Error('openai down'));
  const gemini = provider('gemini', 'from gemini');
  const ai = new AiClient({ aiProvider: 'openai' }, silentLog, { openai, gemini });
  const result = await ai.complete([]);
  assert.equal(result.text, 'from gemini');
  assert.equal(result.provider, 'gemini', 'reports the provider that actually answered, not the configured primary');
  assert.deepEqual(result.failedProviders, [{ provider: 'openai', error: 'openai down' }],
    'the failed primary and its error are visible, not just silently swallowed');
  assert.equal(openai.calls, 1);
  assert.equal(gemini.calls, 1);
});

test('AI_PROVIDER chooses which one is primary', async () => {
  const openai = provider('openai', 'from openai');
  const gemini = provider('gemini', 'from gemini');
  const ai = new AiClient({ aiProvider: 'gemini' }, silentLog, { openai, gemini });
  const result = await ai.complete([]);
  assert.equal(result.text, 'from gemini');
  assert.equal(result.provider, 'gemini');
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

test('reconfigure swaps providers in place without a new instance', async () => {
  const ai = new AiClient({ aiProvider: 'openai', openaiApiKey: '', geminiApiKey: '' }, silentLog);
  assert.equal(ai.enabled, false, 'starts disabled with no keys');

  ai.reconfigure({ aiProvider: 'gemini', openaiApiKey: '', geminiApiKey: 'a-real-key', geminiModel: 'gemini-2.5-flash' });
  assert.equal(ai.enabled, true, 'enabled once a key is added');
  assert.deepEqual(ai.order, ['gemini']);
});

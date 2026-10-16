import test from 'node:test';
import assert from 'node:assert/strict';

import { GeminiProvider, supportsThinking } from '../../src/ai/providers/gemini.js';
import { AI_TEMPERATURE, AI_MAX_OUTPUT_TOKENS, GEMINI_THINKING_BUDGET } from '../../src/ai/tuning.js';

// Asserted against the request actually sent, not against the constants - the
// point is that the settings reach the provider, and both providers agree.
async function captureGeminiBody(model) {
  const originalFetch = global.fetch;
  let sent;
  global.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
  };
  try {
    await new GeminiProvider('k', model).complete([{ role: 'user', content: 'hi' }], { json: true });
    return sent;
  } finally {
    global.fetch = originalFetch;
  }
}

test('a structured decision is sampled at a low temperature, not a creative one', async () => {
  assert.ok(AI_TEMPERATURE <= 0.35, `expected a low temperature, got ${AI_TEMPERATURE}`);
  const body = await captureGeminiBody('gemini-2.5-flash');
  assert.equal(body.generationConfig.temperature, AI_TEMPERATURE);
  assert.equal(body.generationConfig.maxOutputTokens, AI_MAX_OUTPUT_TOKENS);
});

// Reasoning tokens are billed against maxOutputTokens, which is how a
// truncated image description once got stored as though it were complete.
test('gemini is told not to spend the output budget on thinking', async () => {
  const body = await captureGeminiBody('gemini-2.5-flash');
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, GEMINI_THINKING_BUDGET);
  assert.equal(GEMINI_THINKING_BUDGET, 0);
});

// The model name is free text in the console. generationConfig rejects fields
// it does not know rather than ignoring them, so sending this to a model that
// predates the setting would take the provider down entirely.
test('the thinking setting is only sent to models that have it', async () => {
  for (const model of ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro', 'gemini-3.0-flash']) {
    assert.ok(supportsThinking(model), `${model} should get the setting`);
    const body = await captureGeminiBody(model);
    assert.ok(body.generationConfig.thinkingConfig, `${model} should carry thinkingConfig`);
  }
  for (const model of ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash', '']) {
    assert.equal(supportsThinking(model), false, `${model || '(empty)'} should not get the setting`);
    const body = await captureGeminiBody(model);
    assert.equal(body.generationConfig.thinkingConfig, undefined, `${model || '(empty)'} must not carry thinkingConfig`);
  }
});

test('json mode still rides alongside the tuning, not instead of it', async () => {
  const body = await captureGeminiBody('gemini-2.5-flash');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.temperature, AI_TEMPERATURE);
  assert.ok(body.generationConfig.thinkingConfig);
});

test('both providers read the same tuning, so neither can drift', async () => {
  const openai = await import('../../src/ai/providers/openai.js');
  const gemini = await import('../../src/ai/providers/gemini.js');
  const source = (mod) => mod;
  assert.ok(source(openai).OpenAIProvider, 'openai provider is exported');
  assert.ok(source(gemini).GeminiProvider, 'gemini provider is exported');
  // Neither file may carry its own hardcoded sampling numbers.
  const fs = await import('node:fs');
  for (const file of ['src/ai/providers/openai.js', 'src/ai/providers/gemini.js']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /temperature:\s*0\.\d/, `${file} should take temperature from tuning.js`);
    assert.doesNotMatch(text, /max_?[oO]utput_?[tT]okens:\s*\d/, `${file} should take the output cap from tuning.js`);
  }
});

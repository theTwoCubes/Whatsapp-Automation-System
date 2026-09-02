// Pure-function unit tests. No database, no network — these run instantly.
import test from 'node:test';
import assert from 'node:assert/strict';

import { wantsHuman, isSimpleGreeting, categorizeHandoffReason } from '../../src/ai/reply.js';
import { estimateTokens } from '../../src/knowledge/context.js';

// wantsHuman -----------------------------------------------------------------

test('wantsHuman: matches explicit human-request phrases', () => {
  assert.equal(wantsHuman('I want to talk to a human'), true);
  assert.equal(wantsHuman('Can I speak with an agent?'), true);
  assert.equal(wantsHuman('please let me speak to a real person'), true);
  assert.equal(wantsHuman('customer support please'), true);
});

test('wantsHuman: ignores ordinary conversation', () => {
  assert.equal(wantsHuman('what does a logo cost?'), false);
  assert.equal(wantsHuman('hi, how are you?'), false);
  assert.equal(wantsHuman(''), false);
  assert.equal(wantsHuman(null), false);
});

// isSimpleGreeting -----------------------------------------------------------

test('isSimpleGreeting: matches pure openers', () => {
  assert.equal(isSimpleGreeting('hi'), true);
  assert.equal(isSimpleGreeting('hello'), true);
  assert.equal(isSimpleGreeting('Hey!'), true);
  assert.equal(isSimpleGreeting('namaste'), true);
  assert.equal(isSimpleGreeting('ok'), true);
  assert.equal(isSimpleGreeting('okay'), true);
  assert.equal(isSimpleGreeting('thanks'), true);
  assert.equal(isSimpleGreeting('thank you'), true);
  assert.equal(isSimpleGreeting('👋'), true);
});

test('isSimpleGreeting: does not match substantive messages', () => {
  assert.equal(isSimpleGreeting('hi, what does a logo cost?'), false);
  assert.equal(isSimpleGreeting('I need a logo for my business'), false);
  assert.equal(isSimpleGreeting(''), false);
  assert.equal(isSimpleGreeting(null), false);
});

// categorizeHandoffReason ----------------------------------------------------

test('categorizeHandoffReason: maps price-related reasons', () => {
  assert.equal(categorizeHandoffReason('wants a discount on the price'), 'price_negotiation');
  assert.equal(categorizeHandoffReason('asking about the cost and budget'), 'price_negotiation');
});

test('categorizeHandoffReason: maps quote requests', () => {
  assert.equal(categorizeHandoffReason('needs a custom quote'), 'custom_quote');
  assert.equal(categorizeHandoffReason('asked for project quotation'), 'custom_quote');
});

test('categorizeHandoffReason: maps explicit human requests', () => {
  assert.equal(categorizeHandoffReason('Lead asked to speak with a person'), 'explicit_request');
  assert.equal(categorizeHandoffReason('wants to talk to an agent'), 'explicit_request');
});

test('categorizeHandoffReason: maps attachment handoffs', () => {
  assert.equal(categorizeHandoffReason('Lead sent a document'), 'attachment');
  assert.equal(categorizeHandoffReason('sent an image file'), 'attachment');
});

test('categorizeHandoffReason: falls back to other', () => {
  assert.equal(categorizeHandoffReason('some random reason'), 'other');
  assert.equal(categorizeHandoffReason(''), 'other');
  assert.equal(categorizeHandoffReason(null), 'other');
});

// estimateTokens -------------------------------------------------------------

test('estimateTokens: empty/null returns 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
});

test('estimateTokens: reasonable approximation for English text', () => {
  // "Hello world" = 11 chars / 4 chars per token ~= 3
  const t = estimateTokens('Hello world');
  assert.ok(t >= 2 && t <= 4, `expected 2-4, got ${t}`);
});

test('estimateTokens: longer text scales linearly', () => {
  const short = estimateTokens('a'.repeat(40));   // 10 tokens
  const long  = estimateTokens('a'.repeat(400));  // 100 tokens
  assert.ok(long > short * 5, 'longer text should produce significantly more tokens');
});

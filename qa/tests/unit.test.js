// Pure-function unit tests. No database, no network — these run instantly.
import test from 'node:test';
import assert from 'node:assert/strict';

import { categorizeHandoffReason } from '../../src/ai/reply.js';
import { estimateTokens } from '../../src/knowledge/context.js';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../../src/ratelimit.js';

test('allows up to the max then blocks', () => {
  const check = createRateLimiter({ max: 3, windowMs: 60000 });
  assert.equal(check('a').ok, true);
  assert.equal(check('a').ok, true);
  assert.equal(check('a').ok, true);
  const blocked = check('a');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfter > 0);
});

test('tracks keys independently', () => {
  const check = createRateLimiter({ max: 1, windowMs: 60000 });
  assert.equal(check('a').ok, true);
  assert.equal(check('b').ok, true, 'a different key is not affected');
  assert.equal(check('a').ok, false);
});

test('resets after the window passes', () => {
  const check = createRateLimiter({ max: 1, windowMs: -1 });
  assert.equal(check('a').ok, true);
  assert.equal(check('a').ok, true, 'window already elapsed so it resets');
});

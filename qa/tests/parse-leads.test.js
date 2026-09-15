import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLeadsText } from '../../src/leads/parseLeads.js';

test('name, phone order works', () => {
  const { rows } = parseLeadsText('Priya, 91 98765 43210');
  assert.deepEqual(rows, [{ waId: '919876543210', name: 'Priya', business: null, email: null }]);
});

test('phone-first order works just as well - the phone-shaped field wins regardless of position', () => {
  const { rows } = parseLeadsText('919876543210, Priya');
  assert.deepEqual(rows, [{ waId: '919876543210', name: 'Priya', business: null, email: null }]);
});

test('business and email are picked up when present, email recognised by shape not position', () => {
  const { rows } = parseLeadsText('Chetan, Chetan Traders, chetan@example.com, 919000000001');
  assert.deepEqual(rows, [{ waId: '919000000001', name: 'Chetan', business: 'Chetan Traders', email: 'chetan@example.com' }]);
});

test('a phone number alone on a line is enough - a single lead is a valid bulk send', () => {
  const { rows, invalid } = parseLeadsText('919000000002');
  assert.deepEqual(rows, [{ waId: '919000000002', name: null, business: null, email: null }]);
  assert.equal(invalid.length, 0);
});

test('blank lines are ignored, multiple leads parse line by line', () => {
  const { rows } = parseLeadsText('Asha, 919000000003\n\nBhavesh, 919000000004\n');
  assert.equal(rows.length, 2);
});

test('a line with no usable phone number is reported invalid, not silently dropped', () => {
  const { rows, invalid } = parseLeadsText('Just a name, no number here');
  assert.equal(rows.length, 0);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].reason, /phone/);
});

test('the same number pasted twice only produces one row, first occurrence wins', () => {
  const { rows } = parseLeadsText('Asha, 919000000005\nAsha Again, 919000000005');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Asha');
});

test('phone numbers with spaces, dashes, or a plus sign are normalised to digits only', () => {
  const { rows } = parseLeadsText('Dev, +91 90000-00006');
  assert.equal(rows[0].waId, '919000000006');
});

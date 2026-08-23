import test from 'node:test';
import assert from 'node:assert/strict';
import { humanize } from '../../src/ai/sanitize.js';

test('humanize strips markdown bold and italics', () => {
  assert.equal(humanize('That is **really** great and *nice*'), 'That is really great and nice');
});

test('humanize removes em and en dashes', () => {
  assert.equal(humanize('Logos start at 5000 — delivered fast'), 'Logos start at 5000 - delivered fast');
});

test('humanize drops heading and bullet markers', () => {
  assert.equal(humanize('# Services\n- logos\n- posters'), 'Services\nlogos\nposters');
});

test('humanize turns markdown links into plain text', () => {
  assert.equal(humanize('see [our work](https://x.com)'), 'see our work');
});

test('humanize leaves clean text untouched', () => {
  const clean = 'Hey! Our logo packages start at 5000 rupees. Want to see a few samples?';
  assert.equal(humanize(clean), clean);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { humanize, stripUnapprovedLinks } from '../../src/ai/sanitize.js';

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

test('an invented link in the reply is removed, along with the dangling lead-in', () => {
  const { text, stripped } = stripUnapprovedLinks(
    "Sure, here's the link: https://razorpay.com/payment-link/plink_madeup",
    [],
  );
  assert.equal(text, "Sure, here's the link");
  assert.deepEqual(stripped, ['https://razorpay.com/payment-link/plink_madeup']);
});

test("the business's own website and instagram survive", () => {
  const allowed = ['https://advoice.co.in/', 'https://instagram.com/advoice'];
  const { text, stripped } = stripUnapprovedLinks(
    'Our work is at https://advoice.co.in/ if you want a look.',
    allowed,
  );
  assert.equal(text, 'Our work is at https://advoice.co.in/ if you want a look.');
  assert.equal(stripped.length, 0);
});

test('a scheme-less link is caught too, and the sentence punctuation survives it', () => {
  const { text, stripped } = stripUnapprovedLinks('Pay at www.fake-pay.example/abc. Thanks!', []);
  assert.equal(text, 'Pay at. Thanks!');
  assert.deepEqual(stripped, ['www.fake-pay.example/abc']);
});

test('a reply with no links is returned untouched', () => {
  const input = 'The analysis is 510 rupees and Maulikbhai calls you within 24 hours.';
  const { text, stripped } = stripUnapprovedLinks(input, ['https://advoice.co.in/']);
  assert.equal(text, input);
  assert.equal(stripped.length, 0);
});

test('an allowed host still matches when the model writes it without the scheme', () => {
  const { stripped } = stripUnapprovedLinks('See advoice.co.in for more', ['https://advoice.co.in/']);
  assert.equal(stripped.length, 0, 'www./scheme differences must not make the real site look invented');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findPaymentAssertions,
  redactPaymentAssertions,
  validateLeadProfile,
  isRepeatOf,
  resolveService,
} from '../../src/ai/reconcile.js';

// Nothing in this system can see a payment. Every one of these was either sent
// to a real lead or is a phrasing of the same claim in the languages these
// conversations actually run in.
test('a reply claiming a payment arrived is caught, in English and Hinglish', () => {
  const claims = [
    'Thank you, payment received! the designer will call you within 24 hours.',
    "Thank you, that's received. the team will call you on your phone within 24 hours.",
    'Your payment has been confirmed.',
    'We have received your payment, thanks.',
    'Thank you for your payment!',
    'Payment mil gaya hai, dhanyavaad.',
    'Aapka payment ho gaya hai.',
    'Paise aa gaye hain.',
  ];
  for (const claim of claims) {
    assert.ok(findPaymentAssertions(claim).length > 0, `should be caught: ${claim}`);
  }
});

test('talking about what happens after a payment is still allowed', () => {
  const fine = [
    'Once your payment is received, the team will call you within 24 hours.',
    'After payment kindly email your existing logo and business details.',
    'Please make the payment of Rs 500 using the link I shared.',
    'Jab payment ho jaye, the team aapko call karenge.',
    'The fee is Rs 45,000 and it is fixed.',
    'Thanks for letting me know - I have passed it to the team to check.',
  ];
  for (const text of fine) {
    assert.deepEqual(findPaymentAssertions(text), [], `should be allowed: ${text}`);
  }
});

test('a claim that survives the retry is rewritten, keeping the rest of the reply', () => {
  const out = redactPaymentAssertions(
    'Thank you, payment received! the team will call you within 24 hours to fix a meeting.',
    'Hinglish',
  );
  assert.equal(findPaymentAssertions(out.text).length, 0, 'the claim is gone');
  assert.match(out.text, /the team will call you within 24 hours/, 'the useful half survives');
  assert.match(out.text, /team ko bata deta hoon/, 'and it is replaced in the right language');
});

test('a reply that is nothing but the claim still gets a usable answer', () => {
  const out = redactPaymentAssertions('Payment received!', 'English');
  assert.equal(findPaymentAssertions(out.text).length, 0);
  assert.match(out.text, /passed it to the team/);
});

// "For my business" was stored as lead_business = "business", which read as a
// complete field to the qualification gate and as nothing to the team.
test('a lead field that says nothing is rejected rather than stored', () => {
  const services = ['Logo Design', 'Premium Logo Design'];
  for (const value of ['business', 'my business', 'company', 'work', 'haan', 'na']) {
    const out = validateLeadProfile({ business: value }, { serviceNames: services });
    assert.equal(out.profile, null, `${value} should be rejected`);
    assert.equal(out.rejected.length, 1);
  }
});

test('the name of the service they want is not their business, and not a brief', () => {
  const services = ['Logo Design', 'Premium Logo Design'];
  assert.equal(validateLeadProfile({ business: 'Premium Logo Design' }, { serviceNames: services }).profile, null);
  assert.equal(validateLeadProfile({ requirement: 'premium logo design' }, { serviceNames: services }).profile, null);
});

test('a real answer is kept, however short', () => {
  const out = validateLeadProfile(
    { business: 'steel bar manufacturing', address: 'Delhi', requirement: 'new premium logo for the firm' },
    { serviceNames: ['Premium Logo Design'] },
  );
  assert.deepEqual(out.rejected, []);
  assert.equal(out.profile.business, 'steel bar manufacturing');
  assert.equal(out.profile.address, 'Delhi');
});

// The pair below is msgs 24 and 25 from a real chat, sent seven seconds apart.
// Byte comparison missed them because the model reworded as it repeated.
test('a reworded repeat of the previous reply is caught', () => {
  const previous = 'Aap apna logo bhej sakte hain, aur fir hum uska analysis karne ke liye Rs500 ka charge hoga. the designer aapke logo ko study karke aapko feedback denge.';
  const reworded = 'Aap apna existing logo bhej sakte hain, aur fir hum uska analysis karne ke liye Rs500 ka charge hoga. the designer aapke logo ko detail mein study karke feedback denge.';
  assert.ok(isRepeatOf(reworded, [previous]), 'the same turn twice, reworded');
});

test('a genuinely different reply is not treated as a repeat', () => {
  const previous = 'Aap apna logo bhej sakte hain, aur fir hum uska analysis karne ke liye Rs500 ka charge hoga.';
  assert.equal(isRepeatOf('Bilkul, main aapko payment link bhej raha hoon abhi.', [previous]), null);
});

test('short replies are only caught when they are exactly the same', () => {
  // Word overlap is meaningless at this length - these are fine back to back.
  assert.equal(isRepeatOf('Haan theek hai', ['Haan bilkul']), null);
  assert.ok(isRepeatOf('Haan bilkul', ['Haan bilkul']), 'but an exact repeat is still a repeat');
});

test('a repeat is caught even if it skips a turn', () => {
  const earlier = 'Could you tell me a bit about what your business does, so the team has the full picture?';
  const between = 'Sure, let me check that for you.';
  assert.ok(isRepeatOf(earlier, [between, earlier]));
});

// The rule the client asked for: a premium lead saying "logo" in passing is
// still a premium lead.
test('a passing mention of another service never moves an established one', () => {
  const out = resolveService({
    current: '3', currentBasis: 'stated', proposed: '1', proposedBasis: 'inferred', isChange: false,
  });
  assert.equal(out.service, '3');
  assert.equal(out.changed, false);
});

test('a guess never overwrites a service the customer stated', () => {
  const out = resolveService({
    current: '3', currentBasis: 'stated', proposed: '1', proposedBasis: 'inferred', isChange: true,
  });
  assert.equal(out.service, '3', 'calling it a change is not enough if it is only a guess');
});

test('a stated switch does move it, including away from a campaign', () => {
  assert.equal(resolveService({
    current: '3', currentBasis: 'stated', proposed: '1', proposedBasis: 'stated', isChange: true,
  }).service, '1');
  assert.equal(resolveService({
    current: '3', currentBasis: 'campaign', proposed: '1', proposedBasis: 'stated', isChange: true,
  }).service, '1');
});

test('nothing recorded yet means even a guess is worth keeping, labelled as one', () => {
  const out = resolveService({
    current: null, currentBasis: 'unset', proposed: '3', proposedBasis: 'inferred', isChange: false,
  });
  assert.equal(out.service, '3');
  assert.equal(out.basis, 'inferred');
});

test('a guess firming up into something stated is recorded as stated', () => {
  const out = resolveService({
    current: '3', currentBasis: 'inferred', proposed: '3', proposedBasis: 'stated', isChange: false,
  });
  assert.equal(out.basis, 'stated');
});

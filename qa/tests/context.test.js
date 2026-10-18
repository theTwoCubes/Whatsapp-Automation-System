import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildFaqContext, estimateTokens } from '../../src/knowledge/context.js';
import { createFaq, updateFaq } from '../../src/knowledge/faqs.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { setupPool, resetTables } from './support/harness.js';

let pool;

before(async () => {
  pool = await setupPool();
});
after(async () => {
  await pool?.end();
});
beforeEach(async () => {
  await resetTables(pool);
});

async function seed() {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const poster = await upsertTopic(pool, { slug: 'poster', name: 'Poster' });

  await createFaq(pool, { question: 'What are your hours?', answer: 'Monday to Saturday, 10am to 7pm.' });
  await createFaq(pool, { topicId: logo.id, question: 'What does a logo cost?', answer: '15000 rupees plus GST.', verbatim: true });
  await createFaq(pool, { topicId: logo.id, question: 'How many revisions?', answer: 'Two rounds are included.' });
  await createFaq(pool, { topicId: poster.id, question: 'Poster turnaround?', answer: 'Three working days.' });

  return { logo, poster };
}

test('the base pack goes in on its own when no service is linked', async () => {
  await seed();
  const ctx = await buildFaqContext(pool, { packs: ['base'] });

  assert.match(ctx.text, /What are your hours\?/);
  assert.doesNotMatch(ctx.text, /What does a logo cost\?/, 'another service pack is not pulled in');
  assert.equal(ctx.faqCount, 1);
});

test('the whole service pack goes in alongside base, not a selection from it', async () => {
  const { logo } = await seed();
  const ctx = await buildFaqContext(pool, { packs: ['base', logo.id] });

  assert.match(ctx.text, /What are your hours\?/);
  assert.match(ctx.text, /What does a logo cost\?/);
  assert.match(ctx.text, /How many revisions\?/, 'every entry in the pack is included, not just close matches');
  assert.doesNotMatch(ctx.text, /Poster turnaround\?/);
  assert.equal(ctx.faqCount, 3);
});

test('answers marked verbatim are flagged in the text the model sees', async () => {
  const { logo } = await seed();
  const ctx = await buildFaqContext(pool, { packs: ['base', logo.id] });
  assert.match(ctx.text, /15000 rupees plus GST\. \[quote this answer exactly, word for word\]/);
});

test('deactivated answers are left out entirely', async () => {
  const { logo } = await seed();
  const rows = await buildFaqContext(pool, { packs: [logo.id] });
  assert.equal(rows.faqCount, 2);

  const target = rows.faqIds[0];
  await updateFaq(pool, target, { active: false });

  const after = await buildFaqContext(pool, { packs: [logo.id] });
  assert.equal(after.faqCount, 1, 'a deactivated answer cannot reach the model');
});

test('the same pack asked for twice is only included once', async () => {
  const { logo } = await seed();
  const ctx = await buildFaqContext(pool, { packs: ['base', logo.id, logo.id, 'base'] });
  assert.deepEqual(ctx.packs, ['base', logo.id]);
  assert.equal(ctx.faqCount, 3);
});

test('entries are rendered in the order the client put them in', async () => {
  await createFaq(pool, { question: 'First', answer: 'one' });
  await createFaq(pool, { question: 'Second', answer: 'two' });
  await createFaq(pool, { question: 'Third', answer: 'three' });

  const ctx = await buildFaqContext(pool, { packs: ['base'] });
  assert.ok(ctx.text.indexOf('First') < ctx.text.indexOf('Second'));
  assert.ok(ctx.text.indexOf('Second') < ctx.text.indexOf('Third'));
});

test('over budget, the least important pack loses entries first and base survives', async () => {
  const { logo } = await seed();
  for (let i = 0; i < 40; i += 1) {
    await createFaq(pool, { topicId: logo.id, question: `Filler question number ${i}`, answer: 'A reasonably long answer used to take up room in the budget.' });
  }

  const ctx = await buildFaqContext(pool, { packs: ['base', logo.id], budgetTokens: 60 });

  assert.ok(ctx.dropped > 0, 'something was dropped to fit');
  assert.match(ctx.text, /What are your hours\?/, 'the base pack is the last thing to be trimmed');
  assert.ok(ctx.tokens <= 60 || ctx.faqCount === 1);
});

test('a pinned answer is kept even when everything around it is trimmed', async () => {
  const { logo } = await seed();
  const pinned = await createFaq(pool, {
    topicId: logo.id,
    question: 'Do you take rush work?',
    answer: 'Yes, for an extra charge.',
    pinned: true,
  });
  for (let i = 0; i < 40; i += 1) {
    await createFaq(pool, { topicId: logo.id, question: `Filler question number ${i}`, answer: 'A reasonably long answer used to take up room in the budget.' });
  }

  const ctx = await buildFaqContext(pool, { packs: ['base', logo.id], budgetTokens: 60 });
  assert.match(ctx.text, /Do you take rush work\?/, 'pinned entries are never dropped');
  assert.ok(ctx.faqIds.includes(pinned.id));
});

test('an empty knowledge base produces no answers rather than inventing any', async () => {
  const ctx = await buildFaqContext(pool, { packs: ['base'] });
  assert.equal(ctx.text, '');
  assert.equal(ctx.faqCount, 0);
});

test('token estimation tracks length', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(40)));
});

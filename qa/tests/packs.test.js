import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { keywordPacks, packCatalog } from '../../src/knowledge/packs.js';
import { createFaq } from '../../src/knowledge/faqs.js';
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
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design', keywords: 'logo, branding, identity' });
  const poster = await upsertTopic(pool, { slug: 'poster', name: 'Poster', keywords: 'poster, banner, print' });
  const web = await upsertTopic(pool, { slug: 'website', name: 'Website', keywords: 'website, landing page' });
  await createFaq(pool, { topicId: logo.id, question: 'Cost?', answer: '20000.' });
  await createFaq(pool, { topicId: poster.id, question: 'Turnaround?', answer: '3 days.' });
  await createFaq(pool, { topicId: web.id, question: 'Hosting?', answer: 'Included.' });
  return { logo, poster, web };
}

test('a word from a pack pulls that pack in on the current turn', async () => {
  const { poster } = await seed();
  const hits = await keywordPacks(pool, 'do you also make posters');
  assert.deepEqual(hits, [Number(poster.id)]);
});

test('matching is whole word only, so a substring never pulls a pack in by accident', async () => {
  await seed();
  const hits = await keywordPacks(pool, 'my blog is important to me');
  assert.deepEqual(hits, [], 'blog does not pull in the logo pack');
});

test('matching is not case sensitive', async () => {
  const { logo } = await seed();
  const hits = await keywordPacks(pool, 'I need a LOGO for my business');
  assert.deepEqual(hits, [Number(logo.id)]);
});

test('packs already included in this reply are not returned again', async () => {
  const { logo, poster } = await seed();
  const hits = await keywordPacks(pool, 'a logo and a poster please', [Number(logo.id)]);
  assert.deepEqual(hits, [Number(poster.id)]);
});

test('when several packs match, the one with more hits comes first', async () => {
  const { logo, poster } = await seed();
  const hits = await keywordPacks(pool, 'we want a logo, an identity and later a poster');
  assert.equal(hits[0], Number(logo.id), 'two keywords for logo beats one for poster');
  assert.equal(hits[1], Number(poster.id));
});

test('an inactive topic never contributes to keyword matches', async () => {
  const { logo } = await seed();
  await pool.query('update topics set active = false where id = $1', [logo.id]);
  const hits = await keywordPacks(pool, 'we need a logo');
  assert.deepEqual(hits, []);
});

test('a topic with no active answers is not offered as a pack the model can ask for', async () => {
  const { logo, poster, web } = await seed();
  await pool.query('update faqs set active = false where topic_id = $1', [web.id]);
  const catalog = await packCatalog(pool, [Number(logo.id)]);
  const ids = catalog.map((c) => Number(c.id));
  assert.ok(ids.includes(Number(poster.id)));
  assert.ok(!ids.includes(Number(web.id)), 'an empty pack is not worth asking for');
});

test('packs already included in this reply are not offered to the model either', async () => {
  const { logo, poster, web } = await seed();
  const catalog = await packCatalog(pool, [Number(logo.id)]);
  const ids = catalog.map((c) => Number(c.id));
  assert.ok(!ids.includes(Number(logo.id)), 'the pack we already have is not offered again');
  assert.ok(ids.includes(Number(poster.id)));
  assert.ok(ids.includes(Number(web.id)));
});

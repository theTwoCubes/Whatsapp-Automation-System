import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { saveMediaAsset, retrieveMedia } from '../../src/knowledge/media.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { recordOutbound, wasMediaSentRecently } from '../../src/db/repo.js';
import { setupPool, resetTables, FakeEmbeddings } from './support/harness.js';

let pool;
let embed;

before(async () => {
  pool = await setupPool();
  embed = new FakeEmbeddings();
});
after(async () => {
  await pool?.end();
});
beforeEach(async () => {
  await resetTables(pool);
});

async function seed() {
  const logoTopic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const posterTopic = await upsertTopic(pool, { slug: 'poster', name: 'Poster' });

  const pricing = await saveMediaAsset(pool, embed, {
    metaMediaId: 'media-1',
    filename: 'logo-pricing.pdf',
    mimeType: 'application/pdf',
    kind: 'document',
    topicId: logoTopic.id,
    description: 'Pricing sheet for logo design packages and add ons',
  });
  const portfolio = await saveMediaAsset(pool, embed, {
    metaMediaId: 'media-2',
    filename: 'poster-portfolio.jpg',
    mimeType: 'image/jpeg',
    kind: 'image',
    topicId: posterTopic.id,
    description: 'Sample poster designs from past client projects',
  });

  return { logoTopic, posterTopic, pricing, portfolio };
}

test('retrieveMedia finds the closest matching asset by description', async () => {
  const { pricing } = await seed();
  const asset = await retrieveMedia(pool, embed, 'can you send the logo design pricing sheet', {
    similarityFloor: 0.3,
  });
  assert.ok(asset, 'a match was found');
  assert.equal(asset.id, pricing);
});

test('retrieveMedia returns null when nothing clears the similarity floor', async () => {
  await seed();
  const asset = await retrieveMedia(pool, embed, 'completely unrelated query about nothing at all', {
    similarityFloor: 0.99,
  });
  assert.equal(asset, null);
});

test('retrieveMedia returns null with no embeddings support', async () => {
  await seed();
  const disabled = new FakeEmbeddings();
  disabled.enabled = false;
  const asset = await retrieveMedia(pool, disabled, 'logo pricing', { similarityFloor: 0.3 });
  assert.equal(asset, null);
});

test('wasMediaSentRecently reflects a recent outbound send of that asset', async () => {
  const { pricing } = await seed();
  const conv = await pool.query(
    `insert into contacts (wa_id) values ('91900000') returning id`,
  );
  const contactId = conv.rows[0].id;
  const convRow = await pool.query(
    `insert into conversations (contact_id) values ($1) returning id`,
    [contactId],
  );
  const conversationId = convRow.rows[0].id;

  assert.equal(await wasMediaSentRecently(pool, conversationId, pricing), false);

  await recordOutbound(pool, {
    conversationId,
    waMessageId: 'wamid.MED1',
    type: 'document',
    body: 'pricing sheet',
    mediaAssetId: pricing,
  });

  assert.equal(await wasMediaSentRecently(pool, conversationId, pricing), true);
});

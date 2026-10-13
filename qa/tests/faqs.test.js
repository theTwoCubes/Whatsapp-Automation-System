import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildFaqContext } from '../../src/knowledge/context.js';

import {
  listFaqs,
  getFaq,
  createFaq,
  updateFaq,
  deleteFaq,
  reorderFaqs,
  listFaqVersions,
  rollbackFaq,
  listPacks,
  searchFaqs,
  bulkUpdateFaqs,
} from '../../src/knowledge/faqs.js';
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

test('a faq is created in a pack and listed under it', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await createFaq(pool, { topicId: topic.id, question: 'What does a logo cost?', answer: '20000 rupees plus GST.' }, 'a@b.com');
  await createFaq(pool, { question: 'What are your hours?', answer: 'Monday to Saturday, 10am to 7pm.' }, 'a@b.com');

  const inPack = await listFaqs(pool, { pack: topic.id });
  assert.equal(inPack.length, 1);
  assert.equal(inPack[0].question, 'What does a logo cost?');

  const base = await listFaqs(pool, { pack: 'base' });
  assert.equal(base.length, 1, 'a faq with no topic lands in the base pack');
  assert.equal(base[0].topic_id, null);

  assert.equal((await listFaqs(pool, { pack: 'all' })).length, 2);
});

test('positions are assigned per pack so packs do not interleave', async () => {
  const topic = await upsertTopic(pool, { slug: 'poster', name: 'Poster' });
  const a = await createFaq(pool, { question: 'Base one', answer: 'x' });
  const b = await createFaq(pool, { question: 'Base two', answer: 'y' });
  const c = await createFaq(pool, { topicId: topic.id, question: 'Poster one', answer: 'z' });

  assert.equal(a.position, 1);
  assert.equal(b.position, 2);
  assert.equal(c.position, 1, 'a new pack starts its own numbering');
});

test('reordering rewrites positions in the given order', async () => {
  const a = await createFaq(pool, { question: 'First', answer: 'x' });
  const b = await createFaq(pool, { question: 'Second', answer: 'y' });
  const c = await createFaq(pool, { question: 'Third', answer: 'z' });

  await reorderFaqs(pool, [c.id, a.id, b.id]);
  const rows = await listFaqs(pool, { pack: 'base' });
  assert.deepEqual(rows.map((r) => r.question), ['Third', 'First', 'Second']);
});

test('a partial update leaves the fields it was not given alone', async () => {
  const faq = await createFaq(pool, { question: 'Price?', answer: '20000 rupees.', verbatim: true, pinned: true });
  const updated = await updateFaq(pool, faq.id, { answer: '25000 rupees.' }, 'a@b.com');

  assert.equal(updated.answer, '25000 rupees.');
  assert.equal(updated.question, 'Price?', 'question untouched');
  assert.equal(updated.verbatim, true, 'verbatim untouched');
  assert.equal(updated.pinned, true, 'pinned untouched');
});

test('an explicit null clears the attachment rather than being ignored', async () => {
  const assetId = (
    await pool.query("insert into media_assets (kind, filename) values ('document', 'p.pdf') returning id")
  ).rows[0].id;
  const faq = await createFaq(pool, { question: 'Price?', answer: '20000.', mediaAssetId: assetId });
  assert.equal(faq.media_asset_id, assetId);

  const cleared = await updateFaq(pool, faq.id, { mediaAssetId: null });
  assert.equal(cleared.media_asset_id, null, 'passing null detaches the file');

  const untouched = await updateFaq(pool, faq.id, { answer: '21000.' });
  assert.equal(untouched.media_asset_id, null, 'not passing it leaves it as it was');
});

test('every write is snapshotted and an earlier wording can be restored', async () => {
  const faq = await createFaq(pool, { question: 'Price?', answer: '20000 rupees.' }, 'a@b.com');
  await updateFaq(pool, faq.id, { answer: '25000 rupees.' }, 'b@b.com');

  const versions = await listFaqVersions(pool, faq.id);
  assert.equal(versions.length, 2, 'creation and the edit are both recorded');
  assert.equal(versions[0].answer, '25000 rupees.', 'newest first');
  assert.equal(versions[0].actor, 'b@b.com', 'the editor is recorded');

  const original = versions[versions.length - 1];
  const restored = await rollbackFaq(pool, original.id, 'c@b.com');
  assert.equal(restored.answer, '20000 rupees.');

  const after = await listFaqVersions(pool, faq.id);
  assert.equal(after.length, 3, 'the rollback is itself part of the history');
});

test('deleting a faq takes its history with it', async () => {
  const faq = await createFaq(pool, { question: 'Gone?', answer: 'yes' });
  await deleteFaq(pool, faq.id);
  assert.equal(await getFaq(pool, faq.id), null);
  assert.equal((await listFaqVersions(pool, faq.id)).length, 0);
});

test('the pack list always leads with base and counts only active entries', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await createFaq(pool, { question: 'Base one', answer: 'x' });
  await createFaq(pool, { topicId: topic.id, question: 'Logo one', answer: 'y' });
  const inactive = await createFaq(pool, { topicId: topic.id, question: 'Logo two', answer: 'z' });
  await updateFaq(pool, inactive.id, { active: false });

  const packs = await listPacks(pool);
  assert.equal(packs[0].slug, 'base');
  assert.equal(packs[0].faq_count, 1);
  const logo = packs.find((p) => p.slug === 'logo_design');
  assert.equal(logo.faq_count, 1, 'the deactivated entry is not counted');
});

test('search finds a match in either the question or the answer, case insensitively', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await createFaq(pool, { question: 'What does a logo cost?', answer: '20000 rupees plus GST.', topicId: logo.id });
  await createFaq(pool, { question: 'What are your hours?', answer: 'Monday to Saturday, 10am to 7pm.' });
  await createFaq(pool, { question: 'How many revisions?', answer: 'The logo package includes two rounds.', topicId: logo.id });

  const byQuestion = await searchFaqs(pool, 'REVISIONS');
  assert.equal(byQuestion.length, 1);
  assert.equal(byQuestion[0].question, 'How many revisions?');
  assert.equal(byQuestion[0].topic_name, 'Logo Design', 'the pack the match belongs to comes through');

  const byAnswer = await searchFaqs(pool, 'monday');
  assert.equal(byAnswer.length, 1);
  assert.equal(byAnswer[0].question, 'What are your hours?');

  const acrossPacks = await searchFaqs(pool, 'logo');
  assert.ok(acrossPacks.length >= 2, 'search reaches across every pack');

  const noMatch = await searchFaqs(pool, 'nothing that exists');
  assert.equal(noMatch.length, 0);
});

test('bulk deactivating a set of ids moves them out of the live prompt at once', async () => {
  const a = await createFaq(pool, { question: 'First', answer: 'x' });
  const b = await createFaq(pool, { question: 'Second', answer: 'y' });
  const c = await createFaq(pool, { question: 'Third', answer: 'z' });

  const res = await bulkUpdateFaqs(pool, [a.id, b.id], 'deactivate', 'a@b.com');
  assert.equal(res.affected, 2);

  const rows = await listFaqs(pool, { pack: 'base' });
  const active = rows.filter((r) => r.active).map((r) => r.question);
  assert.deepEqual(active, ['Third'], 'only the untouched entry is still live');

  const history = await listFaqVersions(pool, a.id);
  assert.equal(history[0].actor, 'a@b.com', 'the bulk change is snapshotted per entry');
});

test('bulk delete removes rows and their history in one shot', async () => {
  const a = await createFaq(pool, { question: 'First', answer: 'x' });
  const b = await createFaq(pool, { question: 'Second', answer: 'y' });

  const res = await bulkUpdateFaqs(pool, [a.id, b.id], 'delete');
  assert.equal(res.affected, 2);
  assert.equal(await getFaq(pool, a.id), null);
  assert.equal((await listFaqVersions(pool, a.id)).length, 0);
});

test('bulk with no ids or an unknown action is rejected without touching anything', async () => {
  const a = await createFaq(pool, { question: 'Only one', answer: 'x' });
  assert.deepEqual(await bulkUpdateFaqs(pool, [], 'delete'), { affected: 0 });

  await assert.rejects(() => bulkUpdateFaqs(pool, [a.id], 'nuke'), /unknown bulk action/);
  assert.ok(await getFaq(pool, a.id), 'row still there after an invalid action');
});

test('a faq needs both a question and an answer', async () => {
  await assert.rejects(() => createFaq(pool, { question: '  ', answer: 'x' }), /question and answer/);
  await assert.rejects(() => createFaq(pool, { question: 'x', answer: '' }), /question and answer/);
});

// The whole point of pinning: a commercially binding answer (the price, the
// payment terms, the no-negotiation line) must still reach the model when the
// prompt is tight on space, because a lead being quoted from a half-loaded
// pack is worse than a longer prompt. Packs are sticky, so a lead who mentions
// two services carries both and the budget does get hit in practice.
test('a pinned answer survives a budget far too small for the pack, unpinned ones do not', async () => {
  const topic = await upsertTopic(pool, { slug: 'pin-svc', name: 'Pin Service' });
  await createFaq(pool, {
    topicId: topic.id,
    question: 'How much does it cost?',
    answer: 'It is 20,000 rupees plus GST, and that rate is fixed.',
    verbatim: true,
    pinned: true,
  });
  // Plenty of filler so the budget cannot possibly fit everything.
  for (let i = 0; i < 12; i += 1) {
    await createFaq(pool, {
      topicId: topic.id,
      question: `Filler question number ${i}?`,
      answer: `Filler answer number ${i}. ${'padding '.repeat(40)}`,
    });
  }

  const ctx = await buildFaqContext(pool, { packs: [topic.id], budgetTokens: 120 });

  assert.match(ctx.text, /20,000 rupees plus GST/, 'the pinned price answer is still there');
  assert.ok(ctx.dropped > 0, 'and unpinned filler was dropped to make room');
  assert.ok(!ctx.text.includes('Filler answer number 11'), 'dropping starts from the end');
  assert.match(ctx.text, /quote this answer exactly, word for word/, 'verbatim marker rides along');
});

test('every pack file ships its pinned and verbatim flags, so a reseed cannot silently lose them', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../../faq/packs/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 4, 'all four packs present');

  for (const file of files) {
    const text = fs.readFileSync(new URL(file, dir), 'utf8');
    assert.ok(/^!pinned$/m.test(text), `${file} marks at least one answer !pinned`);
    assert.ok(/^!verbatim$/m.test(text), `${file} marks at least one answer !verbatim`);
    // A stray placeholder is what made the ai invent its own payment url.
    assert.ok(!text.includes('[send '), `${file} has no leftover [send ...] placeholder`);
  }
});

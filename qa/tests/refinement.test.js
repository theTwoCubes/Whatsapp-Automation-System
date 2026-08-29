import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  runWeeklyRefinement,
  getRefinementCursor,
  listProposals,
  dismissProposal,
} from '../../src/knowledge/refinement.js';
import { createFaq } from '../../src/knowledge/faqs.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { recordInbound, recordHandoff } from '../../src/db/repo.js';
import { setupPool, resetTables, FakeAi } from './support/harness.js';

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

async function seedHandoff(body, { source = 'ai', reason = 'no answer covers this', topicId = null } = {}) {
  const { conversationId } = await recordInbound(pool, {
    waId: `919${Math.floor(Math.random() * 1e9)}`.slice(0, 12),
    name: 'Lead',
    waMessageId: `wamid.${Math.random()}`,
    type: 'text',
    body,
    referral: null,
    raw: {},
  });
  await recordHandoff(pool, { conversationId, source, reason, topicId });
  return conversationId;
}

// A stub that returns different responses on different calls, so a single pass
// can hit both the gap prompt and the contradiction prompt without confusing
// which is which.
class ScriptedAi {
  constructor(script) {
    this.script = script;
    this.enabled = true;
    this.calls = 0;
  }
  async complete(messages) {
    const system = messages[0]?.content || '';
    const handler = this.script.find((s) => system.includes(s.match));
    this.calls += 1;
    return handler ? handler.reply : JSON.stringify({});
  }
}

test('gap pass proposes an FAQ from repeated handoffs on the same underlying question', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const c1 = await seedHandoff('do you also do 3d renders', { topicId: logo.id });
  const c2 = await seedHandoff('any chance you do 3d?', { topicId: logo.id });

  const ai = new ScriptedAi([
    {
      match: 'Group them into a small number of underlying gaps',
      reply: JSON.stringify({
        gaps: [
          {
            question: 'Do you do 3D renders?',
            suggested_answer: 'Yes, please fill in the details',
            reason: '3d renders keep coming up',
            sample_conversation_ids: [Number(c1), Number(c2)],
          },
        ],
      }),
    },
  ]);

  const res = await runWeeklyRefinement(pool, ai);
  assert.equal(res.gaps.scanned, 2);
  assert.equal(res.gaps.proposed, 1);

  const open = await listProposals(pool);
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'gap');
  assert.equal(open[0].question, 'Do you do 3D renders?');
  assert.equal(Number(open[0].topic_id), Number(logo.id));
  assert.deepEqual(open[0].sample_conversation_ids.map(Number), [Number(c1), Number(c2)]);
});

test('handoffs the lead requested are not scanned as gaps, only ai decided ones', async () => {
  await seedHandoff('need a person please', { source: 'lead', reason: 'Lead asked' });
  await seedHandoff('what is your address', { source: 'attachment', reason: 'attachment' });

  const ai = new ScriptedAi([
    { match: 'gap', reply: JSON.stringify({ gaps: [{ question: 'x', suggested_answer: 'y' }] }) },
  ]);
  const res = await runWeeklyRefinement(pool, ai);
  assert.equal(res.gaps.scanned, 0, 'nothing to look at, so nothing was scanned');
  assert.equal(res.gaps.proposed, 0);
});

test('the cursor advances so a second run does not rescan the same handoffs', async () => {
  await seedHandoff('do you do 3d renders');
  const ai = new ScriptedAi([{ match: 'gap', reply: JSON.stringify({ gaps: [] }) }]);
  await runWeeklyRefinement(pool, ai);
  const cursor1 = await getRefinementCursor(pool);
  assert.ok(cursor1.lastHandoffId > 0);

  const second = await runWeeklyRefinement(pool, ai);
  assert.equal(second.gaps.scanned, 0);
});

test('contradiction pass flags a pair of answers that disagree', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const a = await createFaq(pool, { topicId: logo.id, question: 'What does a logo cost?', answer: '20000 rupees.' });
  const b = await createFaq(pool, { topicId: logo.id, question: 'Logo price?', answer: '25000 rupees.' });

  const ai = new ScriptedAi([
    { match: 'Group them into a small number of underlying gaps', reply: JSON.stringify({ gaps: [] }) },
    {
      match: 'Point out pairs of answers that clearly contradict',
      reply: JSON.stringify({
        contradictions: [{ faq_id_a: Number(a.id), faq_id_b: Number(b.id), reason: 'one says 20000, the other 25000' }],
      }),
    },
  ]);

  const res = await runWeeklyRefinement(pool, ai);
  assert.equal(res.contradictions.proposed, 1);

  const open = await listProposals(pool);
  const contra = open.find((p) => p.kind === 'contradiction');
  assert.ok(contra);
  assert.equal(Number(contra.faq_id_a), Number(a.id));
  assert.equal(Number(contra.faq_id_b), Number(b.id));
  assert.match(contra.reason, /20000/);
});

test('a contradiction naming an id that does not exist is dropped, not stored', async () => {
  await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  await createFaq(pool, { question: 'Only one', answer: 'x' });
  await createFaq(pool, { question: 'Only two', answer: 'y' });

  const ai = new ScriptedAi([
    { match: 'gap', reply: JSON.stringify({ gaps: [] }) },
    {
      match: 'contradict',
      reply: JSON.stringify({
        contradictions: [{ faq_id_a: 99999, faq_id_b: 88888, reason: 'made up' }],
      }),
    },
  ]);

  const res = await runWeeklyRefinement(pool, ai);
  assert.equal(res.contradictions.proposed, 0, 'an id we did not offer is dropped, not trusted');
});

test('running twice does not stack duplicate contradiction proposals', async () => {
  const logo = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const a = await createFaq(pool, { topicId: logo.id, question: 'Cost?', answer: '20000.' });
  const b = await createFaq(pool, { topicId: logo.id, question: 'Price?', answer: '25000.' });

  const ai = new ScriptedAi([
    { match: 'gap', reply: JSON.stringify({ gaps: [] }) },
    {
      match: 'contradict',
      reply: JSON.stringify({
        contradictions: [{ faq_id_a: Number(a.id), faq_id_b: Number(b.id), reason: 'different prices' }],
      }),
    },
  ]);

  await runWeeklyRefinement(pool, ai);
  await runWeeklyRefinement(pool, ai);

  const open = await listProposals(pool);
  const contras = open.filter((p) => p.kind === 'contradiction');
  assert.equal(contras.length, 1, 'the same pair is only flagged once while it is still open');
});

test('refinement is a no op when the ai is disabled', async () => {
  await seedHandoff('anything');
  const disabled = new FakeAi();
  disabled.enabled = false;
  const res = await runWeeklyRefinement(pool, disabled);
  assert.deepEqual(res, {
    gaps: { scanned: 0, proposed: 0 },
    contradictions: { scanned: 0, proposed: 0 },
  });
});

test('a proposal can be dismissed and drops out of the open list', async () => {
  await seedHandoff('do you do 3d');
  const ai = new ScriptedAi([
    { match: 'gap', reply: JSON.stringify({ gaps: [{ question: 'Do you do 3d', suggested_answer: 'yes' }] }) },
  ]);
  await runWeeklyRefinement(pool, ai);

  const before = await listProposals(pool);
  assert.equal(before.length, 1);

  await dismissProposal(pool, before[0].id, 'me@x.com');
  const after = await listProposals(pool);
  assert.equal(after.length, 0);

  const dismissed = await listProposals(pool, { status: 'dismissed' });
  assert.equal(dismissed.length, 1);
  assert.equal(dismissed[0].resolved_by, 'me@x.com');
});
